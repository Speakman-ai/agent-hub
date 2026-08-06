/**
 * Parity tests for the alarm evaluator.
 *
 * The two `describe` blocks named "AWS published example table …" are literal
 * transcriptions of the tables in "Configuring how CloudWatch alarms treat
 * missing data" (verified August 2026), in AWS's own notation: `0` is a
 * non-breaching datapoint, `X` a breaching one, `-` a missing one, most recent
 * on the right. They are the contract. An implementation change that keeps the
 * hand-written cases green but flips a published row has broken parity with the
 * console, which is the one failure this module exists to prevent.
 *
 * Test names state the semantic being pinned rather than the mechanics, so a
 * failure reads as which documented behaviour regressed.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateInfraAlarm,
  isDatapointBreaching,
  DEFAULT_INFRA_TREAT_MISSING_DATA,
  INFRA_COMPARISON_OPERATORS,
  INFRA_TREAT_MISSING_DATA_MODES,
  type InfraAlarmState,
  type InfraAlertRule,
  type InfraTreatMissingData,
} from './alert-evaluator.js';

const THRESHOLD = 50;
const BREACHING_VALUE = 99;
const NOT_BREACHING_VALUE = 1;
const NOW = 1_760_000_000_000;

/** Parse AWS's `0 - X - X` datapoint notation into evaluator input. */
function points(notation: string): Array<number | null> {
  return notation
    .trim()
    .split(/\s+/)
    .map((token) => {
      if (token === '0') return NOT_BREACHING_VALUE;
      if (token === 'X') return BREACHING_VALUE;
      if (token === '-') return null;
      throw new Error(`unknown datapoint token ${JSON.stringify(token)}`);
    });
}

function rule(over: Partial<InfraAlertRule> = {}): InfraAlertRule {
  return {
    comparisonOperator: 'GreaterThanThreshold',
    threshold: THRESHOLD,
    evaluationPeriods: 3,
    ...over,
  };
}

function evaluate(
  notation: string,
  over: Partial<InfraAlertRule> = {},
  previousState: InfraAlarmState = 'OK',
) {
  return evaluateInfraAlarm({
    rule: rule(over),
    datapoints: points(notation),
    previousState,
    evaluatedAtMs: NOW,
  });
}

/** `RETAIN` stands in for AWS's "Retain current state" cell. */
const RETAIN = 'RETAIN' as const;
type ExpectedState = InfraAlarmState | typeof RETAIN;

interface PublishedRow {
  datapoints: string;
  /** AWS's "# of data points that must be filled" column. */
  filled: number;
  missing: ExpectedState;
  ignore: ExpectedState;
  breaching: ExpectedState;
  notBreaching: ExpectedState;
}

/**
 * Run one published row through all four treatments.
 *
 * "Retain current state" is asserted against two different prior states, so a
 * cell that happens to coincide with the seeded state cannot pass by accident —
 * and `transitioned` is asserted alongside, since the caller fires actions off
 * that flag and never off the state alone.
 */
function assertPublishedRow(row: PublishedRow, over: Partial<InfraAlertRule>): void {
  const cells: Array<[InfraTreatMissingData, ExpectedState]> = [
    ['missing', row.missing],
    ['ignore', row.ignore],
    ['breaching', row.breaching],
    ['notBreaching', row.notBreaching],
  ];

  for (const [treatMissingData, expected] of cells) {
    for (const previousState of ['OK', 'ALARM', 'INSUFFICIENT_DATA'] as const) {
      const result = evaluate(row.datapoints, { ...over, treatMissingData }, previousState);
      const expectedState = expected === RETAIN ? previousState : expected;
      expect(
        result.state,
        `"${row.datapoints}" with treatMissingData=${treatMissingData} from ${previousState}`,
      ).toBe(expectedState);
      expect(result.transitioned).toBe(expectedState !== previousState);
      expect(result.previousState).toBe(previousState);
      expect(result.evaluatedAtMs).toBe(NOW);
      // AWS publishes the fill count per row; it is treatment-independent.
      expect(result.filledDatapoints, `fill count for "${row.datapoints}"`).toBe(row.filled);
    }
  }
}

