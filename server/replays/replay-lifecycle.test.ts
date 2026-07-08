import { describe, it, expect } from 'vitest';
import {
  buildRumLifecycleConfiguration,
  mergeManagedLifecycleRules,
  managedRulesEquivalent,
  isManagedRumRule,
  applyRumLifecyclePolicy,
  RUM_STORAGE_PREFIX,
  RUM_LIFECYCLE_RULE_ID,
  RUM_MANAGED_RULE_ID_PREFIX,
  RUM_PROJECT_RULE_ID_PREFIX,
  rumProjectRuleId,
  type LifecycleRule,
  type LifecycleS3Port,
} from './replay-lifecycle.js';

describe('buildRumLifecycleConfiguration', () => {
  it('provisions nothing when retention is disabled (<= 0 / non-finite)', () => {
    expect(buildRumLifecycleConfiguration({ retentionDays: 0 }).Rules).toEqual([]);
    expect(buildRumLifecycleConfiguration({ retentionDays: -5 }).Rules).toEqual([]);
    expect(buildRumLifecycleConfiguration({ retentionDays: NaN }).Rules).toEqual([]);
  });

  it('emits an expiration-only rule at the 30-day default (no room to tier)', () => {
    const { Rules } = buildRumLifecycleConfiguration({ retentionDays: 30 });
    expect(Rules).toHaveLength(1);
    const rule = Rules[0];
    expect(rule.ID).toBe(RUM_LIFECYCLE_RULE_ID);
    expect(rule.Status).toBe('Enabled');
    expect(rule.Filter).toEqual({ Prefix: RUM_STORAGE_PREFIX });
    expect(rule.Expiration).toEqual({ Days: 30 });
    // IA(30) is not strictly < 30, Glacier(90) not < 30 → both dropped.
    expect(rule.Transitions).toBeUndefined();
    // Multipart hygiene always present.
    expect(rule.AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 7 });
  });

  it('tiers IA then Glacier before expiry for extended retention (15 months)', () => {
    const { Rules } = buildRumLifecycleConfiguration({ retentionDays: 450 });
    const rule = Rules[0];
    expect(rule.Expiration).toEqual({ Days: 450 });
    expect(rule.Transitions).toEqual([
      { Days: 30, StorageClass: 'STANDARD_IA' },
      { Days: 90, StorageClass: 'GLACIER' },
    ]);
  });

  it('drops the Glacier transition that would not fit before expiration', () => {
    const { Rules } = buildRumLifecycleConfiguration({ retentionDays: 45 });
    // IA(30) < 45 kept; Glacier(90) not < 45 → dropped.
    expect(Rules[0].Transitions).toEqual([{ Days: 30, StorageClass: 'STANDARD_IA' }]);
  });

  it('clamps IA up to the 30-day S3 minimum', () => {
    const { Rules } = buildRumLifecycleConfiguration({
      retentionDays: 400,
      iaTransitionDays: 10,
    });
    expect(Rules[0].Transitions?.[0]).toEqual({ Days: 30, StorageClass: 'STANDARD_IA' });
  });

  it('clamps Glacier to at least IA + 30 days (min time in IA)', () => {
    const { Rules } = buildRumLifecycleConfiguration({
      retentionDays: 400,
      iaTransitionDays: 60,
      glacierTransitionDays: 70, // below ia(60)+30 = 90 → clamped up to 90
    });
    expect(Rules[0].Transitions).toEqual([
      { Days: 60, StorageClass: 'STANDARD_IA' },
      { Days: 90, StorageClass: 'GLACIER' },
    ]);
  });

  it('honors enableTiering:false with an expiration-only rule', () => {
    const { Rules } = buildRumLifecycleConfiguration({
      retentionDays: 400,
      enableTiering: false,
    });
    expect(Rules[0].Transitions).toBeUndefined();
    expect(Rules[0].Expiration).toEqual({ Days: 400 });
  });

  it('scopes to the given prefix', () => {
    const { Rules } = buildRumLifecycleConfiguration({ retentionDays: 30, prefix: 'rum/acme/' });
    expect(Rules[0].Filter).toEqual({ Prefix: 'rum/acme/' });
  });

  it('supports a Glacier-direct tier when IA is disabled', () => {
    const { Rules } = buildRumLifecycleConfiguration({
      retentionDays: 400,
      iaTransitionDays: 0, // IA off
      glacierTransitionDays: 90,
    });
    expect(Rules[0].Transitions).toEqual([{ Days: 90, StorageClass: 'GLACIER' }]);
  });
});

