/**
 * The alarm evaluator — our reimplementation of CloudWatch's own alarm
 * semantics (decision INFRA-ALERT).
 *
 * We evaluate thresholds in our poller instead of provisioning real
 * `PutMetricAlarm` alarms in the monitored account: that API is quota'd at
 * 3 TPS, needs write access we deliberately do not hold, and leaves mutable
 * state in someone else's account that we would then own the cleanup of. We are
 * already polling the data, so evaluating it is nearly free.
 *
 * The price of that choice is paid here. Operators *will* diff our state
 * against the CloudWatch console, and a divergence in the missing-data rules is
 * indistinguishable from a bug in their infrastructure — the worst possible
 * failure for a monitoring tool. So this module reproduces the published
 * behaviour rather than a reasonable approximation of it, and every rule below
 * is traceable to a specific sentence or table row in AWS's own documentation
 * (verified August 2026):
 *
 *   - "Configuring how CloudWatch alarms treat missing data" — the four
 *     treatments, the *evaluation range*, and the two worked example tables.
 *   - "Avoiding premature transitions to alarm state" — the rule named
 *     {@link prematureAlarmApplies} below.
 *   - `PutMetricAlarm` — the comparison operators, and `DatapointsToAlarm` /
 *     `EvaluationPeriods` as the M and N of an M-out-of-N alarm.
 *
 * Both of AWS's example tables are transcribed verbatim into
 * `alert-evaluator.test.ts` as the fixture the implementation is pinned to. If
 * a change here does not keep all ten published rows green, the change is
 * wrong, however sensible it reads.
 *
 * **Pure and IO-free by construction.** No database handle, no AWS client, and
 * no clock — the caller passes `evaluatedAtMs` and the datapoints. That is what
 * makes exhaustive table-driven testing of the missing-data matrix possible at
 * all, and the matrix is the part that is hard to get right.
 *
 * **The caller acts only on transitions.** CloudWatch's own contract is "an
 * alarm invokes actions only when the alarm changes state", which is why the
 * result carries `transitioned` rather than just a state. Notifying on every
 * tick that a rule is still breaching is the behaviour that gets a monitoring
 * integration muted.
 *
 * ## Known parity limitation — the caller chooses the evaluation range
 *
 * This module evaluates whatever range it is handed; it deliberately does not
 * compute one, and that is the single largest parity risk in the design.
 *
 * CloudWatch "attempts to retrieve a higher number of data points than the
 * number specified as Evaluation Periods", and "the exact number … depends on
 * the length of the alarm period and whether it is based on a metric with
 * standard resolution or high resolution". **AWS publishes no formula.** The
 * only concrete figure anywhere in the documentation is the worked example,
 * where Evaluation Periods is 3 and "5 is the evaluation range for the alarm".
 *
 * The range length is load-bearing, not cosmetic: `0 - X - -` at N=3, M=2 is a
 * published `OK`, but its own last four slots, `- X - -`, evaluate to `ALARM`,
 * because dropping the oldest slot drops the non-breaching datapoint that
 * suppresses the premature-alarm rule. Fetching a shorter range than CloudWatch
 * used can therefore invent an alarm, and fetching a longer one can suppress a
 * real one. `evaluationRangeLengthIsLoadBearing` in the test file pins that.
 *
 * An earlier revision exported an `alarmEvaluationRangeLength()` helper
 * returning `N + 2` for every alarm. It was removed rather than fixed: with no
 * published formula there is no correct value to return, so the helper could
 * only ever be a guess wearing the costume of a derivation, and it had no
 * caller to justify the risk. The collector-tick hook is the layer that holds
 * the period and the resolution, so that ticket owns the choice, states it
 * explicitly, and can revisit it without touching this evaluator.
 */

/** The three alarm states, matching CloudWatch's own. */
export const INFRA_ALARM_STATES = ['OK', 'ALARM', 'INSUFFICIENT_DATA'] as const;
export type InfraAlarmState = (typeof INFRA_ALARM_STATES)[number];

