/**
 * push-gate.test.ts — unit coverage for the §9 push gate.
 *
 * The gate is a pure function over `(stepStatus, reviewerVerdict,
 * headBeforePhases, headAtPushGate)`. The truth table is:
 *
 *   steps  reviewer  head     → outcome
 *   ----   --------  ----     ----------
 *   pass   approved  stable   → pass
 *   pass   approved  drifted  → refuse(head_sha_moved)
 *   pass   changes   *        → refuse(reviewer_not_approved)
 *   pass   null      *        → refuse(reviewer_verdict_missing)
 *   fail   *         *        → refuse(steps_not_green)  [highest-priority]
 *   timeout *        *        → refuse(steps_not_green)
 *   infra  *         *        → refuse(steps_not_green)
 *
 * Tests prove the truth-table AND the check-order: a run that has BOTH
 * a step failure AND a reviewer rejection refuses on `steps_not_green`,
 * not `reviewer_not_approved`. Order matters because the orchestrator
 * dispatches different downstream behavior on different refusal codes.
 */

import { describe, it, expect } from 'vitest';
import { evaluatePushGate, isPushGatePass } from './push-gate.js';
import type { PushGateInputs } from './push-gate.js';

const baseInputs: PushGateInputs = {
  stepStatus: 'success',
  reviewerVerdict: 'approved',
  headBeforePhases: 'sha-stable',
  headAtPushGate: 'sha-stable',
};

describe('evaluatePushGate — pass path', () => {
  it('returns pass when all three conditions hold', () => {
    const outcome = evaluatePushGate(baseInputs);
    expect(outcome.kind).toBe('pass');
    if (outcome.kind === 'pass') {
      expect(outcome.validatedHeadSha).toBe('sha-stable');
    }
  });

  it('forwards the *current* head sha on pass, not the pre-phase one (they are equal but the contract is "current")', () => {
    // The two values are equal in the pass branch by definition;
    // this assertion pins the *which one is returned* contract so a
    // future refactor cannot start returning the pre-phase sha if the
    // gate ever loosens.
    const outcome = evaluatePushGate({
      ...baseInputs,
      headBeforePhases: 'sha-equal',
      headAtPushGate: 'sha-equal',
    });
    if (outcome.kind !== 'pass') throw new Error('expected pass');
    expect(outcome.validatedHeadSha).toBe('sha-equal');
  });

  it('isPushGatePass narrows the type to the pass branch', () => {
    const outcome = evaluatePushGate(baseInputs);
    if (!isPushGatePass(outcome)) throw new Error('expected pass');
    // TypeScript narrowing — this line only compiles if the guard works.
    expect(outcome.validatedHeadSha).toBe('sha-stable');
  });
});

describe('evaluatePushGate — condition 1 (steps green)', () => {
  for (const status of ['failure', 'timeout', 'infra_error'] as const) {
    it(`refuses with steps_not_green when stepStatus = "${status}"`, () => {
      const outcome = evaluatePushGate({ ...baseInputs, stepStatus: status });
      expect(outcome.kind).toBe('refuse');
      if (outcome.kind === 'refuse') {
        expect(outcome.refusalCode).toBe('steps_not_green');
        expect(outcome.detail).toContain(`"${status}"`);
      }
    });
  }

  it('steps_not_green takes priority over reviewer_not_approved', () => {
    // Both conditions fail simultaneously. The order matters: the
    // orchestrator's fix-dispatch composer reads the failed step from
    // the StepRunResult, so if the gate said "reviewer rejected" the
    // dispatch body would omit the step failure entirely. Hardening
    // the check order here pins that behavior.
    const outcome = evaluatePushGate({
      ...baseInputs,
      stepStatus: 'failure',
      reviewerVerdict: 'changes_requested',
    });
    if (outcome.kind !== 'refuse') throw new Error('expected refuse');
    expect(outcome.refusalCode).toBe('steps_not_green');
  });

  it('steps_not_green takes priority over head_sha_moved', () => {
    const outcome = evaluatePushGate({
      ...baseInputs,
      stepStatus: 'failure',
      headBeforePhases: 'sha-old',
      headAtPushGate: 'sha-new',
    });
    if (outcome.kind !== 'refuse') throw new Error('expected refuse');
    expect(outcome.refusalCode).toBe('steps_not_green');
  });
});

