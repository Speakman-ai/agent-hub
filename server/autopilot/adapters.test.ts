import { describe, it, expect } from 'vitest';
import {
  buildEvaluationPrompt,
  buildImplementationPrompt,
  createAutopilotBoardAdapter,
  createAutopilotDeployAdapter,
  createAutopilotDocumentAdapter,
  createAutopilotFinalizeAdapter,
  createAutopilotPlannerAdapter,
  createAutopilotSessionAdapter,
  deployOutcomeFromSnapshot,
  finalizeOutcomeFromSnapshot,
  validateBaselineSpec,
  type AutopilotBoardOps,
} from './adapters.js';
import type { AutopilotBaselineSpec } from './orchestrator.js';

const SPEC: AutopilotBaselineSpec = {
  assumptions: ['single-user'],
  acceptanceJourneys: [
    { action: 'create a todo', expectedResult: 'it appears in the list' },
    { action: 'see the list', expectedResult: 'existing todos are shown' },
    { action: 'delete a todo', expectedResult: 'it disappears from the list' },
  ],
  nonGoals: ['auth'],
  specDecisions: [{ key: 'storage', decision: 'sqlite' }],
  storageRecovery: 'disposable',
  qualityRubricVersion: 1,
};

/** A well-formed resolved baseline the fake planning session returns. */
const RESOLVED_SPEC = {
  assumptions: ['single-user, disposable data'],
  acceptanceJourneys: [
    {
      action: 'submit a new todo via the add form',
      expectedResult: 'the item appears in the list',
    },
  ],
  nonGoals: ['authentication'],
  specDecisions: [{ key: 'storage', decision: 'in-memory SQLite' }],
  storageRecovery: 'disposable',
  qualityRubricVersion: 1,
};

/**
 * Stateful fake board: created cards/epics/phases persist so a second call
 * observes them via findEpicByKey/listCardsForEpic (modelling idempotent
 * reconcile). `seed` can pre-populate a partially-created board.
 */
function recordingBoardOps(opts?: {
  seedEpicId?: string;
  seedCards?: { id: string; key: string; phaseId?: string; columnName?: string }[];
  overrides?: Partial<AutopilotBoardOps>;
}) {
  const state = {
    epicId: opts?.seedEpicId ?? (null as string | null),
    phaseCreated: 0,
    phases: [] as { id: string; name: string; position: number; key?: string | null }[],
    cards: [...(opts?.seedCards ?? [])] as {
      id: string;
      key: string;
      phaseId?: string;
      columnName?: string;
    }[],
    blockers: [] as { cardId: string; blockedByCardId: string }[],
  };
  const created = { epics: 0, cards: 0 };
  let seq = 0;
  const ops: AutopilotBoardOps = {
    ensureBoard: () => ({ boardId: 'board-1' }),
    todoColumnId: () => 'col-todo',
    findEpicByKey: () => (state.epicId ? { epicId: state.epicId } : null),
    createEpic: (a) => {
      state.epicId = a.id;
      created.epics += 1;
    },
    nextEpicPosition: () => 0,
    ensurePhase: () => {
      if (!state.phases.length) {
        state.phases.push({ id: 'phase-1', name: 'Baseline', position: 0 });
      }
      state.phaseCreated = state.phases.length;
      return { phaseId: state.phases[0]!.id };
    },
    listCardsForEpic: () => state.cards.map((c) => ({ id: c.id, key: c.key })),
    listPhases: () => state.phases,
    createPhase: (a) => {
      state.phases.push({
        id: a.id,
        name: a.name,
        position: a.position,
        key: a.key ?? null,
      });
      state.phaseCreated = state.phases.length;
    },
    listEpicCards: () =>
      state.cards.map((c) => ({
        id: c.id,
        key: c.key,
        phaseId: c.phaseId ?? 'phase-1',
        columnName: c.columnName ?? 'To Do',
      })),
    createCard: (a) => {
      state.cards.push({
        id: a.id,
        key: a.key,
        phaseId: a.phaseId,
        columnName: 'To Do',
      });
      created.cards += 1;
    },
    nextCardPosition: () => seq++,
    addBlocker: (a) => {
      if (
        state.blockers.some((b) => b.cardId === a.cardId && b.blockedByCardId === a.blockedByCardId)
      )
        return;
      state.blockers.push({ cardId: a.cardId, blockedByCardId: a.blockedByCardId });
    },
    validateAndSaveOrder: () => ({ ok: true }),
    ...opts?.overrides,
  };
  return { ops, state, created };
}

