import { describe, it, expect } from 'vitest';
import {
  clampReplaySampleRate,
  clampFlushIntervalMs,
  normalizeReplayConfig,
  resolveReplayPolicy,
  resolveEffectiveReplayRate,
  resolveIngestQuota,
  resolveBaseRetentionDays,
  collectRetentionOverrides,
  MAX_BASE_RETENTION_DAYS,
  DEFAULT_REPLAY_POLICY,
  DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
  MIN_CONTINUOUS_FLUSH_INTERVAL_MS,
  MAX_CONTINUOUS_FLUSH_INTERVAL_MS,
  MIN_SEGMENTED_FLUSH_INTERVAL_MS,
  DEFAULT_SEGMENTED_FLUSH_INTERVAL_MS,
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

describe('clampFlushIntervalMs', () => {
  it('defaults unset / non-finite to the 5-min default', () => {
    expect(clampFlushIntervalMs(undefined)).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(clampFlushIntervalMs(null)).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(clampFlushIntervalMs(NaN)).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(clampFlushIntervalMs(Infinity)).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
  });

  it('raises a sub-minute cadence to the floor (no sub-minute on monolithic storage)', () => {
    expect(clampFlushIntervalMs(5_000)).toBe(MIN_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(clampFlushIntervalMs(0)).toBe(MIN_CONTINUOUS_FLUSH_INTERVAL_MS);
  });

  it('caps an excessive cadence to the ceiling', () => {
    expect(clampFlushIntervalMs(10 * 60 * 60 * 1000)).toBe(MAX_CONTINUOUS_FLUSH_INTERVAL_MS);
  });

  it('passes through an in-range cadence', () => {
    expect(clampFlushIntervalMs(2 * 60 * 1000)).toBe(2 * 60 * 1000);
  });

  it('uses the segmented floor + default when { segmented: true }', () => {
    // Unset segmented → the ~5s segment default, NOT the 5-min monolithic default.
    expect(clampFlushIntervalMs(undefined, { segmented: true })).toBe(
      DEFAULT_SEGMENTED_FLUSH_INTERVAL_MS,
    );
    // A sub-minute value is kept (append is O(1)), only floored below 1s.
    expect(clampFlushIntervalMs(5_000, { segmented: true })).toBe(5_000);
    expect(clampFlushIntervalMs(10, { segmented: true })).toBe(MIN_SEGMENTED_FLUSH_INTERVAL_MS);
    // The 1-hour ceiling still applies.
    expect(clampFlushIntervalMs(10 * 60 * 60 * 1000, { segmented: true })).toBe(
      MAX_CONTINUOUS_FLUSH_INTERVAL_MS,
    );
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

  it('accepts an in-range flushIntervalMs', () => {
    expect(
      normalizeReplayConfig({ continuous: true, sampleRate: 1, flushIntervalMs: 120_000 }),
    ).toEqual({
      ok: true,
      value: { sampleRate: 1, continuous: true, flushIntervalMs: 120_000 },
    });
  });

  it('rejects a non-numeric or sub-minute flushIntervalMs', () => {
    expect(normalizeReplayConfig({ flushIntervalMs: 'soon' }).ok).toBe(false);
    expect(normalizeReplayConfig({ flushIntervalMs: NaN }).ok).toBe(false);
    expect(normalizeReplayConfig({ flushIntervalMs: 5_000 }).ok).toBe(false);
    expect(normalizeReplayConfig({ flushIntervalMs: 10 * 60 * 60 * 1000 }).ok).toBe(false);
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

  it('rejects a non-boolean segmented', () => {
    expect(normalizeReplayConfig({ continuous: true, sampleRate: 1, segmented: 'yes' }).ok).toBe(
      false,
    );
  });

  it('persists segmented:true only with continuous on', () => {
    expect(normalizeReplayConfig({ continuous: true, sampleRate: 0.5, segmented: true })).toEqual({
      ok: true,
      value: { sampleRate: 0.5, continuous: true, segmented: true },
    });
  });

  it('drops segmented when continuous is off (meaningless without it)', () => {
    expect(normalizeReplayConfig({ sampleRate: 0.5, segmented: true })).toEqual({
      ok: true,
      value: { sampleRate: 0.5 },
    });
    // A lone segmented (no rate/continuous) clears the config entirely.
    expect(normalizeReplayConfig({ segmented: true })).toEqual({ ok: true, value: null });
  });

  it('drops a redundant segmented:false', () => {
    expect(normalizeReplayConfig({ continuous: true, sampleRate: 0.5, segmented: false })).toEqual({
      ok: true,
      value: { sampleRate: 0.5, continuous: true },
    });
  });

  it('accepts a sub-minute flushIntervalMs on the segmented path (O(1) append lifts the floor)', () => {
    expect(
      normalizeReplayConfig({
        continuous: true,
        sampleRate: 1,
        segmented: true,
        flushIntervalMs: 5_000,
      }),
    ).toEqual({
      ok: true,
      value: { sampleRate: 1, continuous: true, segmented: true, flushIntervalMs: 5_000 },
    });
  });

  it('still rejects a sub-minute flushIntervalMs on the monolithic path', () => {
    const res = normalizeReplayConfig({ continuous: true, sampleRate: 1, flushIntervalMs: 5_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/sub-minute cadence on monolithic storage/);
  });

  it('rejects a flushIntervalMs below the segmented floor (1s)', () => {
    expect(
      normalizeReplayConfig({
        continuous: true,
        sampleRate: 1,
        segmented: true,
        flushIntervalMs: MIN_SEGMENTED_FLUSH_INTERVAL_MS - 1,
      }).ok,
    ).toBe(false);
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
      segmented: false,
      maskAllEnforced: false,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
    });
  });

  it('never resolves continuous-on to an unset rate (pins to a safe 0)', () => {
    // The recorder treats sampleRate null as "use the built-in default (1)", so
    // a continuous policy with no rate must resolve to an explicit 0, not null —
    // otherwise continuous capture would silently be 100%.
    expect(resolveReplayPolicy({ continuous: true })).toEqual({
      sampleRate: 0,
      continuous: true,
      segmented: false,
      maskAllEnforced: true,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
    });
  });

  it('resolves segmented only with continuous on', () => {
    expect(
      resolveReplayPolicy({ sampleRate: 1, continuous: true, segmented: true }).segmented,
    ).toBe(true);
    // Segmented without continuous is meaningless — never resolves true.
    expect(resolveReplayPolicy({ sampleRate: 1, segmented: true }).segmented).toBe(false);
    expect(resolveReplayPolicy({ sampleRate: 1, continuous: true }).segmented).toBe(false);
    expect(DEFAULT_REPLAY_POLICY.segmented).toBe(false);
  });

  it('lifts the sub-minute flush floor when segmented resolves on', () => {
    // Same raw 5s cadence: floored to 60s on monolithic, kept at 5s on segmented.
    expect(
      resolveReplayPolicy({ sampleRate: 1, continuous: true, flushIntervalMs: 5_000 })
        .flushIntervalMs,
    ).toBe(MIN_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(
      resolveReplayPolicy({
        sampleRate: 1,
        continuous: true,
        segmented: true,
        flushIntervalMs: 5_000,
      }).flushIntervalMs,
    ).toBe(5_000);
  });

  it('defaults the segmented cadence to the ~5s segment default (not 5 min) when unset', () => {
    // A segmented project with no explicit flushIntervalMs must resolve to the
    // segment duration default, not the monolithic 5-min whole-blob default.
    expect(
      resolveReplayPolicy({ sampleRate: 1, continuous: true, segmented: true }).flushIntervalMs,
    ).toBe(DEFAULT_SEGMENTED_FLUSH_INTERVAL_MS);
    // Monolithic unset still defaults to 5 min.
    expect(resolveReplayPolicy({ sampleRate: 1, continuous: true }).flushIntervalMs).toBe(
      DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
    );
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
      segmented: false,
      maskAllEnforced: false,
      flushIntervalMs: DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
      sessionSampleRate: null,
      sessionReplaySampleRate: null,
      effectiveReplaySampleRate: null,
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

  it('delivers the (clamped) per-project flush cadence', () => {
    expect(
      resolveReplayPolicy({ continuous: true, sampleRate: 1, flushIntervalMs: 120_000 })
        .flushIntervalMs,
    ).toBe(120_000);
    // Sub-minute is raised to the floor even if it slipped past the validator.
    expect(resolveReplayPolicy({ flushIntervalMs: 1_000 }).flushIntervalMs).toBe(
      MIN_CONTINUOUS_FLUSH_INTERVAL_MS,
    );
    // Unset → default.
    expect(resolveReplayPolicy({ sampleRate: 0.5 }).flushIntervalMs).toBe(
      DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
    );
  });
});

describe('resolveEffectiveReplayRate (two-level nested sampling math)', () => {
  it('multiplies the two levels: replay % is OF the sampled sessions', () => {
    // 50% of sessions sampled, 50% of THOSE recorded → 25% overall, not 50%.
    expect(resolveEffectiveReplayRate(0.5, 0.5)).toBeCloseTo(0.25);
    expect(resolveEffectiveReplayRate(0.2, 0.1)).toBeCloseTo(0.02);
    expect(resolveEffectiveReplayRate(1, 1)).toBe(1);
  });

  it('a zero at either level yields zero effective replay', () => {
    expect(resolveEffectiveReplayRate(0, 1)).toBe(0);
    expect(resolveEffectiveReplayRate(1, 0)).toBe(0);
  });

  it('clamps out-of-range inputs before multiplying', () => {
    expect(resolveEffectiveReplayRate(2, 0.5)).toBeCloseTo(0.5); // 2 → 1
    expect(resolveEffectiveReplayRate(-1, 0.5)).toBe(0); // -1 → 0
    expect(resolveEffectiveReplayRate(NaN, 0.5)).toBe(0); // non-finite → 0
  });
});

describe('resolveIngestQuota (per-tenant budget)', () => {
  it('uses a configured positive quota, floored to an integer', () => {
    expect(resolveIngestQuota(1200, 600)).toBe(1200);
    expect(resolveIngestQuota(50.9, 600)).toBe(50);
  });

  it('falls back to the global default when unset / invalid / non-positive', () => {
    expect(resolveIngestQuota(undefined, 600)).toBe(600);
    expect(resolveIngestQuota(null, 600)).toBe(600);
    expect(resolveIngestQuota(0, 600)).toBe(600);
    expect(resolveIngestQuota(-5, 600)).toBe(600);
    expect(resolveIngestQuota(NaN, 600)).toBe(600);
    expect(resolveIngestQuota(Infinity, 600)).toBe(600);
  });
});

describe('normalizeReplayConfig — two-level sampling + quotas', () => {
  it('accepts and clamps the nested sample rates', () => {
    expect(normalizeReplayConfig({ sessionSampleRate: 0.5, sessionReplaySampleRate: 0.2 })).toEqual(
      {
        ok: true,
        value: { sessionSampleRate: 0.5, sessionReplaySampleRate: 0.2 },
      },
    );
  });

  it('rejects out-of-range or non-numeric nested rates', () => {
    expect(normalizeReplayConfig({ sessionSampleRate: 1.5 }).ok).toBe(false);
    expect(normalizeReplayConfig({ sessionSampleRate: -0.1 }).ok).toBe(false);
    expect(normalizeReplayConfig({ sessionReplaySampleRate: 'half' }).ok).toBe(false);
    expect(normalizeReplayConfig({ sessionReplaySampleRate: NaN }).ok).toBe(false);
  });

  it('accepts positive integer ingest quotas (floored)', () => {
    expect(normalizeReplayConfig({ ingestQuota: 1200, eventsIngestQuota: 9000.7 })).toEqual({
      ok: true,
      value: { ingestQuota: 1200, eventsIngestQuota: 9000 },
    });
  });

  it('rejects non-positive or non-numeric quotas', () => {
    expect(normalizeReplayConfig({ ingestQuota: 0 }).ok).toBe(false);
    expect(normalizeReplayConfig({ ingestQuota: -1 }).ok).toBe(false);
    expect(normalizeReplayConfig({ eventsIngestQuota: 'lots' }).ok).toBe(false);
  });

  it('keeps a config that sets only nested rates or only a quota (not cleared)', () => {
    expect(normalizeReplayConfig({ sessionSampleRate: 0.3 })).toEqual({
      ok: true,
      value: { sessionSampleRate: 0.3 },
    });
    expect(normalizeReplayConfig({ ingestQuota: 100 })).toEqual({
      ok: true,
      value: { ingestQuota: 100 },
    });
  });
});

describe('normalizeReplayConfig — retention', () => {
  it('accepts an extended-retention window in [1, 15] months (floored)', () => {
    expect(normalizeReplayConfig({ extendedRetentionMonths: 15 })).toEqual({
      ok: true,
      value: { extendedRetentionMonths: 15 },
    });
    expect(normalizeReplayConfig({ extendedRetentionMonths: 6.8 })).toEqual({
      ok: true,
      value: { extendedRetentionMonths: 6 },
    });
  });

  it('rejects an out-of-range or non-numeric extended-retention window', () => {
    expect(normalizeReplayConfig({ extendedRetentionMonths: 0 }).ok).toBe(false);
    expect(normalizeReplayConfig({ extendedRetentionMonths: 16 }).ok).toBe(false);
    expect(normalizeReplayConfig({ extendedRetentionMonths: NaN }).ok).toBe(false);
    expect(normalizeReplayConfig({ extendedRetentionMonths: 'year' }).ok).toBe(false);
  });

  it('keeps a config that sets only the extended-retention window (not cleared)', () => {
    expect(normalizeReplayConfig({ extendedRetentionMonths: 12 })).toEqual({
      ok: true,
      value: { extendedRetentionMonths: 12 },
    });
  });
});

describe('resolveReplayPolicy — nested rates', () => {
  it('delivers both nested rates and their effective product', () => {
    const policy = resolveReplayPolicy({ sessionSampleRate: 0.5, sessionReplaySampleRate: 0.4 });
    expect(policy.sessionSampleRate).toBeCloseTo(0.5);
    expect(policy.sessionReplaySampleRate).toBeCloseTo(0.4);
    expect(policy.effectiveReplaySampleRate).toBeCloseTo(0.2);
  });

  it('treats an unset level as 1 when the other is set', () => {
    // Only level-1 set → effective is just the session rate.
    expect(resolveReplayPolicy({ sessionSampleRate: 0.3 }).effectiveReplaySampleRate).toBeCloseTo(
      0.3,
    );
    // Only level-2 set → effective is just the replay rate.
    expect(
      resolveReplayPolicy({ sessionReplaySampleRate: 0.25 }).effectiveReplaySampleRate,
    ).toBeCloseTo(0.25);
  });

  it('leaves effective null when both nested rates are unset (built-in default)', () => {
    const policy = resolveReplayPolicy({ sampleRate: 0.5 });
    expect(policy.sessionSampleRate).toBeNull();
    expect(policy.sessionReplaySampleRate).toBeNull();
    expect(policy.effectiveReplaySampleRate).toBeNull();
  });
});

describe('normalizeReplayConfig — retentionDays (per-tenant BASE window)', () => {
  it('accepts a positive integer and floors fractions', () => {
    expect(normalizeReplayConfig({ retentionDays: 7 })).toEqual({
      ok: true,
      value: { retentionDays: 7 },
    });
    expect(normalizeReplayConfig({ retentionDays: 7.9 })).toEqual({
      ok: true,
      value: { retentionDays: 7 },
    });
  });

  it('rejects non-positive, non-finite, and over-max values', () => {
    expect(normalizeReplayConfig({ retentionDays: 0 }).ok).toBe(false);
    expect(normalizeReplayConfig({ retentionDays: -5 }).ok).toBe(false);
    expect(normalizeReplayConfig({ retentionDays: NaN }).ok).toBe(false);
    expect(normalizeReplayConfig({ retentionDays: 'week' }).ok).toBe(false);
    expect(normalizeReplayConfig({ retentionDays: MAX_BASE_RETENTION_DAYS + 1 }).ok).toBe(false);
    expect(normalizeReplayConfig({ retentionDays: MAX_BASE_RETENTION_DAYS }).ok).toBe(true);
  });

  it('coexists with other replay config keys', () => {
    expect(normalizeReplayConfig({ sampleRate: 0.5, retentionDays: 14 })).toEqual({
      ok: true,
      value: { sampleRate: 0.5, retentionDays: 14 },
    });
  });
});

describe('resolveBaseRetentionDays', () => {
  it('returns the global default when there is no override', () => {
    expect(resolveBaseRetentionDays(undefined, 30)).toBe(30);
    expect(resolveBaseRetentionDays(null, 30)).toBe(30);
    expect(resolveBaseRetentionDays(0, 30)).toBe(30);
    // Global off (keep-forever) with no override → 0.
    expect(resolveBaseRetentionDays(undefined, 0)).toBe(0);
  });

  it('tightens: min(override, global) when the global window is on', () => {
    expect(resolveBaseRetentionDays(7, 30)).toBe(7);
    // A longer override cannot beat the global S3 rule → clamps to the global window.
    expect(resolveBaseRetentionDays(90, 30)).toBe(30);
    expect(resolveBaseRetentionDays(30, 30)).toBe(30);
  });

  it('turns retention ON for a tenant when the global window is off', () => {
    expect(resolveBaseRetentionDays(7, 0)).toBe(7);
    expect(resolveBaseRetentionDays(400, 0)).toBe(400);
  });

  it('floors a fractional override', () => {
    expect(resolveBaseRetentionDays(7.9, 30)).toBe(7);
  });
});

describe('collectRetentionOverrides', () => {
  const proj = (id: string, retentionDays?: number) => ({
    id,
    replay: retentionDays === undefined ? undefined : { retentionDays },
  });

  it('returns only projects whose effective window differs from the global default', () => {
    const overrides = collectRetentionOverrides(
      [
        proj('tighter', 7), // < global → included
        proj('same', 30), // == global → omitted
        proj('longer', 90), // clamps to global → omitted (behaves as default)
        proj('default'), // no override → omitted
      ],
      30,
    );
    expect(overrides).toEqual([{ projectId: 'tighter', retentionDays: 7 }]);
  });

  it('includes tenants that opt into retention while the global window is off', () => {
    const overrides = collectRetentionOverrides([proj('opt-in', 14), proj('off')], 0);
    expect(overrides).toEqual([{ projectId: 'opt-in', retentionDays: 14 }]);
  });

  it('ignores non-positive / missing overrides', () => {
    const overrides = collectRetentionOverrides(
      [{ id: 'a', replay: { sampleRate: 0.5 } }, { id: 'b', replay: null }, { id: 'c' }],
      30,
    );
    expect(overrides).toEqual([]);
  });
});
