/**
 * Route-level wiring for security Autofix: after a real (non-dry-run) scan the
 * scan route dispatches an agent SESSION to resolve the open findings — instead
 * of opening a hand-edited bump PR — when the project opted in
 * (securityAutoPr.enabled) OR the request set autoPr:true, AND the repo is
 * Hub-hosted. The dispatched session is surfaced as `res.body.fixSession`.
 */
import '../test/setup.js';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import createSecurityAuditRoutes from './security-audit.js';
import {
  SECURITY_AUDIT_SCHEMA,
  createSecurityAuditStore,
  type SecurityAuditStore,
} from '../security-audit/findings-store.js';
import type { RunSecurityScanResult } from '../security-audit/run.js';
import type { Project, RouteDeps } from '../types.js';

type RouteOpts = NonNullable<Parameters<typeof createSecurityAuditRoutes>[1]>;

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
  autoPr: null,
};

/**
 * Records dispatch calls; returns a session for a non-empty batch. Set
 * `noAgent` to simulate a failed dispatch (null even for a non-empty batch) —
 * the "open findings but no eligible agent" configuration problem.
 */
function fakeDispatch(opts: { noAgent?: boolean } = {}) {
  const calls: Array<{ findings: unknown[] }> = [];
  const dispatchFixSession = vi.fn((_deps: unknown, args: { findings: unknown[] }) => {
    calls.push({ findings: args.findings });
    if (opts.noAgent || args.findings.length === 0) return null;
    return {
      sessionId: 'sess-1',
      agentId: 'dev-1',
      findingCount: args.findings.length,
      reused: false,
      session: {},
    };
  }) as unknown as RouteOpts['dispatchFixSession'];
  return { dispatchFixSession, calls };
}

let db: Database.Database;
let store: SecurityAuditStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SECURITY_AUDIT_SCHEMA);
  store = createSecurityAuditStore(db);
});

/** Seed one open finding so the post-scan dispatch has something to act on. */
function seedOpenFinding(s: SecurityAuditStore): void {
  s.recordScanResults({
    projectId: 'p1',
    scannedManifests: ['package-lock.json'],
    findings: [
      {
        dependency: {
          ecosystem: 'npm',
          name: 'lodash',
          version: '4.17.11',
          manifestPath: 'package-lock.json',
        },
        advisory: {
          id: 'GHSA-a',
          summary: 's',
          severity: 'high',
          aliases: [],
          fixedVersion: '4.17.21',
          url: '',
        },
      },
    ],
    ref: 'main',
    now: 1000,
  });
}

function makeApp(opts: {
  project: Project;
  dispatch?: RouteOpts['dispatchFixSession'];
  result?: RunSecurityScanResult;
}): express.Express {
  const runScan = vi.fn(async (): Promise<RunSecurityScanResult> => opts.result ?? FAKE_RESULT);
  const deps = {
    stmts: {} as RouteDeps['stmts'],
    broadcast: vi.fn(),
    findProject: (id: string) => (id === opts.project.id ? opts.project : null),
    config: {} as RouteDeps['config'],
    findAgent: vi.fn(),
    handleChat: vi.fn(),
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
      store,
      runScan: runScan as unknown as RouteOpts['runScan'],
      dispatchFixSession: opts.dispatch,
    }),
  );
  return app;
}

function project(over: Partial<Project>): Project {
  return { id: 'p1', name: 'P1', gitHost: 'agenthub', ...over } as unknown as Project;
}

/** A scan result that surfaced a fresh (new) finding — arms the opt-in gate. */
const RESULT_WITH_NEW: RunSecurityScanResult = {
  ...FAKE_RESULT,
  summary: { ...FAKE_RESULT.summary, newFindings: [{ id: 'x' }] as never },
};