/**
 * The four `TreatMissingData` modes, spelled exactly as `PutMetricAlarm` spells
 * them so a rule row round-trips to the console vocabulary without a mapping
 * table.
 */
export const INFRA_TREAT_MISSING_DATA_MODES = [
  'missing',
  'notBreaching',
  'breaching',
  'ignore',
] as const;
export type InfraTreatMissingData = (typeof INFRA_TREAT_MISSING_DATA_MODES)[number];

/** AWS's documented default when `TreatMissingData` is omitted. */
export const DEFAULT_INFRA_TREAT_MISSING_DATA: InfraTreatMissingData = 'missing';

/**
 * The static-threshold comparison operators.
 *
 * `PutMetricAlarm` also accepts `LessThanLowerOrGreaterThanUpperThreshold`,
 * `LessThanLowerThreshold` and `GreaterThanUpperThreshold`, but AWS documents
 * those as "used only for alarms based on anomaly detection models". We do not
 * fit anomaly detection bands — there is no threshold *pair* for those
 * operators to compare against — so accepting them would mean accepting a rule
 * we cannot evaluate.
 */
export const INFRA_COMPARISON_OPERATORS = [
  'GreaterThanOrEqualToThreshold',
  'GreaterThanThreshold',
  'LessThanThreshold',
  'LessThanOrEqualToThreshold',
] as const;
export type InfraComparisonOperator = (typeof INFRA_COMPARISON_OPERATORS)[number];

/**
 * Why the evaluator landed on the state it did. Stored on the alert row and
 * rendered to the operator, because "ALARM" without "and it was the premature
 * rule, on one breaching datapoint" is exactly the ambiguity that sends someone
 * to the console to check our work.
 */
export const INFRA_ALARM_REASONS = [
  /** At least M of the N evaluated datapoints breached. */
  'datapoints_breached',
  /** The premature-alarm rule fired on fewer than M real breaching points. */
  'premature_alarm',
  /** Fewer than M breaching datapoints. */
  'within_threshold',
  /** Every datapoint in the evaluation range was missing, treatment `missing`. */
  'all_datapoints_missing',
  /** Treatment `ignore`, and the state would have been decided by missing data. */
  'missing_data_ignored',
] as const;
export type InfraAlarmReason = (typeof INFRA_ALARM_REASONS)[number];

/** The threshold rule, in CloudWatch's own parameter names. */
export interface InfraAlertRule {
  comparisonOperator: InfraComparisonOperator;
  threshold: number;
  /** N — the number of periods data is compared over. */
  evaluationPeriods: number;
  /** M — how many of the N must breach. Defaults to N (consecutive alarm). */
  datapointsToAlarm?: number | null;
  /** Defaults to {@link DEFAULT_INFRA_TREAT_MISSING_DATA}. */
  treatMissingData?: InfraTreatMissingData | null;
}

export interface InfraAlarmEvaluationInput {
  rule: InfraAlertRule;
  /**
   * The evaluation range: one slot per period, **oldest first**, `null` for a
   * period with no datapoint.
   *
   * This is the range, not the N most recent periods — see
   * {@link alarmEvaluationRangeLength}. Passing exactly N slots is legal and
   * simply means the extra history was unavailable; the treatment then fills
   * whatever is short.
   *
   * Non-finite numbers (`NaN`, `Infinity`) are read as missing. Our store never
   * writes one, and a gap is the honest interpretation of a value that cannot
   * be compared to a threshold.
   */
  datapoints: ReadonlyArray<number | null | undefined>;
  /** The state currently persisted for this (rule, resource). */
  previousState: InfraAlarmState;
  /** Clock passed in — this module never reads one. */
  evaluatedAtMs: number;
}

export interface InfraAlarmEvaluation {
  state: InfraAlarmState;
  previousState: InfraAlarmState;
  /** True only when `state !== previousState`. Callers fire actions on this. */
  transitioned: boolean;
  reason: InfraAlarmReason;
  evaluatedAtMs: number;
  /** Real (non-missing) datapoints found in the evaluation range. */
  realDatapoints: number;
  /** Synthetic datapoints the treatment had to supply. 0 when real >= N. */
  filledDatapoints: number;
  /** Breaching datapoints among the N evaluated, with the treatment applied. */
  breachingDatapoints: number;
}

