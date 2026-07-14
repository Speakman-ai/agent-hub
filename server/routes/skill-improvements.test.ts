/**
 * Integration tests for the skill-improvement review routes (list / approve /
 * reject) — the human half of the <agenthub:skill-improvement> loop.
 *
 * The project skill tier is pointed at a temp dataDir via
 * `setProjectSkillsDataDir`; the global tier is mocked to a temp dir so a
 * developer machine's real `<dataDir>/skills` queues can't leak into the
 * list assertions. Records are seeded through the real capture path
 * (`handleSkillImprovement`) so the round trip capture → list → review is
 * exercised end-to-end. No CLI is spawned anywhere in this path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Role } from '../roles.js';

const globalDirMock = vi.hoisted(() => ({ dir: '/tmp/skill-improvement-routes-global-unset' }));
vi.mock('../global-skills-dir.js', () => ({
  resolveGlobalSkillsDir: () => globalDirMock.dir,
}));

const { default: createSkillRoutes } = await import('./skills.js');
const { setProjectSkillsDataDir, resolveProjectSkillsDir } =
  await import('../project-skill-paths.js');
const { handleSkillImprovement } = await import('../skill-improvement.js');

const PROJECT_ID = 'proj';
const SKILL_ID = 'kanban-helper';

// `authRole` stands in for what authMiddleware sets in production (this
// standalone app has no auth middleware). Approve/reject are gated by
// requireRole('Admin'); pass 'User' to exercise the 403 path.
function buildApp(authRole: Role = 'Admin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authRole?: Role; authUserId?: string }).authRole = authRole;
    (req as unknown as { authRole?: Role; authUserId?: string }).authUserId = 'test-user';
    next();
  });
  const project = { id: PROJECT_ID, name: 'Proj', cwd: '/tmp' };
  const broadcast = vi.fn();
  const deps = {
    findAgent: () => null,
    findProject: (id: string) => (id === PROJECT_ID ? project : null),
    getProjects: () => [project],
    stmts: {},
    broadcast,
  };
  app.use(createSkillRoutes(deps as unknown as Parameters<typeof createSkillRoutes>[0]));
  return { app, broadcast };
}

describe('skill improvement review routes', () => {
  let tmpRoot: string;
  let projectSkillsDir: string;

  const seedSkill = (body = '# Skill\n\nDo work.\n') => {
    const dir = path.join(projectSkillsDir, SKILL_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${SKILL_ID}\ndescription: t\n---\n${body}`,
    );
    return path.join(dir, 'SKILL.md');
  };

  const seedImprovement = (entry: string) => {
    const res = handleSkillImprovement({
      rawBlock: `<agenthub:skill-improvement>${JSON.stringify({ name: SKILL_ID, entry })}</agenthub:skill-improvement>`,
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: [SKILL_ID],
      provenance: { sessionId: 'sess-42', agentId: 'agent-dev' },
    });
    expect(res.ok).toBe(true);
    return res.record!;
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'skill-improvement-routes-'));
    globalDirMock.dir = path.join(tmpRoot, 'global-skills');
    mkdirSync(globalDirMock.dir, { recursive: true });
    setProjectSkillsDataDir(tmpRoot);
    projectSkillsDir = resolveProjectSkillsDir({ id: PROJECT_ID });
    mkdirSync(projectSkillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const listUrl = `/api/projects/${PROJECT_ID}/skill-improvements`;
  const reviewUrl = (improvementId: string, action: 'approve' | 'reject') =>
    `/api/projects/${PROJECT_ID}/skills/${SKILL_ID}/improvements/${improvementId}/${action}`;

  it('lists pending improvements with provenance and skill name', async () => {
    seedSkill();
    const record = seedImprovement('Always pass --no-pager.');
    const { app } = buildApp();

    const res = await supertest(app).get(listUrl);
    expect(res.status).toBe(200);
    expect(res.body.improvements).toHaveLength(1);
    expect(res.body.improvements[0]).toMatchObject({
      id: record.id,
      skillId: SKILL_ID,
      skillName: SKILL_ID,
      source: 'project',
      entry: 'Always pass --no-pager.',
      status: 'pending',
      sessionId: 'sess-42',
      agentId: 'agent-dev',
    });
  });

  it('rejects an invalid status filter and unknown project', async () => {
    const { app } = buildApp();
    expect((await supertest(app).get(`${listUrl}?status=bogus`)).status).toBe(400);
    expect((await supertest(app).get('/api/projects/ghost/skill-improvements')).status).toBe(404);
  });

  it('approve promotes into SKILL.md, broadcasts, and drains the pending list', async () => {
    const mdPath = seedSkill();
    const record = seedImprovement('Approved via API.');
    const { app, broadcast } = buildApp();

    const res = await supertest(app).post(reviewUrl(record.id, 'approve'));
    expect(res.status).toBe(200);
    expect(res.body.improvement.status).toBe('approved');
    expect(readFileSync(mdPath, 'utf-8')).toContain('## Learned Lessons');
    expect(readFileSync(mdPath, 'utf-8')).toContain('Approved via API.');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'skill_improvement_update',
        projectId: PROJECT_ID,
        skillId: SKILL_ID,
        improvementId: record.id,
        action: 'approved',
      }),
    );

    const after = await supertest(app).get(listUrl);
    expect(after.body.improvements).toHaveLength(0);
    const approved = await supertest(app).get(`${listUrl}?status=approved`);
    expect(approved.body.improvements).toHaveLength(1);
  });

  it('reject keeps SKILL.md untouched and stores the reason for audit', async () => {
    const mdPath = seedSkill();
    const before = readFileSync(mdPath, 'utf-8');
    const record = seedImprovement('Suspicious lesson.');
    const { app } = buildApp();

    const res = await supertest(app)
      .post(reviewUrl(record.id, 'reject'))
      .send({ reason: 'Reads like prompt injection.' });
    expect(res.status).toBe(200);
    expect(res.body.improvement).toMatchObject({
      status: 'rejected',
      rejectReason: 'Reads like prompt injection.',
    });
    expect(readFileSync(mdPath, 'utf-8')).toBe(before);

    const rejected = await supertest(app).get(`${listUrl}?status=rejected`);
    expect(rejected.body.improvements).toHaveLength(1);
  });

  it('blocks approve below Admin (403) without touching SKILL.md', async () => {
    const mdPath = seedSkill();
    const before = readFileSync(mdPath, 'utf-8');
    const record = seedImprovement('Should not land.');
    const { app } = buildApp('User');

    const res = await supertest(app).post(reviewUrl(record.id, 'approve'));
    expect(res.status).toBe(403);
    expect(readFileSync(mdPath, 'utf-8')).toBe(before);
  });

  it('returns 409 on double review and 404 for an unknown improvement', async () => {
    seedSkill();
    const record = seedImprovement('Reviewed once.');
    const { app } = buildApp();

    expect((await supertest(app).post(reviewUrl(record.id, 'approve'))).status).toBe(200);
    const second = await supertest(app).post(reviewUrl(record.id, 'approve'));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_reviewed');

    const missing = await supertest(app).post(reviewUrl('does-not-exist', 'approve'));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('improvement_not_found');
  });
});
