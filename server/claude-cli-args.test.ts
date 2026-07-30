/**
 * Tests for `disableShadowedNativeToolsArgs` (canonical name) plus the
 * legacy alias `disableNativeSkillToolArgs`, and the `--disallowed-tools`
 * wiring in our Claude Code spawn sites.
 *
 * Regression coverage for two related bugs:
 *
 *   1. "Couldnt find tool skill" — screenshot showed
 *      `Skill aws-infra → <tool_use_error>Unknown skill: aws-infra</tool_use_error>`.
 *      Some Agent-Hub-only skills (`aws-infra`, `design`, `designs`) aren't
 *      in Claude Code's bundled skill list, so the native `Skill` tool errors.
 *
 *   2. "AskUserQuestion ERROR / Answer questions?" — model invoked the
 *      native `AskUserQuestion` tool instead of emitting an `agenthub:ask`
 *      fenced block. Agent Hub doesn't bridge the native tool to its own
 *      picker UI, so the tool_use renders as a generic failed call.
 *
 * Both classes are fixed the same way: disable the native tool via
 * `--disallowed-tools <tool>` on every Agent-Hub-enriched Claude Code spawn.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  claudePermissionModeForSpawn,
  disableShadowedNativeToolsArgs,
  disableNativeSkillToolArgs,
  CODE_MUTATION_NATIVE_TOOLS,
  SHADOWED_NATIVE_TOOLS,
} from './claude-cli-args.js';
import { buildDesignSpawnArgs } from './design-multi-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('claudePermissionModeForSpawn', () => {
  it('returns default when the Hub process is root (Claude refuses bypass as euid 0)', () => {
    const getuid = process.getuid;
    process.getuid = () => 0;
    try {
      expect(claudePermissionModeForSpawn('bypassPermissions')).toBe('default');
      expect(claudePermissionModeForSpawn('plan')).toBe('plan');
    } finally {
      process.getuid = getuid;
    }
  });

  it('passes bypassPermissions through for non-root spawns', () => {
    const getuid = process.getuid;
    process.getuid = () => 501;
    try {
      expect(claudePermissionModeForSpawn('bypassPermissions')).toBe('bypassPermissions');
    } finally {
      process.getuid = getuid;
    }
  });
});

describe('disableShadowedNativeToolsArgs', () => {
  it('returns the --disallowed-tools flag followed by every shadowed tool', () => {
    const args = disableShadowedNativeToolsArgs();
    expect(args).toEqual(['--disallowed-tools', ...SHADOWED_NATIVE_TOOLS]);
  });

  it('includes Skill (replaced by <agenthub:skill>)', () => {
    expect(disableShadowedNativeToolsArgs()).toContain('Skill');
  });

  it('includes AskUserQuestion (replaced by agenthub:ask fenced block)', () => {
    expect(disableShadowedNativeToolsArgs()).toContain('AskUserQuestion');
  });

  it('optionally includes direct file mutation tools for Consult/workflow spawns', () => {
    expect(disableShadowedNativeToolsArgs({ codeMutationTools: true })).toEqual([
      '--disallowed-tools',
      ...SHADOWED_NATIVE_TOOLS,
      ...CODE_MUTATION_NATIVE_TOOLS,
    ]);
  });

  it('returns a fresh array each call so callers can safely mutate it', () => {
    const a = disableShadowedNativeToolsArgs();
    const b = disableShadowedNativeToolsArgs();
    expect(a).not.toBe(b);
    a.push('extra');
    expect(disableShadowedNativeToolsArgs()).toEqual([
      '--disallowed-tools',
      ...SHADOWED_NATIVE_TOOLS,
    ]);
  });

  it('exposes a legacy alias `disableNativeSkillToolArgs` for backwards compatibility', () => {
    // Existing spawn sites still call the old name; keep them working.
    expect(disableNativeSkillToolArgs).toBe(disableShadowedNativeToolsArgs);
    expect(disableNativeSkillToolArgs()).toEqual(disableShadowedNativeToolsArgs());
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
    // Multi-agent session advisor/executor spawns use the same spawn-arg planning to
    // session-multi-engine.ts (same pattern as design-chat.ts → design-multi-engine.ts).
    { file: 'session-multi-engine.ts', reason: 'multi-agent session advisor/executor spawns' },
    { file: 'heartbeat.ts', reason: 'runClaude — heartbeats / crons / workflow' },
    { file: 'slack.ts', reason: 'Slack one-shot' },
    // memory.ts used to spawn Claude directly; it now routes through the
    // unified one-shot spawner so the Skill-disable wiring lives in
    // one-shot-spawn.ts (covered below) instead of memory.ts itself.
    { file: 'one-shot-spawn.ts', reason: 'unified one-shot spawner (memory / analyze / etc.)' },
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

  // Regression for "Input must be provided either through stdin or as a
  // prompt argument when using --print" — Claude CLI 2.x parses
  // `--disallowed-tools <tools...>` as variadic, so a bare positional
  // prompt placed immediately after `--disallowed-tools Skill` gets
  // swallowed as a second disallowed-tool value. Spawn sites that emit a
  // bare positional prompt (no `--session-id`/`--resume` between the
  // disallowed-tools pair and the prompt) MUST insert a `--`
  // end-of-options separator first.
  //
  // Source-level pin: every file in `bareTrailingPromptSites` must
  // include the `'--'` separator near its `disableNativeSkillToolArgs()`
  // call. The check is intentionally fuzzy (substring search) so cosmetic
  // edits don't break it; the separator just needs to land between the
  // disallowed-tools push and the prompt push.
  const bareTrailingPromptSites: Array<{ file: string; reason: string }> = [
    { file: 'heartbeat.ts', reason: 'runClaude — heartbeats / crons / webhooks' },
    // memory.ts no longer spawns Claude directly — the bare-prompt site
    // moved to one-shot-spawn.ts which now powers memory reconciliation
    // (and project analyze fallback). Pin the separator there instead.
    { file: 'one-shot-spawn.ts', reason: 'unified one-shot spawner (memory / analyze / etc.)' },
    { file: 'slack.ts', reason: 'Slack one-shot' },
    // session-multi-agent.ts routes Claude spawns through session-multi-engine.ts
    // (same pattern as design-multi-engine.ts).
    { file: 'session-multi-engine.ts', reason: 'multi-agent session advisor/executor spawns' },
  ];

  it.each(bareTrailingPromptSites)(
    '$file inserts `--` end-of-options before the trailing positional prompt ($reason)',
    ({ file }) => {
      const src = readFileSync(path.join(__dirname, file), 'utf-8');
      // Some modules call `disableNativeSkillToolArgs()` at multiple spawn
      // sites. Every occurrence whose argv ends with a bare positional prompt must have
      // a `'--'` separator between the helper call and the prompt push, or
      // Claude CLI's variadic `--disallowed-tools <tools...>` will swallow
      // the prompt and fail with "Input must be provided…". Walk every
      // occurrence and pin each one independently — the previous version
      // of this test only checked the first match per file and would miss
      // a regression at any second/third call site.
      const needle = 'disableNativeSkillToolArgs()';
      const occurrences: number[] = [];
      let cursor = src.indexOf(needle);
      while (cursor !== -1) {
        occurrences.push(cursor);
        cursor = src.indexOf(needle, cursor + 1);
      }
      expect(
        occurrences.length,
        `${file} should call disableNativeSkillToolArgs()`,
      ).toBeGreaterThan(0);
      occurrences.forEach((idx, occurrenceIndex) => {
        // Find the chunk of source from the disallowed-tools call to the
        // next 6 lines — that's where the prompt push lives.
        const window = src.slice(idx, idx + 600);
        expect(
          window.includes("'--'") || window.includes('"--"'),
          `${file} occurrence #${occurrenceIndex + 1} (offset ${idx}) must push a '--' ` +
            `end-of-options separator before the bare positional prompt; otherwise ` +
            `--disallowed-tools <tools...> swallows the prompt and Claude CLI fails ` +
            `with "Input must be provided either through stdin or as a prompt argument".`,
        ).toBe(true);
      });
    },
  );

  // Behavioural pin for the one path that exposes a pure args-builder we
  // can call directly. The other six are covered by the source-level
  // grep above plus their own existing prompt-structure tests.
  it('design-multi-engine spawns Claude with --disallowed-tools Skill AskUserQuestion', () => {
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
        grok: '/bin/grok',
      },
      engine: 'claude-code',
      model: 'claude-opus-4-8',
      engineSessionId: null,
      isNewEngineSession: true,
    });
    expect(args).toContain('--disallowed-tools');
    const idx = args.indexOf('--disallowed-tools');
    // Both shadowed tools must follow the flag, in registration order.
    expect(args[idx + 1]).toBe('Skill');
    expect(args[idx + 2]).toBe('AskUserQuestion');
    // Prompt body must remain the last element so the CLI parses it as
    // the user message rather than a flag value.
    expect(args[args.length - 1]).toBe('Do the thing');
  });
});
