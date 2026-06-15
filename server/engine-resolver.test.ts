// Tests for the one-shot engine resolver. These exercise the fallback
// chain pure-function-style by injecting a pre-computed `availability`
// map — no probe, no spawn, no fs. The probe is covered separately in
// engine-availability.test.ts.

import { describe, it, expect } from 'vitest';
import {
  resolveOneShotEngine,
  NoEnginesAvailableError,
  DEFAULT_FALLBACK_CHAIN,
} from './engine-resolver.js';
import type { EngineAvailability, SupportedEngine } from './engine-availability.js';
import type { AppConfig } from './types.js';

function ok(engine: SupportedEngine): EngineAvailability {
  return { engine, available: true };
}
function bad(
  engine: SupportedEngine,
  reason: 'no-binary' | 'no-credentials' | 'expired' | 'unknown' = 'no-credentials',
): EngineAvailability {
  return { engine, available: false, reason, detail: `${engine} unavailable: ${reason}` };
}

function makeAvailability(
  overrides: Partial<Record<SupportedEngine, EngineAvailability>> = {},
): Record<SupportedEngine, EngineAvailability> {
  return {
    'claude-code': bad('claude-code'),
    'cursor-agent': bad('cursor-agent'),
    'codex-cli': bad('codex-cli'),
    'gemini-cli': bad('gemini-cli'),
    'grok-cli': bad('grok-cli'),
    ...overrides,
  };
}

const CFG = {
  engineDefaultModels: {
    'claude-code': 'claude-sonnet-4-5',
    'cursor-agent': 'auto',
    'codex-cli': 'gpt-5.4',
    'gemini-cli': 'gemini-2.0-flash',
  },
  defaultModel: 'claude-sonnet-4-5',
} as unknown as AppConfig;