describe('autopilot planner adapter', () => {
  it('returns the agent-resolved baseline when it is fully concrete', async () => {
    const planner = createAutopilotPlannerAdapter({
      ops: { planBaseline: async () => RESOLVED_SPEC },
    });
    const spec = await planner.expandBrief({
      projectId: 'p',
      runId: 'r',
      brief: 'Build a todo list.',
      briefRevision: 1,
    });
    // Each journey carries a concrete action AND an observable expected result.
    expect(spec.acceptanceJourneys[0].action).toBe('submit a new todo via the add form');
    expect(spec.acceptanceJourneys[0].expectedResult).toBe('the item appears in the list');
    expect(spec.specDecisions.some((d) => d.key === 'storage')).toBe(true);
  });

  it('rejects a degenerate baseline that echoes the brief without a resolved outcome', async () => {
    // A journey with an action but no observable expected result — the exact
    // pass-through failure mode — must be refused, not persisted.
    const degenerate = {
      ...RESOLVED_SPEC,
      acceptanceJourneys: [{ action: 'Build a todo list', expectedResult: '' }],
    };
    const planner = createAutopilotPlannerAdapter({
      ops: { planBaseline: async () => degenerate },
    });
    await expect(
      planner.expandBrief({
        projectId: 'p',
        runId: 'r',
        brief: 'Build a todo list.',
        briefRevision: 1,
      }),
    ).rejects.toThrow(/observable expected result/);
  });

  it('validateBaselineSpec enforces concrete journeys and a resolved storage decision', () => {
    expect(() => validateBaselineSpec(RESOLVED_SPEC)).not.toThrow();
    // Missing action.
    expect(() =>
      validateBaselineSpec({ ...RESOLVED_SPEC, acceptanceJourneys: [{ expectedResult: 'x' }] }),
    ).toThrow(/concrete user action/);
    // No journeys at all.
    expect(() => validateBaselineSpec({ ...RESOLVED_SPEC, acceptanceJourneys: [] })).toThrow(
      /no acceptance journeys/,
    );
    // Storage decision not resolved.
    expect(() =>
      validateBaselineSpec({
        ...RESOLVED_SPEC,
        specDecisions: [{ key: 'runtime', decision: 'x' }],
      }),
    ).toThrow(/storage decision/);
    // Empty assumptions / non-goals.
    expect(() => validateBaselineSpec({ ...RESOLVED_SPEC, assumptions: [] })).toThrow(
      /assumptions/,
    );
    expect(() => validateBaselineSpec({ ...RESOLVED_SPEC, nonGoals: [] })).toThrow(/nonGoals/);
  });

  it('validateBaselineSpec requires an exact storageRecovery contract', () => {
    expect(() => validateBaselineSpec({ ...RESOLVED_SPEC, storageRecovery: undefined })).toThrow(
      /storage recovery contract/,
    );
    expect(() =>
      validateBaselineSpec({
        ...RESOLVED_SPEC,
        storageRecovery: 'persistent PostgreSQL; destructive migration; disposable test fixtures',
      }),
    ).toThrow(/cannot be established/);
    expect(() =>
      validateBaselineSpec({
        ...RESOLVED_SPEC,
        specDecisions: [{ key: 'storage', decision: 'in-memory SQLite, disposable' }],
        storageRecovery: undefined,
      }),
    ).toThrow(/cannot be established/);
    expect(() =>
      validateBaselineSpec({
        ...RESOLVED_SPEC,
        storageRecovery: 'migration is not guaranteed to be backward-compatible',
      }),
    ).toThrow(/cannot be established/);
    expect(() =>
      validateBaselineSpec({
        ...RESOLVED_SPEC,
        specDecisions: [
          ...RESOLVED_SPEC.specDecisions,
          { key: 'storage-recovery', decision: 'unsupported' },
        ],
      }),
    ).toThrow(/contradictory/);
    expect(() =>
      validateBaselineSpec({ ...RESOLVED_SPEC, storageRecovery: 'unsupported' }),
    ).toThrow(/unsupported data migration/);
    expect(() => validateBaselineSpec({ ...RESOLVED_SPEC, storageRecovery: 'unknown' })).toThrow(
      /cannot be established/,
    );
    expect(validateBaselineSpec(RESOLVED_SPEC).storageRecovery).toBe('disposable');
  });
});