describe('evaluatePushGate — condition 2 (reviewer approved)', () => {
  it('refuses with reviewer_not_approved when verdict = "changes_requested"', () => {
    const outcome = evaluatePushGate({
      ...baseInputs,
      reviewerVerdict: 'changes_requested',
    });
    if (outcome.kind !== 'refuse') throw new Error('expected refuse');
    expect(outcome.refusalCode).toBe('reviewer_not_approved');
    expect(outcome.detail).toContain('changes_requested');
  });

  it('refuses with reviewer_verdict_missing when verdict = null', () => {
    // Defensive — the orchestrator should never reach the gate without
    // a verdict, but the gate's job is to make that invariant load-
    // bearing instead of relying on caller discipline.
    const outcome = evaluatePushGate({
      ...baseInputs,
      reviewerVerdict: null,
    });
    if (outcome.kind !== 'refuse') throw new Error('expected refuse');
    expect(outcome.refusalCode).toBe('reviewer_verdict_missing');
  });

  it('reviewer_not_approved takes priority over head_sha_moved', () => {
    const outcome = evaluatePushGate({
      ...baseInputs,
      reviewerVerdict: 'changes_requested',
      headBeforePhases: 'sha-old',
      headAtPushGate: 'sha-new',
    });
    if (outcome.kind !== 'refuse') throw new Error('expected refuse');
    expect(outcome.refusalCode).toBe('reviewer_not_approved');
  });

  it('reviewer_verdict_missing takes priority over head_sha_moved', () => {
    const outcome = evaluatePushGate({
      ...baseInputs,
      reviewerVerdict: null,
      headBeforePhases: 'sha-old',
      headAtPushGate: 'sha-new',
    });
    if (outcome.kind !== 'refuse') throw new Error('expected refuse');
    expect(outcome.refusalCode).toBe('reviewer_verdict_missing');
  });
});

describe('evaluatePushGate — condition 3 (head_sha unchanged)', () => {
  it('refuses with head_sha_moved when steps green + approved but HEAD drifted', () => {
    // The realistic mid-run race: reviewer approved on sha-A, steps
    // ran green on sha-A, then a commit landed (the session's own
    // mid-pass fix, or a human commit) before we re-checked HEAD.
    const outcome = evaluatePushGate({
      stepStatus: 'success',
      reviewerVerdict: 'approved',
      headBeforePhases: 'sha-pre-drift',
      headAtPushGate: 'sha-post-drift',
    });
    if (outcome.kind !== 'refuse') throw new Error('expected refuse');
    expect(outcome.refusalCode).toBe('head_sha_moved');
    expect(outcome.detail).toContain('sha-pre-drift');
    expect(outcome.detail).toContain('sha-post-drift');
  });

  it('detail explicitly names both shas so log readers can identify the drift', () => {
    const outcome = evaluatePushGate({
      stepStatus: 'success',
      reviewerVerdict: 'approved',
      headBeforePhases: 'aaaa1111',
      headAtPushGate: 'bbbb2222',
    });
    if (outcome.kind !== 'refuse') throw new Error('expected refuse');
    expect(outcome.detail).toMatch(/aaaa1111.*bbbb2222/);
  });
});

