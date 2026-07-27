/**
 * Tests for the spawn-args builder used by summarizeTranscript().
 *
 * Regression coverage for: "[Auto-summarize] Failed — Cursor Agent
 * Workspace Trust Required". The cursor-agent CLI gates non-interactive
 * runs behind a Workspace Trust prompt unless one of `--trust`, `--yolo`,
 * or `-f`/`--force` is passed; without it the auto-summarize pass hangs
 * on the prompt and exits 1, surfacing as `[Auto-summarize] Failed:` in
 * the server logs.
 */
import { describe, it, expect } from 'vitest';
import { buildSummarizeSpawnArgs, SUMMARIZE_SYSTEM_PROMPT } from './sessions.js';
import type { AppConfig } from '../types.js';

const fakeConfig = {
  claudeBin: '/usr/local/bin/claude',
  cursorBin: '/usr/local/bin/cursor-agent',
  geminiBin: '/usr/local/bin/gemini',
  codexBin: '/usr/local/bin/codex',
  defaultModel: 'claude-sonnet-4',
  engineDefaultModels: { 'cursor-agent': 'cursor-default', 'claude-code': 'claude-default' },
  engineValidModels: {
    'cursor-agent': ['cursor-default'],
    'claude-code': ['claude-default'],
    'gemini-cli': ['gemini-default'],
    'codex-cli': ['codex-default'],
  },
  defaultTimeoutMs: 60_000,
} as unknown as AppConfig;

describe('buildSummarizeSpawnArgs — cursor-agent', () => {
  it('passes --force so cursor-agent skips the Workspace Trust prompt', () => {
    const { bin, args } = buildSummarizeSpawnArgs(
      { engine: 'cursor-agent', model: 'auto' },
      fakeConfig,
    );
    expect(bin).toBe('/usr/local/bin/cursor-agent');
    // The fix: --force is the cursor-agent acknowledgment that bypasses
    // the interactive trust prompt. Equivalent to --trust / --yolo / -f.
    expect(args).toContain('--force');
  });

  it('wires --print, --model, and --system-prompt for cursor-agent', () => {
    const { args } = buildSummarizeSpawnArgs(
      { engine: 'cursor-agent', model: 'gpt-5' },
      fakeConfig,
    );
    expect(args).toContain('--print');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5');
    expect(args).toContain('--system-prompt');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(SUMMARIZE_SYSTEM_PROMPT);
  });

  it('falls back to the engine default when no model is supplied', () => {
    const { args } = buildSummarizeSpawnArgs({ engine: 'cursor-agent' }, fakeConfig);
    expect(args[args.indexOf('--model') + 1]).toBe('cursor-default');
  });
});

describe('buildSummarizeSpawnArgs — other engines', () => {
  it('claude-code uses --print + --system-prompt and does NOT need --force', () => {
    const { bin, args } = buildSummarizeSpawnArgs(
      { engine: 'claude-code', model: 'claude-sonnet-4' },
      fakeConfig,
    );
    expect(bin).toBe('/usr/local/bin/claude');
    expect(args).toContain('--print');
    expect(args).toContain('--system-prompt');
    expect(args).not.toContain('--force');
  });

  it('gemini-cli uses -p with no --system-prompt flag', () => {
    const { bin, args } = buildSummarizeSpawnArgs(
      { engine: 'gemini-cli', model: 'gemini-2.5-pro' },
      fakeConfig,
    );
    expect(bin).toBe('/usr/local/bin/gemini');
    expect(args).toContain('-p');
    expect(args).not.toContain('--system-prompt');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-2.5-pro');
  });

  it('gemini-cli omits --model when model is "auto"', () => {
    const { args } = buildSummarizeSpawnArgs({ engine: 'gemini-cli', model: 'auto' }, fakeConfig);
    expect(args).not.toContain('--model');
  });

  it('codex-cli uses exec --json --skip-git-repo-check --sandbox read-only', () => {
    const { bin, args } = buildSummarizeSpawnArgs(
      { engine: 'codex-cli', model: 'gpt-5' },
      fakeConfig,
    );
    expect(bin).toBe('/usr/local/bin/codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });
});
