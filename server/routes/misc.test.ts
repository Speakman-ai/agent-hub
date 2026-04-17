import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHealthRoute } from './misc.js';
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