describe('evaluatePushGate — truth table coverage', () => {
  // Enumerate every combination of the three conditions and assert the
  // expected outcome. This is the "no clever-test" smoke check — if
  // anyone refactors the check order or adds a fourth condition, this
  // block will surface the change loudly.
  const cases: Array<{
    name: string;
    inputs: PushGateInputs;
    expected: { kind: 'pass'; sha: string } | { kind: 'refuse'; code: string };
  }> = [
    {
      name: 'pass: success + approved + stable',
      inputs: {
        stepStatus: 'success',
        reviewerVerdict: 'approved',
        headBeforePhases: 'sha',
        headAtPushGate: 'sha',
      },
      expected: { kind: 'pass', sha: 'sha' },
    },
    {
      name: 'refuse: failure + approved + stable → steps_not_green',
      inputs: {
        stepStatus: 'failure',
        reviewerVerdict: 'approved',
        headBeforePhases: 'sha',
        headAtPushGate: 'sha',
      },
      expected: { kind: 'refuse', code: 'steps_not_green' },
    },
    {
      name: 'refuse: success + changes_requested + stable → reviewer_not_approved',
      inputs: {
        stepStatus: 'success',
        reviewerVerdict: 'changes_requested',
        headBeforePhases: 'sha',
        headAtPushGate: 'sha',
      },
      expected: { kind: 'refuse', code: 'reviewer_not_approved' },
    },
    {
      name: 'refuse: success + approved + drifted → head_sha_moved',
      inputs: {
        stepStatus: 'success',
        reviewerVerdict: 'approved',
        headBeforePhases: 'a',
        headAtPushGate: 'b',
      },
      expected: { kind: 'refuse', code: 'head_sha_moved' },
    },
    {
      name: 'refuse: failure + changes_requested + drifted → steps_not_green (highest priority)',
      inputs: {
        stepStatus: 'failure',
        reviewerVerdict: 'changes_requested',
        headBeforePhases: 'a',
        headAtPushGate: 'b',
      },
      expected: { kind: 'refuse', code: 'steps_not_green' },
    },
    {
      name: 'refuse: success + null verdict + drifted → reviewer_verdict_missing (priority over head)',
      inputs: {
        stepStatus: 'success',
        reviewerVerdict: null,
        headBeforePhases: 'a',
        headAtPushGate: 'b',
      },
      expected: { kind: 'refuse', code: 'reviewer_verdict_missing' },
    },
    {
      name: 'refuse: timeout step + approved + stable → steps_not_green',
      inputs: {
        stepStatus: 'timeout',
        reviewerVerdict: 'approved',
        headBeforePhases: 'sha',
        headAtPushGate: 'sha',
      },
      expected: { kind: 'refuse', code: 'steps_not_green' },
    },
    {
      name: 'refuse: infra_error step + approved + stable → steps_not_green',
      inputs: {
        stepStatus: 'infra_error',
        reviewerVerdict: 'approved',
        headBeforePhases: 'sha',
        headAtPushGate: 'sha',
      },
      expected: { kind: 'refuse', code: 'steps_not_green' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const outcome = evaluatePushGate(c.inputs);
      if (c.expected.kind === 'pass') {
        if (outcome.kind !== 'pass') {
          throw new Error(
            `expected pass, got refuse: ${'refusalCode' in outcome ? outcome.refusalCode : 'unknown'}`,
          );
        }
        expect(outcome.validatedHeadSha).toBe(c.expected.sha);
      } else {
        if (outcome.kind !== 'refuse') throw new Error('expected refuse');
        expect(outcome.refusalCode).toBe(c.expected.code);
      }
    });
  }
});

describe('evaluatePushGate — purity', () => {
  it('does not mutate its input object', () => {
    const inputs: PushGateInputs = {
      stepStatus: 'success',
      reviewerVerdict: 'approved',
      headBeforePhases: 'sha-a',
      headAtPushGate: 'sha-a',
    };
    const snapshot = JSON.stringify(inputs);
    evaluatePushGate(inputs);
    expect(JSON.stringify(inputs)).toBe(snapshot);
  });

  it('is deterministic — same inputs always produce the same outcome', () => {
    const inputs: PushGateInputs = {
      stepStatus: 'failure',
      reviewerVerdict: 'approved',
      headBeforePhases: 'sha-a',
      headAtPushGate: 'sha-b',
    };
    const a = evaluatePushGate(inputs);
    const b = evaluatePushGate(inputs);
    const c = evaluatePushGate(inputs);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});
