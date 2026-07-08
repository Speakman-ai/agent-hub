import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { createProjectVisibilityGate } from '../project-visibility-middleware.js';
import createRumSessionsRoutes from './rum-sessions.js';
import type { Project, RouteDeps } from '../types.js';
import { getDb } from '../db.js';

// GET /api/projects/:projectId/rum/sessions returns user PII (usrEmail/usrName).
// The handler itself only does findProject → 404 and never checks membership —
// tenant isolation is enforced by the shared project-visibility gate mounted
// ahead of every /api/projects/:projectId sub-router in index.ts. This test
// pins that contract: it wires the REAL gate ahead of the REAL router (the same
// order index.ts uses) and proves a non-viewer is masked with no PII leak, while
// the project owner is let through. A future refactor that drops the route from
// under the gate fails here.

const PRIVATE_PROJECT: Project = {
  id: 'rum-vis-proj',
  name: 'Private RUM Project',
  cwd: '/tmp/rum-vis',
  ahw: '/tmp/rum-vis-ahw',
  agents: [],
  visibility: 'private',
  ownerUserId: 'owner-1',
} as Project;

const findProject = (id: string): Project | null =>
  id === PRIVATE_PROJECT.id ? PRIVATE_PROJECT : null;

/** A minimal app mounting the real gate + real router, with a fake auth
 *  middleware that stamps the caller from headers. A real authUserId keeps
 *  `noAuthConfigured` false so the gate does NOT collapse into the Owner bypass. */
function buildApp(): supertest.Agent {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).authUserId = req.header('x-test-user') || undefined;
    (req as any).authRole = req.header('x-test-role') || 'User';
    next();
  });
  app.use('/api/projects/:projectId', createProjectVisibilityGate({ findProject }));
  app.use(createRumSessionsRoutes({ findProject } as unknown as RouteDeps));
  return supertest(app);
}

describe('rum-sessions visibility gate (PII protection)', () => {
  it('masks the session list as 404 for a caller who cannot view the private project', async () => {
    const res = await buildApp()
      .get(`/api/projects/${PRIVATE_PROJECT.id}/rum/sessions`)
      .set('x-test-user', 'intruder')
      .set('x-test-role', 'User')
      .expect(404);
    // Only the masked not-found envelope — no session/PII payload leaks.
    expect(res.body).toEqual({ error: 'Project not found' });
    expect(res.body.sessions).toBeUndefined();
  });

  it('lets the project owner through to the (PII-bearing) session list', async () => {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO rum_sessions
           (session_id, project_id, started_at, usr_email)
         VALUES (?,?,?,?)`,
      )
      .run('rum-vis-sess', PRIVATE_PROJECT.id, 1000, 'pii@example.com');

    const res = await buildApp()
      .get(`/api/projects/${PRIVATE_PROJECT.id}/rum/sessions`)
      .set('x-test-user', 'owner-1')
      .set('x-test-role', 'User')
      .expect(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.some((s: any) => s.usrEmail === 'pii@example.com')).toBe(true);
  });
});