describe('AWS published example table 1 — EvaluationPeriods 3, DatapointsToAlarm 3, range 5', () => {
  const params = { evaluationPeriods: 3, datapointsToAlarm: 3 };

  const rows: Array<[string, PublishedRow]> = [
    [
      'three real datapoints are enough, so the missing-data setting is ignored entirely',
      {
        datapoints: '0 - X - X',
        filled: 0,
        missing: 'OK',
        ignore: 'OK',
        breaching: 'OK',
        notBreaching: 'OK',
      },
    ],
    [
      'one non-breaching real datapoint holds the alarm at OK even when gaps are treated as breaching',
      {
        datapoints: '0 - - - -',
        filled: 2,
        missing: 'OK',
        ignore: 'OK',
        breaching: 'OK',
        notBreaching: 'OK',
      },
    ],
    [
      'an entirely missing range is INSUFFICIENT_DATA under `missing` and splits all four treatments apart',
      {
        datapoints: '- - - - -',
        filled: 3,
        missing: 'INSUFFICIENT_DATA',
        ignore: RETAIN,
        breaching: 'ALARM',
        notBreaching: 'OK',
      },
    ],
    [
      'three real breaching datapoints alarm under every treatment, the gap between them ignored',
      {
        datapoints: '0 X X - X',
        filled: 0,
        missing: 'ALARM',
        ignore: 'ALARM',
        breaching: 'ALARM',
        notBreaching: 'ALARM',
      },
    ],
    [
      'premature-alarm rule: one breaching datapoint M periods old alarms under `missing` on a single real point',
      {
        datapoints: '- - X - -',
        filled: 2,
        missing: 'ALARM',
        ignore: RETAIN,
        breaching: 'ALARM',
        notBreaching: 'OK',
      },
    ],
  ];

  for (const [name, row] of rows) {
    it(name, () => assertPublishedRow(row, params));
  }
});

describe('AWS published example table 2 — M out of N, EvaluationPeriods 3, DatapointsToAlarm 2, range 5', () => {
  const params = { evaluationPeriods: 3, datapointsToAlarm: 2 };

  const rows: Array<[string, PublishedRow]> = [
    [
      'two of the three most recent real datapoints breaching satisfies M out of N',
      {
        datapoints: '0 - X - X',
        filled: 0,
        missing: 'ALARM',
        ignore: 'ALARM',
        breaching: 'ALARM',
        notBreaching: 'ALARM',
      },
    ],
    [
      'a full range evaluates only the three most recent datapoints, discarding the two older ones',
      {
        datapoints: '0 0 X 0 X',
        filled: 0,
        missing: 'ALARM',
        ignore: 'ALARM',
        breaching: 'ALARM',
        notBreaching: 'ALARM',
      },
    ],
    [
      'a non-breaching datapoint outside the evaluation periods still suppresses the premature-alarm rule',
      {
        datapoints: '0 - X - -',
        filled: 1,
        missing: 'OK',
        ignore: 'OK',
        breaching: 'ALARM',
        notBreaching: 'OK',
      },
    ],
    [
      'two gaps treated as breaching supply both datapoints M needs',
      {
        datapoints: '- - - - 0',
        filled: 2,
        missing: 'OK',
        ignore: 'OK',
        breaching: 'ALARM',
        notBreaching: 'OK',
      },
    ],
    [
      'premature-alarm rule applies to M out of N alarms too, on one breaching datapoint',
      {
        datapoints: '- - - X -',
        filled: 2,
        missing: 'ALARM',
        ignore: RETAIN,
        breaching: 'ALARM',
        notBreaching: 'OK',
      },
    ],
  ];

  for (const [name, row] of rows) {
    it(name, () => assertPublishedRow(row, params));
  }
});

