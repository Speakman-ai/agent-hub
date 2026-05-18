import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRoomSpawnArgs, normalizeRoomEngine, isRoomChatEngine } from './room-multi-engine.js';

const bins = {
  claude: '/bin/claude',
  cursor: '/bin/cursor',
  gemini: '/bin/gemini',
  codex: '/bin/codex',
};

describe('normalizeRoomEngine / isRoomChatEngine', () => {
  it('defaults null/empty/unknown to claude-code', () => {
    expect(normalizeRoomEngine(null)).toBe('claude-code');
    expect(normalizeRoomEngine('')).toBe('claude-code');
    expect(normalizeRoomEngine('  ')).toBe('claude-code');
    expect(normalizeRoomEngine('not-an-engine')).toBe('claude-code');
  });

  it('accepts known engine ids', () => {
    expect(normalizeRoomEngine('cursor-agent')).toBe('cursor-agent');
    expect(normalizeRoomEngine('gemini-cli')).toBe('gemini-cli');
    expect(normalizeRoomEngine('codex-cli')).toBe('codex-cli');
    expect(isRoomChatEngine('claude-code')).toBe(true);
    expect(isRoomChatEngine('gpt-5')).toBe(false);
  });
});

describe('buildRoomSpawnArgs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseInput = {
    systemPrompt: 'SYS-PROMPT',
    userPrompt: 'transcript + you are Dev',
    bins,
  };

  it('claude-code emits stream-json + --system-prompt + bypass perms with -- terminator', () => {
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: 'claude-code',
      model: 'claude-opus-4-7',
    });
    expect(plan.bin).toBe(bins.claude);
    expect(plan.stdinPrompt).toBeNull();
    expect(plan.args).toContain('--print');
    expect(plan.args).toContain('--permission-mode');
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(plan.args).toContain('--output-format');
    expect(plan.args[plan.args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(plan.args).toContain('--include-partial-messages');
    expect(plan.args).toContain('--verbose');
    expect(plan.args).toContain('--system-prompt');
    expect(plan.args[plan.args.indexOf('--system-prompt') + 1]).toBe('SYS-PROMPT');
    // `--` terminator immediately before the trailing positional prompt
    // (claude-cli-args.ts: variadic --disallowed-tools requires this).
    const dashIdx = plan.args.indexOf('--');
    expect(dashIdx).toBeGreaterThan(0);
    expect(plan.args[dashIdx + 1]).toBe('transcript + you are Dev');
    expect(plan.args[plan.args.length - 1]).toBe('transcript + you are Dev');
    // The shadow-tool flag pair must be present.
    expect(plan.args).toContain('--disallowed-tools');
  });

  it('cursor-agent: throws without cursorChatId', () => {
    expect(() =>
      buildRoomSpawnArgs({
        ...baseInput,
        engine: 'cursor-agent',
        model: 'composer-2.5',
      }),
    ).toThrow('cursor-agent requires cursorChatId');
  });

  it('cursor-agent: -p carries SYS + transcript and --resume uses the fresh chat id', () => {
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: 'cursor-agent',
      model: 'composer-2.5',
      cursorChatId: 'cur-fresh-123',
    });
    expect(plan.bin).toBe(bins.cursor);
    expect(plan.stdinPrompt).toBeNull();
    const pIdx = plan.args.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(plan.args[pIdx + 1]).toContain('SYS-PROMPT');
    expect(plan.args[pIdx + 1]).toContain('transcript + you are Dev');
    expect(plan.args).toContain('--force');
    expect(plan.args).toContain('--model');
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('composer-2.5');
    expect(plan.args).toContain('--resume');
    expect(plan.args[plan.args.indexOf('--resume') + 1]).toBe('cur-fresh-123');
    expect(plan.args).toContain('--output-format');
    expect(plan.args[plan.args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(plan.args).toContain('--stream-partial-output');
  });

  it('gemini-cli: -p merges SYS + transcript and --yolo is set', () => {
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: 'gemini-cli',
      model: 'gemini-2.5-pro',
    });
    expect(plan.bin).toBe(bins.gemini);
    expect(plan.stdinPrompt).toBeNull();
    expect(plan.args[0]).toBe('-p');
    expect(plan.args[1]).toContain('SYS-PROMPT');
    expect(plan.args[1]).toContain('transcript + you are Dev');
    expect(plan.args).toContain('--output-format');
    expect(plan.args[plan.args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(plan.args).toContain('--yolo');
    expect(plan.args).toContain('--model');
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('gemini-2.5-pro');
  });

  it('gemini-cli: skips --model when "auto"', () => {
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: 'gemini-cli',
      model: 'auto',
    });
    expect(plan.args.includes('--model')).toBe(false);
  });

  it('codex-cli: exec --json --skip-git-repo-check + danger bypass with stdin sentinel', () => {
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      codexDangerBypass: true,
    });
    expect(plan.bin).toBe(bins.codex);
    expect(plan.args[0]).toBe('exec');
    expect(plan.args).toContain('--json');
    expect(plan.args).toContain('--skip-git-repo-check');
    expect(plan.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(plan.args[plan.args.length - 1]).toBe('-');
    // stdin sentinel must be paired with a stdinPrompt that carries SYS + transcript.
    expect(plan.stdinPrompt).toContain('SYS-PROMPT');
    expect(plan.stdinPrompt).toContain('transcript + you are Dev');
    // Resume is intentionally absent — rooms are stateless per-turn.
    expect(plan.args.includes('resume')).toBe(false);
  });

  it('codex-cli: uses --full-auto when codexDangerBypass is explicitly false', () => {
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      codexDangerBypass: false,
    });
    expect(plan.args).toContain('--full-auto');
    expect(plan.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('codex-cli: uses danger bypass flag when codexDangerBypass is true', () => {
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      codexDangerBypass: true,
    });
    expect(plan.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(plan.args).not.toContain('--full-auto');
  });

  it('codex-cli: forwards --model when shouldPassModelFlag accepts it', () => {
    // detectCodexAuthMode() returns 'api-key' / 'unknown' in tests (no
    // ChatGPT OAuth headers), and shouldPassModelFlag forwards arbitrary
    // model strings under those modes. See codex-auth.ts.
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
    });
    expect(plan.args).toContain('--model');
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('gpt-5.3-codex');
  });

  it('unknown engine falls back to claude-code branch via normalizeRoomEngine', () => {
    const eng = normalizeRoomEngine('some-future-engine');
    const plan = buildRoomSpawnArgs({
      ...baseInput,
      engine: eng,
      model: 'claude-opus-4-7',
    });
    expect(plan.bin).toBe(bins.claude);
  });
});
