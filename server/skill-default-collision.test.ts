import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { skillDirHasSkill, resolveSkillInDir } from './routes/skills.js';

/**
 * `skillDirHasSkill` is the pure core of the bundled-default collision guard
 * (`isBundledDefaultSkill` = `skillDirHasSkill(DEFAULT_SKILLS_DIR, …)`). Testing
 * it against a throwaway temp dir keeps the FLAT-default (`<slug>.md`) case
 * covered WITHOUT mutating the checked-in `server/default-skills` directory —
 * which would race with concurrent tests that enumerate bundled skills and
 * could leak a stray file on interruption.
 */
describe('skillDirHasSkill (bundled-default collision core)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'skill-default-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects the directory form (<dir>/<slug>/SKILL.md)', () => {
    const skillDir = path.join(dir, 'dir-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# x');
    expect(skillDirHasSkill(dir, 'dir-skill')).toBe(true);
  });

  it('detects the FLAT form (<dir>/<slug>.md) — the regression the guard missed', () => {
    writeFileSync(path.join(dir, 'flat-skill.md'), '# x');
    expect(skillDirHasSkill(dir, 'flat-skill')).toBe(true);
  });

  it('returns false when neither form is present', () => {
    expect(skillDirHasSkill(dir, 'absent')).toBe(false);
  });

  it('does not treat a non-matching flat file as a collision', () => {
    writeFileSync(path.join(dir, 'something-else.md'), '# x');
    expect(skillDirHasSkill(dir, 'flat-skill')).toBe(false);
  });

  it('returns false for a plain (non-.md) file sharing the slug name', () => {
    writeFileSync(path.join(dir, 'plain'), 'x');
    expect(skillDirHasSkill(dir, 'plain')).toBe(false);
  });
});

describe('resolveSkillInDir (read/update/delete form resolution)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'skill-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the directory form when <slug>/SKILL.md exists', () => {
    const skillDir = path.join(dir, 'd');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# d');
    expect(resolveSkillInDir(dir, 'd')).toEqual({
      kind: 'dir',
      dir: skillDir,
      mdPath: path.join(skillDir, 'SKILL.md'),
    });
  });

  it('resolves the flat form when only <slug>.md exists', () => {
    const flat = path.join(dir, 'f.md');
    writeFileSync(flat, '# f');
    expect(resolveSkillInDir(dir, 'f')).toEqual({ kind: 'flat', mdPath: flat });
  });

  it('falls through a STALE directory (no SKILL.md) to a valid flat <slug>.md', () => {
    // Stale/resource-only dir beside the real flat skill — must NOT shadow it.
    mkdirSync(path.join(dir, 'g', 'references'), { recursive: true });
    writeFileSync(path.join(dir, 'g', 'references', 'r.md'), 'ref');
    const flat = path.join(dir, 'g.md');
    writeFileSync(flat, '# g');
    expect(resolveSkillInDir(dir, 'g')).toEqual({ kind: 'flat', mdPath: flat });
    expect(skillDirHasSkill(dir, 'g')).toBe(true);
  });

  it('returns null for a stale directory with no SKILL.md and no flat file', () => {
    mkdirSync(path.join(dir, 'empty'), { recursive: true });
    expect(resolveSkillInDir(dir, 'empty')).toBeNull();
    expect(skillDirHasSkill(dir, 'empty')).toBe(false);
  });
});
