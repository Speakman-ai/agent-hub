/**
 * Integration tests for the audit + roster routes.
 *
 * Drives the real Express app via supertest. The audit runner is swapped
 * for a deterministic stub so we don't spawn npm/git in tests.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { setAuditRunner, resetAuditRunner } from './audit.js';
import { getStmts } from '../db.js';
import type { AuditReport } from '../audit/audit-service.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `audit-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

function fakeReport(projectId: string, score = 92): AuditReport {
  return {
    projectId,
    generatedAt: '2026-04-24T00:00:00.000Z',
    score,
    readinessScore: score,
    categories: [
      { id: 'git', label: 'Source Control', status: 'ok', weight: 15 },
      { id: 'tests', label: 'Tests', status: 'ok', weight: 25 },
    ],
    findings: [],
    gaps: [],
    suggestedTracks: [],
  };
}

beforeEach(() => {
  resetAuditRunner();
});

describe('GET /api/projects/:id/audit', () => {
  it('returns 404 when the project does not exist', async () => {
    const res = await request.get('/api/projects/does-not-exist/audit').expect(404);
    expect(res.body.error).toMatch(/project not found/i);
  });

  it('returns 404 when no audit has been generated yet', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/audit`).expect(404);
    expect(res.body.error).toMatch(/audit not found/i);
  });

  it('returns the persisted report once one exists', async () => {
    const projectId = await freshProject();
    const report = fakeReport(projectId);
    getStmts().upsertAuditReport.run(projectId, JSON.stringify(report));

    const res = await request.get(`/api/projects/${projectId}/audit`).expect(200);
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.score).toBe(92);
    expect(res.body.readinessScore).toBe(92);
  });
});

describe('POST /api/projects/:id/audit/refresh', () => {
  it('runs the injected audit runner, persists the report, returns it', async () => {
    const projectId = await freshProject();
    const report = fakeReport(projectId, 77);
    setAuditRunner(async (input) => {
      expect(input.projectId).toBe(projectId);
      return report;
    });

    const res = await request.post(`/api/projects/${projectId}/audit/refresh`).send({}).expect(200);
    expect(res.body.score).toBe(77);

    // Persistence: a follow-up GET should return the same shape without re-running.
    setAuditRunner(async () => {
      throw new Error('should not be called on the read path');
    });
    const followup = await request.get(`/api/projects/${projectId}/audit`).expect(200);
    expect(followup.body.score).toBe(77);
  });

  it('returns 500 when the runner throws', async () => {
    const projectId = await freshProject();
    setAuditRunner(async () => {
      throw new Error('disk on fire');
    });
    const res = await request.post(`/api/projects/${projectId}/audit/refresh`).send({}).expect(500);
    expect(res.body.error).toMatch(/disk on fire/);
  });

  it('passes integrations from the latest provisioning job into the runner', async () => {
    const projectId = await freshProject();
    // Seed a provisioning job for this project.
    getStmts().createProvisioningJob.run(
      `job-${uuidv4()}`,
      projectId,
      JSON.stringify({ integrations: ['aws', 'github'] }),
      'succeeded',
    );

    let captured: unknown = null;
    setAuditRunner(async (input) => {
      captured = input.integrations;
      return fakeReport(projectId);
    });
    await request.post(`/api/projects/${projectId}/audit/refresh`).send({}).expect(200);
    expect(captured).toEqual(['aws', 'github']);
  });

  it('returns 404 for unknown project', async () => {
    await request.post('/api/projects/unknown/audit/refresh').send({}).expect(404);
  });
});

describe('GET /api/projects/:id/roster/suggest', () => {
  it('returns one entry per default track', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/roster/suggest`).expect(200);
    expect(Array.isArray(res.body.tracks)).toBe(true);
    expect(res.body.tracks.length).toBeGreaterThanOrEqual(6);
    expect(res.body.tracks[0]).toMatchObject({
      id: expect.any(String),
      label: expect.any(String),
      rationale: expect.any(String),
    });
  });

  it('returns 404 for unknown project', async () => {
    await request.get('/api/projects/unknown/roster/suggest').expect(404);
  });
});

describe('POST + GET /api/projects/:id/roster', () => {
  it('persists a roster and reads it back', async () => {
    const projectId = await freshProject();
    const payload = {
      tracks: [
        { id: 'backend', label: 'Backend', agentId: 'agent-be' },
        { id: 'frontend', label: 'Frontend', agentId: null },
      ],
    };
    const post = await request.post(`/api/projects/${projectId}/roster`).send(payload).expect(200);
    expect(post.body.tracks).toHaveLength(2);
    expect(post.body.updatedAt).toBeTruthy();

    const get = await request.get(`/api/projects/${projectId}/roster`).expect(200);
    expect(get.body.tracks).toEqual([
      { id: 'backend', label: 'Backend', agentId: 'agent-be', custom: false },
      { id: 'frontend', label: 'Frontend', agentId: null, custom: false },
    ]);
  });

  it('returns 400 when tracks[] is missing', async () => {
    const projectId = await freshProject();
    const res = await request.post(`/api/projects/${projectId}/roster`).send({}).expect(400);
    expect(res.body.error).toMatch(/tracks/);
  });

  it('returns 400 when no usable tracks pass validation', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/roster`)
      .send({ tracks: [{ label: 'no id' }, { id: 42 }] })
      .expect(400);
    expect(res.body.error).toMatch(/no usable tracks/);
  });

  it('returns 404 from the GET when no roster set', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/roster`).expect(404);
  });
});
