/**
 * `POST /api/webhooks` with `autoRegister: true` should skip per-repo
 * webhook registration on GitHub when `config.lanMode` is true. LAN
 * installs (private network, no public URL) cannot receive inbound
 * webhooks — the registration would either fail or, worse, succeed and
 * leave GitHub holding a delivery URL that times out on every event.
 * The reconciliation poller covers the equivalent state transitions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
let projectId: string;
let originalLanMode: boolean;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  const { default: config } = await import('../config.js');
  originalLanMode = (config as { lanMode: boolean }).lanMode;
});

afterAll(async () => {
  const { default: config } = await import('../config.js');
  (config as unknown as { lanMode: boolean }).lanMode = originalLanMode;
});

describe('POST /api/webhooks autoRegister with lanMode=true', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { default: config } = await import('../config.js');
    (config as unknown as { lanMode: boolean }).lanMode = true;
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    const { default: config } = await import('../config.js');
    (config as unknown as { lanMode: boolean }).lanMode = originalLanMode;
  });

  it('returns ok: skipped with reason "lan_mode" and never calls GitHub', async () => {
    fetchSpy.mockImplementation(async (url: unknown) => {
      throw new Error(`unexpected fetch in lan-mode test: ${String(url)}`);
    });

    const res = await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: 'https://github.com/lan-org/some-repo',
        events: { pull_request: { enabled: true } },
        enabled: true,
        autoRegister: true,
      })
      .expect(200);

    expect(res.body.registration).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'lan_mode',
    });
    expect(res.body.registration.message).toMatch(/LAN mode is enabled/i);

    // No fetch should fire — the LAN-mode short-circuit returns before any
    // GitHub call, including the App-installation-token probe.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still creates the webhook_configs row even though no GitHub hook is registered', async () => {
    fetchSpy.mockImplementation(async (url: unknown) => {
      throw new Error(`unexpected fetch in lan-mode test: ${String(url)}`);
    });

    const res = await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: 'https://github.com/lan-org/another-repo',
        events: { pull_request: { enabled: true } },
        enabled: true,
        autoRegister: true,
      })
      .expect(200);

    // Row was created (project_id + repo_url + a generated secret).
    expect(res.body).toMatchObject({
      project_id: projectId,
      repo_url: 'https://github.com/lan-org/another-repo',
    });
    expect(typeof res.body.secret).toBe('string');
    expect((res.body.secret as string).length).toBeGreaterThan(0);
  });
});
