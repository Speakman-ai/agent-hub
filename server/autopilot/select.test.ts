import { describe, it, expect } from 'vitest';
import {
  AUTOPILOT_MAX_IMPROVEMENT_CANDIDATES,
  AUTOPILOT_NO_BENEFIT_PAUSE_STREAK,
  extraProtectedJourneys,
  applyPlannerProposal,
  consecutiveNoBenefitStreak,
  guardImprovementCandidate,
  mergeInScopeSpecDecisions,
  parseSelectedImprovementRecord,
  rankImprovementCandidates,
  selectImprovement,
  serializeSelectedImprovement,
  type AutopilotImprovementCandidate,
  type AutopilotImprovementSpec,
} from './select.js';
import type { AutopilotEventRecord } from './types.js';

const SPEC: AutopilotImprovementSpec = {
  acceptanceJourneys: [
    { action: 'create a todo', expectedResult: 'it appears in the list' },
    { action: 'see the list', expectedResult: 'existing todos are shown' },
  ],
  nonGoals: ['auth', 'multi-tenant'],
  specDecisions: [{ key: 'storage', decision: 'in-memory sqlite' }],
};

function candidate(
  patch: Partial<AutopilotImprovementCandidate> &
    Pick<AutopilotImprovementCandidate, 'id' | 'kind'>,
): AutopilotImprovementCandidate {
  return {
    action: 'complete a todo',
    expectedResult: 'it is marked done in the list',
    expectedBenefit: 'Users can complete todos from the list.',
    rationale: 'Unmet brief goal',
    ...patch,
  };
}

function event(type: string, seq: number): AutopilotEventRecord {
  return {
    id: `evt-${seq}`,
    runId: 'run-1',
    cycleId: null,
    operationId: null,
    type,
    payload: {},
    fencingGeneration: 1,
    createdAt: '2026-09-15 00:00:00',
    seq,
  };
}