describe('premature-alarm rule', () => {
  // AWS: "Because the next data point may be non-breaching, the alarm does not
  // go immediately into ALARM state when the data is either `- - - - X` or
  // `- - - X -` and Datapoints to Alarm is 3."
  it('does not alarm on a breach newer than DatapointsToAlarm periods, so a following healthy point is not a false positive', () => {
    const params = {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'missing' as const,
    };
    expect(evaluate('- - - - X', params).state).toBe('OK');
    expect(evaluate('- - - X -', params).state).toBe('OK');
  });

  // Raised in review: should `0 X X - -` at N=3/M=3 alarm, on the grounds that
  // the N-window `X - -` holds a breach N slots old followed only by gaps?
  //
  // No — and the published table settles it rather than judgement. That range
  // has three real datapoints, which is N, so AWS evaluates it without the
  // missing-data machinery at all ("the value you set for how to treat missing
  // data is not needed and is ignored") on the set `[0, X, X]`: 2 of 3 breaching
  // against M=3, therefore OK. Table-1 row 1 `0 - X - X` is the same evaluated
  // set and is published as OK under all four treatments — and its N-window,
  // `X - X`, satisfies the premature rule's literal wording just as `X - -`
  // does. So a premature rule that fires here fires there too, and contradicts
  // a published row.
  //
  // The premature rule exists to alarm on *too little* data, never to override
  // a healthy datapoint the alarm actually evaluated.
  it('does not override a healthy datapoint in the evaluated set, even when the N-window is a breach followed by gaps', () => {
    const params = {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'missing' as const,
    };
    const raisedInReview = evaluate('0 X X - -', params);
    expect(raisedInReview.state).toBe('OK');
    expect(raisedInReview.reason).toBe('within_threshold');
    // Enough real data to evaluate, so no gap was ever filled.
    expect(raisedInReview.realDatapoints).toBe(3);
    expect(raisedInReview.filledDatapoints).toBe(0);
    expect(raisedInReview.breachingDatapoints).toBe(2);

    // The published row with the identical evaluated set must agree, which is
    // what makes the case above a parity requirement and not a preference.
    expect(evaluate('0 - X - X', params).state).toBe('OK');
  });

  it('suppresses on a healthy datapoint the alarm evaluated, not on one it discarded', () => {
    // With N=2 the alarm evaluates only the two most recent real datapoints, so
    // the leading `0` is surplus and discarded — and the rule is decided by the
    // real breaches, which already satisfy M.
    expect(evaluate('0 X X', { evaluationPeriods: 2, datapointsToAlarm: 2 }).state).toBe('ALARM');
    // Widening to N=3 pulls that same `0` into the evaluated set, and now it
    // holds the alarm at OK.
    expect(evaluate('0 X X', { evaluationPeriods: 3, datapointsToAlarm: 3 }).state).toBe('OK');
  });

  it('alarms once the same breach has aged to DatapointsToAlarm periods with nothing contradicting it', () => {
    const params = {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'missing' as const,
    };
    const result = evaluate('- - X - -', params);
    expect(result.state).toBe('ALARM');
    expect(result.reason).toBe('premature_alarm');
    // The point of the rule: ALARM on fewer real breaching datapoints than M.
    expect(result.breachingDatapoints).toBeLessThan(3);
    expect(result.realDatapoints).toBe(1);
  });

  // AWS: "false positives are avoided when the next data point is
  // non-breaching and causes the data to be `- - - X O` or `- - X - O`."
  it('a following non-breaching datapoint retracts what would have been a premature alarm', () => {
    const params = {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'missing' as const,
    };
    expect(evaluate('- - - X 0', params).state).toBe('OK');
    expect(evaluate('- - X - 0', params).state).toBe('OK');
  });

  it('is reported under its own reason code rather than as an ordinary threshold breach', () => {
    const premature = evaluate('- - X - -', {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'missing',
    });
    const ordinary = evaluate('0 X X - X', {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'missing',
    });
    expect(premature.reason).toBe('premature_alarm');
    expect(ordinary.reason).toBe('datapoints_breached');
  });

  it('never fires under notBreaching, because a filled gap is a healthy datapoint', () => {
    for (const notation of ['- - X - -', '- - - X -', '- X - - -']) {
      expect(
        evaluate(notation, {
          evaluationPeriods: 3,
          datapointsToAlarm: 2,
          treatMissingData: 'notBreaching',
        }).state,
      ).toBe('OK');
    }
  });

  it('ignores a breach that has aged out of the evaluation periods', () => {
    // `X - - - -` with N=3: the breach sits in the range but two slots older
    // than the three evaluation periods, so it can no longer arm the alarm.
    const result = evaluate('X - - - -', {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'missing',
    });
    expect(result.state).toBe('OK');
  });
});

