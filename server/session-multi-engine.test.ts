import { describe, it, expect } from 'vitest';
import { buildSessionMultiSpawnArgs, normalizeSessionMultiEngine } from './session-multi-engine.js';

describe('buildSessionMultiSpawnArgs', () => {
  const bins = {
    claude: '/bin/claude',
    cursor: '/bin/cursor',
    gemini: '/bin/gemini',
    codex: '/bin/codex',
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

  it('codex-cli appends --profile when codexProfile is set', () => {
    const plan = buildSessionMultiSpawnArgs({
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      systemPrompt: 'sys',
      userPrompt: 'user',
      bins,
      codexProfile: 'sandbox-strict',
      advisory: true,
    });
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
});

describe('normalizeSessionMultiEngine', () => {
  it('defaults unknown to claude-code', () => {
    expect(normalizeSessionMultiEngine('unknown')).toBe('claude-code');
  });
});
