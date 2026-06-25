import { describe, it, expect } from 'vitest';
import {
  clampReplaySampleRate,
  normalizeReplayConfig,
  resolveReplayPolicy,
  DEFAULT_REPLAY_POLICY,
} from './replay-config.js';

describe('clampReplaySampleRate', () => {
  it('clamps below 0 to 0 and above 1 to 1', () => {
    expect(clampReplaySampleRate(-0.5)).toBe(0);
    expect(clampReplaySampleRate(0)).toBe(0);
    expect(clampReplaySampleRate(2)).toBe(1);
    expect(clampReplaySampleRate(1)).toBe(1);
  });

  it('passes through a valid fractional rate', () => {
    expect(clampReplaySampleRate(0.1)).toBeCloseTo(0.1);
    expect(clampReplaySampleRate(0.5)).toBeCloseTo(0.5);
  });

  it('treats non-finite as 0', () => {
    expect(clampReplaySampleRate(NaN)).toBe(0);
    expect(clampReplaySampleRate(Infinity)).toBe(0);
    expect(clampReplaySampleRate(-Infinity)).toBe(0);
  });
});

describe('normalizeReplayConfig', () => {
  it('clears config on null', () => {
    expect(normalizeReplayConfig(null)).toEqual({ ok: true, value: null });
  });

  it('rejects non-object, non-null values', () => {
    expect(normalizeReplayConfig('x').ok).toBe(false);
    expect(normalizeReplayConfig(5).ok).toBe(false);
    expect(normalizeReplayConfig([]).ok).toBe(false);
  });

  it('accepts and clamps a valid sampleRate', () => {
    expect(normalizeReplayConfig({ sampleRate: 0.25 })).toEqual({
      ok: true,
      value: { sampleRate: 0.25 },
    });
  });

  it('rejects a non-numeric or out-of-range sampleRate', () => {
    expect(normalizeReplayConfig({ sampleRate: 'half' }).ok).toBe(false);
    expect(normalizeReplayConfig({ sampleRate: NaN }).ok).toBe(false);
    expect(normalizeReplayConfig({ sampleRate: -0.1 }).ok).toBe(false);
    expect(normalizeReplayConfig({ sampleRate: 1.5 }).ok).toBe(false);
  });

  it('pins continuous-on to an explicit sampleRate:0 when no rate is given', () => {
    // A bare { continuous: true } must never persist without a rate — an absent
    // rate would resolve to the recorder's default (100%) for the continuous
    // tier. It is normalized to OFF (0) until a rate is set.
    expect(normalizeReplayConfig({ continuous: true })).toEqual({
      ok: true,
      value: { continuous: true, sampleRate: 0 },
    });
    expect(normalizeReplayConfig({ continuous: 'yes' }).ok).toBe(false);
  });

  it('respects an explicit rate supplied alongside continuous', () => {
    expect(normalizeReplayConfig({ continuous: true, sampleRate: 0.3 })).toEqual({
      ok: true,
      value: { sampleRate: 0.3, continuous: true },
    });
  });

  it('drops unknown keys and clears when nothing recognized', () => {
    expect(normalizeReplayConfig({ foo: 1 })).toEqual({ ok: true, value: null });
    expect(normalizeReplayConfig({ sampleRate: 0.3, foo: 1 })).toEqual({
      ok: true,
      value: { sampleRate: 0.3 },
    });
  });

  it('rejects a non-boolean maskAllEnforced', () => {
    expect(
      normalizeReplayConfig({ continuous: true, sampleRate: 1, maskAllEnforced: 'no' }).ok,
    ).toBe(false);
  });

  it('persists the mask-all Admin opt-out (false) only with continuous on', () => {
    expect(
      normalizeReplayConfig({ continuous: true, sampleRate: 0.5, maskAllEnforced: false }),
    ).toEqual({
      ok: true,
      value: { sampleRate: 0.5, continuous: true, maskAllEnforced: false },
    });
  });

  it('drops a redundant maskAllEnforced:true (the strong default is "absent")', () => {
    expect(
      normalizeReplayConfig({ continuous: true, sampleRate: 0.5, maskAllEnforced: true }),
    ).toEqual({
      ok: true,
      value: { sampleRate: 0.5, continuous: true },
    });
  });

  it('drops maskAllEnforced when continuous is off (meaningless without it)', () => {
    expect(normalizeReplayConfig({ sampleRate: 0.5, maskAllEnforced: false })).toEqual({
      ok: true,
      value: { sampleRate: 0.5 },
    });
    // A lone maskAllEnforced (no rate/continuous) clears the config entirely.
    expect(normalizeReplayConfig({ maskAllEnforced: false })).toEqual({ ok: true, value: null });
  });
});

describe('resolveReplayPolicy', () => {
  it('returns the default policy for missing config', () => {
    expect(resolveReplayPolicy(null)).toEqual(DEFAULT_REPLAY_POLICY);
    expect(resolveReplayPolicy(undefined)).toEqual(DEFAULT_REPLAY_POLICY);
    expect(DEFAULT_REPLAY_POLICY.sampleRate).toBeNull();
    expect(DEFAULT_REPLAY_POLICY.continuous).toBe(false);
    expect(DEFAULT_REPLAY_POLICY.maskAllEnforced).toBe(false);
  });

  it('exposes an explicit sample rate', () => {
    expect(resolveReplayPolicy({ sampleRate: 0.4 })).toEqual({
      sampleRate: 0.4,
      continuous: false,
      maskAllEnforced: false,
    });
  });

  it('never resolves continuous-on to an unset rate (pins to a safe 0)', () => {
    // The recorder treats sampleRate null as "use the built-in default (1)", so
    // a continuous policy with no rate must resolve to an explicit 0, not null —
    // otherwise continuous capture would silently be 100%.
    expect(resolveReplayPolicy({ continuous: true })).toEqual({
      sampleRate: 0,
      continuous: true,
      maskAllEnforced: true,
    });
  });

  it('enforces mask-all by default when continuous is on', () => {
    expect(resolveReplayPolicy({ sampleRate: 1, continuous: true }).maskAllEnforced).toBe(true);
    expect(resolveReplayPolicy({ sampleRate: 1, continuous: false }).maskAllEnforced).toBe(false);
  });

  it('honours the Admin mask-all opt-out (continuous on, maskAllEnforced:false)', () => {
    expect(
      resolveReplayPolicy({ sampleRate: 1, continuous: true, maskAllEnforced: false }),
    ).toEqual({
      sampleRate: 1,
      continuous: true,
      maskAllEnforced: false,
    });
  });

  it('treats maskAllEnforced:true the same as the default (enforced)', () => {
    expect(
      resolveReplayPolicy({ sampleRate: 1, continuous: true, maskAllEnforced: true })
        .maskAllEnforced,
    ).toBe(true);
  });

  it('ignores maskAllEnforced when continuous is off (never enforced)', () => {
    expect(
      resolveReplayPolicy({ sampleRate: 1, continuous: false, maskAllEnforced: false })
        .maskAllEnforced,
    ).toBe(false);
    // Even a stray maskAllEnforced:true can't enforce without continuous on.
    expect(
      resolveReplayPolicy({ sampleRate: 1, continuous: false, maskAllEnforced: true })
        .maskAllEnforced,
    ).toBe(false);
  });
});
