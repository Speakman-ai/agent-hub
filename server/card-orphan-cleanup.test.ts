import { describe, it, expect, vi } from 'vitest';
import {
  classifyCardOnSessionClose,
  isAdvancedColumn,
  isAgentFiledCard,
  cleanupOrphanCardForClosedSession,
  type CardCloseSignals,
} from './card-orphan-cleanup.js';
import type { AgentLookup, KanbanCardRow, Stmts } from './types.js';

const baseSignals: CardCloseSignals = {
  isAgentFiled: true,
  hasPr: false,
  hasFinalizeRun: false,
  inAdvancedColumn: false,
  isAutonomous: false,
  hasComments: false,
  hasEpic: false,
  hasGithubIssue: false,
  hasBlockers: false,
  alreadyOrphaned: false,
};

describe('classifyCardOnSessionClose', () => {
  it('deletes a pristine agent-filed stub that never progressed', () => {
    const d = classifyCardOnSessionClose({ ...baseSignals });
    expect(d.action).toBe('delete');
    expect(d.reason).toBe('abandoned-stub');
  });

  it('never deletes a card it did not file (human / support)', () => {
    const d = classifyCardOnSessionClose({ ...baseSignals, isAgentFiled: false });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('not-agent-filed');
  });

  it.each([
    ['hasPr', { hasPr: true }, 'progressed:pr'],
    ['hasFinalizeRun', { hasFinalizeRun: true }, 'progressed:finalize-run'],
    ['inAdvancedColumn', { inAdvancedColumn: true }, 'progressed:advanced-column'],
    ['isAutonomous', { isAutonomous: true }, 'progressed:autonomous'],
    ['hasComments', { hasComments: true }, 'progressed:comments'],
    ['hasEpic', { hasEpic: true }, 'progressed:epic'],
    ['hasGithubIssue', { hasGithubIssue: true }, 'progressed:github-issue'],
    ['hasBlockers', { hasBlockers: true }, 'progressed:blockers'],
  ])('flags (not deletes) a progressed card via %s', (_label, overrides, reason) => {
    const d = classifyCardOnSessionClose({ ...baseSignals, ...overrides });
    expect(d.action).toBe('flag');
    expect(d.reason).toBe(reason);
  });

  it('combines multiple progression reasons in the flag reason', () => {
    const d = classifyCardOnSessionClose({ ...baseSignals, hasPr: true, hasEpic: true });
    expect(d.action).toBe('flag');
    expect(d.reason).toBe('progressed:pr+epic');
  });

  it('is idempotent — an already-orphaned card is left alone', () => {
    const d = classifyCardOnSessionClose({ ...baseSignals, hasPr: true, alreadyOrphaned: true });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('already-orphaned');
  });

  it('does not delete an already-orphaned stub (no double work)', () => {
    const d = classifyCardOnSessionClose({ ...baseSignals, alreadyOrphaned: true });
    expect(d.action).toBe('keep');
  });
});

describe('isAdvancedColumn', () => {
  it.each(['Review', 'In Review', 'Done', 'Done ✅', 'Deployed / Done', 'Shipped'])(
    'treats %s as advanced',
    (name) => {
      expect(isAdvancedColumn(name)).toBe(true);
    },
  );

  it.each(['To Do', 'Todo', 'Backlog', 'In Progress', '', null, undefined])(
    'treats %s as not advanced',
    (name) => {
      expect(isAdvancedColumn(name as string | null | undefined)).toBe(false);
    },
  );
});

