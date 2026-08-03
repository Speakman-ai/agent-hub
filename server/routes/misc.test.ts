import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHealthRoute } from './misc.js';
import { initLogShipperFromEnv, _resetLogShipper } from '../log-shipper.js';
import type { AppConfig, EnrichedAgent, Project } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression tests for the misc route's `serverVersion` resolution.
//
// Background: an earlier revision read `../../package.json` from
// `server/routes/misc.ts`, which resolved to the repo-root package.json in
// dev. In the packaged Electron app, only `server/**/*` is listed in
// `asarUnpack`, so the root package.json lives inside `app.asar` and is
// unreachable from `app.asar.unpacked/server/routes/`. The module therefore
// threw `ENOENT` at import time and the embedded server never bound to its
// port. These tests lock in the fix: the version comes from
// `server/package.json` (always unpacked alongside the server tree).

describe('GET /api/health', () => {
  function buildApp(): ReturnType<typeof express> {
    const app = express();
    app.use(
      createHealthRoute({
        allAgents: () => [{ id: 'a1', name: 'Test Agent' } as EnrichedAgent],
        getProjects: () => [{ id: 'p1', name: 'Test Project' } as Project],
        config: {} as AppConfig,
      }),
    );
    return app;
  }

  it('responds with the version from server/package.json', async () => {
    const app = buildApp();
    const res = await supertest(app).get('/api/health');
    expect(res.status).toBe(200);

    // Load server/package.json from its known on-disk location rather than
    // the route's internal lookup — if the two ever diverge, this test is
    // what catches it.
    const serverPkg = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version: string };

    expect(res.body.version).toBe(serverPkg.version);
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
  });

  it('reports projects and agents counts from deps', async () => {
    const app = buildApp();
    const res = await supertest(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      projects: 1,
      agents: 1,
    });
    expect(typeof res.body.uptime).toBe('number');
  });

  it('exposes gitHash as a string (empty when git metadata is unavailable)', async () => {
    const app = buildApp();
    const res = await supertest(app).get('/api/health');
    expect(res.status).toBe(200);
    // Shape only — the actual value depends on the checkout's git state or
    // the AGENT_HUB_GIT_HASH env. Either a short SHA or '' when neither is
    // available (packaged Electron/asar without .git).
    expect(typeof res.body.gitHash).toBe('string');
    if (res.body.gitHash.length > 0) {
      // Short SHAs are hex and at least 7 chars.
      expect(res.body.gitHash).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  // Regression tests for the self log-shipping status field.
  //
  // Background: the Hub's `agent-hub` log source sat at lastIngestAt=null for
  // two weeks because AHLOG_TOKEN was never set on the deployment. The only
  // signal was one console.warn at boot, which rotates out of the bounded
  // /api/server-logs ring buffer within the hour — so the disabled state was
  // undetectable at runtime. These lock in the at-a-glance check.
  it('reports logShipping.enabled=false when no shipper is active', async () => {
    await _resetLogShipper();
    const app = buildApp();
    const res = await supertest(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.logShipping).toEqual({ enabled: false });
  });

  it('reports logShipping.enabled=true once a shipper is initialized', async () => {
    await _resetLogShipper();
    try {
      const shipper = initLogShipperFromEnv({
        AHLOG_TOKEN: 'ahlog_test_token_value',
        AHLOG_ENDPOINT: 'http://127.0.0.1:3051/api/logs/ingest',
      } as unknown as NodeJS.ProcessEnv);
      expect(shipper).not.toBeNull();

      const res = await supertest(buildApp()).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.logShipping).toEqual({ enabled: true });
    } finally {
      await _resetLogShipper();
    }
  });

  it('never leaks the ingest token or endpoint on the unauthenticated health route', async () => {
    await _resetLogShipper();
    try {
      initLogShipperFromEnv({
        AHLOG_TOKEN: 'ahlog_super_secret_value',
        AHLOG_ENDPOINT: 'http://internal-host.example.internal/api/logs/ingest',
      } as unknown as NodeJS.ProcessEnv);

      const res = await supertest(buildApp()).get('/api/health');
      // /api/health is mounted ahead of authMiddleware (server/index.ts), so the
      // whole payload is world-readable. Assert on the serialized body so a
      // future field added anywhere in the response can't smuggle either value.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('ahlog_super_secret_value');
      expect(body).not.toContain('internal-host.example.internal');
      expect(res.body.logShipping).toEqual({ enabled: true });
    } finally {
      await _resetLogShipper();
    }
  });

  it('reflects authRequired when the config has an apiKey', async () => {
    const app = express();
    app.use(
      createHealthRoute({
        allAgents: () => [],
        getProjects: () => [],
        config: { apiKey: 'secret' } as AppConfig,
      }),
    );
    const res = await supertest(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.authRequired).toBe(true);
  });
});