describe('treatMissingData', () => {
  it('defaults to `missing` when the rule omits it', () => {
    expect(DEFAULT_INFRA_TREAT_MISSING_DATA).toBe('missing');
    const omitted = evaluate('- - - - -', { evaluationPeriods: 3, datapointsToAlarm: 3 });
    const explicit = evaluate('- - - - -', {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'missing',
    });
    expect(omitted.state).toBe('INSUFFICIENT_DATA');
    expect(omitted.state).toBe(explicit.state);
  });

  it('is not consulted at all once the range holds EvaluationPeriods real datapoints', () => {
    // AWS: "the value you set for how to treat missing data is not needed and
    // is ignored" — so all four treatments must agree, gaps notwithstanding.
    const states = INFRA_TREAT_MISSING_DATA_MODES.map(
      (treatMissingData) =>
        evaluate('X - X - X', { evaluationPeriods: 3, datapointsToAlarm: 3, treatMissingData })
          .state,
    );
    expect(new Set(states)).toEqual(new Set(['ALARM']));
  });

  it('fills only the shortfall, never every gap in the range', () => {
    // AWS: "CloudWatch uses missing data points only as few times as possible."
    // Three gaps, but N=3 and two real points, so exactly one is filled — and
    // one breaching fill is not enough to reach M=3.
    const result = evaluate('0 - X - -', {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: 'breaching',
    });
    expect(result.realDatapoints).toBe(2);
    expect(result.filledDatapoints).toBe(1);
    expect(result.breachingDatapoints).toBe(2);
    expect(result.state).toBe('OK');
  });

  it('`ignore` retains INSUFFICIENT_DATA rather than resolving it to OK', () => {
    const result = evaluate(
      '- - - - -',
      { evaluationPeriods: 3, datapointsToAlarm: 3, treatMissingData: 'ignore' },
      'INSUFFICIENT_DATA',
    );
    expect(result.state).toBe('INSUFFICIENT_DATA');
    expect(result.transitioned).toBe(false);
    expect(result.reason).toBe('missing_data_ignored');
  });

  it('`ignore` still transitions on real data, so it mutes gaps and not the alarm', () => {
    const result = evaluate(
      'X X X',
      { evaluationPeriods: 3, datapointsToAlarm: 3, treatMissingData: 'ignore' },
      'OK',
    );
    expect(result.state).toBe('ALARM');
    expect(result.transitioned).toBe(true);
    expect(result.reason).toBe('datapoints_breached');
  });

  it('reports `all_datapoints_missing` only for `missing`, the one treatment that yields INSUFFICIENT_DATA', () => {
    const params = { evaluationPeriods: 3, datapointsToAlarm: 3 };
    expect(evaluate('- - - - -', { ...params, treatMissingData: 'missing' }).reason).toBe(
      'all_datapoints_missing',
    );
    expect(evaluate('- - - - -', { ...params, treatMissingData: 'breaching' }).reason).toBe(
      'datapoints_breached',
    );
    expect(evaluate('- - - - -', { ...params, treatMissingData: 'notBreaching' }).reason).toBe(
      'within_threshold',
    );
    expect(evaluate('- - - - -', { ...params, treatMissingData: 'ignore' }).reason).toBe(
      'missing_data_ignored',
    );
  });
});