describe('autopilot improvement ranking', () => {
  it('ranks regressions ahead of unmet goals and bounds the set', () => {
    const proposed: AutopilotImprovementCandidate[] = [
      candidate({ id: 'goal', kind: 'unmet-goal' }),
      candidate({
        id: 'a11y',
        kind: 'usability',
        action: 'complete the main flow with a keyboard',
        expectedResult: 'the same outcome is visible without a pointer',
        expectedBenefit: 'Keyboard users can finish the main flow.',
      }),
      candidate({
        id: 'reg',
        kind: 'regression',
        action: 'create a todo',
        expectedResult: 'it appears in the list',
        expectedBenefit: 'Restore the add-todo baseline.',
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        candidate({
          id: `extra-${i}`,
          kind: 'unmet-goal',
          action: `goal ${i}`,
          expectedResult: `result ${i}`,
          expectedBenefit: `Benefit ${i}`,
        }),
      ),
    ];
    const ranked = rankImprovementCandidates({
      brief: 'Build a todo list.',
      briefRevision: 1,
      spec: SPEC,
      lastVerification: null,
      failedAttempts: [],
      priorImprovements: [],
      proposed,
    });
    expect(ranked[0]?.kind).toBe('regression');
    expect(ranked[1]?.kind).toBe('usability');
    expect(ranked.length).toBe(AUTOPILOT_MAX_IMPROVEMENT_CANDIDATES);
  });

  it('selects one falsifiable improvement and pauses on expanded authority', () => {
    const ok = candidate({ id: 'ok', kind: 'unmet-goal' });
    const chosen = selectImprovement([ok], SPEC);
    expect(chosen.outcome).toBe('selected');
    expect(chosen.selected?.action).toBe('complete a todo');

    const scoped = candidate({
      id: 'auth',
      kind: 'unmet-goal',
      action: 'add auth',
      expectedResult: 'users must log in',
      expectedBenefit: 'Add authentication.',
    });
    expect(guardImprovementCandidate(scoped, SPEC, 'Build a todo list.').outcome).toBe(
      'needs-expanded-authority',
    );
    expect(
      guardImprovementCandidate(
        candidate({
          id: 'google',
          kind: 'unmet-goal',
          action: 'sign in with Google',
          expectedResult: 'the user is authenticated',
          expectedBenefit: 'Users can sign in with Google.',
        }),
        SPEC,
        'Build a todo list.',
      ).outcome,
    ).toBe('needs-expanded-authority');

    const expanded = candidate({
      id: 'cloud',
      kind: 'unmet-goal',
      expandsScope: true,
    });
    expect(selectImprovement([expanded], SPEC)).toMatchObject({
      outcome: 'needs-expanded-authority',
    });
  });

  it('skips an out-of-scope ranked candidate when a later in-scope improvement remains', () => {
    const expanded = candidate({
      id: 'cloud',
      kind: 'unmet-goal',
      expandsScope: true,
    });
    const ok = candidate({ id: 'ok', kind: 'unmet-goal' });
    const chosen = selectImprovement([expanded, ok], SPEC, 'Build a todo list.');
    expect(chosen.outcome).toBe('selected');
    expect(chosen.selected?.id).toBe('ok');
  });

  it('does not let the planner pause on an in-scope candidate by claiming expanded authority', () => {
    const ok = candidate({ id: 'ok', kind: 'unmet-goal' });
    const proposal = applyPlannerProposal(
      [ok],
      SPEC,
      {
        candidates: [ok],
        selected: ok,
        outcome: 'needs-expanded-authority',
        reason: 'planner asked to expand scope',
      },
      'Build a todo list. Users can complete a todo.',
    );
    expect(proposal.outcome).toBe('selected');
    expect(proposal.selected?.id).toBe('ok');
  });

  it('refuses dropped baseline coverage and protected spec decisions', () => {
    expect(
      guardImprovementCandidate(
        candidate({ id: 'drop', kind: 'unmet-goal', dropsBaselineCoverage: true }),
        SPEC,
      ).outcome,
    ).toBe('needs-expanded-authority');
    expect(
      guardImprovementCandidate(
        candidate({
          id: 'eval',
          kind: 'unmet-goal',
          specDecisions: [{ key: 'evaluator-policy', decision: 'skip baseline' }],
        }),
        SPEC,
      ).outcome,
    ).toBe('needs-expanded-authority');
  });

  it('lets the planner decline a benefit without Hub substituting another candidate', () => {
    const ranked = [candidate({ id: 'ok', kind: 'unmet-goal' })];
    const proposal = applyPlannerProposal(
      ranked,
      SPEC,
      {
        candidates: ranked,
        selected: null,
        outcome: 'no-benefit',
        reason: 'no measured benefit remains',
      },
      'Build a todo list. Users can complete a todo.',
    );
    expect(proposal.outcome).toBe('no-benefit');
    expect(proposal.selected).toBeNull();
  });

  it('preserves an explicit planner rejection even when a ranked candidate remains', () => {
    const ranked = [candidate({ id: 'ok', kind: 'unmet-goal' })];
    const proposal = applyPlannerProposal(
      ranked,
      SPEC,
      {
        candidates: ranked,
        selected: null,
        outcome: 'rejected',
        reason: 'planner rejected the candidate',
      },
      'Build a todo list. Users can complete a todo.',
    );
    expect(proposal.outcome).toBe('rejected');
    expect(proposal.selected).toBeNull();
  });

  it('generates unmet-goal candidates from the brief after specified journeys are verified', () => {
    const ranked = rankImprovementCandidates({
      brief: 'Build a todo list. Users can complete a todo and edit a todo title.',
      briefRevision: 1,
      spec: SPEC,
      lastVerification: {
        pinned: {
          specRevision: 1,
          qualityRubricVersion: 1,
          criteria: SPEC.acceptanceJourneys.map((j, i) => ({
            id: `baseline-${i + 1}`,
            source: 'baseline',
            kind: 'browser_journey',
            action: j.action,
            expectedResult: j.expectedResult,
          })),
        },
        judgement: { ok: true, sha: 'deadbeef' },
      },
      failedAttempts: [],
      priorImprovements: [],
    });
    expect(ranked.some((c) => c.action === 'complete a todo')).toBe(true);
    expect(ranked.some((c) => c.action === 'edit a todo title')).toBe(true);
    expect(ranked.some((c) => c.action === 'create a todo')).toBe(false);
  });

  it('counts three consecutive rejected or no-benefit proposals until a selection resets the streak', () => {
    expect(AUTOPILOT_NO_BENEFIT_PAUSE_STREAK).toBe(3);
    const streak = consecutiveNoBenefitStreak([
      event('improvement_selected', 1),
      event('improvement_no_benefit', 2),
      event('improvement_rejected', 3),
      event('improvement_no_benefit', 4),
    ]);
    expect(streak).toBe(3);
    expect(
      consecutiveNoBenefitStreak([
        event('improvement_no_benefit', 1),
        event('improvement_selected', 2),
        event('improvement_no_benefit', 3),
      ]),
    ).toBe(1);
  });

  it('round-trips a selected improvement and merges only in-scope spec decisions', () => {
    const selected = candidate({
      id: 'complete',
      kind: 'unmet-goal',
      specDecisions: [{ key: 'complete-control', decision: 'checkbox on each row' }],
    });
    const raw = serializeSelectedImprovement(selected);
    expect(parseSelectedImprovementRecord(raw)).toMatchObject({
      action: 'complete a todo',
      expectedResult: 'it is marked done in the list',
    });
    const merged = mergeInScopeSpecDecisions(SPEC, selected.specDecisions);
    expect(merged.specDecisions).toEqual([
      { key: 'storage', decision: 'in-memory sqlite' },
      { key: 'complete-control', decision: 'checkbox on each row' },
    ]);
    expect(
      mergeInScopeSpecDecisions(SPEC, [{ key: 'limits', decision: 'raise the budget' }])
        .specDecisions,
    ).toEqual(SPEC.specDecisions);
    expect(
      extraProtectedJourneys(
        SPEC,
        [selected],
        candidate({
          id: 'edit',
          kind: 'unmet-goal',
          action: 'edit a todo title',
          expectedResult: 'the list shows the new title',
        }),
      ).map((j) => j.action),
    ).toEqual(['complete a todo', 'edit a todo title']);
  });
});
