import { afterEach, describe, expect, it } from 'vitest';

import {
  computeRootCauseEscalation,
  resolveRootCauseEscalationRounds,
  DEFAULT_ROOTCAUSE_ESCALATION_ROUNDS,
  type ReviewRoundFindings,
} from './review-cluster-tracker.js';

function finding(
  file: string,
  line: number,
  body = 'note',
): {
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  body: string;
} {
  return { file_path: file, line_start: line, line_end: line, body };
}

describe('computeRootCauseEscalation', () => {
  it('returns null when history is shorter than the threshold', () => {
    const history: ReviewRoundFindings[] = [{ round: 1, findings: [finding('a.ts', 1)] }];
    expect(computeRootCauseEscalation(history, 2)).toBeNull();
  });

  it('returns null when no cluster repeats across consecutive rounds', () => {
    const history: ReviewRoundFindings[] = [
      { round: 1, findings: [finding('a.ts', 1)] },
      { round: 2, findings: [finding('b.ts', 2)] },
    ];
    expect(computeRootCauseEscalation(history, 2)).toBeNull();
  });

  it('escalates when the same file is flagged two rounds running (default threshold)', () => {
    const history: ReviewRoundFindings[] = [
      { round: 1, findings: [finding('dxf.ts', 100, 'stale setScale tap')] },
      { round: 2, findings: [finding('dxf.ts', 200, 'ASCALE hydrate race')] },
    ];
    const esc = computeRootCauseEscalation(history, 2);
    expect(esc).not.toBeNull();
    expect(esc!.clusters).toEqual(['dxf.ts']);
    expect(esc!.rounds).toBe(2);
    // Prior-round findings (round 1) for the recurring cluster are carried.
    expect(esc!.priorFindings).toHaveLength(1);
    expect(esc!.priorFindings[0]).toContain('round 1');
    expect(esc!.priorFindings[0]).toContain('dxf.ts:100');
    expect(esc!.priorFindings[0]).toContain('stale setScale tap');
  });

  it('does not count a cluster whose streak was broken by an intervening round', () => {
    // dxf.ts appears in rounds 1 and 3 but NOT 2 → streak from latest is 1.
    const history: ReviewRoundFindings[] = [
      { round: 1, findings: [finding('dxf.ts', 1)] },
      { round: 2, findings: [finding('other.ts', 2)] },
      { round: 3, findings: [finding('dxf.ts', 3)] },
    ];
    expect(computeRootCauseEscalation(history, 2)).toBeNull();
  });

  it('reports the longest streak and every recurring cluster', () => {
    const history: ReviewRoundFindings[] = [
      { round: 1, findings: [finding('a.ts', 1), finding('b.ts', 1)] },
      { round: 2, findings: [finding('a.ts', 2), finding('b.ts', 2)] },
      { round: 3, findings: [finding('a.ts', 3), finding('b.ts', 3)] },
    ];
    const esc = computeRootCauseEscalation(history, 2);
    expect(esc).not.toBeNull();
    expect(new Set(esc!.clusters)).toEqual(new Set(['a.ts', 'b.ts']));
    expect(esc!.rounds).toBe(3);
    // Prior findings are rounds 1 and 2 for BOTH clusters (4 lines), latest excluded.
    expect(esc!.priorFindings).toHaveLength(4);
  });

  it('honours a raised threshold (3 consecutive rounds required)', () => {
    const two: ReviewRoundFindings[] = [
      { round: 1, findings: [finding('a.ts', 1)] },
      { round: 2, findings: [finding('a.ts', 2)] },
    ];
    expect(computeRootCauseEscalation(two, 3)).toBeNull();
    const three: ReviewRoundFindings[] = [...two, { round: 3, findings: [finding('a.ts', 3)] }];
    expect(computeRootCauseEscalation(three, 3)).not.toBeNull();
  });

  it('ignores blank file paths', () => {
    const history: ReviewRoundFindings[] = [
      { round: 1, findings: [finding('', 1)] },
      { round: 2, findings: [finding('', 2)] },
    ];
    expect(computeRootCauseEscalation(history, 2)).toBeNull();
  });
});

describe('resolveRootCauseEscalationRounds', () => {
  afterEach(() => {
    delete process.env.FINALIZE_ROOTCAUSE_ESCALATION_ROUNDS;
  });

  it('defaults to DEFAULT_ROOTCAUSE_ESCALATION_ROUNDS', () => {
    expect(resolveRootCauseEscalationRounds()).toBe(DEFAULT_ROOTCAUSE_ESCALATION_ROUNDS);
  });

  it('honours a valid env override (≥ 2)', () => {
    process.env.FINALIZE_ROOTCAUSE_ESCALATION_ROUNDS = '3';
    expect(resolveRootCauseEscalationRounds()).toBe(3);
  });

  it('falls back to the default on an invalid or below-floor value', () => {
    process.env.FINALIZE_ROOTCAUSE_ESCALATION_ROUNDS = '1';
    expect(resolveRootCauseEscalationRounds()).toBe(DEFAULT_ROOTCAUSE_ESCALATION_ROUNDS);
    process.env.FINALIZE_ROOTCAUSE_ESCALATION_ROUNDS = 'nope';
    expect(resolveRootCauseEscalationRounds()).toBe(DEFAULT_ROOTCAUSE_ESCALATION_ROUNDS);
  });
});