describe('POST /security-audit/scan — Autofix gate', () => {
  it('opt-in dispatches a session when the scan surfaced new findings', async () => {
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: true } }),
      dispatch: dispatchFixSession,
      result: RESULT_WITH_NEW,
    });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(200);
    expect(res.body.fixSession).toMatchObject({ sessionId: 'sess-1', findingCount: 1 });
    expect(calls).toHaveLength(1);
  });

  it('opt-in does NOT re-dispatch when the scan surfaced nothing new (idempotency)', async () => {
    // A repeat scan: the finding is already open but not new/reopened this scan.
    // Dispatching again would spawn a duplicate session for the same unresolved
    // findings, so the opt-in path must skip it.
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: true } }),
      dispatch: dispatchFixSession,
      result: FAKE_RESULT, // summary.newFindings/reopenedFindings both empty
    });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(200);
    expect(res.body.fixSession).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('explicit Autofix (autoPr:true) dispatches even with no new findings this scan', async () => {
    // A deliberate one-off click acts on the CURRENT open findings regardless of
    // whether this scan surfaced anything new — unlike the auto opt-in.
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: true } }),
      dispatch: dispatchFixSession,
      result: FAKE_RESULT,
    });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(res.body.fixSession).toMatchObject({ sessionId: 'sess-1', findingCount: 1 });
    expect(calls).toHaveLength(1);
  });

  it('does NOT dispatch when the setting is disabled and autoPr not requested', async () => {
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: false } }),
      dispatch: dispatchFixSession,
    });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(200);
    expect(res.body.fixSession).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('dispatches when the request sets autoPr:true, even with the setting unset', async () => {
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ project: project({}), dispatch: dispatchFixSession });
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(calls).toHaveLength(1);
  });

  it('does NOT dispatch for a non-Hub-hosted project even with autoPr:true', async () => {
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ project: project({ gitHost: 'github' }), dispatch: dispatchFixSession });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(res.body.fixSession).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does NOT dispatch on a dry-run scan', async () => {
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: true } }),
      dispatch: dispatchFixSession,
      result: { ...FAKE_RESULT, dryRun: true },
    });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(200);
    expect(res.body.fixSession).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('surfaces a null fixSession AND null fixSessionError when there are no open findings', async () => {
    // Explicit Autofix, but the store has no open findings → a legit no-op:
    // both fixSession and fixSessionError are null (not a config problem).
    const { dispatchFixSession } = fakeDispatch();
    const app = makeApp({ project: project({}), dispatch: dispatchFixSession });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(res.body.fixSession).toBeNull();
    expect(res.body.fixSessionError).toBeNull();
  });

  it('surfaces fixSessionError (not a false no-op) when open findings exist but dispatch fails', async () => {
    // Open findings ARE present, but no eligible agent can be dispatched → the
    // scan route must report the config problem, not "nothing to resolve".
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = fakeDispatch({ noAgent: true });
    const app = makeApp({ project: project({}), dispatch: dispatchFixSession });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(res.body.fixSession).toBeNull();
    expect(res.body.fixSessionError).toMatch(/no agent/i);
    expect(calls).toHaveLength(1); // dispatch WAS attempted (open.length > 0)
  });

  it('rejects a non-boolean autoPr with 400 (strict schema)', async () => {
    const app = makeApp({ project: project({}), dispatch: fakeDispatch().dispatchFixSession });
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: 'yes' })
      .expect(400);
  });
});

// ── PR vs. auto-merge ─────────────────────────────────────────────────────
// `securityAutoPr.autoMerge` used to be dead config: the dispatcher pinned
// `push` unconditionally, so a project that asked for unattended merging still
// parked the fix at an open PR.
describe('POST /security-audit/scan — Autofix automation level', () => {
  function captureDispatch() {
    const calls: Array<{ automation?: string }> = [];
    const dispatchFixSession = vi.fn((_deps: unknown, args: { automation?: string }) => {
      calls.push({ automation: args.automation });
      return {
        sessionId: 'sess-1',
        agentId: 'dev-1',
        findingCount: 1,
        reused: false,
        session: {},
      };
    }) as unknown as RouteOpts['dispatchFixSession'];
    return { dispatchFixSession, calls };
  }

  it('opens a PR for review by default', async () => {
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = captureDispatch();
    const app = makeApp({
      project: project({ securityAutoPr: { enabled: true } }),
      dispatch: dispatchFixSession,
      result: RESULT_WITH_NEW,
    });
    await request(app).post('/api/projects/p1/security-audit/scan').send({}).expect(200);
    expect(calls).toEqual([{ automation: 'push' }]);
  });

  it('pins merge automation when the project opted into auto-merge', async () => {
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = captureDispatch();
    const app = makeApp({
      project: project({
        securityAutoPr: { enabled: true, autoMerge: true, actorUserId: 'u1' },
      }),
      dispatch: dispatchFixSession,
      result: RESULT_WITH_NEW,
    });
    await request(app).post('/api/projects/p1/security-audit/scan').send({}).expect(200);
    expect(calls).toEqual([{ automation: 'merge' }]);
  });

  it('applies the same choice to a manual per-finding Fix', async () => {
    seedOpenFinding(store);
    const { dispatchFixSession, calls } = captureDispatch();
    const p = project({ securityAutoPr: { enabled: true, autoMerge: true, actorUserId: 'u1' } });
    const app = makeApp({ project: p, dispatch: dispatchFixSession });
    const findingId = store.listFindings('p1', { status: 'open' })[0]!.id;
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${findingId}/fix`)
      .send({})
      .expect(201);
    expect(calls).toEqual([{ automation: 'merge' }]);
  });
});