describe('buildRumLifecycleConfiguration — per-tenant overrides', () => {
  it('emits a per-prefix rule per override alongside the global rule', () => {
    const { Rules } = buildRumLifecycleConfiguration({
      retentionDays: 30,
      projectOverrides: [
        { prefix: 'rum/acme/', retentionDays: 7, ruleId: rumProjectRuleId('acme') },
        { prefix: 'rum/globex/', retentionDays: 14, ruleId: rumProjectRuleId('globex') },
      ],
    });
    expect(Rules).toHaveLength(3);
    expect(Rules[0].ID).toBe(RUM_LIFECYCLE_RULE_ID);
    expect(Rules[0].Expiration).toEqual({ Days: 30 });

    const acme = Rules.find((r) => r.ID === rumProjectRuleId('acme'))!;
    expect(acme.Filter).toEqual({ Prefix: 'rum/acme/' });
    expect(acme.Expiration).toEqual({ Days: 7 });
    // Short window → no room to tier, expiration-only.
    expect(acme.Transitions).toBeUndefined();
    // Every per-project rule id is recognized as managed (cleaned up on re-provision).
    expect(acme.ID?.startsWith(RUM_PROJECT_RULE_ID_PREFIX)).toBe(true);
    expect(isManagedRumRule(acme)).toBe(true);

    const globex = Rules.find((r) => r.ID === rumProjectRuleId('globex'))!;
    expect(globex.Expiration).toEqual({ Days: 14 });
  });

  it('emits ONLY per-tenant rules when the global window is off', () => {
    const { Rules } = buildRumLifecycleConfiguration({
      retentionDays: 0, // global keep-forever
      projectOverrides: [
        { prefix: 'rum/acme/', retentionDays: 7, ruleId: rumProjectRuleId('acme') },
      ],
    });
    expect(Rules).toHaveLength(1);
    expect(Rules[0].ID).toBe(rumProjectRuleId('acme'));
    expect(Rules[0].Expiration).toEqual({ Days: 7 });
  });

  it('dedupes overrides by rule id (last one wins)', () => {
    const { Rules } = buildRumLifecycleConfiguration({
      retentionDays: 30,
      projectOverrides: [
        { prefix: 'rum/acme/', retentionDays: 7, ruleId: rumProjectRuleId('acme') },
        { prefix: 'rum/acme/', retentionDays: 9, ruleId: rumProjectRuleId('acme') },
      ],
    });
    const acme = Rules.filter((r) => r.ID === rumProjectRuleId('acme'));
    expect(acme).toHaveLength(1);
    // First-wins dedupe (the second is skipped).
    expect(acme[0].Expiration).toEqual({ Days: 7 });
  });

  it('derives a default rule id from the prefix when none is given', () => {
    const { Rules } = buildRumLifecycleConfiguration({
      retentionDays: 30,
      projectOverrides: [{ prefix: 'rum/acme/', retentionDays: 7 }],
    });
    const acme = Rules.find((r) => r.Filter?.Prefix === 'rum/acme/')!;
    expect(acme.ID).toBe(`${RUM_PROJECT_RULE_ID_PREFIX}rum/acme/`);
  });
});

describe('mergeManagedLifecycleRules / isManagedRumRule', () => {
  const foreign: LifecycleRule = {
    ID: 'ops-archive-logs',
    Status: 'Enabled',
    Filter: { Prefix: 'logs/' },
    Expiration: { Days: 90 },
  };
  const managed = buildRumLifecycleConfiguration({ retentionDays: 30 }).Rules;

  it('identifies managed rules by id prefix', () => {
    expect(isManagedRumRule(managed[0])).toBe(true);
    expect(isManagedRumRule(foreign)).toBe(false);
    expect(isManagedRumRule({})).toBe(false);
  });

  it('preserves foreign rules and appends managed rules last', () => {
    const merged = mergeManagedLifecycleRules([foreign], managed);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(foreign);
    expect(merged[1].ID).toBe(RUM_LIFECYCLE_RULE_ID);
  });

  it('replaces a prior managed rule instead of duplicating it', () => {
    const prior: LifecycleRule = {
      ID: `${RUM_MANAGED_RULE_ID_PREFIX}-retention`,
      Status: 'Enabled',
    };
    const merged = mergeManagedLifecycleRules([foreign, prior], managed);
    expect(merged.filter((r) => isManagedRumRule(r))).toHaveLength(1);
    expect(merged[0]).toBe(foreign);
  });

  it('drops the managed rule (keeping foreign) when managed is empty', () => {
    const prior: LifecycleRule = {
      ID: `${RUM_MANAGED_RULE_ID_PREFIX}-retention`,
      Status: 'Enabled',
    };
    const merged = mergeManagedLifecycleRules([foreign, prior], []);
    expect(merged).toEqual([foreign]);
  });
});

