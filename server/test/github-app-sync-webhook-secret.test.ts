/**
 * POST /api/github-app/sync-webhook-secret — operator-facing button that
 * pushes our locally-stored App webhook secret to GitHub via
 * PATCH /app/hook/config and persists the (possibly-new) secret to
 * config.json.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type supertest from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { getRequest } from './helpers.js';

const { privateKey: appPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let request: supertest.Agent;
let tempDataDir: string;
let originalDataDir: string;
let originalGithubApp: unknown;

beforeAll(async () => {
  request = await getRequest();
  const { default: config } = await import('../config.js');
  originalDataDir = config.dataDir;
  originalGithubApp = (config as { githubApp: unknown }).githubApp;
});

afterAll(async () => {
  const { default: config } = await import('../config.js');
  (config as { dataDir: string }).dataDir = originalDataDir;
  (config as unknown as { githubApp: unknown }).githubApp = originalGithubApp;
});

describe('POST /api/github-app/sync-webhook-secret', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    tempDataDir = mkdtempSync(join(tmpdir(), 'agent-hub-sync-secret-'));
    writeFileSync(join(tempDataDir, 'config.json'), JSON.stringify({ githubApp: {} }), 'utf-8');

    const { default: config } = await import('../config.js');
    (config as { dataDir: string }).dataDir = tempDataDir;
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = originalGithubApp;
    (config as { dataDir: string }).dataDir = originalDataDir;
  });

  it('returns 400 when no GitHub App is configured', async () => {
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = null;

    const res = await request.post('/api/github-app/sync-webhook-secret').send({}).expect(400);
    expect(res.body.error).toMatch(/No GitHub App configured/);
  });

  it('pushes the local secret to GitHub and persists when one exists', async () => {
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = {
      appId: '7777',
      privateKey: appPrivateKey,
      webhookSecret: 'preserved-local-secret-123',
    };

    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));

    const res = await request.post('/api/github-app/sync-webhook-secret').send({}).expect(200);

    expect(res.body).toMatchObject({
      ok: true,
      generated: false,
      secretLength: 'preserved-local-secret-123'.length,
      secretPrefix: 'pres',
    });

    // PATCH was made with the existing secret (not a freshly generated one)
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/app/hook/config');
    expect((opts as RequestInit).method).toBe('PATCH');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toEqual({ secret: 'preserved-local-secret-123' });

    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(join(tempDataDir, 'config.json'), 'utf-8'));
    expect(onDisk.githubApp.webhookSecret).toBe('preserved-local-secret-123');
  });

  it('generates a fresh secret when none is stored locally', async () => {
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = {
      appId: '7777',
      privateKey: appPrivateKey,
      // no webhookSecret
    };

    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));

    const res = await request.post('/api/github-app/sync-webhook-secret').send({}).expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.generated).toBe(true);
    expect(res.body.secretLength).toBe(64); // 32 bytes hex = 64 chars

    // The runtime config + on-disk file both got the new secret
    const onDisk = JSON.parse(readFileSync(join(tempDataDir, 'config.json'), 'utf-8'));
    expect(typeof onDisk.githubApp.webhookSecret).toBe('string');
    expect(onDisk.githubApp.webhookSecret).toHaveLength(64);

    // PATCH body matches what was generated
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.secret).toBe(onDisk.githubApp.webhookSecret);
  });

  it('rotates on explicit { rotate: true } even when a secret exists', async () => {
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = {
      appId: '7777',
      privateKey: appPrivateKey,
      webhookSecret: 'old-secret',
    };

    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));

    const res = await request
      .post('/api/github-app/sync-webhook-secret')
      .send({ rotate: true })
      .expect(200);

    expect(res.body.generated).toBe(true);
    expect(res.body.secretLength).toBe(64);

    const onDisk = JSON.parse(readFileSync(join(tempDataDir, 'config.json'), 'utf-8'));
    expect(onDisk.githubApp.webhookSecret).not.toBe('old-secret');
    expect(onDisk.githubApp.webhookSecret).toHaveLength(64);
  });

  it('rolls back in-memory and returns 500 githubMutated when disk persist fails after GitHub accepts', async () => {
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = {
      appId: '7777',
      privateKey: appPrivateKey,
      webhookSecret: 'previous-on-disk-secret',
    };

    // Point dataDir at a non-existent directory so writeFileSync ENOENTs.
    // The readFileSync that loads the existing file is already wrapped in
    // its own try/catch (no-op if missing); the writeFileSync is the one
    // that must trip the new outer guard.
    const missingDir = join(tempDataDir, 'does-not-exist');
    (config as { dataDir: string }).dataDir = missingDir;

    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));

    const res = await request
      .post('/api/github-app/sync-webhook-secret')
      .send({ rotate: true })
      .expect(500);

    expect(res.body).toMatchObject({
      githubMutated: true,
      error: expect.stringMatching(/Pushed to GitHub but failed to persist locally/),
    });
    expect(typeof res.body.cause).toBe('string');

    // The PATCH was made (GitHub got the new secret)…
    expect(fetchSpy.mock.calls).toHaveLength(1);
    const patchedBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(typeof patchedBody.secret).toBe('string');
    expect(patchedBody.secret).toHaveLength(64); // rotated → 32-byte hex
    expect(patchedBody.secret).not.toBe('previous-on-disk-secret');

    // …but in-memory rolled back to the previous value so we don't lie
    // about what's on disk. Restart would have re-read the prior file.
    expect(
      (config as unknown as { githubApp: { webhookSecret: string } }).githubApp.webhookSecret,
    ).toBe('previous-on-disk-secret');
  });

  it('returns 502 and does NOT persist when GitHub rejects the PATCH', async () => {
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = {
      appId: '7777',
      privateKey: appPrivateKey,
      webhookSecret: 'unchanged-local-secret',
    };

    fetchSpy.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const res = await request.post('/api/github-app/sync-webhook-secret').send({}).expect(502);
    expect(res.body.error).toMatch(/Failed to push webhook secret to GitHub/);

    // Disk untouched (still the empty seed from beforeEach)
    if (existsSync(join(tempDataDir, 'config.json'))) {
      const onDisk = JSON.parse(readFileSync(join(tempDataDir, 'config.json'), 'utf-8'));
      // The original disk seed had `githubApp: {}` (no webhookSecret).
      // After a 502 we should NOT have written 'unchanged-local-secret'.
      expect(onDisk.githubApp?.webhookSecret).toBeUndefined();
    }
  });
});
