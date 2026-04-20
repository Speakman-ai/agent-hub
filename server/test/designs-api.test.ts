import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

interface DesignBody {
  id: string;
  name: string;
  linkedProjects: Array<{ id: string }>;
}

interface MessageBody {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

describe('Designs API — CRUD', () => {
  it('POST /api/designs creates a design and seeds the artifact dir', async () => {
    const proj = (await createProject()) as { id: string };
    const res = await request
      .post('/api/designs')
      .send({ name: 'Landing page', linkedProjectIds: [proj.id] })
      .expect(201);

    const body = res.body as DesignBody;
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe('Landing page');
    expect(body.linkedProjects.map((p) => p.id)).toEqual([proj.id]);

    // The static mount should serve the seed index.html.
    const html = await request.get(`/design-files/${body.id}/index.html`).expect(200);
    expect(html.text).toContain('<body>');
  });

  it('POST /api/designs rejects empty name', async () => {
    await request.post('/api/designs').send({ name: '' }).expect(400);
    await request.post('/api/designs').send({}).expect(400);
  });

  it('GET /api/designs lists designs', async () => {
    await request.post('/api/designs').send({ name: 'List Me' }).expect(201);
    const res = await request.get('/api/designs').expect(200);
    const names = (res.body as DesignBody[]).map((d) => d.name);
    expect(names).toContain('List Me');
  });

  it('GET /api/designs/:id returns 404 for missing rows', async () => {
    await request.get('/api/designs/nonexistent-id').expect(404);
  });

  it('PATCH /api/designs/:id renames and replaces linked projects', async () => {
    const a = (await createProject()) as { id: string };
    const b = (await createProject()) as { id: string };
    const created = await request
      .post('/api/designs')
      .send({ name: 'Original', linkedProjectIds: [a.id] })
      .expect(201);
    const id = (created.body as DesignBody).id;

    const res = await request
      .patch(`/api/designs/${id}`)
      .send({ name: 'Renamed', linkedProjectIds: [b.id] })
      .expect(200);

    const body = res.body as DesignBody;
    expect(body.name).toBe('Renamed');
    expect(body.linkedProjects.map((p) => p.id)).toEqual([b.id]);
  });

  it('GET /api/designs/:id/messages is empty on create', async () => {
    const created = await request.post('/api/designs').send({ name: 'Msgs' }).expect(201);
    const id = (created.body as DesignBody).id;
    const res = await request.get(`/api/designs/${id}/messages`).expect(200);
    expect(res.body).toEqual([]);
  });

  it('DELETE /api/designs/:id removes the design and its static mount', async () => {
    const created = await request.post('/api/designs').send({ name: 'Kill' }).expect(201);
    const id = (created.body as DesignBody).id;
    await request.delete(`/api/designs/${id}`).expect(200);
    await request.get(`/api/designs/${id}`).expect(404);
    await request.get(`/design-files/${id}/index.html`).expect(404);
  });
});

describe('Designs API — messages cascade', () => {
  it('messages persisted via the store are readable through GET and wiped on delete', async () => {
    const created = await request.post('/api/designs').send({ name: 'Chat' }).expect(201);
    const id = (created.body as DesignBody).id;

    // Seed two messages directly via the store (WS-driven normally). We do
    // this through a lightweight import to avoid standing up the CLI.
    const { appendDesignMessage } = await import('../designs-store.js');
    appendDesignMessage(id, 'user', 'hi');
    appendDesignMessage(id, 'assistant', 'hello');

    const res = await request.get(`/api/designs/${id}/messages`).expect(200);
    const msgs = res.body as MessageBody[];
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
    ]);

    await request.delete(`/api/designs/${id}`).expect(200);
    await request.get(`/api/designs/${id}/messages`).expect(404);
  });
});

