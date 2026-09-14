import { describe, it, expect } from 'vitest';
import { buildSessionMultiSpawnArgs } from './session-multi-engine.js';
import { buildOneShotSpawnArgs } from './one-shot-spawn.js';
import { cursorSandboxArgs, CURSOR_SANDBOX_DISABLED_ARGS } from './cursor-sandbox-args.js';
import type { AppConfig } from './types.js';

/**
 * Regression for the Finalize review stall: Cursor sandboxes its tools with
 * bubblewrap, which cannot create a user namespace inside our container, so
 * every file read the reviewer attempted died with
 * `bwrap: No permissions to create a new namespace`. The reviewer could not
 * read a single omitted patch for 17 rounds. `--sandbox disabled` is what
 * makes those reads run at all, so every cursor-agent spawn must carry it.
 */
describe('cursorSandboxArgs', () => {
  it('disables the sandbox by default (undefined config)', () => {
    expect(cursorSandboxArgs(undefined)).toEqual(['--sandbox', 'disabled']);
    expect(cursorSandboxArgs(null)).toEqual([...CURSOR_SANDBOX_DISABLED_ARGS]);
    expect(cursorSandboxArgs(true)).toEqual(['--sandbox', 'disabled']);
  });

  it('emits nothing when the operator opts back into the sandbox', () => {
    // Not `--sandbox enabled`: the user's own cli-config.json still decides.
    expect(cursorSandboxArgs(false)).toEqual([]);
  });

  it('returns a fresh array so a caller cannot mutate the shared constant', () => {
    const args = cursorSandboxArgs(true);
    args.push('--mutated');
    expect(cursorSandboxArgs(true)).toEqual(['--sandbox', 'disabled']);
  });
});

function pairAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

describe('cursor-agent spawn sites pass --sandbox disabled', () => {
  const bins = {
    claude: '/bin/claude',
    cursor: '/bin/cursor-agent',
    gemini: '/bin/gemini',
    codex: '/bin/codex',
    grok: '/bin/grok',
  };

  it('the in-session reviewer turn can actually read files', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'cursor-agent',
      model: 'grok-4.6',
      systemPrompt: 'system',
      userPrompt: 'review this',
      cursorChatId: 'chat-1',
      bins,
      advisory: true,
      reviewerReadOnly: true,
      cwd: null,
      sessionId: null,
    } as never);
    expect(pairAfter(plan.args, '--sandbox')).toBe('disabled');
  });

  it('respects an explicit opt-out', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'cursor-agent',
      model: 'grok-4.6',
      systemPrompt: 'system',
      userPrompt: 'review this',
      cursorChatId: 'chat-1',
      bins,
      advisory: true,
      reviewerReadOnly: true,
      cursorSandboxBypass: false,
      cwd: null,
      sessionId: null,
    } as never);
    expect(plan.args).not.toContain('--sandbox');
  });

  it('one-shot prompts (heartbeats, crons, analyze) carry the flag', () => {
    const cfg = { cursorBin: '/bin/cursor-agent', cursorSandboxBypass: true } as AppConfig;
    const { args } = buildOneShotSpawnArgs(
      { engine: 'cursor-agent', model: 'grok-4.6', prompt: 'hi' } as never,
      cfg,
    );
    expect(pairAfter(args, '--sandbox')).toBe('disabled');
  });
});