/** One slot of the evaluation range, classified against the threshold. */
type DatapointClass = 'breaching' | 'notBreaching' | 'missing';

/** A rule with every optional field resolved to its documented default. */
interface NormalizedRule {
  comparisonOperator: InfraComparisonOperator;
  threshold: number;
  evaluationPeriods: number;
  datapointsToAlarm: number;
  treatMissingData: InfraTreatMissingData;
}

/**
 * Resolve defaults and reject a rule we cannot evaluate.
 *
 * Throwing rather than clamping, for the same reason `parseInfraTagFilter`
 * throws: a rule with `datapointsToAlarm` above `evaluationPeriods` can never
 * reach ALARM, and silently repairing it to something evaluable would hand the
 * operator an alarm that looks armed and is not. The caller evaluates rules in
 * a loop and skips the broken one, which is a visible, fixable state.
 */
function normalizeRule(rule: InfraAlertRule): NormalizedRule {
  if (!INFRA_COMPARISON_OPERATORS.includes(rule.comparisonOperator)) {
    throw new Error(
      `alert rule has unsupported comparisonOperator ${JSON.stringify(rule.comparisonOperator)}; ` +
        `expected one of ${INFRA_COMPARISON_OPERATORS.join(', ')}`,
    );
  }
  if (typeof rule.threshold !== 'number' || !Number.isFinite(rule.threshold)) {
    throw new Error(`alert rule threshold must be a finite number, got ${String(rule.threshold)}`);
  }

  const evaluationPeriods = rule.evaluationPeriods;
  if (!Number.isInteger(evaluationPeriods) || evaluationPeriods < 1) {
    throw new Error(
      `alert rule evaluationPeriods must be an integer >= 1, got ${String(evaluationPeriods)}`,
    );
  }

  const datapointsToAlarm = rule.datapointsToAlarm ?? evaluationPeriods;
  if (!Number.isInteger(datapointsToAlarm) || datapointsToAlarm < 1) {
    throw new Error(
      `alert rule datapointsToAlarm must be an integer >= 1, got ${String(rule.datapointsToAlarm)}`,
    );
  }
  if (datapointsToAlarm > evaluationPeriods) {
    throw new Error(
      `alert rule datapointsToAlarm (${datapointsToAlarm}) exceeds evaluationPeriods ` +
        `(${evaluationPeriods}); such a rule can never reach ALARM`,
    );
  }

  const treatMissingData = rule.treatMissingData ?? DEFAULT_INFRA_TREAT_MISSING_DATA;
  if (!INFRA_TREAT_MISSING_DATA_MODES.includes(treatMissingData)) {
    throw new Error(
      `alert rule has unsupported treatMissingData ${JSON.stringify(rule.treatMissingData)}; ` +
        `expected one of ${INFRA_TREAT_MISSING_DATA_MODES.join(', ')}`,
    );
  }

  return {
    comparisonOperator: rule.comparisonOperator,
    threshold: rule.threshold,
    evaluationPeriods,
    datapointsToAlarm,
    treatMissingData,
  };
}

/**
 * Compare one datapoint to the threshold.
 *
 * The `*OrEqualTo` variants are the whole reason this is a function rather than
 * an inline `>`: a rule written as `>= 1` on a count metric (NAT Gateway
 * `ErrorPortAllocation`, DynamoDB `WriteThrottleEvents`) means something
 * different from `> 1`, and off-by-one on the boundary is a class of divergence
 * an operator would report as "your alarm never fires".
 */
export function isDatapointBreaching(
  value: number,
  comparisonOperator: InfraComparisonOperator,
  threshold: number,
): boolean {
  switch (comparisonOperator) {
    case 'GreaterThanThreshold':
      return value > threshold;
    case 'GreaterThanOrEqualToThreshold':
      return value >= threshold;
    case 'LessThanThreshold':
      return value < threshold;
    case 'LessThanOrEqualToThreshold':
      return value <= threshold;
  }
}