describe('resolveOneShotEngine', () => {
  it('picks the preferred engine when available (no fallback)', async () => {
    const r = await resolveOneShotEngine(CFG, {
      preferred: 'claude-code',
      availability: makeAvailability({ 'claude-code': ok('claude-code') }),
    });
    expect(r.engine).toBe('claude-code');
    expect(r.fallbackUsed).toBe(false);
    expect(r.model).toBe('claude-sonnet-4-5');
  });

  it('honors preferredModel when the preferred engine is selected', async () => {
    const r = await resolveOneShotEngine(CFG, {
      preferred: 'claude-code',
      preferredModel: 'claude-opus-4-1',
      availability: makeAvailability({ 'claude-code': ok('claude-code') }),
    });
    expect(r.model).toBe('claude-opus-4-1');
  });

  it('falls back to the next available engine when preferred is unavailable', async () => {
    const r = await resolveOneShotEngine(CFG, {
      preferred: 'claude-code',
      availability: makeAvailability({
        'claude-code': bad('claude-code', 'expired'),
        'cursor-agent': ok('cursor-agent'),
      }),
    });
    expect(r.engine).toBe('cursor-agent');
    expect(r.fallbackUsed).toBe(true);
    expect(r.fallbackFromReason).toBe('claude-code:expired');
    // Falls back to the engine's default model, not the caller's preferredModel.
    expect(r.model).toBe('auto');
  });

  it('walks the entire fallback chain in order', async () => {
    const r = await resolveOneShotEngine(CFG, {
      preferred: 'claude-code',
      availability: makeAvailability({
        'claude-code': bad('claude-code', 'no-credentials'),
        'cursor-agent': bad('cursor-agent', 'no-binary'),
        'codex-cli': ok('codex-cli'),
      }),
    });
    expect(r.engine).toBe('codex-cli');
    expect(r.fallbackUsed).toBe(true);
  });

  it('throws NoEnginesAvailableError when nothing is available', async () => {
    await expect(
      resolveOneShotEngine(CFG, {
        preferred: 'claude-code',
        availability: makeAvailability(),
      }),
    ).rejects.toBeInstanceOf(NoEnginesAvailableError);
  });

  it('NoEnginesAvailableError carries the per-engine availability map', async () => {
    try {
      await resolveOneShotEngine(CFG, {
        preferred: 'claude-code',
        availability: makeAvailability(),
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NoEnginesAvailableError);
      const e = err as NoEnginesAvailableError;
      expect(e.code).toBe('no_engines_configured');
      expect(e.availability['claude-code'].available).toBe(false);
      expect(e.availability['claude-code'].detail).toMatch(/claude-code unavailable/);
      // Message lists every engine so the user can see what to set up.
      expect(e.message).toContain('claude-code');
      expect(e.message).toContain('cursor-agent');
      expect(e.message).toContain('codex-cli');
      expect(e.message).toContain('gemini-cli');
    }
  });

  it('walks the chain top-to-bottom when no preferred is given', async () => {
    // Only grok-cli is set up. The chain order is claude → cursor →
    // codex → grok, so grok wins.
    const r = await resolveOneShotEngine(CFG, {
      availability: makeAvailability({ 'grok-cli': ok('grok-cli') }),
    });
    expect(r.engine).toBe('grok-cli');
    expect(r.fallbackUsed).toBe(false); // No "preferred" was missed
  });

  it('never auto-selects gemini-cli for a userless run — grok is the host fallback', async () => {
    // Regression for the support-ticket AI investigation 429 storm: it resolves
    // with `preferred: 'claude-code'` and no acting user, so claude/cursor/codex
    // are all unavailable (per-account, no host fallback). Gemini USED to be the
    // sole host-configured fallback, so the chain landed on it — and after Google
    // removed Pro from the free tier (2026-04-01) every such run 429'd with
    // limit:0. Gemini is now reserved for RAG only; the default chain must skip
    // it and fall to host-configured Grok instead, even when Gemini is the only
    // other "available" engine.
    const r = await resolveOneShotEngine(CFG, {
      preferred: 'claude-code',
      availability: makeAvailability({
        // Both host-configured engines report available...
        'gemini-cli': ok('gemini-cli'),
        'grok-cli': ok('grok-cli'),
      }),
    });
    expect(r.engine).toBe('grok-cli');
    expect(r.engine).not.toBe('gemini-cli');
    expect(r.fallbackUsed).toBe(true);
    expect(DEFAULT_FALLBACK_CHAIN).not.toContain('gemini-cli');
  });

  it('throws NoEnginesAvailableError when only gemini-cli is available (RAG-only, not an agent engine)', async () => {
    // A host configured with ONLY Gemini (for RAG) and no other engine creds must
    // NOT silently run background work on Gemini — it should surface "no engines".
    await expect(
      resolveOneShotEngine(CFG, {
        availability: makeAvailability({ 'gemini-cli': ok('gemini-cli') }),
      }),
    ).rejects.toBeInstanceOf(NoEnginesAvailableError);
  });

  it('treats an unsupported preferred engine as no preference (walks the chain)', async () => {
    const r = await resolveOneShotEngine(CFG, {
      // Deliberately invalid engine name — resolver should ignore it.
      preferred: 'fake-cli',
      availability: makeAvailability({ 'cursor-agent': ok('cursor-agent') }),
    });
    expect(r.engine).toBe('cursor-agent');
    expect(r.fallbackUsed).toBe(false);
  });

  it('respects an explicit fallbackChain override', async () => {
    // Custom chain in a non-default order (grok first) — proves an explicit
    // override is honored over DEFAULT_FALLBACK_CHAIN's claude-first priority,
    // even though grok sits last in the default chain.
    const r = await resolveOneShotEngine(CFG, {
      fallbackChain: ['grok-cli', 'codex-cli', 'cursor-agent', 'claude-code'],
      availability: makeAvailability({
        'grok-cli': ok('grok-cli'),
        'claude-code': ok('claude-code'),
      }),
    });
    expect(r.engine).toBe('grok-cli');
  });

  it('exports the default fallback chain as a named constant (gemini excluded, grok included)', () => {
    expect(DEFAULT_FALLBACK_CHAIN).toEqual([
      'claude-code',
      'cursor-agent',
      'codex-cli',
      'grok-cli',
    ]);
  });
});
