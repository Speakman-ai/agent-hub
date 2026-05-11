import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// POST /api/projects/:projectId/preview/detect
//
// The Preview settings panel (`Settings → Preview`) wires a
// "Re-detect from repo" button to this endpoint. It re-runs
// `detectPreviewDefaults(project.cwd)` and returns the suggested
// `prEnv.preview` defaults so the user can accept-overwrite or
// dismiss. The endpoint is a pure read — `projects.json` is not
// mutated; the client follows up with PATCH if the user accepts.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let scratchRoot: string;

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(() => {
  scratchRoot = mkdtempSync(path.join(tmpdir(), 'preview-detect-'));
});

afterEach(() => {
  if (scratchRoot) {
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function writePkg(dir: string, pkg: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

describe('POST /api/projects/:projectId/preview/detect', () => {
  it('returns vite defaults when the workspace package.json depends on vite', async () => {
    writePkg(scratchRoot, { dependencies: { vite: '^5.0.0' } });
    const project = await createProject({ cwd: scratchRoot });
    const projectId = project.id as string;

    const res = await request
      .post(`/api/projects/${projectId}/preview/detect`)
      .send({})
      .expect(200);
    const body = res.body as {
      detected: {
        stack: string;
        startScript: string;
        port: number;
        captureRoutes: string[];
        idleTTL: number;
      } | null;
    };
    expect(body.detected).toEqual({
      stack: 'vite',
      startScript: 'npm run dev',
      port: 5173,
      captureRoutes: ['/'],
      idleTTL: 600,
    });
  });

  it('returns null detected when the workspace stack is unknown', async () => {
    writePkg(scratchRoot, { dependencies: { lodash: '^4.0.0' } });
    const project = await createProject({ cwd: scratchRoot });
    const projectId = project.id as string;

    const res = await request
      .post(`/api/projects/${projectId}/preview/detect`)
      .send({})
      .expect(200);
    const body = res.body as { detected: unknown };
    expect(body.detected).toBeNull();
  });

  it('returns null detected when the project cwd does not exist on disk', async () => {
    const project = await createProject({ cwd: path.join(scratchRoot, 'does-not-exist') });
    const projectId = project.id as string;

    const res = await request
      .post(`/api/projects/${projectId}/preview/detect`)
      .send({})
      .expect(200);
    const body = res.body as { detected: unknown };
    expect(body.detected).toBeNull();
  });

  it('returns 404 for an unknown project id', async () => {
    await request.post('/api/projects/no-such-project/preview/detect').send({}).expect(404);
  });

  it('does not mutate project.prEnv when called', async () => {
    // Pre-existing prEnv block must survive the read-only detect call.
    writePkg(scratchRoot, { dependencies: { vite: '^5.0.0' } });
    const project = await createProject({ cwd: scratchRoot });
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: false,
          healthPath: '/h',
          preview: {
            enabled: true,
            startScript: 'pnpm dev',
            captureRoutes: ['/'],
            idleTTL: 600,
          },
        },
      })
      .expect(200);

    await request.post(`/api/projects/${projectId}/preview/detect`).send({}).expect(200);

    const after = await request.get(`/api/projects/${projectId}`).expect(200);
    const body = after.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: false,
      healthPath: '/h',
      preview: {
        enabled: true,
        startScript: 'pnpm dev',
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
  });
});
