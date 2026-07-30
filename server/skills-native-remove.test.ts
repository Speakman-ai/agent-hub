import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { removeSkillFromClaude, syncSkillsToClaude } from './routes/skills.js';

/**
 * removeSkillFromClaude is the delete-side inverse of syncSkillsToClaude. Since
 * the sync is purely additive (cpSync on top, never prunes), a deleted global
 * skill would linger in Claude's native skill targets until restart — so delete
 * must actively remove it from the plugin target. These tests pin that
 * behavior under a throwaway HOME.
 */
describe('removeSkillFromClaude', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('removes the plugin-mode skill dir (including nested resources)', () => {
    const pluginSkillDir = path.join(
      tmpHome,
      '.claude',
      'plugins',
      'local',
      'agent-hub-skills',
      'skills',
      'gone',
    );
    mkdirSync(path.join(pluginSkillDir, 'references'), { recursive: true });
    writeFileSync(path.join(pluginSkillDir, 'SKILL.md'), '# gone');
    writeFileSync(path.join(pluginSkillDir, 'references', 'r.md'), 'ref');

    removeSkillFromClaude('gone');
    expect(existsSync(pluginSkillDir)).toBe(false);
  });

  it('is a no-op (no throw) when the skill is not present', () => {
    expect(() => removeSkillFromClaude('never-installed')).not.toThrow();
  });

  it('refuses path-traversal ids without touching the filesystem', () => {
    const sibling = path.join(tmpHome, '.claude', 'commands', 'keep.md');
    mkdirSync(path.dirname(sibling), { recursive: true });
    writeFileSync(sibling, 'keep');
    removeSkillFromClaude('../keep');
    expect(existsSync(sibling)).toBe(true);
  });
});

describe('native-target tier precedence when a global skill changes', () => {
  let tmpHome: string;
  let tmpSrc: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    tmpSrc = mkdtempSync(path.join(os.tmpdir(), 'skill-src-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpSrc, { recursive: true, force: true });
  });

  /** Build a `<dir>/<id>/SKILL.md` source skill with a distinguishable marker. */
  function makeSkillDir(tier: string, id: string, marker: string): string {
    const dir = path.join(tmpSrc, tier);
    const skillDir = path.join(dir, id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${marker}\n---\n`,
    );
    return dir;
  }

  /** Read the native plugin target syncSkillsToClaude writes to. */
  function nativeSkillContent(id: string): string | null {
    const pluginMd = path.join(
      tmpHome,
      '.claude',
      'plugins',
      'local',
      'agent-hub-skills',
      'skills',
      id,
      'SKILL.md',
    );
    if (existsSync(pluginMd)) return readFileSync(pluginMd, 'utf-8');
    return null;
  }

  const ID = 'zz-precedence-shared';

  it('a same-id project skill wins over global in the native target (project last in sync order)', () => {
    const globalDir = makeSkillDir('global', ID, 'GLOBAL_VERSION');
    const projectDir = makeSkillDir('project', ID, 'PROJECT_VERSION');

    // Matches the create/update route order: [globalDir, ...projectSkillDirs()].
    syncSkillsToClaude([globalDir, projectDir]);

    expect(nativeSkillContent(ID)).toContain('PROJECT_VERSION');
  });

  it('deleting a global skill restores the shadowed same-id project skill (no hole)', () => {
    const globalDir = makeSkillDir('global', ID, 'GLOBAL_VERSION');
    const projectDir = makeSkillDir('project', ID, 'PROJECT_VERSION');

    // Pre-state: global copy present in the native target.
    syncSkillsToClaude([globalDir]);
    // Delete route sequence: drop global copy, then re-assert project tier.
    removeSkillFromClaude(ID);
    syncSkillsToClaude([projectDir]);

    expect(nativeSkillContent(ID)).toContain('PROJECT_VERSION');
  });

  it('deleting a global-only skill leaves no native target when no project defines it', () => {
    const globalDir = makeSkillDir('global', 'zz-precedence-globalonly', 'GLOBAL_ONLY');
    syncSkillsToClaude([globalDir]);
    expect(nativeSkillContent('zz-precedence-globalonly')).toContain('GLOBAL_ONLY');

    removeSkillFromClaude('zz-precedence-globalonly');
    syncSkillsToClaude([]); // no project provides it

    expect(nativeSkillContent('zz-precedence-globalonly')).toBeNull();
  });
});
