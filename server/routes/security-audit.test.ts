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
  fixDeps?: RouteOpts['fixDeps'];
  findProject?: (id: string) => Project | null;
  /** Wire a native PR service into the route deps (fix route gate). */
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
      fixDeps: opts.fixDeps,
    }),
  );
  return app;
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
});

describe('POST /security-audit/findings/:id/fix', () => {
  const LOCK = JSON.stringify(
    {
      name: 'fixture',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.11', integrity: 'sha512-OLD' },
      },
    },
    null,
    2,
  );

  /** Seed one fixable open lodash finding and return its id. */
  function seedFixable(s: SecurityAuditStore): string {
    const r = s.recordScanResults({
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
            summary: 'Prototype pollution',
            severity: 'high',
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

  function fakeFixDeps(files: Record<string, string | null>) {
    const commitFiles = vi.fn(
      async (_args: { branch: string; files: Record<string, string>; message: string }) => ({
        headSha: 'deadbeef',
        created: true,
      }),
    );
    return {
      fixDeps: {
        resolveRepo: vi.fn(async () => ({
          repoPath: '/bare/p1.git',
          baseBranch: 'main',
          baseSha: 'basesha',
        })),
        makeReader: () => ({
          readFile: async (_ref: string, p: string) => (p in files ? files[p] : null),
        }),
        commitFiles,
      } as unknown as Parameters<typeof makeApp>[0]['fixDeps'],
      commitFiles,
    };
  }

  function fakeNativePr() {
    return {
      createOrGetOpenPr: vi.fn((_args: Record<string, unknown>) => ({
        row: { number: 42 },
        prUrl: '/projects/p1/pulls/42',
        created: true,
      })),
    };
  }

  it('opens a native bump PR for the finding and returns the opened entry', async () => {
    const id = seedFixable(store);
    const nativePr = fakeNativePr();
    const { fixDeps, commitFiles } = fakeFixDeps({ 'package-lock.json': LOCK });
    const app = makeApp({ store, nativePr, fixDeps });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(200);
    expect(res.body.opened).toHaveLength(1);
    expect(res.body.opened[0]).toMatchObject({
      packageName: 'lodash',
      toVersion: '4.17.21',
      prNumber: 42,
      prUrl: '/projects/p1/pulls/42',
      prCreated: true,
    });
    expect(res.body.skipped).toEqual([]);
    expect(commitFiles).toHaveBeenCalledOnce();
    expect(nativePr.createOrGetOpenPr).toHaveBeenCalledOnce();
    // The PR is cut from the resolved base branch.
    expect(nativePr.createOrGetOpenPr.mock.calls[0][0]).toMatchObject({ baseBranch: 'main' });
  });

  it('only bumps SUPPORTED siblings: a null-fixed advisory on the same package is excluded', async () => {
    // The package is installed at three vulnerable versions in one manifest. Two
    // advisories publish a fix (4.16.0 + 4.17.11 → 4.17.21); a third advisory on
    // 4.13.0 has NO published fix. The per-finding Fix must bump only the two
    // fixable copies and leave the unfixable one untouched — never letting the
    // null-fixed sibling into the bump group.
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
            summary: 'fixable',
            severity: 'high',
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        },
        {
          dependency: {
            ecosystem: 'npm',
            name: 'lodash',
            version: '4.16.0',
            manifestPath: 'package-lock.json',
          },
          advisory: {
            id: 'GHSA-b',
            summary: 'fixable sibling',
            severity: 'high',
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        },
        {
          dependency: {
            ecosystem: 'npm',
            name: 'lodash',
            version: '4.13.0',
            manifestPath: 'package-lock.json',
          },
          advisory: {
            id: 'GHSA-c',
            summary: 'no fix published',
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
    // Click the first (fixable) finding.
    const clicked = r.newFindings.find((f) => f.package_version === '4.17.11')!.id;
    const lock = JSON.stringify(
      {
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/lodash': { version: '4.17.11', integrity: 'sha512-A' },
          'node_modules/a/node_modules/lodash': { version: '4.16.0', integrity: 'sha512-B' },
          'node_modules/b/node_modules/lodash': { version: '4.13.0', integrity: 'sha512-C' },
        },
      },
      null,
      2,
    );
    const nativePr = fakeNativePr();
    const { fixDeps, commitFiles } = fakeFixDeps({ 'package-lock.json': lock });
    const app = makeApp({ store, nativePr, fixDeps });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${clicked}/fix`)
      .send()
      .expect(200);

    expect(res.body.opened).toHaveLength(1);
    // Only the two FIXABLE versions are in the bump; the null-fixed 4.13.0 is not.
    expect(res.body.opened[0]).toMatchObject({
      packageName: 'lodash',
      fromVersions: ['4.16.0', '4.17.11'],
      toVersion: '4.17.21',
    });
    // The committed lockfile reflects the same: fixable copies bumped, the
    // unfixable copy left at its original version.
    const committed = JSON.parse(commitFiles.mock.calls[0][0].files['package-lock.json']);
    expect(committed.packages['node_modules/lodash'].version).toBe('4.17.21');
    expect(committed.packages['node_modules/a/node_modules/lodash'].version).toBe('4.17.21');
    expect(committed.packages['node_modules/b/node_modules/lodash'].version).toBe('4.13.0');
  });

  it('batches ALL open fixable packages into the single PR, not just the clicked one', async () => {
    // Two distinct fixable packages are open. Clicking Fix on lodash must open
    // ONE combined PR that also bumps express — the rolling security PR — rather
    // than a lodash-only PR that would clobber express's bump on the shared
    // branch.
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
            summary: 'lodash',
            severity: 'high',
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        },
        {
          dependency: {
            ecosystem: 'npm',
            name: 'express',
            version: '4.17.0',
            manifestPath: 'package-lock.json',
          },
          advisory: {
            id: 'GHSA-b',
            summary: 'express',
            severity: 'high',
            aliases: [],
            fixedVersion: '4.19.2',
            url: '',
          },
        },
      ],
      ref: 'main',
      now: 1000,
    });
    const clicked = r.newFindings.find((f) => f.package_name === 'lodash')!.id;
    const lock = JSON.stringify(
      {
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'fixture',
            version: '1.0.0',
            dependencies: { lodash: '^4.17.11', express: '^4.17.0' },
          },
          'node_modules/lodash': { version: '4.17.11' },
          'node_modules/express': { version: '4.17.0' },
        },
      },
      null,
      2,
    );
    const nativePr = fakeNativePr();
    const { fixDeps, commitFiles } = fakeFixDeps({ 'package-lock.json': lock });
    const app = makeApp({ store, nativePr, fixDeps });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${clicked}/fix`)
      .send()
      .expect(200);

    // both packages opened in ONE PR (one commit, one createOrGetOpenPr)
    expect(res.body.opened).toHaveLength(2);
    expect(res.body.opened.map((o: { packageName: string }) => o.packageName).sort()).toEqual([
      'express',
      'lodash',
    ]);
    expect(commitFiles).toHaveBeenCalledOnce();
    expect(nativePr.createOrGetOpenPr).toHaveBeenCalledOnce();
    const committed = JSON.parse(commitFiles.mock.calls[0][0].files['package-lock.json']);
    expect(committed.packages['node_modules/lodash'].version).toBe('4.17.21');
    expect(committed.packages['node_modules/express'].version).toBe('4.19.2');
  });

  it('reports a skip (no PR) when the lockfile is missing, without 500ing', async () => {
    const id = seedFixable(store);
    const nativePr = fakeNativePr();
    const { fixDeps } = fakeFixDeps({}); // reader returns null for every path
    const app = makeApp({ store, nativePr, fixDeps });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(200);
    expect(res.body.opened).toEqual([]);
    expect(res.body.skipped[0]).toMatchObject({ reason: 'lockfile_missing' });
    expect(nativePr.createOrGetOpenPr).not.toHaveBeenCalled();
  });

  it('409s when the project is not Hub-hosted', async () => {
    const id = seedFixable(store);
    const app = makeApp({ store, nativePr: fakeNativePr(), gitHost: 'github' });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(409);
  });

  it('409s when no native PR service is wired', async () => {
    const id = seedFixable(store);
    const app = makeApp({ store }); // no nativePr
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(409);
  });

  it('409s when the advisory has no published fix', async () => {
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
    const app = makeApp({ store, nativePr: fakeNativePr() });
    const res = await request(app)
      .post(`/api/projects/p1/security-audit/findings/${r.newFindings[0].id}/fix`)
      .send()
      .expect(409);
    expect(res.body.error).toMatch(/no fix/i);
  });

  it('409s when the finding is already dismissed (not open)', async () => {
    const id = seedFixable(store);
    store.dismissFinding({ projectId: 'p1', id, reason: null, createdBy: null, suppress: true });
    const app = makeApp({ store, nativePr: fakeNativePr() });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(409);
  });

  it('404s for an unknown finding id', async () => {
    const app = makeApp({ store, nativePr: fakeNativePr() });
    await request(app).post('/api/projects/p1/security-audit/findings/nope/fix').send().expect(404);
  });

  it('requires the Admin role: a User is 403 and no PR is opened', async () => {
    const id = seedFixable(store);
    const nativePr = fakeNativePr();
    const app = makeApp({ store, nativePr, role: 'User' });
    await request(app)
      .post(`/api/projects/p1/security-audit/findings/${id}/fix`)
      .send()
      .expect(403);
    expect(nativePr.createOrGetOpenPr).not.toHaveBeenCalled();
  });
});

describe('POST /security-audit/fix (batch, by severity)', () => {
  // A lockfile carrying three distinct packages installed at one vulnerable
  // version each — one per severity tier we want to threshold on.
  const LOCK = JSON.stringify(
    {
      name: 'fixture',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/critpkg': { version: '1.0.0', integrity: 'sha512-C' },
        'node_modules/highpkg': { version: '1.0.0', integrity: 'sha512-H' },
        'node_modules/medpkg': { version: '1.0.0', integrity: 'sha512-M' },
      },
    },
    null,
    2,
  );

  /** Seed one open fixable finding per severity (critical/high/medium). */
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

  function fakeFixDeps(files: Record<string, string | null>) {
    const commitFiles = vi.fn(
      async (_args: { branch: string; files: Record<string, string>; message: string }) => ({
        headSha: 'deadbeef',
        created: true,
      }),
    );
    return {
      fixDeps: {
        resolveRepo: vi.fn(async () => ({
          repoPath: '/bare/p1.git',
          baseBranch: 'main',
          baseSha: 'basesha',
        })),
        makeReader: () => ({
          readFile: async (_ref: string, p: string) => (p in files ? files[p] : null),
        }),
        commitFiles,
      } as unknown as Parameters<typeof makeApp>[0]['fixDeps'],
      commitFiles,
    };
  }

  function fakeNativePr() {
    return {
      createOrGetOpenPr: vi.fn((_args: Record<string, unknown>) => ({
        row: { number: 77 },
        prUrl: '/projects/p1/pulls/77',
        created: true,
      })),
    };
  }

  it('fixes every fixable finding when no minSeverity is given', async () => {
    seedTiers(store);
    const nativePr = fakeNativePr();
    const { fixDeps } = fakeFixDeps({ 'package-lock.json': LOCK });
    const app = makeApp({ store, nativePr, fixDeps });
    const res = await request(app).post('/api/projects/p1/security-audit/fix').send({}).expect(200);
    const names = res.body.opened.map((o: any) => o.packageName).sort();
    expect(names).toEqual(['critpkg', 'highpkg', 'medpkg']);
    // One combined PR (one createOrGetOpenPr) regardless of package count.
    expect(nativePr.createOrGetOpenPr).toHaveBeenCalledOnce();
  });

  it('minSeverity:high fixes critical AND high but not medium (threshold, not exact)', async () => {
    seedTiers(store);
    const nativePr = fakeNativePr();
    const { fixDeps } = fakeFixDeps({ 'package-lock.json': LOCK });
    const app = makeApp({ store, nativePr, fixDeps });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ minSeverity: 'high' })
      .expect(200);
    const names = res.body.opened.map((o: any) => o.packageName).sort();
    expect(names).toEqual(['critpkg', 'highpkg']);
  });

  it('minSeverity:critical fixes only the critical finding', async () => {
    seedTiers(store);
    const nativePr = fakeNativePr();
    const { fixDeps } = fakeFixDeps({ 'package-lock.json': LOCK });
    const app = makeApp({ store, nativePr, fixDeps });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ minSeverity: 'critical' })
      .expect(200);
    expect(res.body.opened.map((o: any) => o.packageName)).toEqual(['critpkg']);
  });

  it('returns empty opened (no PR) when no finding meets the threshold', async () => {
    seedTiers(store); // highest is critical; nothing is below "low" missing, but medpkg is medium
    // Dismiss every tier except medium, then threshold at critical → nothing.
    const open = store.listFindings('p1', { status: 'open' });
    for (const f of open) {
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
    const nativePr = fakeNativePr();
    const { fixDeps } = fakeFixDeps({ 'package-lock.json': LOCK });
    const app = makeApp({ store, nativePr, fixDeps });
    const res = await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ minSeverity: 'critical' })
      .expect(200);
    expect(res.body.opened).toEqual([]);
    expect(res.body.skipped).toEqual([]);
    expect(nativePr.createOrGetOpenPr).not.toHaveBeenCalled();
  });

  it('400s on an invalid minSeverity', async () => {
    seedTiers(store);
    const app = makeApp({ store, nativePr: fakeNativePr() });
    await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ minSeverity: 'bogus' })
      .expect(400);
  });

  it('400s on an unknown body key (strict schema)', async () => {
    const app = makeApp({ store, nativePr: fakeNativePr() });
    await request(app)
      .post('/api/projects/p1/security-audit/fix')
      .send({ severity: 'high' })
      .expect(400);
  });

  it('409s when the project is not Hub-hosted', async () => {
    seedTiers(store);
    const app = makeApp({ store, nativePr: fakeNativePr(), gitHost: 'github' });
    await request(app).post('/api/projects/p1/security-audit/fix').send({}).expect(409);
  });

  it('409s when no native PR service is wired', async () => {
    seedTiers(store);
    const app = makeApp({ store }); // no nativePr
    await request(app).post('/api/projects/p1/security-audit/fix').send({}).expect(409);
  });

  it('404s for an unknown project', async () => {
    const app = makeApp({ store, nativePr: fakeNativePr() });
    await request(app).post('/api/projects/nope/security-audit/fix').send({}).expect(404);
  });

  it('requires the Admin role: a User is 403 and no PR is opened', async () => {
    seedTiers(store);
    const nativePr = fakeNativePr();
    const app = makeApp({ store, nativePr, role: 'User' });
    await request(app).post('/api/projects/p1/security-audit/fix').send({}).expect(403);
    expect(nativePr.createOrGetOpenPr).not.toHaveBeenCalled();
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
