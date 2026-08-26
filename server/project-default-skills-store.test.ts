import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync } from 'fs';
import { initDb } from './db.js';
import {
  listProjectDefaultSkillIds,
  addProjectDefaultSkill,
  removeProjectDefaultSkill,
} from './project-default-skills-store.js';

describe('project-default-skills-store', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = path.join(
      os.tmpdir(),
      `agent-hub-projdefaultskills-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    initDb(dataDir);
  });

  afterAll(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('starts empty', () => {
    expect(listProjectDefaultSkillIds('proj-a')).toEqual([]);
  });

  it('adds skills and lists them sorted, scoped per project', () => {
    addProjectDefaultSkill('proj-a', 'survey-tracker');
    addProjectDefaultSkill('proj-a', 'agent-hub-kanban');
    addProjectDefaultSkill('proj-b', 'other-skill');
    expect(listProjectDefaultSkillIds('proj-a')).toEqual(['agent-hub-kanban', 'survey-tracker']);
    expect(listProjectDefaultSkillIds('proj-b')).toEqual(['other-skill']);
  });

  it('is idempotent on duplicate add (ON CONFLICT DO NOTHING)', () => {
    addProjectDefaultSkill('proj-a', 'survey-tracker');
    expect(listProjectDefaultSkillIds('proj-a')).toEqual(['agent-hub-kanban', 'survey-tracker']);
  });

  it('removes a skill and reports ok, false when absent', () => {
    expect(removeProjectDefaultSkill('proj-a', 'survey-tracker').ok).toBe(true);
    expect(listProjectDefaultSkillIds('proj-a')).toEqual(['agent-hub-kanban']);
    expect(removeProjectDefaultSkill('proj-a', 'survey-tracker').ok).toBe(false);
  });
});