describe('isAgentFiledCard', () => {
  const agent = { id: 'agent-hub-dev', name: 'Agent Hub Dev' };

  it('treats an empty / null author as agent-filed (lazy or script default)', () => {
    expect(isAgentFiledCard(null, agent)).toBe(true);
    expect(isAgentFiledCard('', agent)).toBe(true);
    expect(isAgentFiledCard('   ', agent)).toBe(true);
  });

  it('matches the session agent by id or (case-insensitive) name', () => {
    expect(isAgentFiledCard('agent-hub-dev', agent)).toBe(true);
    expect(isAgentFiledCard('Agent Hub Dev', agent)).toBe(true);
    expect(isAgentFiledCard('agent hub dev', agent)).toBe(true);
  });

  it('treats a different / external author as NOT agent-filed', () => {
    expect(isAgentFiledCard('acme', agent)).toBe(false);
    expect(isAgentFiledCard('support-ticket', agent)).toBe(false);
    expect(isAgentFiledCard('Ticket Intake', agent)).toBe(false);
  });

  it('is conservative when the agent cannot be resolved (non-empty author)', () => {
    expect(isAgentFiledCard('whoever', null)).toBe(false);
    // ...but a missing author with no agent still counts as agent/lazy-filed.
    expect(isAgentFiledCard(null, null)).toBe(true);
  });
});

// ─── Executor ───────────────────────────────────────────────────────────────

type CardOverrides = Partial<KanbanCardRow>;

function makeCard(overrides: CardOverrides = {}): KanbanCardRow {
  return {
    id: 'card-1',
    column_id: 'col-todo',
    board_id: 'board-1',
    title: 'One-off question',
    description: null,
    priority: 'medium',
    assignee: null,
    labels: null,
    session_id: 'sess-1',
    github_issue_url: null,
    pr_url: null,
    review_status: null,
    created_by: null,
    short_id: 1,
    position: 0,
    epic_id: null,
    documented: 0,
    dispatched_by_autonomous: 0,
    orphaned_at: null,
    ...(overrides as object),
  } as KanbanCardRow;
}

interface FakeWorld {
  card?: KanbanCardRow;
  columnName?: string;
  finalizeRun?: unknown;
  comments?: unknown[];
  blockerEdges?: number;
}

function buildDeps(world: FakeWorld) {
  const deleteRun = vi.fn();
  const orphanRun = vi.fn();
  const broadcast = vi.fn();

  const stmts = {
    getKanbanCardBySession: { get: vi.fn(() => world.card) },
    getKanbanBoardById: { get: vi.fn(() => ({ id: 'board-1', project_id: 'proj-1' })) },
    getSession: { get: vi.fn(() => ({ id: 'sess-1', agent_id: 'agent-hub-dev' })) },
    getKanbanColumn: { get: vi.fn(() => ({ id: 'col-todo', name: world.columnName ?? 'To Do' })) },
    getLatestFinalizeRunForSession: { get: vi.fn(() => world.finalizeRun ?? undefined) },
    getKanbanCardComments: { all: vi.fn(() => world.comments ?? []) },
    countBlockerEdgesForCard: { get: vi.fn(() => ({ n: world.blockerEdges ?? 0 })) },
    deleteKanbanCard: { run: deleteRun },
    markKanbanCardOrphaned: { run: orphanRun },
  } as unknown as Stmts;

  const findAgent = vi.fn(
    (id: string): AgentLookup | null =>
      ({ agent: { id, name: 'Agent Hub Dev' } }) as unknown as AgentLookup,
  );

  return { deps: { stmts, broadcast, findAgent }, deleteRun, orphanRun, broadcast };
}

