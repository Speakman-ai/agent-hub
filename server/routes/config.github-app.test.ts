import { vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import type TestAgent from 'supertest/lib/agent.js';
import type { GitHubAppConfig } from '../types.js';

// In-memory config.json so the route's read/merge/write cycle is observable
// without touching the real filesystem. `fsState.json` is both the seed the
// GET/PUT read and the sink writeFileSync persists to, so a PUT is visible to a
// following GET exactly as on disk. `fsState.lastWriteOpts` / `chmodCalls`
// capture the secure-write hardening (mode 0o600 + chmod) for assertions.
const fsState = vi.hoisted(() => ({
  json: '{}',
  lastWriteOpts: undefined as unknown,
  chmodCalls: [] as number[],
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn((p: string, data: string, opts?: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        fsState.json = String(data);
        fsState.lastWriteOpts = opts;
      }
    }),
    readFileSync: vi.fn((p: string, enc?: BufferEncoding) => {
      if (typeof p === 'string' && p.endsWith('config.json')) return fsState.json;
      return actual.readFileSync(p, enc);
    }),
    chmodSync: vi.fn((p: string, mode: number) => {
      if (typeof p === 'string' && p.endsWith('config.json')) fsState.chmodCalls.push(mode);
    }),
  };
});

import { getRequest } from '../test/helpers.js';
import config from '../config.js';

let request: TestAgent;
let originalGithubApp: GitHubAppConfig | null;
let originalApiKey: string | null;

