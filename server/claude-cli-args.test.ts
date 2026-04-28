/**
 * Tests for `disableNativeSkillToolArgs` and the `--disallowed-tools Skill`
 * wiring in our Claude Code spawn sites.
 *
 * Regression coverage for bug: "Couldnt find tool skill"
 * (screenshot showed `Skill aws-infra → <tool_use_error>Unknown skill:
 * aws-infra</tool_use_error>`).
 *
 * Agent Hub injects its own `## Available Skills` section into enriched
 * prompts and tells agents to load skills via the `<agenthub:skill>` block.
 * Some of those skills (`aws-infra`, `design`, `designs`) are Agent-Hub-only
 * and not in Claude Code's bundled skill list — so when an agent fell back
 * to the native `Skill` tool, the call would error with `Unknown skill`,
 * waste a turn, and surface a confusing failure to the user.
 *
 * The fix disables the native `Skill` tool via `--disallowed-tools Skill`
 * everywhere we spawn Claude Code with an Agent-Hub-enriched prompt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { disableNativeSkillToolArgs } from './claude-cli-args.js';
import { buildDesignSpawnArgs } from './design-multi-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('disableNativeSkillToolArgs', () => {
  it('returns the --disallowed-tools Skill flag pair', () => {
    const args = disableNativeSkillToolArgs();
    expect(args).toEqual(['--disallowed-tools', 'Skill']);
  });

  it('returns a fresh array each call so callers can safely mutate it', () => {
    const a = disableNativeSkillToolArgs();
    const b = disableNativeSkillToolArgs();
    expect(a).not.toBe(b);
    a.push('extra');
    expect(disableNativeSkillToolArgs()).toEqual(['--disallowed-tools', 'Skill']);
  });
});

describe('Claude spawn args include --disallowed-tools Skill', () => {
  // Source-level grep regression: every Agent-Hub-enriched Claude Code
  // spawn site must wire `disableNativeSkillToolArgs()` (or the equivalent
  // literal flag pair). If a future refactor drops the call from any
  // module here, the bug class silently comes back for that path. The
  // table below lists every spawn site we audited at the time of the
  // "Couldnt find tool skill" fix; new spawn sites should be added here.
  const spawnSites: Array<{ file: string; reason: string }> = [
    { file: 'chat.ts', reason: 'main interactive chat session' },
    { file: 'delegation.ts', reason: '<delegate> sub-agent + synthesis' },
    { file: 'room-chat.ts', reason: 'conference room replies' },
    { file: 'heartbeat.ts', reason: 'runClaude — heartbeats / crons / workflow' },
    { file: 'slack.ts', reason: 'Slack one-shot' },
    { file: 'memory.ts', reason: 'memory reconciliation' },
    { file: 'design-multi-engine.ts', reason: 'Design Studio (via design-chat)' },
  ];

  it.each(spawnSites)(
    '$file imports disableNativeSkillToolArgs and wires it ($reason)',
    ({ file }) => {
      const src = readFileSync(path.join(__dirname, file), 'utf-8');
      expect(src.includes("from './claude-cli-args.js'"), `${file} must import the helper`).toBe(
        true,
      );
      expect(
        src.includes('disableNativeSkillToolArgs('),
        `${file} must call disableNativeSkillToolArgs()`,
      ).toBe(true);
    },
  );

  // Behavioural pin for the one path that exposes a pure args-builder we
  // can call directly. The other six are covered by the source-level
  // grep above plus their own existing prompt-structure tests.
  it('design-multi-engine spawns Claude with --disallowed-tools Skill', () => {
    const { args } = buildDesignSpawnArgs({
      designId: 'design-uuid-1',
      systemPrompt: 'SYS',
      cliContent: 'Do the thing',
      priorMessages: [],
      bins: {
        claude: '/bin/claude',
        cursor: '/bin/cursor-agent',
        gemini: '/bin/gemini',
        codex: '/bin/codex',
      },
      engine: 'claude-code',
      model: 'claude-opus-4-7',
      engineSessionId: null,
      isNewEngineSession: true,
    });
    expect(args).toContain('--disallowed-tools');
    const idx = args.indexOf('--disallowed-tools');
    expect(args[idx + 1]).toBe('Skill');
    // Prompt body must remain the last element so the CLI parses it as
    // the user message rather than a flag value.
    expect(args[args.length - 1]).toBe('Do the thing');
  });
});
