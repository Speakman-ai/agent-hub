import { describe, it, expect } from 'vitest';
import {
  CODEX_REASONING_PRESETS,
  DEFAULT_CODEX_REASONING_PRESET,
  normalizeCodexReasoningPreset,
  resolveCodexReasoningEffort,
  codexReasoningArgs,
} from './codex-reasoning.js';

describe('codex-reasoning presets', () => {
  it('exposes exactly the two user-facing presets', () => {
    expect(CODEX_REASONING_PRESETS).toEqual(['high', 'pro']);
  });

  it('defaults to high', () => {
    expect(DEFAULT_CODEX_REASONING_PRESET).toBe('high');
  });

  describe('normalizeCodexReasoningPreset', () => {
    it('passes through valid presets', () => {
      expect(normalizeCodexReasoningPreset('high')).toBe('high');
      expect(normalizeCodexReasoningPreset('pro')).toBe('pro');
    });

    it.each([null, undefined, '', 'xhigh', 'medium', 'PRO', 'High', 'bogus'])(
      'falls back to high for invalid/legacy value %p',
      (value) => {
        expect(normalizeCodexReasoningPreset(value as string | null | undefined)).toBe('high');
      },
    );
  });

  describe('resolveCodexReasoningEffort', () => {
    it('maps high → high', () => {
      expect(resolveCodexReasoningEffort('high')).toBe('high');
    });

    it('maps pro → xhigh (max thinking)', () => {
      expect(resolveCodexReasoningEffort('pro')).toBe('xhigh');
    });

    it('maps null/unknown → high (the default)', () => {
      expect(resolveCodexReasoningEffort(null)).toBe('high');
      expect(resolveCodexReasoningEffort(undefined)).toBe('high');
      expect(resolveCodexReasoningEffort('nope')).toBe('high');
    });
  });

  describe('codexReasoningArgs', () => {
    // This is the exact argv pair appended to `codex exec`. The Codex CLI has
    // no dedicated reasoning flag — `-c model_reasoning_effort=<level>` is the
    // documented override (verified against codex-cli 0.140.0).
    it('builds the -c override for the default (high)', () => {
      expect(codexReasoningArgs(null)).toEqual(['-c', 'model_reasoning_effort=high']);
    });

    it('builds the -c override for pro (xhigh)', () => {
      expect(codexReasoningArgs('pro')).toEqual(['-c', 'model_reasoning_effort=xhigh']);
    });

    it('always returns a two-element pair (caller can spread unconditionally)', () => {
      for (const v of ['high', 'pro', null, 'garbage']) {
        const args = codexReasoningArgs(v as string | null);
        expect(args).toHaveLength(2);
        expect(args[0]).toBe('-c');
        expect(args[1]).toMatch(/^model_reasoning_effort=(high|xhigh)$/);
      }
    });
  });
});