// A REAL RSA private key so the route's parse-validation accepts it; the
// matching public key drives the "reject a pasted public key" case.
const { privateKey: PEM, publicKey: PUBLIC_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

beforeAll(async () => {
  request = await getRequest();
  originalGithubApp = config.githubApp;
  originalApiKey = config.apiKey;
  // No apiKey + no auth record → authMiddleware treats requests as Owner, which
  // satisfies requireRole('Admin') on these routes.
  config.apiKey = null;
});

afterAll(() => {
  config.githubApp = originalGithubApp;
  config.apiKey = originalApiKey;
});

beforeEach(() => {
  fsState.json = '{}';
  fsState.lastWriteOpts = undefined;
  fsState.chmodCalls = [];
  config.githubApp = null;
});

function seed(githubApp: Record<string, unknown>) {
  fsState.json = JSON.stringify({ githubApp });
}

describe('GET /api/config/github-app', () => {
  it('reports unconfigured when no githubApp block exists', async () => {
    const res = await request.get('/api/config/github-app').expect(200);
    expect(res.body).toEqual({
      configured: false,
      appId: null,
      installationId: null,
      installations: [],
      hasPrivateKey: false,
    });
  });

  it('reports configured and exposes appId but NEVER the private key', async () => {
    seed({
      appId: 123456,
      privateKey: PEM,
      installationId: 987,
      installations: [{ account: 'acme', id: 987 }],
    });
    const res = await request.get('/api/config/github-app').expect(200);
    expect(res.body).toMatchObject({
      configured: true,
      appId: 123456,
      installationId: 987,
      installations: [{ account: 'acme', id: 987 }],
      hasPrivateKey: true,
    });
    // The write-only key must never cross the read surface.
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    expect(res.body).not.toHaveProperty('privateKey');
  });

  it('reports partial config (appId, no key) as not configured but shows the appId', async () => {
    seed({ appId: 42 });
    const res = await request.get('/api/config/github-app').expect(200);
    expect(res.body).toMatchObject({ configured: false, appId: 42, hasPrivateKey: false });
  });
});

describe('PUT /api/config/github-app', () => {
  it('rejects a missing appId', async () => {
    const res = await request.put('/api/config/github-app').send({ privateKey: PEM }).expect(400);
    expect(res.body.error).toMatch(/appId/);
  });

  it('rejects first-time config without a private key', async () => {
    const res = await request.put('/api/config/github-app').send({ appId: '1' }).expect(400);
    expect(res.body.error).toMatch(/privateKey/);
  });

  it('rejects a non-numeric appId (typo like "abc")', async () => {
    const res = await request
      .put('/api/config/github-app')
      .send({ appId: 'abc', privateKey: PEM })
      .expect(400);
    expect(res.body.error).toMatch(/numeric GitHub App id/i);
    expect(config.githubApp).toBeNull();
    expect(JSON.parse(fsState.json).githubApp).toBeUndefined();
  });

  it('rejects a partially-numeric / decorated appId string', async () => {
    for (const bad of ['12.5', '12 3', 'App-123', '0x1F', ' 12a ']) {
      const res = await request
        .put('/api/config/github-app')
        .send({ appId: bad, privateKey: PEM })
        .expect(400);
      expect(res.body.error).toMatch(/numeric GitHub App id/i);
    }
    expect(config.githubApp).toBeNull();
  });

  it('rejects an all-zero appId — a GitHub App id is a positive integer', async () => {
    for (const zero of ['0', '00', '000']) {
      const res = await request
        .put('/api/config/github-app')
        .send({ appId: zero, privateKey: PEM })
        .expect(400);
      expect(res.body.error).toMatch(/numeric GitHub App id/i);
    }
    // The number branch already rejects 0.
    const numRes = await request
      .put('/api/config/github-app')
      .send({ appId: 0, privateKey: PEM })
      .expect(400);
    expect(numRes.body.error).toMatch(/numeric GitHub App id/i);
    expect(config.githubApp).toBeNull();
    expect(JSON.parse(fsState.json).githubApp).toBeUndefined();
  });

  it('rejects a non-integer numeric appId', async () => {
    const res = await request
      .put('/api/config/github-app')
      .send({ appId: 12.5, privateKey: PEM })
      .expect(400);
    expect(res.body.error).toMatch(/numeric GitHub App id/i);
  });

  it('accepts a numeric string appId and trims surrounding whitespace', async () => {
    await request
      .put('/api/config/github-app')
      .send({ appId: '  123456  ', privateKey: PEM })
      .expect(200);
    expect(JSON.parse(fsState.json).githubApp.appId).toBe('123456');
  });

  it('rejects a privateKey that is not a valid PEM private key', async () => {
    const res = await request
      .put('/api/config/github-app')
      .send({
        appId: '1',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----',
      })
      .expect(400);
    expect(res.body.error).toMatch(/valid PEM private key/i);
    // Nothing was persisted.
    expect(config.githubApp).toBeNull();
    expect(JSON.parse(fsState.json).githubApp).toBeUndefined();
  });

  it('rejects a pasted PUBLIC key (parses, but is not a private key)', async () => {
    const res = await request
      .put('/api/config/github-app')
      .send({ appId: '1', privateKey: PUBLIC_PEM })
      .expect(400);
    expect(res.body.error).toMatch(/valid PEM private key/i);
    expect(config.githubApp).toBeNull();
  });

  it('rejects an edit that would preserve an invalid stored key', async () => {
    seed({ appId: '1', privateKey: 'garbage-not-a-key', installationId: '10' });
    const res = await request.put('/api/config/github-app').send({ appId: '2' }).expect(400);
    expect(res.body.error).toMatch(/stored private key/i);
  });

  it('rejects installations that lack an id', async () => {
    const res = await request
      .put('/api/config/github-app')
      .send({ appId: '1', privateKey: PEM, installations: [{ account: 'acme' }] })
      .expect(400);
    expect(res.body.error).toMatch(/installation/i);
  });

  it('rejects a non-positive-integer installationId', async () => {
    for (const bad of ['0', '00', 'abc', '12.5', '12 3', -5, 1.5, 0]) {
      const res = await request
        .put('/api/config/github-app')
        .send({ appId: '1', privateKey: PEM, installationId: bad })
        .expect(400);
      expect(res.body.error).toMatch(/installationId must be a positive integer/i);
    }
    expect(config.githubApp).toBeNull();
  });

  it('rejects a non-positive-integer installation id', async () => {
    for (const bad of ['0', 'abc', -1, 2.5]) {
      const res = await request
        .put('/api/config/github-app')
        .send({ appId: '1', privateKey: PEM, installations: [{ account: 'acme', id: bad }] })
        .expect(400);
      expect(res.body.error).toMatch(/positive integer id/i);
    }
    expect(config.githubApp).toBeNull();
  });

  it('accepts valid positive-integer installationId and installations', async () => {
    await request
      .put('/api/config/github-app')
      .send({
        appId: '55',
        privateKey: PEM,
        installationId: '900',
        installations: [{ account: 'acme', id: '42' }],
      })
      .expect(200);
    const persisted = JSON.parse(fsState.json).githubApp;
    expect(persisted.installationId).toBe('900');
    expect(persisted.installations).toEqual([{ account: 'acme', id: '42' }]);
  });

  it('saves a new App, persists the key with 0o600 perms, and resolves config.githubApp', async () => {
    const res = await request
      .put('/api/config/github-app')
      .send({ appId: '55', privateKey: PEM, installationId: '900' })
      .expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      configured: true,
      appId: '55',
      installationId: '900',
      hasPrivateKey: true,
    });
    // Response never leaks the key…
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    // …but it IS persisted and loaded into the live config. resolveGithubAppConfig
    // trims the stored key, while the persisted file keeps the raw PEM.
    expect(config.githubApp).toMatchObject({
      appId: '55',
      privateKey: PEM.trim(),
      installationId: '900',
    });
    const persisted = JSON.parse(fsState.json).githubApp;
    expect(persisted.privateKey).toBe(PEM);
    // Secret-bearing write is hardened to owner-only.
    expect(fsState.lastWriteOpts).toMatchObject({ mode: 0o600 });
    expect(fsState.chmodCalls).toContain(0o600);
  });

  it('preserves the stored key when a PUT omits privateKey (edit id/installations)', async () => {
    seed({ appId: '1', privateKey: PEM, installationId: '10' });
    await request
      .put('/api/config/github-app')
      .send({ appId: '2', installationId: '20' })
      .expect(200);
    const persisted = JSON.parse(fsState.json).githubApp;
    expect(persisted.appId).toBe('2');
    expect(persisted.installationId).toBe('20');
    expect(persisted.privateKey).toBe(PEM); // untouched
    expect(config.githubApp?.privateKey).toBe(PEM.trim());
  });

  it('preserves legacy clientId/clientSecret in the same block across writes', async () => {
    seed({ clientId: 'legacy-id', clientSecret: 'legacy-secret', privateKey: PEM });
    await request.put('/api/config/github-app').send({ appId: '7' }).expect(200);
    const persisted = JSON.parse(fsState.json).githubApp;
    expect(persisted.clientId).toBe('legacy-id');
    expect(persisted.clientSecret).toBe('legacy-secret');
    expect(persisted.appId).toBe('7');
  });

  it('clears installationId/installations when omitted (replace semantics)', async () => {
    seed({ appId: '1', privateKey: PEM, installationId: '10', installations: [{ id: '10' }] });
    await request.put('/api/config/github-app').send({ appId: '1' }).expect(200);
    const persisted = JSON.parse(fsState.json).githubApp;
    expect(persisted.installationId).toBeUndefined();
    expect(persisted.installations).toBeUndefined();
  });
});

describe('DELETE /api/config/github-app', () => {
  it('removes App fields but preserves legacy clientId/clientSecret', async () => {
    seed({
      appId: '1',
      privateKey: PEM,
      installationId: '10',
      clientId: 'legacy-id',
      clientSecret: 'legacy-secret',
    });
    const res = await request.delete('/api/config/github-app').expect(200);
    expect(res.body).toEqual({ ok: true });
    const persisted = JSON.parse(fsState.json).githubApp;
    expect(persisted).toEqual({ clientId: 'legacy-id', clientSecret: 'legacy-secret' });
    expect(config.githubApp).toBeNull();
    // The rewritten config is still hardened.
    expect(fsState.chmodCalls).toContain(0o600);
  });

  it('drops the whole githubApp block when only App fields existed', async () => {
    seed({ appId: '1', privateKey: PEM });
    await request.delete('/api/config/github-app').expect(200);
    expect(JSON.parse(fsState.json).githubApp).toBeUndefined();
    expect(config.githubApp).toBeNull();
  });

  it('is a no-op when nothing is configured', async () => {
    const res = await request.delete('/api/config/github-app').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(config.githubApp).toBeNull();
  });
});
