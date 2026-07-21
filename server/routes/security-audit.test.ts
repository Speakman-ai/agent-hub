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
import { SecurityScanError } from '../security-audit/run.js';
import type { RouteDeps, Project } from '../types.js';

// NonNullable: the 2nd param is optional (has a default), so Parameters<>[1]
// includes `undefined`; strip it before indexing so the field types resolve to
// the real option types rather than `undefined`.
type RouteOpts = NonNullable<Parameters<typeof createSecurityAuditRoutes>[1]>;

function makeApp(opts: {
  store?: SecurityAuditStore;
  runScan?: RouteOpts['runScan'];
  dispatchFixSession?: RouteOpts['dispatchFixSession'];
  findProject?: (id: string) => Project | null;
  /** Wire a native PR service into the route deps (kept for scan-path parity). */
  nativePr?: unknown;
  /** Override the project's gitHost (defaults to 'agenthub'). */
  gitHost?: string;
  /** Role stamped on the request (authMiddleware does this in production). */
  role?: 'Owner' | 'Admin' | 'User' | null;
}): express.Express {
  const project = {
    id: 'p1',
    name: 'P1',
    gitHost: opts.gitHost ?? 'agenthub',
  } as unknown as Project;
  const deps = {
    stmts: {} as RouteDeps['stmts'],
    broadcast: vi.fn(),
    findProject: opts.findProject ?? ((id: string) => (id === 'p1' ? project : null)),
    nativePr: opts.nativePr,
    config: {} as RouteDeps['config'],
    findAgent: vi.fn(),
    handleChat: vi.fn(),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  // Stand in for authMiddleware: stamp the caller's role + user id. Defaults to
  // Owner so the Admin-gated mutating routes pass unless a test lowers it.
  const role = opts.role === undefined ? 'Owner' : opts.role;
  app.use((req, _res, next) => {
    if (role) (req as unknown as { authRole: string }).authRole = role;
    (req as unknown as { authUserId: string }).authUserId = 'u1';
    next();
  });
  app.use(
    createSecurityAuditRoutes(deps, {
      store: opts.store,
      runScan: opts.runScan,
      dispatchFixSession: opts.dispatchFixSession,
    }),
  );
  return app;
}

/**
 * A fake `dispatchSecurityFixSession` that records its calls. Returns a session
 * result for a non-empty finding batch; `null` for an empty batch (mirroring
 * the real "nothing to do" contract). Set `noAgent` to simulate a roster with
 * no eligible agent (null even for a non-empty batch → route 409). Set `reused`
 * to simulate the idempotency guard returning an already-running session.
 */
function fakeDispatch(opts: { noAgent?: boolean; reused?: boolean } = {}) {
  const calls: Array<{ findings: unknown[]; ownerUserId: unknown }> = [];
  const dispatchFixSession = vi.fn(
    (_deps: unknown, args: { findings: unknown[]; ownerUserId?: unknown }) => {
      calls.push({
        findings: args.findings,
        ownerUserId: args.ownerUserId ?? null,
      });
      if (opts.noAgent || args.findings.length === 0) return null;
      return {
        sessionId: 'sess-1',
        agentId: 'dev-1',
        findingCount: args.findings.length,
        reused: opts.reused === true,
        session: { id: 'sess-1', name: '[Security fix]' },
      };
    },
  ) as unknown as RouteOpts['dispatchFixSession'];
  return { dispatchFixSession, calls };
}

let db: Database.Database;
let store: SecurityAuditStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SECURITY_AUDIT_SCHEMA);
  store = createSecurityAuditStore(db);
});

