import { describe, it, expect } from 'vitest';
import { buildSessionMultiSpawnArgs, normalizeSessionMultiEngine } from './session-multi-engine.js';

describe('buildSessionMultiSpawnArgs', () => {
  const bins = {
    claude: '/bin/claude',
    cursor: '/bin/cursor',
    gemini: '/bin/gemini',
    codex: '/bin/codex',
    grok: '/bin/grok',
  };

  it('advisory claude uses plan permission mode', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: true,
    });
    expect(plan.args).toContain('plan');
  });

  it('executor claude uses bypassPermissions', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: false,
    });
    expect(plan.args).toContain('bypassPermissions');
  });

  it('caps an oversized claude userPrompt so the spawn does not hit E2BIG', () => {
    // A fix turn embedding verbose CI logs (or a huge diff) would otherwise be
    // passed raw as a positional argv arg and overflow ARG_MAX (spawn E2BIG).
    const huge = 'x'.repeat(300_000);
    const plan = buildSessionMultiSpawnArgs({
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      systemPrompt: 'sys',
      userPrompt: huge,
      bins,
      advisory: true,
    });
    const positional = plan.args[plan.args.length - 1];
    expect(Buffer.byteLength(positional, 'utf8')).toBeLessThanOrEqual(101_000);
  });

  it('codex-cli appends --profile when codexProfile is set', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      codexProfile: 'sandbox-strict',
      advisory: true,
      codexEnv: {
        PATH: '/app/server/default-skills/agent-hub/scripts:/usr/bin',
        AGENT_HUB_SKILLS_DIR: '/app/server/default-skills/agent-hub',
      },
    });
    expect(plan.args).toContain(
      'shell_environment_policy.set.PATH="/app/server/default-skills/agent-hub/scripts:/usr/bin"',
    );
    const idx = plan.args.indexOf('--profile');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(plan.args[idx + 1]).toBe('sandbox-strict');
    // `--profile` must come before the `-` stdin sentinel.
    expect(idx).toBeLessThan(plan.args.indexOf('-'));
  });

  it('codex-cli omits --profile when codexProfile is null/empty/whitespace', () => {
    // Belt-and-braces: config.ts normalizes load-time, but a future PATCH path
    // could leave a whitespace value in memory. The spawn site `?.trim()` guard
    // must turn each of these into a no-op rather than `--profile ""`.
    for (const profile of [null, undefined, '', '   ', '\t', '\n']) {
      const plan = buildSessionMultiSpawnArgs({
        engine: 'codex-cli',
        model: 'gpt-5.3-codex',
        systemPrompt: 'sys',
        userPrompt: 'user',
        bins,
        codexProfile: profile,
        advisory: true,
      });
      expect(plan.args).not.toContain('--profile');
    }
  });

  it('codex-cli trims surrounding whitespace from codexProfile', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      codexProfile: '  my-profile  ',
      advisory: true,
    });
    const idx = plan.args.indexOf('--profile');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(plan.args[idx + 1]).toBe('my-profile');
  });

  it('grok-cli uses the grok bin, streaming-json, and omits --always-approve when advisory', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'grok-cli',
      model: 'grok-4.6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: true,
    });
    expect(plan.bin).toBe('/bin/grok');
    expect(plan.args[0]).toBe('-p');
    expect(plan.args[1]).toContain('sys');
    expect(plan.args[1]).toContain('user');
    expect(plan.args).toContain('streaming-json');
    expect(plan.args).toContain('--no-auto-update');
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('grok-4.6');
    expect(plan.args).not.toContain('--always-approve');
  });

  it('grok-cli adds --always-approve on non-advisory turns', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'grok-cli',
      model: 'grok-4.6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: false,
    });
    expect(plan.args).toContain('--always-approve');
    expect(plan.args[1]).toContain('agent-hub-local-commit');
  });

  it('grok-cli omits the local-commit reminder on advisory turns', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'grok-cli',
      model: 'grok-4.6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: true,
    });
    expect(plan.args[1]).not.toContain('agent-hub-local-commit');
  });

  // Finalize reviewer turns are advisory (read-only) but must keep the
  // engine's auto-approve flag so the reviewer can read worktree files the
  // inline diff omitted. Without it, headless tool calls block on an approval
  // that never comes and the reviewer ends with no verdict (review_failed).
  it('grok-cli keeps --always-approve on reviewerReadOnly advisory turns', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'grok-cli',
      model: 'grok-4.6',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: true,
      reviewerReadOnly: true,
    });
    expect(plan.args).toContain('--always-approve');
    // Still a review turn, not a build turn: no local-commit reminder.
    expect(plan.args[1]).not.toContain('agent-hub-local-commit');
  });

  it('gemini-cli keeps --yolo on reviewerReadOnly advisory turns but omits it on plain advisory', () => {
    const readOnly = buildSessionMultiSpawnArgs({
      engine: 'gemini-cli',
      model: 'gemini-2.5-pro',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: true,
      reviewerReadOnly: true,
    });
    expect(readOnly.args).toContain('--yolo');

    const plain = buildSessionMultiSpawnArgs({
      engine: 'gemini-cli',
      model: 'gemini-2.5-pro',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      advisory: true,
    });
    expect(plain.args).not.toContain('--yolo');
  });

  it('cursor-agent keeps --force on reviewerReadOnly advisory turns but omits it on plain advisory', () => {
    const readOnly = buildSessionMultiSpawnArgs({
      engine: 'cursor-agent',
      model: 'auto',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      cursorChatId: 'chat-1',
      advisory: true,
      reviewerReadOnly: true,
    });
    expect(readOnly.args).toContain('--force');

    const plain = buildSessionMultiSpawnArgs({
      engine: 'cursor-agent',
      model: 'auto',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      cursorChatId: 'chat-1',
      advisory: true,
    });
    expect(plain.args).not.toContain('--force');
  });

  // The reminder is pinned last so applyArgvPromptCap's tail-keep cannot drop
  // it, even when a huge system prompt shoves the head off the 100 KB cap.
  it('grok-cli keeps the tail reminder after the argv cap trims an oversized head', () => {
    const hugeSystem = 'HEAD_MARKER ' + 'x'.repeat(200_000);
    const reminder = 'TAIL_REMINDER_MARKER emit the verdict block';
    const plan = buildSessionMultiSpawnArgs({
      engine: 'grok-cli',
      model: 'grok-4.6',
      systemPrompt: hugeSystem,
      userPrompt: 'user',
      bins,
      advisory: true,
      reviewerReadOnly: true,
      tailReminder: reminder,
      sessionId: 'sess-1',
    });
    expect(plan.args[1]).toContain('TAIL_REMINDER_MARKER');
    // The head was trimmed away by the argv cap.
    expect(plan.args[1]).not.toContain('HEAD_MARKER');
  });

  it('claude keeps the tail reminder appended to the capped user prompt', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      systemPrompt: 'sys',
      userPrompt: 'user body',
      bins,
      advisory: true,
      reviewerReadOnly: true,
      tailReminder: 'TAIL_REMINDER_MARKER',
    });
    // Claude takes the user prompt as the last positional argv element.
    expect(plan.args[plan.args.length - 1]).toContain('TAIL_REMINDER_MARKER');
  });
});

describe('normalizeSessionMultiEngine', () => {
  it('defaults unknown to claude-code', () => {
    expect(normalizeSessionMultiEngine('unknown')).toBe('claude-code');
  });

  it('keeps grok-cli instead of rewriting it to claude-code', () => {
    expect(normalizeSessionMultiEngine('grok-cli')).toBe('grok-cli');
  });
});
