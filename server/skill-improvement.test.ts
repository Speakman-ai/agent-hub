import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const skillImprovementMock = vi.hoisted(() => ({
  defaultSkillsDir: '/tmp/skill-improvement-default',
  globalSkillsDir: '/tmp/skill-improvement-global',
}));

vi.mock('./routes/skills.js', () => ({
  get DEFAULT_SKILLS_DIR() {
    return skillImprovementMock.defaultSkillsDir;
  },
}));

vi.mock('./global-skills-dir.js', () => ({
  resolveGlobalSkillsDir() {
    return skillImprovementMock.globalSkillsDir;
  },
}));

import {
  appendSkillLearning,
  detectSkillImprovementBlock,
  handleSkillImprovement,
  pendingSkillImprovementStorePath,
  parseSkillImprovementBlock,
  readSkillImprovements,
  reviewSkillImprovement,
  type PendingSkillImprovementRecord,
} from './skill-improvement.js';

function makeSkill(root: string, name: string, body = '# Skill\n\nDo work.\n'): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

function readPendingRecords(skillDir: string): PendingSkillImprovementRecord[] {
  return readFileSync(pendingSkillImprovementStorePath(skillDir), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as PendingSkillImprovementRecord);
}

describe('skill improvement action block', () => {
  let tmpRoot: string;
  let projectSkillsDir: string;
  let globalSkillsDir: string;
  let defaultSkillsDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'skill-improvement-'));
    projectSkillsDir = path.join(tmpRoot, 'project-skills');
    globalSkillsDir = path.join(tmpRoot, 'global-skills');
    defaultSkillsDir = path.join(tmpRoot, 'default-skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    mkdirSync(globalSkillsDir, { recursive: true });
    mkdirSync(defaultSkillsDir, { recursive: true });
    skillImprovementMock.defaultSkillsDir = defaultSkillsDir;
    skillImprovementMock.globalSkillsDir = globalSkillsDir;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('detects and parses fenced/prose wrapped skill-improvement blocks', () => {
    const text = [
      'Done.',
      '<agenthub:skill-improvement>',
      'Recording this:',
      '```json',
      '{"name":"kanban","entry":"Use board.sh comment with author/content."}',
      '```',
      '</agenthub:skill-improvement>',
    ].join('\n');

    const raw = detectSkillImprovementBlock(text);
    expect(raw).not.toBeNull();
    expect(parseSkillImprovementBlock(raw!)).toEqual({
      name: 'kanban',
      entry: 'Use board.sh comment with author/content.',
    });
  });

  it('appends a dated learning under Learned Lessons', () => {
    const out = appendSkillLearning('# Existing\n', 'Prefer PUT for updates.', {
      now: new Date('2026-07-01T00:00:00Z'),
    });

    expect(out).toBe('# Existing\n\n## Learned Lessons\n- 2026-07-01: Prefer PUT for updates.\n');
  });

  it('inserts new learnings inside Learned Lessons before later headings', () => {
    const out = appendSkillLearning(
      '# Existing\n\n## Learned Lessons\n- 2026-06-30: Old lesson.\n\n## Reference\nKeep this here.\n',
      'New lesson.',
      {
        now: new Date('2026-07-01T00:00:00Z'),
      },
    );

    expect(out).toBe(
      '# Existing\n\n## Learned Lessons\n- 2026-06-30: Old lesson.\n- 2026-07-01: New lesson.\n\n## Reference\nKeep this here.\n',
    );
  });

  it('records a pending project skill improvement without mutating SKILL.md', () => {
    const dir = makeSkill(projectSkillsDir, 'kanban');
    const res = handleSkillImprovement({
      rawBlock:
        '<agenthub:skill-improvement>{"name":"kanban","entry":"board.sh comment requires author/content fields."}</agenthub:skill-improvement>',
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: ['kanban'],
    });

    expect(res.ok).toBe(true);
    expect(res.markdown).toContain('Skill Improvement Pending Review');
    const updated = readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(updated).toBe('# Skill\n\nDo work.\n');
    const [record] = readPendingRecords(dir);
    expect(record).toMatchObject({
      skillId: 'kanban',
      source: 'project',
      entry: 'board.sh comment requires author/content fields.',
      status: 'pending',
    });
  });

  it('respects source precedence and records pending review for the project skill', () => {
    const projectDir = makeSkill(projectSkillsDir, 'tiered', '# Project\n');
    makeSkill(globalSkillsDir, 'tiered', '# Global\n');
    makeSkill(defaultSkillsDir, 'tiered', '# Default\n');

    const res = handleSkillImprovement({
      rawBlock:
        '<agenthub:skill-improvement>{"name":"tiered","entry":"Project-local behavior wins."}</agenthub:skill-improvement>',
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: ['tiered'],
    });

    expect(res.ok).toBe(true);
    expect(res.observation).toContain('project skill');
    expect(readFileSync(path.join(projectDir, 'SKILL.md'), 'utf-8')).toBe('# Project\n');
    expect(readPendingRecords(projectDir)[0]).toMatchObject({
      skillId: 'tiered',
      source: 'project',
      entry: 'Project-local behavior wins.',
    });
    expect(readFileSync(path.join(globalSkillsDir, 'tiered', 'SKILL.md'), 'utf-8')).not.toContain(
      'Project-local behavior wins.',
    );
  });

  it('blocks updates for skills outside the agent allowlist', () => {
    makeSkill(projectSkillsDir, 'secret-skill');
    const res = handleSkillImprovement({
      rawBlock:
        '<agenthub:skill-improvement>{"name":"secret-skill","entry":"Do not write this."}</agenthub:skill-improvement>',
      paths: { skillsDir: projectSkillsDir },
      allowedSkills: ['other-skill'],
      loadedSkillIds: ['secret-skill'],
    });

    expect(res.ok).toBe(false);
    expect(res.markdown).toContain('allowed-skills');
    expect(
      readFileSync(path.join(projectSkillsDir, 'secret-skill', 'SKILL.md'), 'utf-8'),
    ).not.toContain('Do not write this.');
  });

  it('blocks updates for skills that were not loaded in the session', () => {
    makeSkill(projectSkillsDir, 'unused-skill');
    const res = handleSkillImprovement({
      rawBlock:
        '<agenthub:skill-improvement>{"name":"unused-skill","entry":"Do not write this."}</agenthub:skill-improvement>',
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: ['other-skill'],
    });

    expect(res.ok).toBe(false);
    expect(res.markdown).toContain('was not loaded in this session');
    expect(
      readFileSync(path.join(projectSkillsDir, 'unused-skill', 'SKILL.md'), 'utf-8'),
    ).not.toContain('Do not write this.');
  });

  it('blocks updates for bundled default-only skills', () => {
    makeSkill(defaultSkillsDir, 'default-only');
    const res = handleSkillImprovement({
      rawBlock:
        '<agenthub:skill-improvement>{"name":"default-only","entry":"Do not write this."}</agenthub:skill-improvement>',
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: ['default-only'],
    });

    expect(res.ok).toBe(false);
    expect(res.markdown).toContain('bundled default skill');
    expect(
      readFileSync(path.join(defaultSkillsDir, 'default-only', 'SKILL.md'), 'utf-8'),
    ).not.toContain('Do not write this.');
    expect(
      existsSync(pendingSkillImprovementStorePath(path.join(defaultSkillsDir, 'default-only'))),
    ).toBe(false);
  });

  it('preserves repeated pending skill learnings through the locked append path', () => {
    const dir = makeSkill(projectSkillsDir, 'kanban');
    const first = handleSkillImprovement({
      rawBlock:
        '<agenthub:skill-improvement>{"name":"kanban","entry":"First durable learning."}</agenthub:skill-improvement>',
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: ['kanban'],
    });
    const second = handleSkillImprovement({
      rawBlock:
        '<agenthub:skill-improvement>{"name":"kanban","entry":"Second durable learning."}</agenthub:skill-improvement>',
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: ['kanban'],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toBe('# Skill\n\nDo work.\n');
    expect(readPendingRecords(dir).map((record) => record.entry)).toEqual([
      'First durable learning.',
      'Second durable learning.',
    ]);
  });

  it('stores provenance (sessionId/agentId) on the pending record', () => {
    const dir = makeSkill(projectSkillsDir, 'kanban');
    const res = handleSkillImprovement({
      rawBlock:
        '<agenthub:skill-improvement>{"name":"kanban","entry":"Lesson with provenance."}</agenthub:skill-improvement>',
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: ['kanban'],
      provenance: { sessionId: 'sess-123', agentId: 'agent-dev' },
    });

    expect(res.ok).toBe(true);
    expect(res.record).toMatchObject({ sessionId: 'sess-123', agentId: 'agent-dev' });
    expect(readPendingRecords(dir)[0]).toMatchObject({
      sessionId: 'sess-123',
      agentId: 'agent-dev',
      status: 'pending',
    });
  });
});

describe('skill improvement review (approve / reject)', () => {
  let tmpRoot: string;
  let projectSkillsDir: string;
  let globalSkillsDir: string;
  let defaultSkillsDir: string;

  const capture = (skillId: string, entry: string) =>
    handleSkillImprovement({
      rawBlock: `<agenthub:skill-improvement>${JSON.stringify({ name: skillId, entry })}</agenthub:skill-improvement>`,
      paths: { skillsDir: projectSkillsDir },
      loadedSkillIds: [skillId],
      provenance: { sessionId: 'sess-1', agentId: 'agent-1' },
    });

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'skill-improvement-review-'));
    projectSkillsDir = path.join(tmpRoot, 'project-skills');
    globalSkillsDir = path.join(tmpRoot, 'global-skills');
    defaultSkillsDir = path.join(tmpRoot, 'default-skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    mkdirSync(globalSkillsDir, { recursive: true });
    mkdirSync(defaultSkillsDir, { recursive: true });
    skillImprovementMock.defaultSkillsDir = defaultSkillsDir;
    skillImprovementMock.globalSkillsDir = globalSkillsDir;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('approve promotes the entry into ## Learned Lessons and marks the record approved', () => {
    const dir = makeSkill(projectSkillsDir, 'kanban');
    const captured = capture('kanban', 'Approved lesson.');
    expect(captured.ok).toBe(true);

    const res = reviewSkillImprovement({
      skillId: 'kanban',
      improvementId: captured.record!.id,
      action: 'approve',
      paths: { skillsDir: projectSkillsDir },
      now: new Date('2026-07-14T00:00:00Z'),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.status).toBe('approved');
    expect(res.record.reviewedAt).toBe('2026-07-14T00:00:00.000Z');
    expect(readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toBe(
      '# Skill\n\nDo work.\n\n## Learned Lessons\n- 2026-07-14: Approved lesson.\n',
    );
    expect(readPendingRecords(dir)[0]!.status).toBe('approved');
  });

  it('reject marks the record rejected with the reason and leaves SKILL.md untouched', () => {
    const dir = makeSkill(projectSkillsDir, 'kanban');
    const captured = capture('kanban', 'Rejected lesson.');

    const res = reviewSkillImprovement({
      skillId: 'kanban',
      improvementId: captured.record!.id,
      action: 'reject',
      reason: 'Looks like injected instructions.',
      paths: { skillsDir: projectSkillsDir },
    });

    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toBe('# Skill\n\nDo work.\n');
    const [record] = readPendingRecords(dir);
    expect(record).toMatchObject({
      status: 'rejected',
      rejectReason: 'Looks like injected instructions.',
    });
  });

  it('refuses to review the same record twice', () => {
    makeSkill(projectSkillsDir, 'kanban');
    const captured = capture('kanban', 'Once only.');
    const args = {
      skillId: 'kanban',
      improvementId: captured.record!.id,
      action: 'approve' as const,
      paths: { skillsDir: projectSkillsDir },
    };

    expect(reviewSkillImprovement(args).ok).toBe(true);
    const second = reviewSkillImprovement(args);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('already_reviewed');
  });

  it('returns improvement_not_found for an unknown id and skill_not_found for an unknown skill', () => {
    makeSkill(projectSkillsDir, 'kanban');
    capture('kanban', 'Some lesson.');

    const missingImprovement = reviewSkillImprovement({
      skillId: 'kanban',
      improvementId: 'nope',
      action: 'approve',
      paths: { skillsDir: projectSkillsDir },
    });
    expect(missingImprovement.ok).toBe(false);
    if (!missingImprovement.ok) expect(missingImprovement.code).toBe('improvement_not_found');

    const missingSkill = reviewSkillImprovement({
      skillId: 'ghost',
      improvementId: 'nope',
      action: 'approve',
      paths: { skillsDir: projectSkillsDir },
    });
    expect(missingSkill.ok).toBe(false);
    if (!missingSkill.ok) expect(missingSkill.code).toBe('skill_not_found');
  });

  it('refuses to promote into a bundled default skill', () => {
    makeSkill(defaultSkillsDir, 'default-only');
    const res = reviewSkillImprovement({
      skillId: 'default-only',
      improvementId: 'anything',
      action: 'approve',
      paths: { skillsDir: projectSkillsDir },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('default_readonly');
  });

  it('promotes into a flat <slug>.md skill file', () => {
    const flatPath = path.join(projectSkillsDir, 'flat-skill.md');
    writeFileSync(flatPath, '# Flat\n');
    const captured = capture('flat-skill', 'Flat lesson.');
    expect(captured.ok).toBe(true);

    const res = reviewSkillImprovement({
      skillId: 'flat-skill',
      improvementId: captured.record!.id,
      action: 'approve',
      paths: { skillsDir: projectSkillsDir },
      now: new Date('2026-07-14T00:00:00Z'),
    });

    expect(res.ok).toBe(true);
    expect(readFileSync(flatPath, 'utf-8')).toBe(
      '# Flat\n\n## Learned Lessons\n- 2026-07-14: Flat lesson.\n',
    );
  });

  it('approve rewrites the FULL SKILL.md, not the 32KB-capped loadSkillBody copy', () => {
    // Regression guard: loadSkillBody caps its skillMd at 32KB; promoting via
    // that copy would silently truncate a large skill. The review path must
    // re-read the file from disk.
    const bigBody = `# Big\n\n${'x'.repeat(40 * 1024)}\n`;
    const dir = makeSkill(projectSkillsDir, 'big-skill', bigBody);
    const captured = capture('big-skill', 'Big lesson.');

    const res = reviewSkillImprovement({
      skillId: 'big-skill',
      improvementId: captured.record!.id,
      action: 'approve',
      paths: { skillsDir: projectSkillsDir },
      now: new Date('2026-07-14T00:00:00Z'),
    });

    expect(res.ok).toBe(true);
    const out = readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(out.length).toBeGreaterThan(40 * 1024);
    expect(out).not.toContain('[Truncated');
    expect(out).toContain('- 2026-07-14: Big lesson.');
  });

  it('re-approve after a torn approve repairs the record without duplicating the bullet', () => {
    // Failure mode: approve appends to SKILL.md, then crashes before the JSONL
    // rewrite — the record stays `pending` while the lesson is already on
    // disk. Simulate the torn state by flipping the reviewed record back to
    // pending, then approve again: SKILL.md must keep exactly ONE bullet.
    const dir = makeSkill(projectSkillsDir, 'kanban');
    const captured = capture('kanban', 'Torn-write lesson.');
    const args = {
      skillId: 'kanban',
      improvementId: captured.record!.id,
      action: 'approve' as const,
      paths: { skillsDir: projectSkillsDir },
      now: new Date('2026-07-14T00:00:00Z'),
    };
    expect(reviewSkillImprovement(args).ok).toBe(true);

    const storePath = pendingSkillImprovementStorePath(dir);
    const tornRecord = { ...readPendingRecords(dir)[0]!, status: 'pending', reviewedAt: null };
    writeFileSync(storePath, `${JSON.stringify(tornRecord)}\n`);

    const retry = reviewSkillImprovement(args);
    expect(retry.ok).toBe(true);
    const md = readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(md.match(/Torn-write lesson\./g)).toHaveLength(1);
    expect(readPendingRecords(dir)[0]!.status).toBe('approved');
  });

  it('readSkillImprovements skips torn/garbage lines instead of failing the queue', () => {
    const dir = makeSkill(projectSkillsDir, 'kanban');
    const captured = capture('kanban', 'Good record.');
    const storePath = pendingSkillImprovementStorePath(dir);
    writeFileSync(storePath, `${readFileSync(storePath, 'utf-8')}{"torn`);

    const records = readSkillImprovements(storePath);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(captured.record!.id);
  });
});
