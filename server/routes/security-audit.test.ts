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

function makeApp(opts: {
  store?: SecurityAuditStore;
  runScan?: Parameters<typeof createSecurityAuditRoutes>[1] extends infer O
    ? O extends { runScan?: infer R }
      ? R
      : never
    : never;
  findProject?: (id: string) => Project | null;
  /** Role stamped on the request (authMiddleware does this in production). */
  role?: 'Owner' | 'Admin' | 'User' | null;
}): express.Express {
  const project = { id: 'p1', name: 'P1', gitHost: 'agenthub' } as unknown as Project;
  const deps = {
    stmts: {} as RouteDeps['stmts'],
    broadcast: vi.fn(),
    findProject: opts.findProject ?? ((id: string) => (id === 'p1' ? project : null)),
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
  app.use(createSecurityAuditRoutes(deps, { store: opts.store, runScan: opts.runScan }));
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
