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
import { existsSync, readFileSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { getRequest } from '../test/helpers.js';
import { setAuditRunner, resetAuditRunner, formatRosterSection } from './audit.js';
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

async function freshAgent(projectId: string): Promise<string> {
  const id = `agent-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/agents')
    .send({ id, projectId, name: id, engine: 'claude-code' })
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
  it('persists a roster with existing agents and reads it back', async () => {
    const projectId = await freshProject();
    const agentA = await freshAgent(projectId);
    const agentB = await freshAgent(projectId);
    const payload = {
      tracks: [
        { id: 'backend', label: 'Backend', agentId: agentA },
        { id: 'frontend', label: 'Frontend', agentId: agentB },
      ],
    };
    const post = await request.post(`/api/projects/${projectId}/roster`).send(payload).expect(200);
    expect(post.body.tracks).toHaveLength(2);
    expect(post.body.updatedAt).toBeTruthy();
    // Response shape must match the frontend destructure:
    // saved.tracks = [{ id, label, agentId, custom }].
    for (const t of post.body.tracks) {
      expect(t).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        agentId: expect.any(String),
        custom: expect.any(Boolean),
      });
    }
    // The response now also surfaces the bound agents so the Act V
    // landing can hydrate display names without an extra fetch.
    expect(Array.isArray(post.body.agents)).toBe(true);
    expect(post.body.agents.map((a: { id: string }) => a.id).sort()).toEqual(
      [agentA, agentB].sort(),
    );

    const get = await request.get(`/api/projects/${projectId}/roster`).expect(200);
    expect(get.body.tracks).toEqual([
      { id: 'backend', label: 'Backend', agentId: agentA, custom: false },
      { id: 'frontend', label: 'Frontend', agentId: agentB, custom: false },
    ]);
  });

  it('returns 400 when tracks[] is missing', async () => {
    const projectId = await freshProject();
    const res = await request.post(`/api/projects/${projectId}/roster`).send({}).expect(400);
    expect(res.body.error).toMatch(/tracks/);
  });

  it('returns 400 on an empty tracks array', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/roster`)
      .send({ tracks: [] })
      .expect(400);
    expect(res.body.error).toMatch(/no usable tracks/);
  });

  it('returns 400 when a track has neither agentId nor custom', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/roster`)
      .send({ tracks: [{ id: 'frontend', label: 'Frontend', agentId: null }] })
      .expect(400);
    expect(res.body.error).toMatch(/must have either agentId OR custom/i);
  });

  it('returns 400 when a track has both agentId and custom:true', async () => {
    const projectId = await freshProject();
    const agent = await freshAgent(projectId);
    const res = await request
      .post(`/api/projects/${projectId}/roster`)
      .send({ tracks: [{ id: 'x', label: 'X', agentId: agent, custom: true }] })
      .expect(400);
    expect(res.body.error).toMatch(/must have either agentId OR custom/i);
  });

  it('returns 400 when a track id is missing or non-string', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/roster`)
      .send({ tracks: [{ label: 'no id', custom: true }] })
      .expect(400);
    expect(res.body.error).toMatch(/id must be a non-empty string/i);
  });

  it('returns 400 when agentId references a non-existent agent', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/roster`)
      .send({ tracks: [{ id: 'backend', label: 'Backend', agentId: 'no-such-agent' }] })
      .expect(400);
    expect(res.body.error).toMatch(/unknown agentId/i);
  });

  it('returns 404 from the GET when no roster set', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/roster`).expect(404);
  });

  it('returns 404 when the project does not exist', async () => {
    await request
      .post('/api/projects/does-not-exist/roster')
      .send({ tracks: [{ id: 'x', custom: true }] })
      .expect(404);
  });

  it('creates a new agent for each custom track and links it to the project', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/roster`)
      .send({
        tracks: [
          { id: 'architect', label: 'Architect', custom: true },
          { id: 'qa', label: 'QA', custom: true },
        ],
      })
      .expect(200);

    expect(res.body.tracks).toEqual([
      { id: 'architect', label: 'Architect', agentId: `${projectId}-architect`, custom: true },
      { id: 'qa', label: 'QA', agentId: `${projectId}-qa`, custom: true },
    ]);
    // The response surfaces the minted agent rows for the landing page.
    const respAgentIds = (res.body.agents as Array<{ id: string }>).map((a) => a.id).sort();
    expect(respAgentIds).toEqual([`${projectId}-architect`, `${projectId}-qa`].sort());

    // Both new agents must be queryable through /api/agents with the
    // correct project linkage and default engine.
    const list = (await request.get('/api/agents').expect(200)).body as Array<{
      id: string;
      projectId: string;
      engine: string;
      role?: string;
      name?: string;
      cwd?: string;
    }>;
    const architect = list.find((a) => a.id === `${projectId}-architect`);
    const qa = list.find((a) => a.id === `${projectId}-qa`);
    expect(architect).toBeTruthy();
    expect(architect?.projectId).toBe(projectId);
    expect(architect?.engine).toBe('claude-code');
    expect(architect?.role).toBe('Architect');
    expect(qa?.role).toBe('QA');
  });

  it('preserves an existing agent display name when re-saving without agentName', async () => {
    const projectId = await freshProject();
    // First save mints the agent + display name.
    await request
      .post(`/api/projects/${projectId}/roster`)
      .send({
        tracks: [
          {
            id: 'frontend',
            label: 'Frontend',
            agentName: 'Scrabble UI Dev',
            custom: true,
          },
        ],
      })
      .expect(200);
    // Re-saving the roster from a context that doesn't carry `agentName`
    // (e.g. a roster picker showing the existing agents) must not clobber
    // the user-chosen name.
    await request
      .post(`/api/projects/${projectId}/roster`)
      .send({
        tracks: [{ id: 'frontend', label: 'Frontend', custom: true }],
      })
      .expect(200);
    const list = (await request.get('/api/agents').expect(200)).body as Array<{
      id: string;
      name?: string;
    }>;
    const fe = list.find((a) => a.id === `${projectId}-frontend`);
    expect(fe?.name).toBe('Scrabble UI Dev');
  });

  it('rejects an agentName longer than the max length cap', async () => {
    const projectId = await freshProject();
    const longName = 'x'.repeat(81);
    const res = await request
      .post(`/api/projects/${projectId}/roster`)
      .send({
        tracks: [{ id: 'frontend', label: 'Frontend', agentName: longName, custom: true }],
      })
      .expect(400);
    expect(res.body.error).toMatch(/80 characters or fewer/i);
  });

  it('uses agentName for the created agent display name when provided', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/roster`)
      .send({
        tracks: [
          {
            id: 'frontend',
            label: 'Frontend',
            agentName: 'Scrabble UI Dev',
            custom: true,
          },
        ],
      })
      .expect(200);

    const list = (await request.get('/api/agents').expect(200)).body as Array<{
      id: string;
      name?: string;
      role?: string;
    }>;
    const fe = list.find((a) => a.id === `${projectId}-frontend`);
    expect(fe?.name).toBe('Scrabble UI Dev');
    expect(fe?.role).toBe('Frontend');
  });

  it('is idempotent across re-runs for the same custom track', async () => {
    const projectId = await freshProject();
    const payload = {
      tracks: [{ id: 'devex', label: 'DevEx', custom: true }],
    };
    await request.post(`/api/projects/${projectId}/roster`).send(payload).expect(200);
    // Second run — must not 4xx on duplicate custom track and must not
    // create a second agent row.
    await request.post(`/api/projects/${projectId}/roster`).send(payload).expect(200);

    const list = (await request.get('/api/agents').expect(200)).body as Array<{ id: string }>;
    const matches = list.filter((a) => a.id === `${projectId}-devex`);
    expect(matches).toHaveLength(1);
  });

  it('writes AGENTS.md with the confirmed roster and re-applies idempotently', async () => {
    // Use a dedicated project so the AGENTS.md write path is isolated.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'roster-agents-md-'));
    const id = `roster-md-${uuidv4().slice(0, 8)}`;
    await request
      .post('/api/projects')
      .send({ id, name: id, cwd: tmp, color: '#3B82F6' })
      .expect(201);
    const projectId = id;

    const agentExisting = await freshAgent(projectId);

    const first = {
      tracks: [
        { id: 'backend', label: 'Backend', agentId: agentExisting },
        { id: 'architect', label: 'Architect', custom: true },
      ],
    };
    await request.post(`/api/projects/${projectId}/roster`).send(first).expect(200);

    // AGENTS.md is owned by the project workspace data dir (`ahw`),
    // not cwd. Pull the project record to find the ahw path.
    const projRes = await request.get(`/api/projects/${projectId}`).expect(200);
    const ahw = (projRes.body as { ahw: string }).ahw;
    const agentsMdPath = path.join(ahw, 'AGENTS.md');
    expect(existsSync(agentsMdPath)).toBe(true);

    let body = readFileSync(agentsMdPath, 'utf-8');
    expect(body).toContain('## Agent Roster');
    expect(body).toContain(`\`${agentExisting}\``);
    expect(body).toContain(`\`${projectId}-architect\``);
    expect(body).toContain('<!-- agent-hub-roster:start -->');
    expect(body).toContain('<!-- agent-hub-roster:end -->');

    // Second POST with a different roster — the section between the
    // markers must be rewritten, not duplicated.
    const agentExisting2 = await freshAgent(projectId);
    const second = {
      tracks: [{ id: 'frontend', label: 'Frontend', agentId: agentExisting2 }],
    };
    await request.post(`/api/projects/${projectId}/roster`).send(second).expect(200);

    body = readFileSync(agentsMdPath, 'utf-8');
    // Exactly one roster block, and it reflects the *new* roster only.
    const startMatches = body.match(/<!-- agent-hub-roster:start -->/g) ?? [];
    const endMatches = body.match(/<!-- agent-hub-roster:end -->/g) ?? [];
    expect(startMatches).toHaveLength(1);
    expect(endMatches).toHaveLength(1);
    expect(body).toContain(`\`${agentExisting2}\``);
    expect(body).not.toContain(`\`${agentExisting}\``);
    expect(body).not.toContain(`\`${projectId}-architect\``);
  });
});

describe('formatRosterSection', () => {
  it('wraps content in start/end markers', () => {
    const out = formatRosterSection([
      { id: 'backend', label: 'Backend', agentId: 'agent-a', custom: false },
      { id: 'arch', label: 'Architect', agentId: 'proj-arch', custom: true },
    ]);
    expect(out).toMatch(/^<!-- agent-hub-roster:start -->/);
    expect(out.trimEnd()).toMatch(/<!-- agent-hub-roster:end -->$/);
    expect(out).toContain('**Backend** (`agent-a`)');
    expect(out).toContain('**Architect** (`proj-arch`)');
    expect(out).toContain('_(new)_');
  });

  it('renders the user-picked display name as the heading when provided', () => {
    const out = formatRosterSection([
      {
        id: 'frontend',
        label: 'Frontend',
        agentId: 'scrabble-frontend',
        custom: true,
        displayName: 'Scrabble UI Dev',
      },
    ]);
    expect(out).toContain('**Scrabble UI Dev** (`scrabble-frontend`) — role: Frontend');
  });

  it('renders a friendly placeholder when the roster is empty', () => {
    const out = formatRosterSection([]);
    expect(out).toContain('_No agents assigned._');
  });
});
