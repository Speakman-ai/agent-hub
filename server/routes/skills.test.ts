import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { syncSkillsToClaude } from './skills.js';

/**
 * Regression guard for the ClawHub-installed-skill registration bug:
 * skills installed into a project's skillsDir were never synced to the
 * Claude Code CLI's plugin dir, so the CLI couldn't see them. The fix
 * exposes `syncSkillsToClaude(extraSkillDirs)` — this test proves that
 * an extra dir's skill actually lands in the CLI's plugin target.
 */
describe('syncSkillsToClaude', () => {
  let tmpRoot: string;
  let fakeHome: string;
  let extraSkillsDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `skills-sync-test-${process.pid}-${Date.now()}`);
    fakeHome = path.join(tmpRoot, 'home');
    extraSkillsDir = path.join(tmpRoot, 'project-skills');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(extraSkillsDir, { recursive: true });

    // Drop a fake-skill/SKILL.md into the simulated project skillsDir.
    const fakeSkillDir = path.join(extraSkillsDir, 'fake-skill');
    mkdirSync(fakeSkillDir, { recursive: true });
    writeFileSync(
      path.join(fakeSkillDir, 'SKILL.md'),
      '---\nname: fake-skill\ndescription: regression guard\ncategory: test\n---\nbody\n',
    );

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    // USERPROFILE is Windows' equivalent — stub it too so the function's
    // `HOME || USERPROFILE` fallback can't accidentally pick up a real dir.
    delete process.env.USERPROFILE;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('registers a project-scoped skill with the Claude Code CLI', () => {
    syncSkillsToClaude([extraSkillsDir]);

    // In plugin mode (plugin/ exists in the repo), the target is
    // ~/.claude/plugins/local/agent-hub-skills/skills/<skill>/SKILL.md.
    // In fallback mode, the target is ~/.claude/commands/<skill>.md.
    // The function handles whichever applies — accept either shape here
    // so the test works regardless of the checkout state.
    const pluginPath = path.join(
      fakeHome,
      '.claude',
      'plugins',
      'local',
      'agent-hub-skills',
      'skills',
      'fake-skill',
      'SKILL.md',
    );
    const commandsPath = path.join(fakeHome, '.claude', 'commands', 'fake-skill.md');

    const landedAtPlugin = existsSync(pluginPath);
    const landedAtCommands = existsSync(commandsPath);
    expect(
      landedAtPlugin || landedAtCommands,
      `fake-skill missing from both\n  plugin: ${pluginPath}\n  commands: ${commandsPath}`,
    ).toBe(true);

    const body = readFileSync(landedAtPlugin ? pluginPath : commandsPath, 'utf-8');
    expect(body).toContain('name: fake-skill');
    expect(body).toContain('regression guard');
  });

  it('is a no-op (no crash) when extraSkillDirs is empty', () => {
    expect(() => syncSkillsToClaude([])).not.toThrow();
  });

  it('ignores extra dirs that do not exist', () => {
    const bogus = path.join(tmpRoot, 'does-not-exist');
    expect(() => syncSkillsToClaude([bogus, extraSkillsDir])).not.toThrow();
  });
});