describe('managedRulesEquivalent', () => {
  it('matches identical managed rule sets', () => {
    const a = buildRumLifecycleConfiguration({ retentionDays: 30 }).Rules;
    const b = buildRumLifecycleConfiguration({ retentionDays: 30 }).Rules;
    expect(managedRulesEquivalent(a, b)).toBe(true);
  });

  it('differs when the managed content differs (retention change)', () => {
    const a = buildRumLifecycleConfiguration({ retentionDays: 30 }).Rules;
    const b = buildRumLifecycleConfiguration({ retentionDays: 60 }).Rules;
    expect(managedRulesEquivalent(a, b)).toBe(false);
  });

  it('is order-insensitive on object keys (SDK read-back reorders XML keys)', () => {
    const ours = buildRumLifecycleConfiguration({ retentionDays: 450 }).Rules;
    // Simulate the SDK-deserialized shape: same values, different key ORDER, plus
    // an extra field S3 echoes that we don't manage. This is the real-world case
    // a raw JSON.stringify compare got wrong (PUT on every boot).
    const fromS3: LifecycleRule[] = [
      {
        Expiration: { Days: 450 },
        Transitions: [
          { StorageClass: 'STANDARD_IA', Days: 30 },
          { StorageClass: 'GLACIER', Days: 90 },
        ],
        Filter: { Prefix: RUM_STORAGE_PREFIX },
        Status: 'Enabled',
        ID: RUM_LIFECYCLE_RULE_ID,
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        // Field S3 may add that we never set — must be ignored by the compare.
        NoncurrentVersionExpiration: undefined,
      },
    ];
    expect(managedRulesEquivalent(fromS3, ours)).toBe(true);
  });

  it('treats an empty set as equivalent only to another empty set', () => {
    expect(managedRulesEquivalent([], [])).toBe(true);
    expect(
      managedRulesEquivalent([], buildRumLifecycleConfiguration({ retentionDays: 30 }).Rules),
    ).toBe(false);
  });
});

describe('applyRumLifecyclePolicy', () => {
  /** In-memory port that persists rules like a real bucket would. */
  function fakePort(
    initial: LifecycleRule[] = [],
  ): LifecycleS3Port & { rules: LifecycleRule[]; puts: number } {
    const state = { rules: [...initial], puts: 0 };
    return {
      get rules() {
        return state.rules;
      },
      get puts() {
        return state.puts;
      },
      async getBucketLifecycleRules() {
        return state.rules;
      },
      async putBucketLifecycleRules(rules: LifecycleRule[]) {
        state.rules = rules;
        state.puts += 1;
      },
    } as LifecycleS3Port & { rules: LifecycleRule[]; puts: number };
  }

  it('PUTs the managed rule onto an empty bucket', async () => {
    const port = fakePort();
    const res = await applyRumLifecyclePolicy(port, { retentionDays: 30 });
    expect(res.changed).toBe(true);
    expect(res.managedRuleCount).toBe(1);
    expect(port.rules.map((r) => r.ID)).toEqual([RUM_LIFECYCLE_RULE_ID]);
  });

  it('is idempotent: a second apply issues no PUT', async () => {
    const port = fakePort();
    await applyRumLifecyclePolicy(port, { retentionDays: 30 });
    const before = port.puts;
    const res = await applyRumLifecyclePolicy(port, { retentionDays: 30 });
    expect(res.changed).toBe(false);
    expect(port.puts).toBe(before);
  });

  it('no-ops against an SDK-shaped read-back (reordered keys + extra field)', async () => {
    // The real GetBucketLifecycleConfiguration returns objects whose key order and
    // defaulted fields won't match our literal. A raw stringify compare would PUT
    // on every boot; the semantic compare must recognize it as already-provisioned.
    let puts = 0;
    const port: LifecycleS3Port = {
      async getBucketLifecycleRules() {
        return [
          {
            Expiration: { Days: 30 },
            Filter: { Prefix: RUM_STORAGE_PREFIX },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            Status: 'Enabled',
            ID: RUM_LIFECYCLE_RULE_ID,
            NoncurrentVersionExpiration: undefined,
          },
        ];
      },
      async putBucketLifecycleRules() {
        puts += 1;
      },
    };
    const res = await applyRumLifecyclePolicy(port, { retentionDays: 30 });
    expect(res.changed).toBe(false);
    expect(puts).toBe(0);
  });

  it('preserves foreign rules while adding ours', async () => {
    const foreign: LifecycleRule = { ID: 'ops-x', Status: 'Enabled', Filter: { Prefix: 'x/' } };
    const port = fakePort([foreign]);
    await applyRumLifecyclePolicy(port, { retentionDays: 30 });
    expect(port.rules.map((r) => r.ID)).toEqual(['ops-x', RUM_LIFECYCLE_RULE_ID]);
  });

  it('removes the managed rule when retention is disabled, keeping foreign rules', async () => {
    const foreign: LifecycleRule = { ID: 'ops-x', Status: 'Enabled', Filter: { Prefix: 'x/' } };
    const port = fakePort([foreign]);
    await applyRumLifecyclePolicy(port, { retentionDays: 30 });
    const res = await applyRumLifecyclePolicy(port, { retentionDays: 0 });
    expect(res.changed).toBe(true);
    expect(res.managedRuleCount).toBe(0);
    expect(port.rules).toEqual([foreign]);
  });
});
