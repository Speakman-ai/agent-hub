import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'agent-hub');
const PLUGIN_SKILL_DIR = path.join(__dirname, '..', '..', 'plugin', 'skills', 'agent-hub');
const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugin');

/**
 * Distribution guards for the `agent-hub` skill.
 *
 * The skill is the first thing every agent running on Agent Hub loads, and the
 * server syncs `plugin/` into `~/.claude/plugins/local/agent-hub-skills` on
 * startup (`routes/skills.ts::syncDefaultSkillsToClaude`). If scripts lose the
 * executable bit during that copy — or if the SKILL.md body drifts and scripts
 * are missing from disk — a delegated sub-agent that tries to shell out to
 * `scripts/ah-api.sh` silently fails.
 *
 * These tests lock in the on-disk invariants that make the acceptance case
 * ("sub-agent can invoke scripts/ah-api.sh without additional setup") hold.
 */

const STRUCTURE_DIRS = ['scripts', 'references', 'evals'] as const;

function assertExecutable(file: string, label: string): void {
  const mode = statSync(file).mode;
  // Unix: any of owner/group/other execute bits must be set.
  const isExec = (mode & 0o111) !== 0;
  expect(isExec, `${label}: ${file} is missing the executable bit (mode=${mode.toString(8)})`).toBe(
    true,
  );
}

describe('agent-hub skill — distribution integrity', () => {
  it.each([
    ['default-skills', DEFAULT_SKILL_DIR],
    ['plugin mirror', PLUGIN_SKILL_DIR],
  ])('%s ships the full structure (scripts/, references/, evals/)', (label, dir) => {
    if (label === 'plugin mirror' && !existsSync(dir)) return;
    for (const sub of STRUCTURE_DIRS) {
      expect(existsSync(path.join(dir, sub)), `${label}: ${sub}/ missing from ${dir}`).toBe(true);
    }
  });

  it.each([
    ['default-skills', DEFAULT_SKILL_DIR],
    ['plugin mirror', PLUGIN_SKILL_DIR],
  ])('%s ships every scripts/*.sh with the executable bit set', (label, dir) => {
    if (label === 'plugin mirror' && !existsSync(dir)) return;
    const scriptsDir = path.join(dir, 'scripts');
    const scripts = readdirSync(scriptsDir).filter((f) => f.endsWith('.sh'));
    expect(scripts.length, `${label}: scripts/ is empty`).toBeGreaterThan(0);
    for (const name of scripts) {
      assertExecutable(path.join(scriptsDir, name), label);
    }
  });

  it('cpSync (the plugin sync path) preserves executable bits end-to-end', () => {
    // Simulate what `syncDefaultSkillsToClaude` does: recursive copy of the
    // plugin directory to a fresh destination. If Node's fs.cpSync ever stops
    // preserving modes on this platform, the sub-agent regression we saw in
    // the skill distribution card would return silently — so guard it here.
    if (!existsSync(PLUGIN_ROOT)) return;

    const tmpDest = path.join(os.tmpdir(), `agent-hub-skill-sync-${Date.now()}`);
    try {
      mkdirSync(tmpDest, { recursive: true });
      cpSync(PLUGIN_ROOT, tmpDest, { recursive: true });

      const copiedScripts = path.join(tmpDest, 'skills', 'agent-hub', 'scripts');
      expect(
        existsSync(copiedScripts),
        `sync destination is missing skills/agent-hub/scripts/`,
      ).toBe(true);

      const scripts = readdirSync(copiedScripts).filter((f) => f.endsWith('.sh'));
      expect(scripts.length, 'sync destination scripts/ is empty').toBeGreaterThan(0);
      for (const name of scripts) {
        assertExecutable(path.join(copiedScripts, name), 'sync destination');
      }
    } finally {
      rmSync(tmpDest, { recursive: true, force: true });
    }
  });

  it('cpSync preserves the executable bit on a freshly chmod +x script', () => {
    // Isolation test: explicitly chmod a script to 0o755 in a source tree and
    // confirm the bit survives the copy. Catches regressions caused by future
    // changes to the sync routine that strip modes (e.g. readFile/writeFile).
    const tmpSrc = path.join(os.tmpdir(), `cp-mode-src-${Date.now()}`);
    const tmpDst = path.join(os.tmpdir(), `cp-mode-dst-${Date.now()}`);
    try {
      mkdirSync(path.join(tmpSrc, 'scripts'), { recursive: true });
      const scriptPath = path.join(tmpSrc, 'scripts', 'probe.sh');
      writeFileSync(scriptPath, '#!/usr/bin/env bash\necho probe\n');
      chmodSync(scriptPath, 0o755);

      cpSync(tmpSrc, tmpDst, { recursive: true });

      assertExecutable(path.join(tmpDst, 'scripts', 'probe.sh'), 'probe');
    } finally {
      rmSync(tmpSrc, { recursive: true, force: true });
      rmSync(tmpDst, { recursive: true, force: true });
    }
  });
});
