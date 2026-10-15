import '../test/setup.js';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import createDesktopRuntimeRoutes, { type DesktopRuntimeRouteDeps } from './desktop-runtime.js';

function app(deps: DesktopRuntimeRouteDeps) {
  const a = express();
  a.use(createDesktopRuntimeRoutes(deps));
  return a;
}

describe('GET /api/desktop/runtime', () => {
  it('reports the auto-selected firecracker backend', async () => {
    const res = await request(
      app({ configured: () => 'auto', firecrackerRegistered: () => true }),
    ).get('/api/desktop/runtime');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: true,
      configured: 'auto',
      kind: 'firecracker',
      firecrackerRegistered: true,
      screen: { width: 1280, height: 800 },
    });
  });

  it('reports the container placement on the runner fleet', async () => {
    const res = await request(
      app({
        configured: () => 'container',
        firecrackerRegistered: () => false,
        finalizeRunnerBackend: () => 'remote',
      }),
    ).get('/api/desktop/runtime');
    expect(res.body).toMatchObject({ kind: 'container', containerPlacement: 'runner-fleet' });
  });

  it('reports an unavailable explicit firecracker with the reason', async () => {
    const res = await request(
      app({ configured: () => 'firecracker', firecrackerRegistered: () => false }),
    ).get('/api/desktop/runtime');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.kind).toBeNull();
    expect(res.body.reason).toMatch(/not registered/);
  });
});
