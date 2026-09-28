import { describe, expect, it } from 'vitest';
import {
  formatEpicSpecDecisionsForContext,
  isSpikeCard,
  isSpikeSession,
  normalizeSpecItemStatus,
  buildSpikeSessionContext,
  buildSpikeSessionContextFallback,
  countOpenSpecItemsForPhase,
  deriveSpecTagFromSpikeTitle,
} from './epic-spec.js';
import type { KanbanCardRow, KanbanEpicSpecItemRow, Stmts } from './types.js';

const baseSpec = (over: Partial<KanbanEpicSpecItemRow>): KanbanEpicSpecItemRow => ({
  id: 'spec-1',
  epic_id: 'epic-1',
  board_id: 'board-1',
  phase_id: null,
  tag: 'MODEL',
  title: 'Phase table shape',
  decision: null,
  status: 'open',
  position: 0,
  spike_card_id: null,
  resolved_session_id: null,
  created_at: '',
  updated_at: '',
  ...over,
});

describe('epic-spec', () => {
  it('isSpikeCard detects spike kind', () => {
    expect(isSpikeCard({ card_kind: 'spike' })).toBe(true);
    expect(isSpikeCard({ card_kind: 'task' })).toBe(false);
    expect(isSpikeCard({})).toBe(false);
    expect(isSpikeCard({ title: 'Spike: pick delivery model' })).toBe(true);
    expect(isSpikeCard({ title: 'Implement spike detector' })).toBe(false);
  });

  it('countOpenSpecItemsForPhase queries by epic + phase and returns the count', () => {
    let calledWith: unknown[] = [];
    const stmts = {
      countOpenKanbanSpecItemsByPhase: {
        get: (...args: unknown[]) => {
          calledWith = args;
          return { n: 2 };
        },
      },
    } as unknown as Stmts;
    expect(countOpenSpecItemsForPhase(stmts, 'epic-1', 'phase-9')).toBe(2);
    expect(calledWith).toEqual(['epic-1', 'phase-9']);
  });

  it('countOpenSpecItemsForPhase defaults to 0 when the row is undefined', () => {
    const stmts = {
      countOpenKanbanSpecItemsByPhase: { get: () => undefined },
    } as unknown as Stmts;
    expect(countOpenSpecItemsForPhase(stmts, 'epic-1', 'phase-9')).toBe(0);
  });

  it('normalizeSpecItemStatus falls back to open', () => {
    expect(normalizeSpecItemStatus('chosen')).toBe('chosen');
    expect(normalizeSpecItemStatus('nope')).toBe('open');
  });

  it('formatEpicSpecDecisionsForContext includes only chosen items with text', () => {
    const block = formatEpicSpecDecisionsForContext([
      baseSpec({ status: 'open' }),
      baseSpec({
        id: 'spec-2',
        tag: 'EDGES',
        title: 'Sequential only',
        status: 'chosen',
        decision: 'Left-to-right phase order; no phase graph.',
      }),
    ]);
    expect(block).toContain('Epic spec decisions');
    expect(block).toContain('Sequential only');
    expect(block).not.toContain('Phase table shape');
  });

  it('buildSpikeSessionContext references spec item and API', () => {
    const card = {
      id: 'card-spike',
      title: 'Spike: Phase table shape',
      description: 'notes',
    } as KanbanCardRow;
    const ctx = buildSpikeSessionContext({
      card,
      specItem: baseSpec({ id: 'spec-abc' }),
      projectId: 'agent-hub',
    });
    expect(ctx).toContain('spec-abc');
    expect(ctx).toContain('/board/spec-items/spec-abc');
    expect(ctx).toContain('Spec decisions');
    expectSpikeRules(ctx);
  });

  it('deriveSpecTagFromSpikeTitle picks a unique tag', () => {
    expect(deriveSpecTagFromSpikeTitle('Spike: choose chat delivery', new Set())).toBe('CHOOSE');
    expect(deriveSpecTagFromSpikeTitle('Spike: choose chat delivery', new Set(['CHOOSE']))).toBe(
      'CHOOSE2',
    );
  });

  it('buildSpikeSessionContextFallback requires epic spec output', () => {
    const ctx = buildSpikeSessionContextFallback({
      card: {
        id: 'c1',
        title: 'Spike: polling vs websocket',
        epic_id: 'epic-1',
        phase_id: 'phase-1',
      } as KanbanCardRow,
      projectId: 'agent-hub',
    });
    expect(ctx).toContain('Spec decisions');
    expect(ctx).toContain('/board/spec-items');
    expect(ctx).toContain('/board/epics/epic-1');
    expectSpikeRules(ctx);
  });

  it('isSpikeSession flags spike-card and spec-linked scoping sessions only', () => {
    const cards: Record<string, Partial<KanbanCardRow> | undefined> = {
      'sess-spike': { card_kind: 'spike' },
      'sess-task': { card_kind: 'task', title: 'Build it' },
    };
    const stmts = {
      getKanbanCardBySession: { get: (id: string) => cards[id] },
    } as unknown as Parameters<typeof isSpikeSession>[0];

    expect(isSpikeSession(stmts, { id: 'sess-spike' })).toBe(true);
    expect(isSpikeSession(stmts, { id: 'sess-task' })).toBe(false);
    expect(isSpikeSession(stmts, { id: 'sess-none' })).toBe(false);
    // Reassigned spike card: the older session keeps its spec-item link.
    expect(
      isSpikeSession(stmts, {
        id: 'sess-none',
        session_mode: 'scoping',
        linked_spec_item_id: 'spec-1',
      }),
    ).toBe(true);
    // Reassigned spike with no spec item (fallback dispatch, no epic): the card
    // now points at a newer session, but the stamp on this one still holds.
    expect(isSpikeSession(stmts, { id: 'sess-none', spike_card_id: 'card-spike' })).toBe(true);
    expect(isSpikeSession(stmts, { id: 'sess-none', spike_card_id: null })).toBe(false);
    // An epic-scoping session without a spec item is not a spike.
    expect(isSpikeSession(stmts, { id: 'sess-none', session_mode: 'scoping' })).toBe(false);
  });
});

function expectSpikeRules(ctx: string): void {
  // Code may be written and run in the worktree...
  expect(ctx).toMatch(/\*\*may\*\* edit files and run code/);
  // ...but never shipped.
  expect(ctx).toMatch(/Do not run Finalize, do not `git push`, and do not open a PR/);
  expect(ctx).not.toContain('No code');
  // Scope instead of budget.
  expect(ctx).toContain('Answer the spec question, then stop.');
  expect(ctx).toContain('Do not finish the feature');
  expect(ctx).toMatch(/no turn, time, or token budget/);
  // Decision plus findings.
  expect(ctx).toContain('## Findings');
  expect(ctx).toMatch(/What was tried/);
  expect(ctx).toMatch(/What broke/);
  expect(ctx).toMatch(/Roadblocks/);
  // Code references go to build tickets, and to the epic when they span tickets.
  expect(ctx).toMatch(/files, functions, and call sites/);
  expect(ctx).toMatch(/\/board\/cards\/<buildCardId>\/comments/);
  expect(ctx).toMatch(/span several tickets go on the epic description/);
  expect(ctx).toMatch(/Treat spike code as \*\*throwaway\*\*/);
  // No cleanup exists yet, so the prompt must not promise deletion.
  expect(ctx).not.toMatch(/deleted|No branch or ref is kept/);
}