describe('comparison operators', () => {
  it('distinguishes the strict operators from their OrEqualTo variants on the boundary', () => {
    expect(isDatapointBreaching(50, 'GreaterThanThreshold', 50)).toBe(false);
    expect(isDatapointBreaching(50, 'GreaterThanOrEqualToThreshold', 50)).toBe(true);
    expect(isDatapointBreaching(50, 'LessThanThreshold', 50)).toBe(false);
    expect(isDatapointBreaching(50, 'LessThanOrEqualToThreshold', 50)).toBe(true);
  });

  it('compares in the right direction away from the boundary', () => {
    expect(isDatapointBreaching(51, 'GreaterThanThreshold', 50)).toBe(true);
    expect(isDatapointBreaching(49, 'GreaterThanThreshold', 50)).toBe(false);
    expect(isDatapointBreaching(49, 'LessThanThreshold', 50)).toBe(true);
    expect(isDatapointBreaching(51, 'LessThanThreshold', 50)).toBe(false);
  });

  it('covers every operator the evaluator accepts', () => {
    for (const comparisonOperator of INFRA_COMPARISON_OPERATORS) {
      expect(() => isDatapointBreaching(1, comparisonOperator, 1)).not.toThrow();
    }
  });

  it('alarms a LessThan rule on a value below the threshold, matching a healthy-host-count alarm', () => {
    // The AWS/ApplicationELB guidance case: alarm when HealthyHostCount drops.
    const result = evaluateInfraAlarm({
      rule: {
        comparisonOperator: 'LessThanThreshold',
        threshold: 1,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
      },
      datapoints: [0, 0],
      previousState: 'OK',
      evaluatedAtMs: NOW,
    });
    expect(result.state).toBe('ALARM');
  });

  it('treats `>= 0` as breaching on zero, the boundary a count-metric rule depends on', () => {
    // NAT Gateway ErrorPortAllocation and DynamoDB *ThrottleEvents rules are
    // written on counts where 0 and 1 mean opposite things.
    const zeroIsBreaching = evaluateInfraAlarm({
      rule: {
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        threshold: 0,
        evaluationPeriods: 1,
      },
      datapoints: [0],
      previousState: 'OK',
      evaluatedAtMs: NOW,
    });
    const zeroIsNotBreaching = evaluateInfraAlarm({
      rule: { comparisonOperator: 'GreaterThanThreshold', threshold: 0, evaluationPeriods: 1 },
      datapoints: [0],
      previousState: 'OK',
      evaluatedAtMs: NOW,
    });
    expect(zeroIsBreaching.state).toBe('ALARM');
    expect(zeroIsNotBreaching.state).toBe('OK');
  });
});

describe('transitions', () => {
  it('reports no transition when the state is unchanged, so a still-breaching rule does not re-notify', () => {
    const result = evaluate('X X X', { evaluationPeriods: 3, datapointsToAlarm: 3 }, 'ALARM');
    expect(result.state).toBe('ALARM');
    expect(result.transitioned).toBe(false);
  });

  it('reports a transition on recovery as well as on breach', () => {
    const params = { evaluationPeriods: 3, datapointsToAlarm: 3 };
    expect(evaluate('X X X', params, 'OK').transitioned).toBe(true);
    expect(evaluate('0 0 0', params, 'ALARM')).toMatchObject({
      state: 'OK',
      transitioned: true,
    });
  });

  it('carries the previous state through so the caller can label the edge', () => {
    const result = evaluate(
      'X X X',
      { evaluationPeriods: 3, datapointsToAlarm: 3 },
      'INSUFFICIENT_DATA',
    );
    expect(result.previousState).toBe('INSUFFICIENT_DATA');
    expect(result.state).toBe('ALARM');
    expect(result.transitioned).toBe(true);
  });
});

describe('M of N', () => {
  it('requires M breaching datapoints, not merely one', () => {
    const params = { evaluationPeriods: 4, datapointsToAlarm: 3 };
    expect(evaluate('0 0 X X', params).state).toBe('OK');
    expect(evaluate('0 X X X', params).state).toBe('ALARM');
  });

  it('does not require the M breaching datapoints to be consecutive', () => {
    const result = evaluate('X 0 X 0 X', { evaluationPeriods: 5, datapointsToAlarm: 3 });
    expect(result.state).toBe('ALARM');
    expect(result.breachingDatapoints).toBe(3);
  });

  it('defaults DatapointsToAlarm to EvaluationPeriods, making the rule consecutive', () => {
    const consecutive = evaluate('0 X X X', { evaluationPeriods: 4 });
    expect(consecutive.state).toBe('OK');
    expect(evaluate('X X X X', { evaluationPeriods: 4 }).state).toBe('ALARM');
  });
});