describe('Designs API — status endpoint', () => {
  it('GET /api/designs/:id/status returns inFlight:false when no turn is running', async () => {
    const created = await request.post('/api/designs').send({ name: 'Idle' }).expect(201);
    const id = (created.body as DesignBody).id;

    const res = await request.get(`/api/designs/${id}/status`).expect(200);
    expect(res.body).toEqual({ inFlight: false, messageId: null, streaming: '' });
  });

  it('GET /api/designs/:id/status reflects an active turn with partial streaming', async () => {
    const created = await request.post('/api/designs').send({ name: 'Busy' }).expect(201);
    const id = (created.body as DesignBody).id;

    // Seed the in-memory `activeDesignProcesses` map directly to simulate a
    // turn in flight without spawning the CLI. This is what the status
    // endpoint reads; the fake entry is cleaned up at the end of the test.
    const chat = await import('../design-chat.js');
    chat.activeDesignProcesses.set(id, {
      proc: null,
      cancelled: false,
      messageId: 'msg-123',
      lastStream: 'partial output so far…',
    } as unknown as Parameters<typeof chat.activeDesignProcesses.set>[1]);

    try {
      const res = await request.get(`/api/designs/${id}/status`).expect(200);
      expect(res.body).toEqual({
        inFlight: true,
        messageId: 'msg-123',
        streaming: 'partial output so far…',
      });
    } finally {
      chat.activeDesignProcesses.delete(id);
    }
  });

  it('GET /api/designs/:id/status returns 404 for unknown designs', async () => {
    await request.get('/api/designs/nonexistent-id/status').expect(404);
  });
});

describe('Designs API — cross-org isolation', () => {
  it('per-ID routes return 404 for a design belonging to a different org', async () => {
    // Create a design via the normal flow (it gets the server's active org).
    const created = await request.post('/api/designs').send({ name: 'Org A' }).expect(201);
    const id = (created.body as DesignBody).id;

    // Forcibly reassign the design to a different org in the DB.
    const { getDb } = await import('../db.js');
    getDb().prepare("UPDATE designs SET org_id = 'other-org' WHERE id = ?").run(id);

    // All per-ID routes should now 404.
    await request.get(`/api/designs/${id}`).expect(404);
    await request.patch(`/api/designs/${id}`).send({ name: 'Hijack' }).expect(404);
    await request.delete(`/api/designs/${id}`).expect(404);
    await request.get(`/api/designs/${id}/messages`).expect(404);
    await request.get(`/api/designs/${id}/status`).expect(404);
    await request.get(`/design-files/${id}/index.html`).expect(404);
  });

  it('listing does not include designs from other orgs', async () => {
    const created = await request.post('/api/designs').send({ name: 'Hidden' }).expect(201);
    const id = (created.body as DesignBody).id;

    const { getDb } = await import('../db.js');
    getDb().prepare("UPDATE designs SET org_id = 'other-org' WHERE id = ?").run(id);

    const res = await request.get('/api/designs').expect(200);
    const ids = (res.body as DesignBody[]).map((d) => d.id);
    expect(ids).not.toContain(id);
  });
});

describe('Designs API — path-traversal guard', () => {
  it('rejects an invalid designId segment with 400', async () => {
    // A `..` inside the designId slot fails the [A-Za-z0-9-]+ regex and
    // never reaches express.static.
    await request.get('/design-files/..%2F..%2Fetc/passwd').expect(400);
  });

  it('refuses to serve files outside the per-design root', async () => {
    const created = await request.post('/api/designs').send({ name: 'Trav' }).expect(201);
    const id = (created.body as DesignBody).id;

    // Encoded `../../etc/passwd` — express decodes `%2e%2e%2f` before our
    // guard resolves the path. The resolved path escapes the design root,
    // so either our guard (404) or serve-static's own traversal check (403)
    // rejects it. Both are acceptable — the assertion guards against the
    // file actually being served.
    const res = await request.get(`/design-files/${id}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    expect([403, 404]).toContain(res.status);
    expect(res.text).not.toContain('root:');
  });

  it('refuses sibling-design access via traversal', async () => {
    const a = await request.post('/api/designs').send({ name: 'A' }).expect(201);
    const b = await request.post('/api/designs').send({ name: 'B' }).expect(201);
    const aId = (a.body as DesignBody).id;
    const bId = (b.body as DesignBody).id;
    // Try to reach design B's index.html via a traversal inside A's mount.
    const res = await request.get(`/design-files/${aId}/%2e%2e%2f${bId}%2findex.html`);
    expect([403, 404]).toContain(res.status);
  });
});
