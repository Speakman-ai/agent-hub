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
});

describe('normalizeSessionMultiEngine', () => {
  it('defaults unknown to claude-code', () => {
    expect(normalizeSessionMultiEngine('unknown')).toBe('claude-code');
  });
});
