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
});