function classifyDatapoints(
  datapoints: ReadonlyArray<number | null | undefined>,
  comparisonOperator: InfraComparisonOperator,
  threshold: number,
): DatapointClass[] {
  return datapoints.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'missing';
    return isDatapointBreaching(value, comparisonOperator, threshold)
      ? 'breaching'
      : 'notBreaching';
  });
}

/**
 * The premature-alarm rule, named because AWS names it.
 *
 * AWS: "alarms are designed to always go into ALARM state when the oldest
 * available breaching datapoint during the **Evaluation Periods** number of
 * data points is at least as old as the value of **Datapoints to Alarm**, and
 * all other more recent data points are breaching or missing. In this case, the
 * alarm goes into ALARM state even if the total number of datapoints available
 * is lower than M."
 *
 * The rule exists to split two intermittent-data cases that a plain M-of-N
 * count cannot tell apart. With N=3 and M=3, `- - - - X` must *not* alarm: the
 * breach is the newest point, and the next point may well be non-breaching
 * (`- - - X O`), so alarming now is a false positive. But `- - X - -` must
 * alarm: M periods have already elapsed since the breach with nothing
 * contradicting it, so waiting longer only delays a page.
 *
 * Two details are load-bearing and both are pinned by AWS's published rows:
 *
 *   - **The breaching datapoint is looked for in the most recent N slots only**
 *     ("during the Evaluation Periods number of data points"), so a breach that
 *     has aged out of the evaluation periods cannot resurrect the alarm.
 *   - **Any non-breaching datapoint in the *evaluated set* suppresses the
 *     rule**, and the evaluated set reaches further back than the N most recent
 *     slots whenever data is missing. This is what separates table-2 row 3
 *     (`0 - X - -`, N=3, M=2 → `OK`) from table-2 row 5 (`- - - X -`, same
 *     parameters → `ALARM`). The two are identical inside the N-window; the only
 *     difference is a non-breaching point two slots further back, which is in
 *     the evaluated set because AWS is explicit that "all real data points in
 *     the evaluation range are included in the evaluation".
 *
 * Scoping that second check to the evaluated set rather than to the raw range
 * is what keeps the rule from overriding real data. `0 X X - -` at N=3, M=3 has
 * three real datapoints — enough to evaluate without the missing-data machinery
 * at all — and one of them is healthy, so it is `OK` at 2-of-3, exactly like the
 * published table-1 row 1 `0 - X - X`, whose evaluated set is the identical
 * `[0, X, X]`. Dropping this check so that the rule fires on `0 X X - -` would
 * flip that published row too: its N-window is `X - X`, whose oldest breach is
 * also N slots old with only missing-or-breaching data after it.
 */
function prematureAlarmApplies(
  slots: readonly DatapointClass[],
  evaluated: readonly DatapointClass[],
  evaluationPeriods: number,
  datapointsToAlarm: number,
): boolean {
  // A real non-breaching datapoint the alarm actually evaluated is evidence the
  // metric was healthy, and this rule is only about intermittent *breaching*
  // data. Real datapoints beyond the N the alarm evaluated are not consulted —
  // AWS discards those ("the extra data points … are ignored").
  if (evaluated.some((slot) => slot === 'notBreaching')) return false;

  const window = slots.slice(-evaluationPeriods);
  const oldestBreachingIndex = window.indexOf('breaching');
  if (oldestBreachingIndex === -1) return false;

  // Stated explicitly because the rule names it, even though the check above
  // has already guaranteed it.
  const moreRecent = window.slice(oldestBreachingIndex + 1);
  if (moreRecent.some((slot) => slot === 'notBreaching')) return false;

  // Age in periods, 1 = the newest slot.
  const ageInPeriods = window.length - oldestBreachingIndex;
  return ageInPeriods >= datapointsToAlarm;
}