describe('autopilot board adapter', () => {
  it('files an epic, phase, primary card and blocked journey cards', async () => {
    let n = 0;
    const { ops, state, created } = recordingBoardOps();
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `id-${n++}` });
    const result = await board.createBaselineBoard({
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC,
    });

    expect(created.epics).toBe(1);
    expect(state.phaseCreated).toBe(1);
    // One primary card + one card per additional journey (3 journeys -> 3 cards).
    expect(created.cards).toBe(3);
    expect(result.primaryCardId).toBe(result.cards[0].cardId);
    // The two journey cards are each blocked by the primary card.
    expect(state.blockers).toHaveLength(2);
    expect(state.blockers.every((b) => b.blockedByCardId === result.primaryCardId)).toBe(true);
    expect(result.cards).toHaveLength(3);
  });

  it('reconciles a board that crashed after the primary card without duplicating rows', async () => {
    // Seed a partial board: epic + primary card exist, but the journey cards
    // and blockers were never written (a crash after the primary card).
    let n = 0;
    const { ops, state, created } = recordingBoardOps({
      seedEpicId: 'epic-existing',
      seedCards: [{ id: 'primary-existing', key: 'autopilot:run-1:cycle-1#primary' }],
      overrides: {},
    });
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `new-${n++}` });
    const result = await board.createBaselineBoard({
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC, // 3 journeys
    });

    // The epic and primary card were reused (not recreated).
    expect(result.epicId).toBe('epic-existing');
    expect(result.primaryCardId).toBe('primary-existing');
    expect(created.epics).toBe(0);
    // Only the two MISSING journey cards were created — the primary was not duplicated.
    expect(created.cards).toBe(2);
    expect(state.cards).toHaveLength(3);
    // The journey -> primary blockers were filled in.
    expect(state.blockers).toHaveLength(2);
    expect(state.blockers.every((b) => b.blockedByCardId === 'primary-existing')).toBe(true);
    expect(result.cards).toHaveLength(3);
  });

  it('is fully idempotent: a second identical call creates nothing new', async () => {
    let n = 0;
    const { ops, state, created } = recordingBoardOps();
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `id-${n++}` });
    const args = {
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC,
    };
    const first = await board.createBaselineBoard(args);
    const second = await board.createBaselineBoard(args);
    expect(second.epicId).toBe(first.epicId);
    expect(second.primaryCardId).toBe(first.primaryCardId);
    expect(created.epics).toBe(1);
    expect(created.cards).toBe(3); // no new rows on the second call
    expect(state.blockers).toHaveLength(2);
    expect(second.cards.map((c) => c.cardId)).toEqual(first.cards.map((c) => c.cardId));
  });

  it('keeps distinct journeys separate even when their titles share a >120-char prefix, across a retry', async () => {
    // Two journeys whose actions are identical for the first 104 chars -> the
    // truncated "Verify journey: ..." titles collide. Keyed by journey index,
    // they must remain two cards, not collapse into one.
    const prefix = 'x'.repeat(110);
    const spec: AutopilotBaselineSpec = {
      ...SPEC,
      acceptanceJourneys: [
        { action: 'baseline', expectedResult: 'the app runs' },
        { action: `${prefix} ALPHA`, expectedResult: 'alpha result' },
        { action: `${prefix} BETA`, expectedResult: 'beta result' },
      ],
    };

    let n = 0;
    const { ops, state, created } = recordingBoardOps();
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `id-${n++}` });
    const args = {
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec,
    };

    const first = await board.createBaselineBoard(args);
    // Primary + two distinct journey cards.
    expect(created.cards).toBe(3);
    expect(new Set(first.cards.map((c) => c.cardId)).size).toBe(3);

    // Retry reconciles to the SAME three cards (no collapse, no duplication).
    const second = await board.createBaselineBoard(args);
    expect(created.cards).toBe(3);
    expect(state.cards).toHaveLength(3);
    expect(second.cards.map((c) => c.cardId)).toEqual(first.cards.map((c) => c.cardId));
  });

  it('surfaces a dependency cycle from validateAndSaveOrder', async () => {
    const { ops } = recordingBoardOps({
      overrides: { validateAndSaveOrder: () => ({ ok: false, reason: 'cycle: p1 -> p2 -> p1' }) },
    });
    const board = createAutopilotBoardAdapter({ ops });
    const res = await board.validatePhaseOrder({ projectId: 'demo', epicId: 'epic-1' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/cycle/);
  });

  it('files the next cycle phase only after prior cards are settled', async () => {
    let n = 0;
    const { ops, state } = recordingBoardOps();
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `imp-${n++}` });
    const baseline = await board.createBaselineBoard({
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC,
    });
    for (const card of state.cards) card.columnName = 'Done';
    const prior = await board.priorPhaseComplete({ projectId: 'demo', epicId: state.epicId! });
    expect(prior.ok).toBe(true);
    const next = await board.createImprovementBoard({
      projectId: 'demo',
      runId: 'run-1',
      epicId: state.epicId!,
      idempotencyKey: 'autopilot:run-1:cycle-2',
      improvement: {
        id: 'complete',
        kind: 'unmet-goal',
        action: 'complete a todo',
        expectedResult: 'it is marked done in the list',
        expectedBenefit: 'Users can complete todos.',
        rationale: 'Unmet brief goal',
      },
      blockedByCardIds: [baseline.primaryCardId],
      specDecisions: [],
    });
    expect(state.phaseCreated).toBe(2);
    expect(next.primaryCardId).toBeTruthy();
    expect(state.blockers.some((b) => b.blockedByCardId === baseline.primaryCardId)).toBe(true);
  });

  it('requires the Done column before filing the next phase', async () => {
    let columnName = 'Cancelled';
    const { ops, state } = recordingBoardOps();
    ops.listEpicCards = () =>
      state.cards.map((c) => ({
        id: c.id,
        key: c.key,
        phaseId: 'phase-1',
        columnName,
      }));
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `gate-${Math.random()}` });
    await board.createBaselineBoard({
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC,
    });
    expect((await board.priorPhaseComplete({ projectId: 'demo', epicId: state.epicId! })).ok).toBe(
      false,
    );
    columnName = 'Not Done';
    expect((await board.priorPhaseComplete({ projectId: 'demo', epicId: state.epicId! })).ok).toBe(
      false,
    );
    columnName = 'Done';
    expect((await board.priorPhaseComplete({ projectId: 'demo', epicId: state.epicId! })).ok).toBe(
      true,
    );
    ops.listEpicCards = () => [
      ...state.cards.map((c) => ({
        id: c.id,
        key: c.key,
        phaseId: 'phase-1',
        columnName: 'Done',
      })),
      { id: 'human-1', key: null, phaseId: 'phase-1', columnName: 'To Do' },
    ];
    expect((await board.priorPhaseComplete({ projectId: 'demo', epicId: state.epicId! })).ok).toBe(
      false,
    );
  });

  it('fails the gate when baseline cards are Done but an unassigned epic card is not', async () => {
    const { ops, state } = recordingBoardOps();
    const board = createAutopilotBoardAdapter({
      ops,
      randomId: () => `unassigned-${Math.random()}`,
    });
    await board.createBaselineBoard({
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC,
    });
    const assigned = () =>
      state.cards.map((c) => ({
        id: c.id,
        key: c.key,
        phaseId: c.phaseId ?? 'phase-1',
        columnName: 'Done' as const,
      }));
    ops.listEpicCards = () => [
      ...assigned(),
      { id: 'unassigned-1', key: null, phaseId: null, columnName: 'To Do' },
    ];
    const blocked = await board.priorPhaseComplete({ projectId: 'demo', epicId: state.epicId! });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/unassigned/i);
    expect(
      (
        await board.priorPhaseComplete({
          projectId: 'demo',
          epicId: state.epicId!,
          idempotencyKey: 'autopilot:run-1:cycle-2',
        })
      ).ok,
    ).toBe(false);
    ops.listEpicCards = () => [
      ...assigned(),
      { id: 'unassigned-1', key: null, phaseId: null, columnName: 'Done' },
    ];
    expect((await board.priorPhaseComplete({ projectId: 'demo', epicId: state.epicId! })).ok).toBe(
      true,
    );
  });

  it('retries the predecessor phase after a partially created improvement board', async () => {
    let n = 0;
    const { ops, state } = recordingBoardOps();
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `imp-${n++}` });
    const baseline = await board.createBaselineBoard({
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC,
    });
    for (const card of state.cards) card.columnName = 'Done';
    const cycle2Key = 'autopilot:run-1:cycle-2';
    const improvement = {
      id: 'complete',
      kind: 'unmet-goal' as const,
      action: 'complete a todo',
      expectedResult: 'it is marked done in the list',
      expectedBenefit: 'Users can complete todos.',
      rationale: 'Unmet brief goal',
    };
    const created = await board.createImprovementBoard({
      projectId: 'demo',
      runId: 'run-1',
      epicId: state.epicId!,
      idempotencyKey: cycle2Key,
      improvement,
      blockedByCardIds: [baseline.primaryCardId],
      specDecisions: [],
    });
    expect(state.phaseCreated).toBe(2);
    expect((await board.priorPhaseComplete({ projectId: 'demo', epicId: state.epicId! })).ok).toBe(
      false,
    );
    expect(
      (
        await board.priorPhaseComplete({
          projectId: 'demo',
          epicId: state.epicId!,
          idempotencyKey: cycle2Key,
        })
      ).ok,
    ).toBe(true);
    const reused = await board.createImprovementBoard({
      projectId: 'demo',
      runId: 'run-1',
      epicId: state.epicId!,
      idempotencyKey: cycle2Key,
      improvement,
      blockedByCardIds: [baseline.primaryCardId],
      specDecisions: [],
    });
    expect(reused.primaryCardId).toBe(created.primaryCardId);
    expect(state.phaseCreated).toBe(2);
  });

  it('fails the gate when an earlier phase card is reopened and the immediate predecessor is still Done', async () => {
    let n = 0;
    const { ops, state } = recordingBoardOps();
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `imp-${n++}` });
    const baseline = await board.createBaselineBoard({
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC,
    });
    for (const card of state.cards) card.columnName = 'Done';
    const cycle2 = await board.createImprovementBoard({
      projectId: 'demo',
      runId: 'run-1',
      epicId: state.epicId!,
      idempotencyKey: 'autopilot:run-1:cycle-2',
      improvement: {
        id: 'complete',
        kind: 'unmet-goal',
        action: 'complete a todo',
        expectedResult: 'it is marked done in the list',
        expectedBenefit: 'Users can complete todos.',
        rationale: 'Unmet brief goal',
      },
      blockedByCardIds: [baseline.primaryCardId],
      specDecisions: [],
    });
    for (const card of state.cards) card.columnName = 'Done';
    const cycle3Key = 'autopilot:run-1:cycle-3';
    await board.createImprovementBoard({
      projectId: 'demo',
      runId: 'run-1',
      epicId: state.epicId!,
      idempotencyKey: cycle3Key,
      improvement: {
        id: 'edit-todo',
        kind: 'unmet-goal',
        action: 'edit a todo title',
        expectedResult: 'the list shows the new title',
        expectedBenefit: 'Users can rename todos.',
        rationale: 'Unmet brief goal',
      },
      blockedByCardIds: [cycle2.primaryCardId],
      specDecisions: [],
    });
    const earlier = state.cards.find((c) => (c.phaseId ?? 'phase-1') === 'phase-1');
    expect(earlier).toBeTruthy();
    earlier!.columnName = 'To Do';
    expect(
      (
        await board.priorPhaseComplete({
          projectId: 'demo',
          epicId: state.epicId!,
          idempotencyKey: cycle3Key,
        })
      ).ok,
    ).toBe(false);
    earlier!.columnName = 'Done';
    expect(
      (
        await board.priorPhaseComplete({
          projectId: 'demo',
          epicId: state.epicId!,
          idempotencyKey: cycle3Key,
        })
      ).ok,
    ).toBe(true);
  });

  it('recovers after createPhase before the improvement card exists', async () => {
    let n = 0;
    const { ops, state } = recordingBoardOps();
    const originalCreateCard = ops.createCard;
    let failNextImprovementCard = true;
    ops.createCard = (a) => {
      if (failNextImprovementCard && a.key.endsWith('#improvement')) {
        failNextImprovementCard = false;
        throw new Error('injected crash after createPhase');
      }
      originalCreateCard(a);
    };
    const board = createAutopilotBoardAdapter({ ops, randomId: () => `imp-${n++}` });
    const baseline = await board.createBaselineBoard({
      projectId: 'demo',
      runId: 'run-1',
      idempotencyKey: 'autopilot:run-1:cycle-1',
      spec: SPEC,
    });
    for (const card of state.cards) card.columnName = 'Done';
    const cycle2Key = 'autopilot:run-1:cycle-2';
    const improvement = {
      id: 'complete',
      kind: 'unmet-goal' as const,
      action: 'complete a todo',
      expectedResult: 'it is marked done in the list',
      expectedBenefit: 'Users can complete todos.',
      rationale: 'Unmet brief goal',
    };
    await expect(
      board.createImprovementBoard({
        projectId: 'demo',
        runId: 'run-1',
        epicId: state.epicId!,
        idempotencyKey: cycle2Key,
        improvement,
        blockedByCardIds: [baseline.primaryCardId],
        specDecisions: [],
      }),
    ).rejects.toThrow(/injected crash after createPhase/);
    expect(state.phaseCreated).toBe(2);
    expect(state.cards.some((c) => c.key === `${cycle2Key}#improvement`)).toBe(false);
    expect(
      (
        await board.priorPhaseComplete({
          projectId: 'demo',
          epicId: state.epicId!,
          idempotencyKey: cycle2Key,
        })
      ).ok,
    ).toBe(true);
    const recovered = await board.createImprovementBoard({
      projectId: 'demo',
      runId: 'run-1',
      epicId: state.epicId!,
      idempotencyKey: cycle2Key,
      improvement,
      blockedByCardIds: [baseline.primaryCardId],
      specDecisions: [],
    });
    expect(state.phaseCreated).toBe(2);
    expect(recovered.primaryCardId).toBeTruthy();
    expect(state.cards.some((c) => c.key === `${cycle2Key}#improvement`)).toBe(true);
  });
});

