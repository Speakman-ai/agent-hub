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
  agent_model?: string | null;
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

  it('PATCH /api/designs/:id sets agent_model to a valid Claude Code model', async () => {
    const mc = await request.get('/api/config/models').expect(200);
    const allowed = (mc.body as { engineValidModels?: Record<string, string[]> })
      .engineValidModels?.['claude-code'];
    const pick = Array.isArray(allowed) && allowed.length > 0 ? allowed[0] : 'claude-opus-4-7';

    const created = await request.post('/api/designs').send({ name: 'Model test' }).expect(201);
    const id = (created.body as DesignBody).id;

    const res = await request.patch(`/api/designs/${id}`).send({ agentModel: pick }).expect(200);
    const body = res.body as DesignBody;
    expect(body.agent_model).toBe(pick);

    const cleared = await request
      .patch(`/api/designs/${id}`)
      .send({ agentModel: null })
      .expect(200);
    expect((cleared.body as DesignBody).agent_model).toBeNull();
  });

  it('PATCH /api/designs/:id rejects agentModel not valid for Claude Code', async () => {
    const created = await request.post('/api/designs').send({ name: 'Bad model' }).expect(201);
    const id = (created.body as DesignBody).id;
    await request
      .patch(`/api/designs/${id}`)
      .send({ agentModel: 'definitely-not-a-real-model-id' })
      .expect(400);
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

describe('Designs API — files listing (agent read-access)', () => {
  it('GET /api/designs/:id/files returns just the seed index.html on a fresh design', async () => {
    const created = await request.post('/api/designs').send({ name: 'Fresh' }).expect(201);
    const id = (created.body as DesignBody).id;

    const res = await request.get(`/api/designs/${id}/files`).expect(200);
    const body = res.body as {
      designId: string;
      files: Array<{ path: string; size: number; mtime: string }>;
    };
    expect(body.designId).toBe(id);
    expect(body.files.map((f) => f.path)).toEqual(['index.html']);
    const seed = body.files[0];
    expect(seed!.size).toBeGreaterThan(0);
    expect(typeof seed!.mtime).toBe('string');
    // mtime should be parseable as a real date
    expect(Number.isNaN(Date.parse(seed!.mtime))).toBe(false);
  });

  it('GET /api/designs/:id/files recurses into subdirectories and reports size/mtime', async () => {
    const created = await request.post('/api/designs').send({ name: 'Tree' }).expect(201);
    const id = (created.body as DesignBody).id;

    // Drop a few fake artifacts into the on-disk dir (same as what a Design
    // Studio turn would do via the CLI). We go through the store to avoid
    // hard-coding the dataDir in the test.
    const { mkdirSync, writeFileSync } = await import('fs');
    const path = await import('path');
    const { designDir } = await import('../designs-store.js');
    // Resolve the designs root by inspecting a known location: the store's
    // public path helper requires the root, so pull it from the same module
    // the routes use. The static mount test above proves the directory
    // exists at `<dataDir>/designs/<id>`; we re-derive it from the server
    // by asking for the project config endpoint's data dir indirectly via
    // an env-agnostic approach — write alongside `index.html`, located by
    // walking up from the known seed.
    //
    // Simplest: the test setup pins AGENT_HUB_DATA_DIR, so construct the
    // path the same way index.ts does.
    const dataDir = process.env.AGENT_HUB_DATA_DIR as string;
    expect(dataDir).toBeTruthy();
    const root = designDir(path.join(dataDir, 'designs'), id);

    writeFileSync(path.join(root, 'styles.css'), 'body { color: red; }', 'utf-8');
    writeFileSync(path.join(root, 'app.js'), 'console.log("hi");', 'utf-8');
    mkdirSync(path.join(root, 'assets'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'hero.png'), Buffer.from([137, 80, 78, 71]));

    const res = await request.get(`/api/designs/${id}/files`).expect(200);
    const body = res.body as {
      designId: string;
      files: Array<{ path: string; size: number; mtime: string }>;
    };
    const paths = body.files.map((f) => f.path).sort();
    expect(paths).toEqual(['app.js', 'assets/hero.png', 'index.html', 'styles.css']);

    const hero = body.files.find((f) => f.path === 'assets/hero.png');
    expect(hero?.size).toBe(4);
  });

  it('GET /api/designs/:id/files returns 404 for unknown designs', async () => {
    await request.get('/api/designs/nonexistent-id/files').expect(404);
  });

  it('GET /api/designs/:id/files is org-scoped', async () => {
    const created = await request.post('/api/designs').send({ name: 'Org-B' }).expect(201);
    const id = (created.body as DesignBody).id;

    const { getDb } = await import('../db.js');
    getDb().prepare("UPDATE designs SET org_id = 'other-org' WHERE id = ?").run(id);

    await request.get(`/api/designs/${id}/files`).expect(404);
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