/**
 * Evaluate one (rule, resource) against its evaluation range.
 *
 * The order of operations follows AWS's three-branch description of what
 * happens once the range has been retrieved:
 *
 *   1. No datapoints missing → evaluate the most recent N; the extra range
 *      slots are ignored.
 *   2. Some missing, but at least N real datapoints retrieved → evaluate the
 *      most recent N *real* ones, reaching further back in the range as needed.
 *      "In this case, the value you set for how to treat missing data is not
 *      needed and is ignored."
 *   3. Fewer than N real datapoints → fill the shortfall with the treatment,
 *      but keep every real datapoint in the range in the evaluation, and use
 *      "missing data points only as few times as possible".
 *
 * Branches 1 and 2 are the same code path here: take the real datapoints, and
 * if there are at least N of them use the N most recent. That equivalence is
 * not a shortcut — it is what "the extra data points are ignored" means.
 */
export function evaluateInfraAlarm(input: InfraAlarmEvaluationInput): InfraAlarmEvaluation {
  const rule = normalizeRule(input.rule);
  const { evaluationPeriods, datapointsToAlarm, treatMissingData } = rule;

  const slots = classifyDatapoints(input.datapoints, rule.comparisonOperator, rule.threshold);
  const realSlots = slots.filter((slot) => slot !== 'missing');
  const realDatapoints = realSlots.length;

  const evaluated =
    realDatapoints >= evaluationPeriods ? realSlots.slice(-evaluationPeriods) : realSlots;
  const filledDatapoints = Math.max(0, evaluationPeriods - realDatapoints);

  let breachingDatapoints = evaluated.filter((slot) => slot === 'breaching').length;
  if (treatMissingData === 'breaching') breachingDatapoints += filledDatapoints;

  const meetsDatapointsToAlarm = breachingDatapoints >= datapointsToAlarm;

  // `notBreaching` turns every gap into a healthy datapoint, so no slot is left
  // "breaching or missing" and the premature rule can never hold. This is what
  // keeps `- - X - -` at OK under that treatment in AWS's table.
  const premature =
    !meetsDatapointsToAlarm &&
    treatMissingData !== 'notBreaching' &&
    prematureAlarmApplies(slots, evaluated, evaluationPeriods, datapointsToAlarm);

  const settle = (state: InfraAlarmState, reason: InfraAlarmReason): InfraAlarmEvaluation => ({
    state,
    previousState: input.previousState,
    transitioned: state !== input.previousState,
    reason,
    evaluatedAtMs: input.evaluatedAtMs,
    realDatapoints,
    filledDatapoints,
    breachingDatapoints,
  });

  if (meetsDatapointsToAlarm) return settle('ALARM', 'datapoints_breached');

  // `ignore` — "The current alarm state is maintained". It evaluates exactly
  // like `missing` except for the two outcomes that the missing-data machinery
  // *manufactures* rather than reads off real data: the INSUFFICIENT_DATA of an
  // all-missing range, and a premature ALARM. Both retain instead. That is the
  // shape of AWS's tables: `ignore` reads "Retain current state" on precisely
  // the rows where `missing` reads INSUFFICIENT_DATA or a premature ALARM, and
  // agrees with `missing` on every other row — including `0 - - - -` and
  // `0 - X - -`, which have missing data and still resolve to OK.
  if (treatMissingData === 'ignore' && (realDatapoints === 0 || premature)) {
    return settle(input.previousState, 'missing_data_ignored');
  }

  if (premature) return settle('ALARM', 'premature_alarm');

  // "If all data points in the alarm evaluation range are missing, the alarm
  // transitions to INSUFFICIENT_DATA." Only `missing` reaches this: `breaching`
  // has already alarmed on N synthetic breaches (M <= N always), `notBreaching`
  // resolves to OK, and `ignore` retained above.
  if (realDatapoints === 0 && treatMissingData === 'missing') {
    return settle('INSUFFICIENT_DATA', 'all_datapoints_missing');
  }

  return settle('OK', 'within_threshold');
}