describe('autopilot session adapter', () => {
  it('dispatches with a structured prompt and the durable operation id', async () => {
    let received: { operationId: string; prompt: string } | null = null;
    const adapter = createAutopilotSessionAdapter({
      ops: {
        startImplementationSession: async (args) => {
          received = { operationId: args.operationId, prompt: args.prompt };
          return { sessionId: 'sess-x' };
        },
      },
    });
    const out = await adapter.dispatchImplementation({
      projectId: 'demo',
      runId: 'run-1',
      operationId: 'op-1',
      cardId: 'card-1',
      workerKeyName: 'autopilot:demo:run-1',
      bounds: { maxStageTimeoutMs: 1000 },
      context: {
        specRevision: 1,
        cardId: 'card-1',
        acceptanceJourneys: [{ action: 'create a todo', expectedResult: 'it appears in the list' }],
        nonGoals: ['auth'],
        specDecisions: [{ key: 'storage', decision: 'sqlite' }],
        storageRecovery: 'disposable',
        priorHandoff: null,
      },
    });
    expect(out.sessionId).toBe('sess-x');
    expect(received!.operationId).toBe('op-1');
    expect(received!.prompt).toContain('create a todo');
    expect(received!.prompt).toContain('it appears in the list');
    expect(received!.prompt).toContain('Do not push');
  });

  it('builds a prompt that forbids push/PR/merge', () => {
    const prompt = buildImplementationPrompt({
      specRevision: 1,
      cardId: 'c',
      acceptanceJourneys: [{ action: 'do j1', expectedResult: 'see r1' }],
      nonGoals: ['n1'],
      specDecisions: [{ key: 'k', decision: 'd' }],
      storageRecovery: 'disposable',
      priorHandoff: null,
    });
    expect(prompt).toContain('do j1');
    expect(prompt).toContain('see r1');
    expect(prompt).toContain('n1');
    expect(prompt).toContain('Finalize');
    expect(prompt).toContain('disposable');
    expect(prompt).toContain('do not infer recoverability');
  });

  it('includes reconstructed prior-cycle records in the implementation prompt', () => {
    const prompt = buildImplementationPrompt({
      specRevision: 1,
      cardId: 'c',
      acceptanceJourneys: [{ action: 'do j1', expectedResult: 'see r1' }],
      nonGoals: ['n1'],
      specDecisions: [{ key: 'k', decision: 'd' }],
      storageRecovery: 'disposable',
      priorHandoff: {
        briefRevision: 3,
        specRevision: 3,
        lastVerifiedSha: 'deadbeefcafe',
        lastDeploymentId: 'dep-1',
        lastSuccessfulCycle: null,
        records: [
          {
            version: 1,
            kind: 'success',
            runId: 'run-1',
            cycleId: 'cyc-1',
            cycleNumber: 1,
            briefRevision: 3,
            specRevision: 3,
            expectedBenefit: 'baseline',
            actualChange: 'Merged deadbeefcafe',
            decisions: [],
            links: {
              cardId: 'c',
              sessionId: 's',
              testedCommitSha: 'deadbeefcafe',
              finalizeRunId: 'f',
              deploymentId: 'dep-1',
              deploymentOrigin: 'http://127.0.0.1:4310',
            },
            evidence: [],
            usage: { wallTimeMs: 1, costUsd: null, costAvailable: false },
            outcome: 'verified',
            nextAction: 'selecting-next',
            journalSlug: 'autopilot-journal',
            wikiSlugs: ['autopilot-journal'],
            artifactIds: [],
            publishedByKey: {},
            redactions: 0,
            documentedAt: 't',
            failedAttempts: [],
          },
        ],
        acceptanceJourneys: [],
        nonGoals: [],
        specDecisions: [],
        storageRecovery: 'disposable',
      },
    });
    expect(prompt).toContain('successful behavior');
    expect(prompt).toContain('deadbeefcafe');
    expect(prompt).toContain('Do not treat proposals or failures as current verified behavior');
  });
});

