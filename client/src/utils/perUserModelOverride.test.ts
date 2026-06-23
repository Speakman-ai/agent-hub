import { describe, it, expect } from 'vitest';
import { effectiveEngine, modelsForEngine, modelOverrideIsStale } from './perUserModelOverride';

const modelConfig = {
  engineValidModels: {
    'claude-code': ['claude-a', 'claude-b'],
    'codex-cli': ['gpt-a', 'gpt-b'],
  },
  engineDefaultModels: { 'claude-code': 'claude-a', 'codex-cli': 'gpt-a' },
  defaultModel: 'claude-a',
};

describe('effectiveEngine', () => {
  it('prefers the per-user override, then shared, then default', () => {
    expect(effectiveEngine('codex-cli', 'claude-code')).toBe('codex-cli');
    expect(effectiveEngine('', 'claude-code')).toBe('claude-code');
    expect(effectiveEngine('  ', '  ')).toBe('claude-code');
    expect(effectiveEngine(undefined, undefined)).toBe('claude-code');
  });
});

describe('modelsForEngine', () => {
  it('returns the engine model list or empty', () => {
    expect(modelsForEngine(modelConfig, 'codex-cli')).toEqual(['gpt-a', 'gpt-b']);
    expect(modelsForEngine(modelConfig, 'nope')).toEqual([]);
    expect(modelsForEngine(null, 'claude-code')).toEqual([]);
  });
});

describe('modelOverrideIsStale', () => {
  it('flags an override incompatible with the new effective engine', () => {
    expect(modelOverrideIsStale('claude-b', modelConfig, 'codex-cli')).toBe(true);
  });

  it('does not flag an override still valid for the engine', () => {
    expect(modelOverrideIsStale('gpt-b', modelConfig, 'codex-cli')).toBe(false);
  });

  it('treats empty / whitespace overrides as never stale', () => {
    expect(modelOverrideIsStale('', modelConfig, 'codex-cli')).toBe(false);
    expect(modelOverrideIsStale('   ', modelConfig, 'codex-cli')).toBe(false);
    expect(modelOverrideIsStale(undefined, modelConfig, 'codex-cli')).toBe(false);
  });

  it('flags any non-empty override for an unknown engine (no valid models)', () => {
    expect(modelOverrideIsStale('claude-a', modelConfig, 'unknown-engine')).toBe(true);
  });

  it('ignores surrounding whitespace on the override', () => {
    expect(modelOverrideIsStale('  gpt-a  ', modelConfig, 'codex-cli')).toBe(false);
    expect(modelOverrideIsStale('  claude-a  ', modelConfig, 'codex-cli')).toBe(true);
  });
});
