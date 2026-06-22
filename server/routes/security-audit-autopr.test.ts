/**
 * Route-level wiring for security auto-PR: the scan route builds and passes
 * the `openBumpPrs` closure to runScan ONLY when the project opted in
 * (securityAutoPr.enabled), the repo is Hub-hosted, AND a native PR service
 * is wired — and surfaces the scan's autoPr result in the response.
 */
import '../test/setup.js';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import createSecurityAuditRoutes from './security-audit.js';
import type { RunSecurityScanResult } from '../security-audit/run.js';
import type { NativePrService } from '../native-pr/service.js';
import type { Project, RouteDeps } from '../types.js';

const FAKE_RESULT: RunSecurityScanResult = {
  ref: 'main',
  scannedManifests: ['package-lock.json'],
  presentManifests: ['package-lock.json'],
  failedManifests: [],
  truncated: false,
  dependencyCount: 1,
  vulnerableFindings: 1,
  dryRun: false,
  summary: { newFindings: [], reopenedFindings: [], updated: 0, fixed: 0, suppressed: 0 },
  cardId: null,
  autoPr: { opened: [], skipped: [] },
};

function makeApp(opts: {
  project: Project;
  nativePr?: NativePrService;
  onDeps: (deps: unknown) => void;
}): express.Express {
  const runScan = vi.fn(async (scanDeps: unknown): Promise<RunSecurityScanResult> => {
    opts.onDeps(scanDeps);
    return FAKE_RESULT;
  });
  const deps = {
    stmts: {} as RouteDeps['stmts'],
    broadcast: vi.fn(),
    nativePr: opts.nativePr,
    findProject: (id: string) => (id === opts.project.id ? opts.project : null),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authRole: string }).authRole = 'Owner';
    (req as unknown as { authUserId: string }).authUserId = 'u1';
    next();
  });
  app.use(
    createSecurityAuditRoutes(deps, {
      runScan: runScan as unknown as NonNullable<
        Parameters<typeof createSecurityAuditRoutes>[1]
      >['runScan'],
    }),
  );
  return app;
}

const fakeNativePr = (): NativePrService =>
  ({ createOrGetOpenPr: vi.fn() }) as unknown as NativePrService;

function project(over: Partial<Project>): Project {
  return { id: 'p1', name: 'P1', gitHost: 'agenthub', ...over } as unknown as Project;
}

describe('POST /security-audit/scan — auto-PR gate', () => {
  it('passes openBumpPrs when enabled + Hub-hosted + nativePr present, and returns autoPr', async () => {
    let captured: { openBumpPrs?: unknown } = {};
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: true } }),
      nativePr: fakeNativePr(),
      onDeps: (d) => {
        captured = d as { openBumpPrs?: unknown };
      },
    });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(200);
    expect(typeof captured.openBumpPrs).toBe('function');
    expect(res.body.autoPr).toEqual({ opened: [], skipped: [] });
  });

  it('does NOT pass openBumpPrs when the setting is disabled', async () => {
    let captured: { openBumpPrs?: unknown } = {};
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: false } }),
      nativePr: fakeNativePr(),
      onDeps: (d) => {
        captured = d as { openBumpPrs?: unknown };
      },
    });
    await request(app).post('/api/projects/p1/security-audit/scan').send({}).expect(200);
    expect(captured.openBumpPrs).toBeUndefined();
  });

  it('does NOT pass openBumpPrs when no native PR service is wired', async () => {
    let captured: { openBumpPrs?: unknown } = {};
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: true } }),
      nativePr: undefined,
      onDeps: (d) => {
        captured = d as { openBumpPrs?: unknown };
      },
    });
    await request(app).post('/api/projects/p1/security-audit/scan').send({}).expect(200);
    expect(captured.openBumpPrs).toBeUndefined();
  });

  it('does NOT pass openBumpPrs for a non-Hub-hosted project', async () => {
    let captured: { openBumpPrs?: unknown } = {};
    const app = makeApp({
      project: project({ gitHost: 'github', securityAutoPr: { enabled: true } }),
      nativePr: fakeNativePr(),
      onDeps: (d) => {
        captured = d as { openBumpPrs?: unknown };
      },
    });
    await request(app).post('/api/projects/p1/security-audit/scan').send({}).expect(200);
    expect(captured.openBumpPrs).toBeUndefined();
  });

  // The "Autofix" button passes { autoPr: true } as its own opt-in — it must
  // open bump PRs even when the project never set securityAutoPr.enabled.
  it('passes openBumpPrs when the request body sets autoPr:true, even with the setting unset', async () => {
    let captured: { openBumpPrs?: unknown } = {};
    const app = makeApp({
      project: project({}), // no securityAutoPr at all
      nativePr: fakeNativePr(),
      onDeps: (d) => {
        captured = d as { openBumpPrs?: unknown };
      },
    });
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(typeof captured.openBumpPrs).toBe('function');
  });

  it('autoPr:true still does NOT open PRs for a non-Hub-hosted project', async () => {
    let captured: { openBumpPrs?: unknown } = {};
    const app = makeApp({
      project: project({ gitHost: 'github' }),
      nativePr: fakeNativePr(),
      onDeps: (d) => {
        captured = d as { openBumpPrs?: unknown };
      },
    });
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(captured.openBumpPrs).toBeUndefined();
  });

  it('autoPr:true still does NOT open PRs when no native PR service is wired', async () => {
    let captured: { openBumpPrs?: unknown } = {};
    const app = makeApp({
      project: project({}),
      nativePr: undefined,
      onDeps: (d) => {
        captured = d as { openBumpPrs?: unknown };
      },
    });
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(captured.openBumpPrs).toBeUndefined();
  });

  it('rejects a non-boolean autoPr with 400 (strict schema)', async () => {
    const app = makeApp({
      project: project({}),
      nativePr: fakeNativePr(),
      onDeps: () => {},
    });
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: 'yes' })
      .expect(400);
  });
});