describe('input validation', () => {
  const base = {
    datapoints: [1, 2, 3],
    previousState: 'OK' as const,
    evaluatedAtMs: NOW,
  };

  it('rejects DatapointsToAlarm above EvaluationPeriods instead of silently clamping an unarmable rule', () => {
    expect(() =>
      evaluateInfraAlarm({
        ...base,
        rule: rule({ evaluationPeriods: 2, datapointsToAlarm: 3 }),
      }),
    ).toThrow(/datapointsToAlarm \(3\) exceeds evaluationPeriods \(2\)/);
  });

  it('rejects a non-positive or fractional EvaluationPeriods', () => {
    for (const evaluationPeriods of [0, -1, 1.5, Number.NaN]) {
      expect(() => evaluateInfraAlarm({ ...base, rule: rule({ evaluationPeriods }) })).toThrow(
        /evaluationPeriods must be an integer >= 1/,
      );
    }
  });

  it('rejects an unsupported comparison operator, including the anomaly-detection ones', () => {
    expect(() =>
      evaluateInfraAlarm({
        ...base,
        rule: rule({
          comparisonOperator: 'LessThanLowerOrGreaterThanUpperThreshold' as never,
        }),
      }),
    ).toThrow(/unsupported comparisonOperator/);
  });

  it('rejects an unsupported treatMissingData rather than falling back to a default', () => {
    expect(() =>
      evaluateInfraAlarm({
        ...base,
        rule: rule({ treatMissingData: 'NOT_BREACHING' as never }),
      }),
    ).toThrow(/unsupported treatMissingData/);
  });

  it('rejects a non-finite threshold', () => {
    for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => evaluateInfraAlarm({ ...base, rule: rule({ threshold }) })).toThrow(
        /threshold must be a finite number/,
      );
    }
  });
});

describe('datapoint inputs', () => {
  it('reads a non-finite value as missing, since it cannot be compared to a threshold', () => {
    const result = evaluateInfraAlarm({
      rule: rule({ evaluationPeriods: 3, datapointsToAlarm: 3, treatMissingData: 'missing' }),
      datapoints: [Number.NaN, undefined, null],
      previousState: 'OK',
      evaluatedAtMs: NOW,
    });
    expect(result.realDatapoints).toBe(0);
    expect(result.state).toBe('INSUFFICIENT_DATA');
  });

  it('handles a range shorter than EvaluationPeriods by filling the shortfall', () => {
    // A rule armed before enough history exists must not read as healthy.
    const result = evaluateInfraAlarm({
      rule: rule({ evaluationPeriods: 3, datapointsToAlarm: 3, treatMissingData: 'breaching' }),
      datapoints: [],
      previousState: 'OK',
      evaluatedAtMs: NOW,
    });
    expect(result.filledDatapoints).toBe(3);
    expect(result.state).toBe('ALARM');
  });

  it('never mutates the caller’s datapoint array', () => {
    const datapoints = [BREACHING_VALUE, null, BREACHING_VALUE];
    const snapshot = [...datapoints];
    evaluateInfraAlarm({
      rule: rule({ evaluationPeriods: 3 }),
      datapoints,
      previousState: 'OK',
      evaluatedAtMs: NOW,
    });
    expect(datapoints).toEqual(snapshot);
  });
});

describe('evaluationRangeLengthIsLoadBearing', () => {
  // Raised in review, and the reason this module computes no range of its own.
  //
  // AWS publishes no formula for the evaluation range size — only that it
  // "depends on the length of the alarm period and whether it is based on a
  // metric with standard resolution or high resolution", plus the single worked
  // example of Evaluation Periods 3 → range 5. These cases exist so that the
  // consequence of guessing is visible in the suite rather than buried in prose:
  // the caller that fetches the range owns a real parity decision.
  const params = {
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    treatMissingData: 'missing' as const,
  };

  it('changes the alarm state when the range is truncated, so a short fetch invents an alarm', () => {
    // The published table-2 row 3, at its published length.
    expect(evaluate('0 - X - -', params).state).toBe('OK');
    // The same recent history one slot shorter: the non-breaching datapoint
    // that suppressed the premature rule is gone, and the alarm fires.
    expect(evaluate('- X - -', params).state).toBe('ALARM');
  });

  it('changes the alarm state when the range is extended, so an over-long fetch suppresses a real one', () => {
    // The published table-2 row 5.
    expect(evaluate('- - - X -', params).state).toBe('ALARM');
    // One extra slot of history holding a healthy datapoint suppresses it.
    expect(evaluate('0 - - - X -', params).state).toBe('OK');
  });
});