describe('autopilot finalize adapter', () => {
  it('starts finalize through the injected merge-automation op', async () => {
    let started: { sessionId: string; cardId: string } | null = null;
    const adapter = createAutopilotFinalizeAdapter({
      ops: {
        startMergeAutomation: async (args) => {
          started = { sessionId: args.sessionId, cardId: args.cardId };
          return { finalizeRunId: 'fin-9' };
        },
      },
    });
    const out = await adapter.startFinalize({
      projectId: 'demo',
      runId: 'run-1',
      operationId: 'op-2',
      cardId: 'card-1',
      sessionId: 'sess-x',
      workerKeyName: null,
    });
    expect(out.finalizeRunId).toBe('fin-9');
    expect(started!.sessionId).toBe('sess-x');
  });

  it('maps finalize run snapshots to orchestrator results', () => {
    // Still running.
    expect(
      finalizeOutcomeFromSnapshot({
        status: 'reviewing',
        reviewerVerdict: null,
        merged: false,
        mergedSha: null,
      }),
    ).toBeNull();
    // Merged + approved.
    expect(
      finalizeOutcomeFromSnapshot({
        status: 'pushed',
        reviewerVerdict: 'approved',
        merged: true,
        mergedSha: 'sha1',
      }),
    ).toEqual({ status: 'merged', mergedSha: 'sha1', reviewStatus: 'approved' });
    // Review rejected.
    expect(
      finalizeOutcomeFromSnapshot({
        status: 'failed',
        reviewerVerdict: 'changes_requested',
        merged: false,
        mergedSha: null,
      }),
    ).toEqual({ status: 'review_rejected', reviewStatus: 'changes_requested' });
    // CI failure.
    expect(
      finalizeOutcomeFromSnapshot({
        status: 'failed',
        reviewerVerdict: 'approved',
        merged: false,
        mergedSha: null,
      })?.status,
    ).toBe('ci_failed');
    // Pushed but PR not actually merged (defensive) -> error, not merged.
    expect(
      finalizeOutcomeFromSnapshot({
        status: 'pushed',
        reviewerVerdict: 'approved',
        merged: false,
        mergedSha: null,
      })?.status,
    ).toBe('error');
    // Merged with a real SHA but NO reviewer verdict must NOT manufacture an
    // approved merge — it is an error, never 'merged'/'approved'.
    const noVerdict = finalizeOutcomeFromSnapshot({
      status: 'pushed',
      reviewerVerdict: null,
      merged: true,
      mergedSha: 'sha-nolabel',
    });
    expect(noVerdict?.status).toBe('error');
    expect(noVerdict?.reviewStatus ?? null).not.toBe('approved');
  });
});