describe('cleanupOrphanCardForClosedSession', () => {
  it('no-ops for a card-less session', () => {
    const { deps, deleteRun, orphanRun, broadcast } = buildDeps({ card: undefined });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('none');
    expect(deleteRun).not.toHaveBeenCalled();
    expect(orphanRun).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('deletes a pristine agent-filed stub and broadcasts a board update', () => {
    const { deps, deleteRun, orphanRun, broadcast } = buildDeps({ card: makeCard() });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('delete');
    expect(deleteRun).toHaveBeenCalledWith('card-1');
    expect(orphanRun).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'proj-1' });
  });

  it('flags (keeps) a card that has a PR', () => {
    const { deps, deleteRun, orphanRun, broadcast } = buildDeps({
      card: makeCard({ pr_url: 'https://github.com/x/y/pull/1' }),
    });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('flag');
    expect(orphanRun).toHaveBeenCalledWith('card-1');
    expect(deleteRun).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'proj-1' });
  });

  it('flags a card that has a finalize run', () => {
    const { deps, orphanRun } = buildDeps({ card: makeCard(), finalizeRun: { id: 'fr-1' } });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('flag');
    expect(orphanRun).toHaveBeenCalledWith('card-1');
  });

  it('flags (never deletes) a card linked only to a GitHub issue', () => {
    const { deps, orphanRun, deleteRun } = buildDeps({
      card: makeCard({ github_issue_url: 'https://github.com/x/y/issues/42' }),
    });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('flag');
    expect(r.reason).toBe('progressed:github-issue');
    expect(orphanRun).toHaveBeenCalledWith('card-1');
    expect(deleteRun).not.toHaveBeenCalled();
  });

  it('flags (never deletes) a card that has blocker edges', () => {
    // A card with blocker edges has accumulated coordination state; deleting it
    // would cascade-drop those edges and could silently un-block a downstream
    // card. Keep + flag instead.
    const { deps, orphanRun, deleteRun } = buildDeps({ card: makeCard(), blockerEdges: 1 });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('flag');
    expect(r.reason).toBe('progressed:blockers');
    expect(orphanRun).toHaveBeenCalledWith('card-1');
    expect(deleteRun).not.toHaveBeenCalled();
  });

  it('flags a card sitting in an advanced (Review) column', () => {
    const { deps, orphanRun } = buildDeps({ card: makeCard(), columnName: 'Review' });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('flag');
    expect(orphanRun).toHaveBeenCalledWith('card-1');
  });

  it('flags a card with comments rather than deleting it', () => {
    const { deps, orphanRun, deleteRun } = buildDeps({
      card: makeCard(),
      comments: [{ id: 'c-1', author: 'someone', content: 'hi' }],
    });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('flag');
    expect(orphanRun).toHaveBeenCalledWith('card-1');
    expect(deleteRun).not.toHaveBeenCalled();
  });

  it('deletes a stub whose created_by is the session agent name (agent must resolve)', () => {
    // Regression: the cleanup resolves the owning agent via getSession. If that
    // identity is unavailable at cleanup time, a card stamped with the agent's
    // own name reads as externally-owned and is wrongly skipped. Asserting the
    // delete here guards that the agent is resolvable when cleanup runs.
    const { deps, deleteRun, orphanRun } = buildDeps({
      card: makeCard({ created_by: 'Agent Hub Dev' }),
    });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('delete');
    expect(deleteRun).toHaveBeenCalledWith('card-1');
    expect(orphanRun).not.toHaveBeenCalled();
  });

  it('skips a stub when the owning session/agent cannot be resolved (defensive)', () => {
    // If getSession returns nothing (e.g. a future change filters archived rows
    // and cleanup were ordered after the soft-delete), a card with a non-empty
    // created_by must NOT be deleted — better to keep a stub than drop work we
    // can no longer attribute. The route runs cleanup BEFORE soft-delete to
    // avoid this, but the executor stays conservative regardless.
    const { deps, deleteRun, orphanRun } = buildDeps({
      card: makeCard({ created_by: 'Agent Hub Dev' }),
    });
    (deps.stmts.getSession as unknown as { get: () => unknown }).get = vi.fn(() => undefined);
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('keep');
    expect(deleteRun).not.toHaveBeenCalled();
    expect(orphanRun).not.toHaveBeenCalled();
  });

  it('keeps (never deletes) a human-filed card', () => {
    const { deps, deleteRun, orphanRun, broadcast } = buildDeps({
      card: makeCard({ created_by: 'acme' }),
    });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('keep');
    expect(deleteRun).not.toHaveBeenCalled();
    expect(orphanRun).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('is idempotent for an already-orphaned card (no re-flag, no broadcast)', () => {
    const { deps, orphanRun, broadcast } = buildDeps({
      card: makeCard({
        pr_url: 'https://github.com/x/y/pull/1',
        orphaned_at: '2026-06-19 00:00:00',
      }),
    });
    const r = cleanupOrphanCardForClosedSession(deps, 'sess-1');
    expect(r.action).toBe('keep');
    expect(orphanRun).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