describe('GET /security-audit/findings', () => {
  it('404s for an unknown project', async () => {
    const app = makeApp({ store });
    await request(app).get('/api/projects/nope/security-audit/findings').expect(404);
  });

  it('returns findings and open severity counts', async () => {
    store.recordScanResults({
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
            severity: 'critical',
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const app = makeApp({ store });
    const res = await request(app).get('/api/projects/p1/security-audit/findings').expect(200);
    expect(res.body.findings).toHaveLength(1);
    expect(res.body.findings[0]).toMatchObject({ package_name: 'lodash', severity: 'critical' });
    expect(res.body.openCounts).toMatchObject({ critical: 1, high: 0 });
    // The internal persistence marker must NOT leak into the public DTO.
    expect(res.body.findings[0]).not.toHaveProperty('last_scan_id');
  });

  it('rejects an invalid status filter with 400 instead of returning all findings', async () => {
    store.recordScanResults({
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
            fixedVersion: null,
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const app = makeApp({ store });
    // A typo must 400, not silently fall through to "no filter".
    await request(app)
      .get('/api/projects/p1/security-audit/findings?status=dismisssed')
      .expect(400);
  });

  it('filters by status', async () => {
    store.recordScanResults({
      projectId: 'p1',
      scannedManifests: ['package-lock.json'],
      findings: [
        {
          dependency: {
            ecosystem: 'npm',
            name: 'a',
            version: '1.0.0',
            manifestPath: 'package-lock.json',
          },
          advisory: {
            id: 'A',
            summary: 's',
            severity: 'high',
            aliases: [],
            fixedVersion: null,
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const app = makeApp({ store });
    await request(app)
      .get('/api/projects/p1/security-audit/findings?status=dismissed')
      .expect(200)
      .expect((r) => {
        expect(r.body.findings).toEqual([]);
      });
    await request(app)
      .get('/api/projects/p1/security-audit/findings?status=open')
      .expect(200)
      .expect((r) => {
        expect(r.body.findings).toHaveLength(1);
      });
  });
});

describe('POST /security-audit/scan', () => {
  it('delegates to the scan orchestrator and returns a summary', async () => {
    const runScan = vi.fn().mockResolvedValue({
      ref: 'main',
      dryRun: false,
      scannedManifests: ['package-lock.json'],
      failedManifests: ['broken/package-lock.json'],
      truncated: true,
      dependencyCount: 42,
      vulnerableFindings: 5,
      summary: {
        newFindings: [{ id: 'x' }],
        reopenedFindings: [{ id: 'y' }],
        updated: 3,
        fixed: 1,
        suppressed: 0,
      },
      cardId: 'card-1',
    });
    const app = makeApp({ store, runScan });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(200);
    expect(res.body).toMatchObject({
      ref: 'main',
      dryRun: false,
      scannedManifests: ['package-lock.json'],
      failedManifests: ['broken/package-lock.json'],
      truncated: true,
      dependencyCount: 42,
      vulnerableFindings: 5,
      newFindings: 1,
      reopened: 1,
      updated: 3,
      fixed: 1,
      cardId: 'card-1',
    });
    expect(runScan).toHaveBeenCalledOnce();
    const callArgs = runScan.mock.calls[0][1];
    expect(callArgs.project.id).toBe('p1');
  });

  it('requires the Admin role: a User is 403 and the scan never runs', async () => {
    const runScan = vi.fn();
    const app = makeApp({ store, runScan, role: 'User' });
    await request(app).post('/api/projects/p1/security-audit/scan').send({}).expect(403);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('rejects a malformed or typo body with 400 and does NOT run the scan', async () => {
    const runScan = vi.fn();
    const app = makeApp({ store, runScan });
    // ref must be a string → reject 123.
    await request(app).post('/api/projects/p1/security-audit/scan').send({ ref: 123 }).expect(400);
    // generateCard must be a boolean → reject "false".
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ generateCard: 'false' })
      .expect(400);
    // A typo'd unknown key must 400 (strict), not be silently stripped and then
    // fall through to creating a card.
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ generateCards: false })
      .expect(400);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('passes a validated generateCard:false through to the orchestrator', async () => {
    const runScan = vi.fn().mockResolvedValue({
      ref: 'main',
      scannedManifests: [],
      failedManifests: [],
      truncated: false,
      dependencyCount: 0,
      summary: { newFindings: [], reopenedFindings: [], updated: 0, fixed: 0, suppressed: 0 },
      cardId: null,
    });
    const app = makeApp({ store, runScan });
    await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ generateCard: false, ref: 'dev' })
      .expect(200);
    expect(runScan.mock.calls[0][1]).toMatchObject({ ref: 'dev', generateCard: false });
  });

  it('maps a SecurityScanError to 409', async () => {
    const runScan = vi.fn().mockRejectedValue(new SecurityScanError('not hosted', 'not_hosted'));
    const app = makeApp({ store, runScan });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(409);
    expect(res.body.error).toBe('not hosted');
  });

  it('maps a bad-ref SecurityScanError to 400', async () => {
    const runScan = vi.fn().mockRejectedValue(new SecurityScanError('Unknown ref "x"', 'bad_ref'));
    const app = makeApp({ store, runScan });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ ref: 'x' })
      .expect(400);
    expect(res.body.error).toContain('Unknown ref');
  });

  it('maps an unexpected error to 500', async () => {
    const runScan = vi.fn().mockRejectedValue(new Error('boom\nstack'));
    const app = makeApp({ store, runScan });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(500);
    expect(res.body.error).toContain('boom');
  });

  it('autofix (autoPr:true) dispatches a session over the open findings after a real scan', async () => {
    // Pre-seed an open finding the post-scan dispatch will pick up. The scan
    // orchestrator is mocked (non-dry-run) so we exercise only the route's
    // dispatch wiring, not OSV/git.
    store.recordScanResults({
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
    const runScan = vi.fn().mockResolvedValue({
      ref: 'main',
      dryRun: false,
      scannedManifests: ['package-lock.json'],
      failedManifests: [],
      truncated: false,
      dependencyCount: 1,
      vulnerableFindings: 1,
      summary: { newFindings: [], reopenedFindings: [], updated: 0, fixed: 0, suppressed: 0 },
      cardId: null,
    });
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, runScan, dispatchFixSession });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true })
      .expect(200);
    expect(res.body.fixSession).toMatchObject({ sessionId: 'sess-1', findingCount: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].findings).toHaveLength(1);
  });

  it('does NOT dispatch a session on a dry-run scan even when autoPr:true', async () => {
    const runScan = vi.fn().mockResolvedValue({
      ref: 'dev',
      dryRun: true,
      scannedManifests: [],
      failedManifests: [],
      truncated: false,
      dependencyCount: 0,
      vulnerableFindings: 0,
      summary: { newFindings: [], reopenedFindings: [], updated: 0, fixed: 0, suppressed: 0 },
      cardId: null,
    });
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, runScan, dispatchFixSession });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({ autoPr: true, ref: 'dev' })
      .expect(200);
    expect(res.body.fixSession).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a plain rescan (no autoPr) never dispatches a session', async () => {
    const runScan = vi.fn().mockResolvedValue({
      ref: 'main',
      dryRun: false,
      scannedManifests: [],
      failedManifests: [],
      truncated: false,
      dependencyCount: 0,
      vulnerableFindings: 0,
      summary: { newFindings: [], reopenedFindings: [], updated: 0, fixed: 0, suppressed: 0 },
      cardId: null,
    });
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, runScan, dispatchFixSession });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/scan')
      .send({})
      .expect(200);
    expect(res.body.fixSession).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('POST /security-audit/findings/:id/fix', () => {
  /** Seed one open high finding and return its id. */
  function seedOpen(s: SecurityAuditStore, name = 'lodash', severity = 'high'): string {
    const r = s.recordScanResults({
      projectId: 'p1',
      scannedManifests: ['package-lock.json'],
      findings: [
        {
          dependency: {
            ecosystem: 'npm',
            name,
            version: '4.17.11',
            manifestPath: 'package-lock.json',
          },
          advisory: {
            id: `GHSA-${name}`,
            summary: 'Prototype pollution',
            severity: severity as any,
            aliases: [],
            fixedVersion: '4.17.21',
            url: 'https://example.test/GHSA-a',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    return r.newFindings[0].id;
  }

  it('dispatches a session over ALL open findings and returns 201 with the session', async () => {
    // Two open findings recorded in ONE scan (a second scan would sweep the
    // first as vanished/fixed). The clicked row is lodash; the batch covers both.
    const seeded = store.recordScanResults({
      projectId: 'p1',
      scannedManifests: ['package-lock.json'],
      findings: ['lodash', 'express'].map((name) => ({
        dependency: {
          ecosystem: 'npm' as const,
          name,
          version: '4.17.11',
          manifestPath: 'package-lock.json',
        },
        advisory: {
          id: `GHSA-${name}`,
          summary: 's',
          severity: 'high' as any,
          aliases: [],
          fixedVersion: '4.17.21',
          url: '',
        },
      })),
      ref: 'main',
      now: 1000,
    });
    const id = seeded.newFindings.find((f) => f.package_name === 'lodash')!.id;
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(201);
    expect(res.body).toMatchObject({ sessionId: 'sess-1', agentId: 'dev-1', findingCount: 2 });
    expect(res.body.session).toMatchObject({ id: 'sess-1' });
    // Every open finding was handed to the session (not just the clicked row),
    // with no severity threshold and the caller as owner.
    expect(calls).toHaveLength(1);
    expect(calls[0].findings).toHaveLength(2);
    expect(calls[0].ownerUserId).toBe('u1');
  });

  it('returns 200 (not 201) when an already-running fix session is reused', async () => {
    const r = store.recordScanResults({
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
    const { dispatchFixSession } = fakeDispatch({ reused: true });
    const app = makeApp({ store, dispatchFixSession });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${r.newFindings[0].id}/fix`)
      .send()
      .expect(200);
    expect(res.body).toMatchObject({ sessionId: 'sess-1', reused: true });
  });

  it('dispatches even for a finding with no published fix (a check is a valid outcome)', async () => {
    const r = store.recordScanResults({
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
            fixedVersion: null,
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${r.newFindings[0].id}/fix`)
      .send()
      .expect(201);
    expect(calls[0].findings).toHaveLength(1);
  });

  it('dispatches for a non-npm (pip) finding — sessions are not npm-only', async () => {
    const r = store.recordScanResults({
      projectId: 'p1',
      scannedManifests: ['requirements.txt'],
      findings: [
        {
          dependency: {
            ecosystem: 'pip',
            name: 'django',
            version: '3.2.0',
            manifestPath: 'requirements.txt',
          },
          advisory: {
            id: 'GHSA-dj',
            summary: 'sql injection',
            severity: 'high',
            aliases: [],
            fixedVersion: '3.2.18',
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const { dispatchFixSession } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${r.newFindings[0].id}/fix`)
      .send()
      .expect(201);
  });

  it('409s when the project is not Hub-hosted', async () => {
    const id = seedOpen(store);
    const app = makeApp({
      store,
      gitHost: 'github',
      dispatchFixSession: fakeDispatch().dispatchFixSession,
    });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(409);
  });

  it('409s when no eligible agent is available to run the session', async () => {
    const id = seedOpen(store);
    const { dispatchFixSession } = fakeDispatch({ noAgent: true });
    const app = makeApp({ store, dispatchFixSession });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(409);
    expect(res.body.error).toMatch(/no agent/i);
  });

  it('409s when the finding is already dismissed (not open)', async () => {
    const id = seedOpen(store);
    store.dismissFinding({ projectId: 'p1', id, reason: null, createdBy: null, suppress: true });
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(409);
    expect(calls).toHaveLength(0); // never dispatched
  });

  it('404s for an unknown finding id', async () => {
    const app = makeApp({ store, dispatchFixSession: fakeDispatch().dispatchFixSession });
    await request(app).post('/api/projects/p1/security-audit/findings/nope/fix').send().expect(404);
  });

  it('requires the Admin role: a User is 403 and no session is dispatched', async () => {
    const id = seedOpen(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession, role: 'User' });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(403);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /security-audit/fix (batch, by severity)', () => {
  /** Seed one open finding per severity (critical/high/medium). */
  function seedTiers(s: SecurityAuditStore): void {
    const mk = (name: string, severity: string, id: string) => ({
      dependency: {
        ecosystem: 'npm' as const,
        name,
        version: '1.0.0',
        manifestPath: 'package-lock.json',
      },
      advisory: {
        id,
        summary: severity,
        severity: severity as any,
        aliases: [],
        fixedVersion: '2.0.0',
        url: '',
      },
    });
    s.recordScanResults({
      projectId: 'p1',
      scannedManifests: ['package-lock.json'],
      findings: [
        mk('critpkg', 'critical', 'GHSA-crit'),
        mk('highpkg', 'high', 'GHSA-high'),
        mk('medpkg', 'medium', 'GHSA-med'),
      ],
      ref: 'main',
      now: 1000,
    });
  }

  const sevOf = (calls: Array<{ findings: unknown[] }>) =>
    (calls[0].findings as Array<{ severity: string }>).map((f) => f.severity).sort();

  it('dispatches a session over every open finding when no minSeverity is given', async () => {
    seedTiers(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession });
    const res = await request(app).post('/api/projects/p1/security-audit/fix').send({}).expect(201);
    expect(res.body).toMatchObject({ sessionId: 'sess-1', findingCount: 3 });
    expect(sevOf(calls)).toEqual(['critical', 'high', 'medium']);
  });

  it('minSeverity:high scopes the batch to critical AND high (threshold, not exact)', async () => {
    seedTiers(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession });
    await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ minSeverity: 'high' })
      .expect(201);
    expect(sevOf(calls)).toEqual(['critical', 'high']);
  });

  it('minSeverity:critical scopes the batch to only the critical finding', async () => {
    seedTiers(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession });
    await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ minSeverity: 'critical' })
      .expect(201);
    expect(sevOf(calls)).toEqual(['critical']);
  });

  it('returns 200 with a null session when no finding meets the threshold', async () => {
    seedTiers(store);
    // Dismiss every tier except medium, then threshold at critical → nothing.
    for (const f of store.listFindings('p1', { status: 'open' })) {
      if (f.severity !== 'medium') {
        store.dismissFinding({
          projectId: 'p1',
          id: f.id,
          reason: null,
          createdBy: null,
          suppress: true,
        });
      }
    }
    const { dispatchFixSession } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ minSeverity: 'critical' })
      .expect(200);
    expect(res.body).toMatchObject({ sessionId: null, findingCount: 0, session: null });
  });

  it('400s on an invalid minSeverity', async () => {
    seedTiers(store);
    const app = makeApp({ store, dispatchFixSession: fakeDispatch().dispatchFixSession });
    await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ minSeverity: 'bogus' })
      .expect(400);
  });

  it('400s on an unknown body key (strict schema)', async () => {
    const app = makeApp({ store, dispatchFixSession: fakeDispatch().dispatchFixSession });
    await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ severity: 'high' })
      .expect(400);
  });

  it('409s when the project is not Hub-hosted', async () => {
    seedTiers(store);
    const app = makeApp({
      store,
      gitHost: 'github',
      dispatchFixSession: fakeDispatch().dispatchFixSession,
    });
    await request(app).post('/api/projects/p1/security-audit/fix').send({}).expect(409);
  });

  it('409s when a matching finding exists but no eligible agent is available', async () => {
    seedTiers(store);
    const { dispatchFixSession } = fakeDispatch({ noAgent: true });
    const app = makeApp({ store, dispatchFixSession });
    await request(app).post('/api/projects/p1/security-audit/fix').send({}).expect(409);
  });

  it('404s for an unknown project', async () => {
    const app = makeApp({ store, dispatchFixSession: fakeDispatch().dispatchFixSession });
    await request(app).post('/api/projects/nope/security-audit/fix').send({}).expect(404);
  });

  it('requires the Admin role: a User is 403 and no session is dispatched', async () => {
    seedTiers(store);
    const { dispatchFixSession, calls } = fakeDispatch();
    const app = makeApp({ store, dispatchFixSession, role: 'User' });
    await request(app).post('/api/projects/p1/security-audit/fix').send({}).expect(403);
    expect(calls).toHaveLength(0);
  });
});
describe('POST /security-audit/findings/:id/dismiss', () => {
  it('dismisses a finding and records a suppression by default', async () => {
    const s = store.recordScanResults({
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
            fixedVersion: null,
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const app = makeApp({ store });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${s.newFindings[0].id}/dismiss`)
      .send({ reason: 'not exploitable' })
      .expect(200);
    expect(res.body.status).toBe('dismissed');
    expect(res.body).not.toHaveProperty('last_scan_id'); // public DTO
    expect(store.listSuppressions('p1')).toHaveLength(1);
  });

  it('rejects a typo key (e.g. "supress") with 400 and records no suppression', async () => {
    const s = store.recordScanResults({
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
            fixedVersion: null,
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const app = makeApp({ store });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${s.newFindings[0].id}/dismiss`)
      .send({ supress: false }) // typo of `suppress`
      .expect(400);
    expect(store.getFinding('p1', s.newFindings[0].id)?.status).toBe('open');
    expect(store.listSuppressions('p1')).toHaveLength(0);
  });

  it('404s for an unknown finding id', async () => {
    const app = makeApp({ store });
    await request(app)
      .post('/api/projects/p1/security-audit/findings/nope/dismiss')
      .send({})
      .expect(404);
  });

  it('requires the Admin role: a User is 403 and nothing is dismissed', async () => {
    const s = store.recordScanResults({
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
            fixedVersion: null,
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const app = makeApp({ store, role: 'User' });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${s.newFindings[0].id}/dismiss`)
      .send({ reason: 'x' })
      .expect(403);
    expect(store.getFinding('p1', s.newFindings[0].id)?.status).toBe('open');
    expect(store.listSuppressions('p1')).toHaveLength(0);
  });
});
