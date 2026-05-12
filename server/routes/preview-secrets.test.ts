/**
 * Integration tests for the worktree-preview secrets REST surface.
 *
 *   GET    /api/projects/:id/preview/secrets         (Admin+)
 *   PUT    /api/projects/:id/preview/secrets         (Owner)
 *   POST   /api/projects/:id/preview/secrets/import  (Owner)
 *
 * Drives the real Express app via supertest. Default test caller resolves
 * to Owner (apiKey + JWT are both unset → auth middleware seeds Owner),
 * so the routes' requireRole gates are open here. The Admin-vs-Owner
 * cliff is tested by the dedicated `roles.test.ts` suite — we focus on
 * route behaviour: 404, validation, mask-on-GET, .env parser.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { MASK } from '../secret-crypto.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `preview-secrets-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

describe('GET /api/projects/:id/preview/secrets', () => {
  it('returns 404 when the project does not exist', async () => {
    const res = await request.get('/api/projects/does-not-exist/preview/secrets').expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns an empty list for a project with no secrets', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    expect(res.body).toEqual({ secrets: [] });
  });

  it('masks secret-kind values and returns plain-kind values in clear', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({
        secrets: [
          { key: 'STRIPE_KEY', value: 'sk_live_REAL', kind: 'secret' },
          { key: 'FEATURE_X', value: 'on', kind: 'plain' },
        ],
      })
      .expect(200);

    const res = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    const map = Object.fromEntries(
      (res.body.secrets as Array<{ key: string; value: string; kind: string }>).map((r) => [
        r.key,
        { value: r.value, kind: r.kind },
      ]),
    );
    expect(map.STRIPE_KEY).toEqual({ value: MASK, kind: 'secret' });
    expect(map.FEATURE_X).toEqual({ value: 'on', kind: 'plain' });
    // No path in the GET response may leak the real secret value.
    expect(JSON.stringify(res.body)).not.toContain('sk_live_REAL');
  });
});

describe('PUT /api/projects/:id/preview/secrets', () => {
  it('returns 404 for an unknown project', async () => {
    const res = await request
      .put('/api/projects/does-not-exist/preview/secrets')
      .send({ secrets: [] })
      .expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('400s when `secrets` is missing or not an array', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/array/);
  });

  it('400s on a reserved AGENT_HUB_* key', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({
        secrets: [{ key: 'AGENT_HUB_URL', value: 'http://evil', kind: 'plain' }],
      })
      .expect(400);
    expect(res.body.error).toMatch(/reserved/i);
  });

  it('400s on a reserved NODE_* / PATH / HOME key', async () => {
    const projectId = await freshProject();
    for (const key of ['NODE_ENV', 'PATH', 'HOME']) {
      const res = await request
        .put(`/api/projects/${projectId}/preview/secrets`)
        .send({ secrets: [{ key, value: 'x', kind: 'plain' }] })
        .expect(400);
      expect(res.body.error).toMatch(/reserved/i);
    }
  });

  it('replaces the project secret set atomically (bulk replace)', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({
        secrets: [
          { key: 'KEEP', value: '1', kind: 'plain' },
          { key: 'DROP', value: '2', kind: 'plain' },
        ],
      })
      .expect(200);
    await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({ secrets: [{ key: 'NEW', value: '3', kind: 'plain' }] })
      .expect(200);

    const res = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    expect((res.body.secrets as Array<{ key: string }>).map((r) => r.key)).toEqual(['NEW']);
  });

  it('400s on invalid `kind` value', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({
        secrets: [{ key: 'X', value: 'y', kind: 'bogus' }],
      })
      .expect(400);
    expect(res.body.error).toMatch(/kind/);
  });
});

describe('POST /api/projects/:id/preview/secrets/import', () => {
  it('returns 404 for unknown project', async () => {
    await request
      .post('/api/projects/does-not-exist/preview/secrets/import')
      .send({ env: 'FOO=bar' })
      .expect(404);
  });

  it('400s when `env` is missing or not a string', async () => {
    const projectId = await freshProject();
    await request.post(`/api/projects/${projectId}/preview/secrets/import`).send({}).expect(400);
    await request
      .post(`/api/projects/${projectId}/preview/secrets/import`)
      .send({ env: 123 })
      .expect(400);
  });

  it('parses .env (export, quotes, comments, dupes) and persists as secret-kind', async () => {
    const projectId = await freshProject();
    const blob = [
      '# comment',
      '',
      'export FOO=bar',
      'BAZ="quoted value"',
      "QUX='single'",
      'FOO=overwritten', // duplicate: last wins
      'CONFIG_FLAG=on',
    ].join('\n');

    const post = await request
      .post(`/api/projects/${projectId}/preview/secrets/import`)
      .send({ env: blob })
      .expect(200);
    expect(post.body.imported).toBe(4); // FOO, BAZ, QUX, CONFIG_FLAG
    expect(post.body.mode).toBe('replace');

    const list = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    const rows = list.body.secrets as Array<{ key: string; value: string; kind: string }>;
    expect(rows.map((r) => r.key).sort()).toEqual(['BAZ', 'CONFIG_FLAG', 'FOO', 'QUX']);
    // All imported as secret-kind by default → masked on GET.
    for (const r of rows) {
      expect(r.kind).toBe('secret');
      expect(r.value).toBe(MASK);
    }
  });

  it('honors defaultKind=plain (imported config returned in clear)', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/preview/secrets/import`)
      .send({ env: 'FEATURE_X=on\nFEATURE_Y=off', defaultKind: 'plain' })
      .expect(200);
    const list = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    const rows = list.body.secrets as Array<{ key: string; value: string; kind: string }>;
    // defaultKind=plain → parser now emits kind:undefined → route applies
    // defaultKind → entries stored as plain-kind, returned in clear.
    for (const r of rows) {
      expect(r.kind).toBe('plain');
      expect(r.value).not.toBe(MASK);
    }
    expect(rows.find((r) => r.key === 'FEATURE_X')?.value).toBe('on');
    expect(rows.find((r) => r.key === 'FEATURE_Y')?.value).toBe('off');
  });

  it('replaces existing on `mode: replace` (default)', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({ secrets: [{ key: 'OLD', value: '1', kind: 'plain' }] })
      .expect(200);
    await request
      .post(`/api/projects/${projectId}/preview/secrets/import`)
      .send({ env: 'NEW=2' })
      .expect(200);
    const list = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    expect((list.body.secrets as Array<{ key: string }>).map((r) => r.key)).toEqual(['NEW']);
  });

  it('overlays parsed entries on `mode: merge` (existing plain rows preserved)', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({
        secrets: [
          { key: 'PLAIN_KEEP', value: 'keepme', kind: 'plain' },
          { key: 'FOO', value: 'old', kind: 'plain' }, // will be overwritten by merge
        ],
      })
      .expect(200);

    await request
      .post(`/api/projects/${projectId}/preview/secrets/import`)
      .send({ env: 'FOO=new\nNEWKEY=xyz', mode: 'merge' })
      .expect(200);

    const list = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    const map = Object.fromEntries(
      (list.body.secrets as Array<{ key: string; value: string; kind: string }>).map((r) => [
        r.key,
        r,
      ]),
    );
    // Pre-existing plain row preserved verbatim.
    expect(map.PLAIN_KEEP).toMatchObject({ value: 'keepme', kind: 'plain' });
    // Parsed entries land as secret-kind (masked on GET), overwriting FOO.
    expect(map.FOO).toMatchObject({ value: MASK, kind: 'secret' });
    expect(map.NEWKEY).toMatchObject({ value: MASK, kind: 'secret' });
  });

  it('merge preserves existing secret-kind rows not in the import blob', async () => {
    // Regression for the silent-delete bug: secret-kind rows absent from the
    // imported blob must survive a merge (previously they were silently dropped
    // because list() returns MASK for them and we can't re-encrypt MASK).
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/preview/secrets`)
      .send({
        secrets: [
          { key: 'STRIPE_KEY', value: 'sk_live_REAL', kind: 'secret' },
          { key: 'DATABASE_URL', value: 'postgres://prod/db', kind: 'secret' },
          { key: 'FEATURE_X', value: 'on', kind: 'plain' },
        ],
      })
      .expect(200);

    // Import only adds NEW_FLAG — STRIPE_KEY and DATABASE_URL are absent.
    await request
      .post(`/api/projects/${projectId}/preview/secrets/import`)
      .send({ env: 'NEW_FLAG=1', mode: 'merge' })
      .expect(200);

    const list = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    const map = Object.fromEntries(
      (list.body.secrets as Array<{ key: string; value: string; kind: string }>).map((r) => [
        r.key,
        r,
      ]),
    );
    // Secret-kind rows absent from the import must survive.
    expect(map.STRIPE_KEY).toMatchObject({ kind: 'secret', value: MASK });
    expect(map.DATABASE_URL).toMatchObject({ kind: 'secret', value: MASK });
    // Plain-kind row also survives.
    expect(map.FEATURE_X).toMatchObject({ kind: 'plain', value: 'on' });
    // The imported row lands.
    expect(map.NEW_FLAG).toMatchObject({ kind: 'secret', value: MASK });
    // No leaked real values.
    expect(JSON.stringify(list.body)).not.toContain('sk_live_REAL');
    expect(JSON.stringify(list.body)).not.toContain('postgres://prod/db');
  });

  it('rejects an .env that contains a reserved key', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/preview/secrets/import`)
      .send({ env: 'GOOD=ok\nAGENT_HUB_URL=evil\n' })
      .expect(400);
    expect(res.body.error).toMatch(/reserved/i);
    // And nothing landed — validation runs before write.
    const list = await request.get(`/api/projects/${projectId}/preview/secrets`).expect(200);
    expect(list.body.secrets).toHaveLength(0);
  });
});
