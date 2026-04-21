import { describe, it, expect } from 'vitest';
import {
  ENGINE_OPTIONS,
  ENGINE_MODELS,
  ENGINE_DEFAULT_MODELS,
} from './engineOptions.js';

describe('mobile engine picker constants', () => {
  it('exposes exactly claude-code and cursor-agent as engine options', () => {
    const ids = ENGINE_OPTIONS.map((e) => e.id);
    expect(ids).toEqual(['claude-code', 'cursor-agent']);
  });

  it('does not list gemini-cli as an engine option', () => {
    const ids = ENGINE_OPTIONS.map((e) => e.id);
    expect(ids).not.toContain('gemini-cli');
  });

  it('exposes only composer-2 as the model for cursor-agent', () => {
    const models = ENGINE_MODELS['cursor-agent'].map((m) => m.id);
    expect(models).toEqual(['composer-2']);
  });

  it('defaults cursor-agent to composer-2 (matches the TopBar list)', () => {
    // Regression: mobile's ENGINE_DEFAULT_MODELS previously set
    // cursor-agent → gpt-5.3-codex-high while TopBar only exposed composer-2,
    // causing the stored model to diverge from the displayed label on the
    // first engine switch. Keep the default aligned with the model list.
    expect(ENGINE_DEFAULT_MODELS['cursor-agent']).toBe('composer-2');
    const allowed = ENGINE_MODELS['cursor-agent'].map((m) => m.id);
    expect(allowed).toContain(ENGINE_DEFAULT_MODELS['cursor-agent']);
  });

  it('default model for every engine is present in its model list', () => {
    for (const engine of ENGINE_OPTIONS.map((e) => e.id)) {
      const allowed = (ENGINE_MODELS[engine] || []).map((m) => m.id);
      const def = ENGINE_DEFAULT_MODELS[engine];
      expect(
        allowed.includes(def),
        `default "${def}" for engine "${engine}" must be in ENGINE_MODELS`,
      ).toBe(true);
    }
  });
});