describe('autopilot deploy adapter', () => {
  it('starts a deploy through the injected op with trigger autopilot', async () => {
    let started: { targetId: string; sha: string; trigger: string } | null = null;
    const adapter = createAutopilotDeployAdapter({
      ops: {
        startDeployment: async (args) => {
          started = { targetId: args.targetId, sha: args.sha, trigger: args.trigger };
          return { deploymentId: 'dep-9' };
        },
        runRollback: async () => ({
          status: 'success',
          deploymentId: 'dep-rb',
          deployedSha: 'lkg',
        }),
      },
    });
    const out = await adapter.deployRevision({
      projectId: 'demo',
      runId: 'run-1',
      operationId: 'op-3',
      targetId: 'local-preview',
      sha: 'deadbeef',
      workerKeyName: null,
    });
    expect(out.deploymentId).toBe('dep-9');
    expect(started).toEqual({
      targetId: 'local-preview',
      sha: 'deadbeef',
      trigger: 'autopilot',
    });
  });

  it('maps deployment snapshots to orchestrator results', () => {
    expect(deployOutcomeFromSnapshot('dep-1', { status: 'pending', ref: 'sha' })).toBeNull();
    expect(deployOutcomeFromSnapshot('dep-1', { status: 'running', ref: 'sha' })).toBeNull();
    expect(
      deployOutcomeFromSnapshot('dep-1', { status: 'success', ref: 'sha', liveRef: 'live' }),
    ).toEqual({
      status: 'success',
      deploymentId: 'dep-1',
      deployedSha: 'live',
    });
    expect(
      deployOutcomeFromSnapshot('dep-1', { status: 'success', ref: 'sha', liveRef: null }),
    ).toBeNull();
    expect(deployOutcomeFromSnapshot('dep-1', { status: 'success', ref: 'sha' })).toBeNull();
    expect(
      deployOutcomeFromSnapshot('dep-1', { status: 'awaiting_approval', ref: 'sha' })?.status,
    ).toBe('awaiting_approval');
    expect(deployOutcomeFromSnapshot('dep-1', { status: 'cancelled', ref: 'sha' })?.status).toBe(
      'cancelled',
    );
    expect(deployOutcomeFromSnapshot('dep-1', { status: 'error', ref: 'sha' })?.status).toBe(
      'error',
    );
  });

  it('builds an evaluator prompt that forbids implementation writes and preview', () => {
    const prompt = buildEvaluationPrompt({
      origin: 'http://127.0.0.1:4310',
      expectedSha: 'deadbeef',
      pinned: {
        specRevision: 1,
        qualityRubricVersion: 1,
        criteria: [
          {
            id: 'baseline-1',
            source: 'baseline',
            kind: 'browser_journey',
            action: 'create a todo',
            expectedResult: 'it appears',
          },
        ],
      },
    });
    expect(prompt).toMatch(/no implementation write authority/i);
    expect(prompt).toContain('deadbeef');
    expect(prompt).toMatch(/Do not use session preview/);
    expect(prompt).toContain('baseline-1');
    expect(prompt).toMatch(/Hub records HTTP responses/);
    expect(prompt).toMatch(/screenshots and journey traces/);
  });
});

describe('autopilot document adapter', () => {
  it('upserts journal pages in place and publishes artifacts', async () => {
    const pages: { title: string; content: string }[] = [];
    const blobs: { filename: string }[] = [];
    const adapter = createAutopilotDocumentAdapter({
      ops: {
        upsertPage: (_projectId, input) => {
          pages.push({ title: input.title, content: input.content });
        },
        publishArtifact: async ({ filename }) => {
          blobs.push({ filename });
          return { artifactId: `id-${filename}` };
        },
      },
    });
    await adapter.writePages({
      projectId: 'demo',
      runId: 'run-1',
      cycleId: 'cyc-1',
      pages: [
        {
          slug: 'autopilot-journal',
          title: 'Autopilot journal',
          content: 'Cycle 1 (successful behavior)',
          category: 'general',
        },
      ],
    });
    await adapter.writePages({
      projectId: 'demo',
      runId: 'run-1',
      cycleId: 'cyc-1',
      pages: [
        {
          slug: 'autopilot-journal',
          title: 'Autopilot journal',
          content: 'Cycle 1 (successful behavior)\nCycle 2 (failure)',
          category: 'general',
        },
      ],
    });
    expect(pages).toHaveLength(2);
    expect(pages[1]!.content).toContain('failure');
    const published = await adapter.publishArtifact({
      sessionId: 'sess-1',
      cycleId: 'cyc-1',
      key: 'record.json',
      filename: 'cycle-1-record.json',
      contentType: 'application/json',
      body: '{}',
    });
    expect(published.artifactId).toEqual('id-cycle-1-record.json');
    expect(blobs).toHaveLength(1);
  });
});
