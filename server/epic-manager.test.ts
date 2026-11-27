import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, getStmts } from './db.js';
import { getOrCreateBoard } from './routes/board.js';
import {
  EPIC_MANAGER_MAX_UNUSED_OFFERS,
  EPIC_MANAGER_MAX_WORKER_ATTEMPTS,
  EPIC_MANAGER_STALLED_EVENT,
  EpicManager,
  type EpicManagerDeps,
} from './epic-manager.js';
import type { KanbanCardRow, KanbanEpicRow, Project, SessionRow } from './types.js';

const OWNER = 'owner-user';

interface Harness {
  manager: EpicManager;
  projectId: string;
  epic: () => KanbanEpicRow;
  cols: Record<string, string>;
  card: (title: string, column?: string) => KanbanCardRow;
  moveCard: (cardId: string, column: string) => void;
  dispatchChat: ReturnType<typeof vi.fn>;
  busy: Set<string>;
  timers: Array<{ fn: () => void; ms: number; live: boolean }>;
  /** Fire due timers, then let delivery promises settle. */
  runTimers: () => Promise<void>;
  broadcast: ReturnType<typeof vi.fn>;
  cancelAutoStarts: ReturnType<typeof vi.fn>;
  enableAutoStart: ReturnType<typeof vi.fn>;
  requestReevaluation: ReturnType<typeof vi.fn>;
  persistSystemMessage: ReturnType<typeof vi.fn>;
  now: { value: number };
}

function setup(overrides: Partial<EpicManagerDeps> = {}): Harness {
  const stmts = getStmts();
  const db = getDb();
  const projectId = `proj-${uuidv4()}`;
  const { board } = getOrCreateBoard(stmts, projectId);
  // Default boards have only To Do / In Progress / Done; most projects add these.
  for (const [name, position] of [
    ['Review', 2],
    ['Cancelled', 99],
  ] as const) {
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
      uuidv4(),
      board.id,
      name,
      position,
    );
  }
  const columns = stmts.getKanbanColumns.all(board.id) as Array<{ id: string; name: string }>;
  const cols = Object.fromEntries(columns.map((c) => [c.name, c.id]));
  const epicId = uuidv4();
  stmts.createKanbanEpic.run(
    epicId,
    board.id,
    'Checkout rewrite',
    'Rebuild checkout.',
    '#3366ff',
    0,
    null,
  );
  db.prepare('UPDATE kanban_epics SET autonomous = 1 WHERE id = ?').run(epicId);
  const project = {
    id: projectId,
    name: 'Shop',
    agents: [
      { id: 'lead-1', name: 'Lead', role: 'lead', engine: 'claude-code' },
      { id: 'dev-1', name: 'Dev', role: 'dev', engine: 'claude-code' },
    ],
  } as unknown as Project;
  const timers: Harness['timers'] = [];
  const now = { value: 1_000_000 };
  const busy = new Set<string>();
  const dispatchChat = vi.fn(async (msg: Record<string, unknown>) => {
    // Persist like handleChat so "has the manager been briefed" is real.
    stmts.addMessage.run(
      uuidv4(),
      msg.sessionId,
      'user',
      msg.content,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
  });
  const broadcast = vi.fn();
  const cancelAutoStarts = vi.fn();
  const enableAutoStart = vi.fn();
  const requestReevaluation = vi.fn();
  const persistSystemMessage = vi.fn();
  const manager = new EpicManager({
    stmts,
    db,
    findProject: (id) => (id === projectId ? project : undefined),
    getConfig: () => ({}) as never,
    setSessionOwner: (sessionId, owner) =>
      db.prepare('UPDATE sessions SET owner_user_id = ? WHERE id = ?').run(owner, sessionId),
    enableAutoStart,
    cancelAutoStarts,
    dispatchChat,
    isSessionBusy: (id) => busy.has(id),
    persistSystemMessage,
    broadcast,
    requestReevaluation,
    now: () => now.value,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { live: boolean }).live = false;
    },
    ...overrides,
  });
  let position = 0;
  const card = (title: string, column = 'To Do'): KanbanCardRow => {
    const id = uuidv4();
    stmts.createKanbanCard.run(
      id,
      cols[column],
      board.id,
      title,
      `${title} description`,
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      position++,
    );
    db.prepare('UPDATE kanban_cards SET epic_id = ? WHERE id = ?').run(epicId, id);
    return stmts.getKanbanCard.get(id) as KanbanCardRow;
  };
  return {
    manager,
    projectId,
    epic: () => stmts.getKanbanEpic.get(epicId) as KanbanEpicRow,
    cols,
    card,
    moveCard: (cardId, column) =>
      db.prepare('UPDATE kanban_cards SET column_id = ? WHERE id = ?').run(cols[column], cardId),
    dispatchChat,
    busy,
    timers,
    runTimers: async () => {
      for (const timer of timers.splice(0)) if (timer.live) timer.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    broadcast,
    cancelAutoStarts,
    enableAutoStart,
    requestReevaluation,
    persistSystemMessage,
    now,
  };
}

function session(id: string): SessionRow {
  return getStmts().getSession.get(id) as SessionRow;
}

function columnNames(h: Harness): Record<string, string> {
  return Object.fromEntries(Object.entries(h.cols).map(([name, id]) => [id, name]));
}

function epicCards(h: Harness): KanbanCardRow[] {
  return getStmts().getKanbanCardsByEpic.all(h.epic().id) as KanbanCardRow[];
}

/** A briefed manager: kicked off and its first wake already sent. */
async function briefed(h: Harness): Promise<SessionRow> {
  const manager = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
  await h.runTimers();
  h.dispatchChat.mockClear();
  return manager;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('EpicManager kickoff', () => {
  it('creates exactly one Orchestrate manager per epic and reuses it on a second kickoff', async () => {
    const h = setup();
    const first = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
    const second = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;

    expect(second.id).toBe(first.id);
    const row = session(first.id);
    expect(row.session_mode).toBe('orchestrate');
    expect(row.owner_user_id).toBe(OWNER);
    expect(row.agent_id).toBe('lead-1');
    expect(row.name).toBe('Epic: Checkout rewrite');
    expect((row as { linked_epic_id?: string }).linked_epic_id).toBe(h.epic().id);
    expect(h.epic().manager_session_id).toBe(first.id);
    expect(h.manager.epicForManager(first.id)?.id).toBe(h.epic().id);
    expect(h.enableAutoStart).toHaveBeenCalledTimes(1);
  });

  it("exposes the manager's agent on the board's epic list until it is archived", async () => {
    const h = setup();
    const manager = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
    const listed = () =>
      (getStmts().getKanbanEpics.all(h.epic().board_id) as KanbanEpicRow[]).find(
        (e) => e.id === h.epic().id,
      )!;
    expect(listed()).toMatchObject({ manager_session_id: manager.id, manager_agent_id: 'lead-1' });
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?")
      .run(manager.id);
    expect(listed().manager_agent_id).toBeNull();
  });

  it('hands the manager to a different person who kicks the epic off explicitly', async () => {
    const h = setup();
    const manager = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;

    expect(h.manager.handOver(h.epic().id, 'second-user')).toBe(true);
    expect(session(manager.id).owner_user_id).toBe('second-user');
    expect(h.persistSystemMessage).toHaveBeenCalledWith(
      manager.id,
      expect.stringContaining('now runs as them'),
      expect.objectContaining({ previousOwnerUserId: OWNER, ownerUserId: 'second-user' }),
    );
    expect(h.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'session-updated' }));

    // A plain kickoff (boot restore, settings save) reuses it as it is.
    const again = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
    expect(again.id).toBe(manager.id);
    expect(session(manager.id).owner_user_id).toBe('second-user');
    // Same owner: nothing to hand over.
    expect(h.manager.handOver(h.epic().id, 'second-user')).toBe(false);
  });

  it('two stale epic snapshots replacing an archived manager create exactly one', async () => {
    const h = setup();
    const first = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
    getDb().prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?").run(first.id);
    // Overlapping epic and phase ticks each read the epic before either acts.
    const snapshotA = h.epic();
    const snapshotB = h.epic();
    const a = h.manager.ensureManager(h.projectId, snapshotA, OWNER)!;
    const b = h.manager.ensureManager(h.projectId, snapshotB, OWNER)!;

    expect(b.id).toBe(a.id);
    expect(h.epic().manager_session_id).toBe(a.id);
    const live = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE linked_epic_id = ? AND session_mode = 'orchestrate' AND deleted_at IS NULL",
      )
      .get(h.epic().id) as { n: number };
    expect(live.n).toBe(1);
  });

  it('replaces a manager the person archived', async () => {
    const h = setup();
    const first = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
    getDb().prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?").run(first.id);
    const next = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
    expect(next.id).not.toBe(first.id);
    expect(h.epic().manager_session_id).toBe(next.id);
  });

  it('sends the brief once, listing every card in the epic', async () => {
    const h = setup();
    h.card('Payment form');
    h.card('Receipt email', 'Done');
    const manager = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
    await h.runTimers();
    h.manager.kickoff(h.projectId, h.epic(), OWNER);
    await h.runTimers();

    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
    const msg = h.dispatchChat.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.sessionId).toBe(manager.id);
    expect(msg._epicManagerWake).toBe(true);
    expect(msg.content).toContain('# Epic brief: Checkout rewrite');
    expect(msg.content).toContain('Rebuild checkout.');
    expect(msg.content).toContain('[To Do] Payment form');
    expect(msg.content).toContain('[Done] Receipt email');
  });

  it('adopts running workers onto the rail without stopping them (in-flight migration)', async () => {
    const h = setup();
    const stmts = getStmts();
    const mine = h.card('Running mine', 'In Progress');
    const theirs = h.card('Running theirs', 'In Progress');
    const workerA = uuidv4();
    const workerB = uuidv4();
    for (const [id, owner, card] of [
      [workerA, OWNER, mine],
      [workerB, 'someone-else', theirs],
    ] as const) {
      stmts.createSession.run(id, 'dev-1', card.title, 'claude-code', 'm', 1, 0, 1);
      getDb().prepare('UPDATE sessions SET owner_user_id = ? WHERE id = ?').run(owner, id);
      getDb().prepare('UPDATE kanban_cards SET session_id = ? WHERE id = ?').run(id, card.id);
    }

    const manager = h.manager.kickoff(h.projectId, h.epic(), OWNER)!;
    await h.runTimers();

    expect(session(workerA).spawned_from_session_id).toBe(manager.id);
    // Someone else's worker stays in their own list.
    expect(session(workerB).spawned_from_session_id ?? null).toBeNull();
    expect(session(workerA).deleted_at ?? null).toBeNull();
    const brief = (h.dispatchChat.mock.calls[0][0] as { content: string }).content;
    expect(brief).toContain('## Workers already running');
    expect(brief).toContain(mine.id);
  });
});

describe('EpicManager ready offers', () => {
  it('wakes the manager with the ready cards and their card ids', async () => {
    const h = setup();
    const manager = await briefed(h);
    const card = h.card('Payment form');

    h.manager.offerReady({
      projectId: h.projectId,
      epic: h.epic(),
      phase: null,
      ready: [{ card, agentId: 'dev-1', phaseId: null }],
      ownerUserId: OWNER,
    });
    expect(h.dispatchChat).not.toHaveBeenCalled();
    await h.runTimers();

    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
    const msg = h.dispatchChat.mock.calls[0][0] as { sessionId: string; content: string };
    expect(msg.sessionId).toBe(manager.id);
    expect(msg.content).toContain('### Ready to start');
    expect(msg.content).toContain(`\`${card.id}\` Payment form`);
    expect(msg.content).toContain('suggested agent `dev-1`');
    expect(msg.content).not.toContain('# Epic brief');
  });

  it('counts unanswered offers against the cap until they lapse', async () => {
    const h = setup();
    await briefed(h);
    const card = h.card('Payment form');
    h.manager.offerReady({
      projectId: h.projectId,
      epic: h.epic(),
      phase: null,
      ready: [{ card, agentId: 'dev-1', phaseId: null }],
      ownerUserId: OWNER,
    });

    expect(h.manager.isOffered(card.id)).toBe(true);
    expect(h.manager.liveOffers(h.epic().id)).toEqual([card.id]);
    h.now.value += 21 * 60_000;
    expect(h.manager.isOffered(card.id)).toBe(false);
    expect(h.manager.liveOffers(h.epic().id)).toEqual([]);
  });

  it('a started worker clears the offer and counts toward the retry cap', async () => {
    const h = setup();
    await briefed(h);
    const card = h.card('Payment form');
    for (let i = 0; i < EPIC_MANAGER_MAX_WORKER_ATTEMPTS; i++) {
      h.manager.offerReady({
        projectId: h.projectId,
        epic: h.epic(),
        phase: null,
        ready: [{ card, agentId: 'dev-1', phaseId: null }],
        ownerUserId: OWNER,
      });
      h.manager.noteWorkerStarted(card.id, h.epic().id);
      expect(h.manager.isOffered(card.id)).toBe(false);
    }
    expect(h.manager.isAtRetryCap(card.id)).toBe(true);
    expect(h.manager.isHeld(card.id)).toBe(true);
  });

  it('holds a card labelled hold', async () => {
    const h = setup();
    const card = h.card('Payment form');
    getDb().prepare("UPDATE kanban_cards SET labels = 'backend, hold' WHERE id = ?").run(card.id);
    expect(h.manager.isHeld(card.id)).toBe(true);
  });

  it('reports a stall in the thread and to the owner instead of re-offering forever', async () => {
    const h = setup();
    const manager = await briefed(h);
    const card = h.card('Payment form');
    for (let i = 0; i <= EPIC_MANAGER_MAX_UNUSED_OFFERS; i++) {
      h.manager.offerReady({
        projectId: h.projectId,
        epic: h.epic(),
        phase: null,
        ready: [{ card, agentId: 'dev-1', phaseId: null }],
        ownerUserId: OWNER,
      });
      h.now.value += 21 * 60_000;
    }

    expect(h.manager.isHeld(card.id)).toBe(true);
    expect(h.persistSystemMessage).toHaveBeenCalledTimes(1);
    expect(h.persistSystemMessage.mock.calls[0][0]).toBe(manager.id);
    expect(h.persistSystemMessage.mock.calls[0][1]).toContain('needs a person');
    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EPIC_MANAGER_STALLED_EVENT,
        ownerUserId: OWNER,
        cardId: card.id,
      }),
    );
  });

  it('counts workers started for a card that was never offered', async () => {
    const h = setup();
    const card = h.card('Forwarded without an offer');
    for (let i = 0; i < EPIC_MANAGER_MAX_WORKER_ATTEMPTS; i++) {
      h.manager.noteWorkerStarted(card.id, h.epic().id);
    }
    expect(h.manager.isAtRetryCap(card.id)).toBe(true);
    expect(h.manager.isHeld(card.id)).toBe(true);
  });

  it('a requeue after a failed worker keeps the retry cap', async () => {
    const h = setup();
    await briefed(h);
    const card = h.card('Payment form', 'In Progress');
    for (let i = 0; i < EPIC_MANAGER_MAX_WORKER_ATTEMPTS; i++) {
      h.manager.offerReady({
        projectId: h.projectId,
        epic: h.epic(),
        phase: null,
        ready: [{ card, agentId: 'dev-1', phaseId: null }],
        ownerUserId: OWNER,
      });
      h.manager.noteWorkerStarted(card.id, h.epic().id);
    }
    h.manager.observeCards(h.epic(), epicCards(h), columnNames(h));
    h.moveCard(card.id, 'To Do');
    h.manager.observeCards(h.epic(), epicCards(h), columnNames(h));
    expect(h.manager.isAtRetryCap(card.id)).toBe(true);
  });

  it('moving a card after its stall was reported hands it back with fresh attempts', async () => {
    const h = setup();
    await briefed(h);
    const card = h.card('Payment form');
    for (let i = 0; i < EPIC_MANAGER_MAX_WORKER_ATTEMPTS; i++) {
      h.manager.offerReady({
        projectId: h.projectId,
        epic: h.epic(),
        phase: null,
        ready: [{ card, agentId: 'dev-1', phaseId: null }],
        ownerUserId: OWNER,
      });
      h.manager.noteWorkerStarted(card.id, h.epic().id);
    }
    h.manager.observeCards(h.epic(), epicCards(h), columnNames(h));
    h.manager.noteRetryCapRefusal(h.epic().id, card.id);
    expect(h.manager.isHeld(card.id)).toBe(true);

    h.moveCard(card.id, 'In Progress');
    h.manager.observeCards(h.epic(), epicCards(h), columnNames(h));

    expect(h.manager.isAtRetryCap(card.id)).toBe(false);
    expect(h.manager.isHeld(card.id)).toBe(false);
  });

  function capAndStall(h: Harness): KanbanCardRow {
    const card = h.card('Payment form');
    for (let i = 0; i < EPIC_MANAGER_MAX_WORKER_ATTEMPTS; i++) {
      h.manager.noteWorkerStarted(card.id, h.epic().id);
    }
    h.manager.noteRetryCapRefusal(h.epic().id, card.id);
    expect(h.manager.isHeld(card.id)).toBe(true);
    return card;
  }

  it('moving a held card out of To Do and back releases it even with no tick in between', async () => {
    const h = setup();
    await briefed(h);
    const card = capAndStall(h);
    // Both moves land before any observation (re-evaluation is debounced).
    h.moveCard(card.id, 'In Progress');
    h.moveCard(card.id, 'To Do');

    expect(h.manager.isHeld(card.id)).toBe(false);
    expect(h.manager.isAtRetryCap(card.id)).toBe(false);
  });

  it('editing a held card releases it', async () => {
    const h = setup();
    await briefed(h);
    const card = capAndStall(h);
    getDb().prepare("UPDATE kanban_cards SET description = 'Re-scoped' WHERE id = ?").run(card.id);
    expect(h.manager.isHeld(card.id)).toBe(false);
  });

  it('a server rewrite with unchanged values does not release a held card', async () => {
    const h = setup();
    await briefed(h);
    const card = capAndStall(h);
    const c = getStmts().getKanbanCard.get(card.id) as KanbanCardRow;
    getStmts().updateKanbanCard.run(
      c.title,
      c.description,
      c.priority,
      c.assignee,
      c.labels,
      c.session_id,
      c.github_issue_url,
      c.pr_url,
      c.epic_id,
      c.phase_id ?? null,
      c.assign_model,
      c.assign_engine ?? null,
      c.pr_base_branch ?? null,
      c.id,
    );
    expect(h.manager.isHeld(card.id)).toBe(true);
    expect(h.manager.isAtRetryCap(card.id)).toBe(true);
  });

  it('a stall whose notice failed to post is reported again', async () => {
    const h = setup();
    await briefed(h);
    const card = h.card('Payment form');
    h.persistSystemMessage.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    h.manager.noteRetryCapRefusal(h.epic().id, card.id);
    h.manager.noteRetryCapRefusal(h.epic().id, card.id);
    expect(h.persistSystemMessage).toHaveBeenCalledTimes(2);
  });

  it('withdrawn offers (pause, hold) are not counted as the manager ignoring a card', async () => {
    const h = setup();
    await briefed(h);
    const card = h.card('Payment form');
    const offer = () =>
      h.manager.offerReady({
        projectId: h.projectId,
        epic: h.epic(),
        phase: null,
        ready: [{ card, agentId: 'dev-1', phaseId: null }],
        ownerUserId: OWNER,
      });
    // Run, then pause before Auto start fires, several times over.
    for (let i = 0; i < EPIC_MANAGER_MAX_UNUSED_OFFERS + 2; i++) {
      offer();
      h.manager.pause(h.epic().id);
      h.now.value += 21 * 60_000;
    }
    // Held and released the same way.
    for (let i = 0; i < EPIC_MANAGER_MAX_UNUSED_OFFERS + 2; i++) {
      offer();
      h.manager.withdrawOffer(card.id);
    }

    // A normal run offers the card as usual: no stall, no notice.
    offer();
    expect(h.manager.isOffered(card.id)).toBe(true);
    expect(h.manager.isHeld(card.id)).toBe(false);
    expect(h.persistSystemMessage).not.toHaveBeenCalled();
  });

  it('a retry-cap refusal notifies once', async () => {
    const h = setup();
    const manager = await briefed(h);
    const card = h.card('Payment form');
    h.manager.noteRetryCapRefusal(h.epic().id, card.id);
    h.manager.noteRetryCapRefusal(h.epic().id, card.id);
    expect(h.persistSystemMessage).toHaveBeenCalledTimes(1);
    expect(h.persistSystemMessage.mock.calls[0][0]).toBe(manager.id);
  });
});

describe('EpicManager worker events', () => {
  function worker(h: Harness, manager: SessionRow, column = 'In Progress') {
    const card = h.card('Payment form', column);
    const id = uuidv4();
    getStmts().createSession.run(id, 'dev-1', card.title, 'claude-code', 'm', 1, 0, 1);
    getDb()
      .prepare('UPDATE sessions SET spawned_from_session_id = ? WHERE id = ?')
      .run(manager.id, id);
    getDb().prepare('UPDATE kanban_cards SET session_id = ? WHERE id = ?').run(id, card.id);
    return { card, sessionId: id };
  }

  it('batches several events into one wake', async () => {
    const h = setup();
    const manager = await briefed(h);
    const a = worker(h, manager);
    const b = worker(h, manager);

    h.manager.noteBroadcast({ type: 'awaiting_input', sessionId: a.sessionId });
    h.manager.noteBroadcast({
      type: 'finalize_run_completed',
      session_id: b.sessionId,
      status: 'failed',
      failure_reason: 'fix_no_progress',
    });
    h.manager.noteBroadcast({ type: 'error', sessionId: a.sessionId, error: 'CLI exited 1' });
    expect(h.dispatchChat).not.toHaveBeenCalled();
    expect(h.timers.filter((t) => t.live)).toHaveLength(1);
    expect(h.timers[0].ms).toBe(60_000);
    await h.runTimers();

    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
    const content = (h.dispatchChat.mock.calls[0][0] as { content: string }).content;
    expect(content).toContain(`Finalize failed: \`${b.card.id}\``);
    expect(content).toContain('fix_no_progress');
    expect(content).toContain(`error: \`${a.card.id}\``);
    expect(content).toContain('CLI exited 1');
    // The turn end hides behind the sharper error for the same worker.
    expect(content).not.toContain('turn finished');
  });

  it('reports a finished worker turn and a worker waiting on input', async () => {
    const h = setup();
    const manager = await briefed(h);
    const a = worker(h, manager);
    const b = worker(h, manager);
    h.manager.noteBroadcast({ type: 'awaiting_input', sessionId: a.sessionId });
    h.manager.noteBroadcast({
      type: 'session_needs_input',
      sessionId: b.sessionId,
      needsInput: 'ask',
    });
    await h.runTimers();
    const content = (h.dispatchChat.mock.calls[0][0] as { content: string }).content;
    expect(content).toContain(`turn finished: \`${a.card.id}\``);
    expect(content).toContain(`waiting on input: \`${b.card.id}\``);
  });

  it('queues the wake while the manager turn runs and sends it when the turn ends', async () => {
    const h = setup();
    const manager = await briefed(h);
    const a = worker(h, manager);
    h.busy.add(manager.id);
    h.manager.noteBroadcast({ type: 'awaiting_input', sessionId: a.sessionId });
    await h.runTimers();
    expect(h.dispatchChat).not.toHaveBeenCalled();

    h.busy.delete(manager.id);
    h.manager.noteBroadcast({ type: 'awaiting_input', sessionId: manager.id });
    await h.runTimers();
    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
    expect((h.dispatchChat.mock.calls[0][0] as { sessionId: string }).sessionId).toBe(manager.id);
  });

  it('turns Done and Cancelled moves into events, but not the first look', async () => {
    const h = setup();
    await briefed(h);
    const shipped = h.card('Shipped', 'Review');
    const dropped = h.card('Dropped', 'To Do');
    h.manager.observeCards(h.epic(), epicCards(h), columnNames(h));
    expect(h.timers.filter((t) => t.live)).toHaveLength(0);

    h.moveCard(shipped.id, 'Done');
    h.moveCard(dropped.id, 'Cancelled');
    h.manager.observeCards(h.epic(), epicCards(h), columnNames(h));
    await h.runTimers();

    const content = (h.dispatchChat.mock.calls[0][0] as { content: string }).content;
    expect(content).toContain(`Done: \`${shipped.id}\``);
    expect(content).toContain(`Cancelled: \`${dropped.id}\``);
  });

  it('asks for a readiness re-check on board changes', async () => {
    const h = setup();
    h.manager.noteBroadcast({ type: 'kanban_update', projectId: h.projectId });
    expect(h.requestReevaluation).toHaveBeenCalledWith(h.projectId);
  });

  it('ignores sessions that are not linked to a managed epic', async () => {
    const h = setup();
    await briefed(h);
    h.manager.noteBroadcast({ type: 'awaiting_input', sessionId: 'random-session' });
    expect(h.timers.filter((t) => t.live)).toHaveLength(0);
  });
});

describe('EpicManager pause', () => {
  it('cancels pending auto starts and drops queued wakes', async () => {
    const h = setup();
    const manager = await briefed(h);
    const card = h.card('Payment form');
    h.manager.offerReady({
      projectId: h.projectId,
      epic: h.epic(),
      phase: null,
      ready: [{ card, agentId: 'dev-1', phaseId: null }],
      ownerUserId: OWNER,
    });
    getDb().prepare('UPDATE kanban_epics SET autonomous = 0 WHERE id = ?').run(h.epic().id);
    h.manager.pause(h.epic().id);
    await h.runTimers();

    expect(h.cancelAutoStarts).toHaveBeenCalledWith(manager.id);
    expect(h.dispatchChat).not.toHaveBeenCalled();
    expect(h.manager.isOffered(card.id)).toBe(false);
  });

  it('still delivers the completion notice', async () => {
    const h = setup();
    await briefed(h);
    h.manager.noteWorkerEvent(h.epic().id, { kind: 'epic_complete', detail: 'all done' });
    getDb().prepare('UPDATE kanban_epics SET autonomous = 0 WHERE id = ?').run(h.epic().id);
    h.manager.pause(h.epic().id);
    await h.runTimers();
    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
    expect((h.dispatchChat.mock.calls[0][0] as { content: string }).content).toContain(
      'epic complete',
    );
  });
});

describe('EpicManager wake delivery', () => {
  function workerFor(h: Harness, manager: SessionRow) {
    const card = h.card('Payment form', 'In Progress');
    const id = uuidv4();
    getStmts().createSession.run(id, 'dev-1', card.title, 'claude-code', 'm', 1, 0, 1);
    getDb()
      .prepare('UPDATE sessions SET spawned_from_session_id = ? WHERE id = ?')
      .run(manager.id, id);
    getDb().prepare('UPDATE kanban_cards SET session_id = ? WHERE id = ?').run(id, card.id);
    return { card, sessionId: id };
  }

  it('keeps the batch when delivery fails once and delivers it on the retry', async () => {
    const h = setup();
    const manager = await briefed(h);
    const w = workerFor(h, manager);
    const ready = h.card('Ready card');
    h.manager.offerReady({
      projectId: h.projectId,
      epic: h.epic(),
      phase: null,
      ready: [{ card: ready, agentId: 'dev-1', phaseId: null }],
      ownerUserId: OWNER,
    });
    h.manager.noteBroadcast({
      type: 'finalize_run_completed',
      session_id: w.sessionId,
      status: 'failed',
      failure_reason: 'fix_no_progress',
    });
    h.dispatchChat.mockRejectedValueOnce(new Error('CLI spawn failed'));

    await h.runTimers();
    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
    // A retry is armed with backoff; nothing was lost.
    const retry = h.timers.filter((t) => t.live);
    expect(retry).toHaveLength(1);
    expect(retry[0].ms).toBe(30_000);

    // An event that arrives while the retry waits joins the next wake.
    h.manager.noteBroadcast({ type: 'error', sessionId: w.sessionId, error: 'late error' });
    await h.runTimers();

    expect(h.dispatchChat).toHaveBeenCalledTimes(2);
    const content = (h.dispatchChat.mock.calls[1][0] as { content: string }).content;
    expect(content).toContain('fix_no_progress');
    expect(content).toContain(`\`${ready.id}\` Ready card`);
    expect(content).toContain('late error');
    // Delivered rows are gone; nothing is sent twice.
    await h.runTimers();
    expect(h.dispatchChat).toHaveBeenCalledTimes(2);
  });

  it('items queued while a wake is out go in the next wake, not lost or duplicated', async () => {
    const h = setup();
    const manager = await briefed(h);
    const w = workerFor(h, manager);
    let finish: () => void = () => {};
    h.dispatchChat.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    h.manager.noteBroadcast({ type: 'error', sessionId: w.sessionId, error: 'first' });
    await h.runTimers();
    expect(h.dispatchChat).toHaveBeenCalledTimes(1);

    h.manager.noteBroadcast({ type: 'error', sessionId: w.sessionId, error: 'second' });
    await h.runTimers(); // in flight: holds
    expect(h.dispatchChat).toHaveBeenCalledTimes(1);

    finish();
    await h.runTimers();
    await h.runTimers();
    expect(h.dispatchChat).toHaveBeenCalledTimes(2);
    const second = (h.dispatchChat.mock.calls[1][0] as { content: string }).content;
    expect(second).toContain('second');
    expect(second).not.toContain('first');
  });

  it('a restart delivers wakes that were queued but never sent', async () => {
    const h = setup();
    const manager = await briefed(h);
    const w = workerFor(h, manager);
    h.manager.noteBroadcast({ type: 'error', sessionId: w.sessionId, error: 'before restart' });
    // The process dies before the debounce fires.
    h.manager.stopAll();

    const dispatchChat = vi.fn(async () => {});
    const timers: Array<() => void> = [];
    const after = new EpicManager({
      stmts: getStmts(),
      db: getDb(),
      findProject: () => undefined,
      getConfig: () => ({}) as never,
      setSessionOwner: () => {},
      enableAutoStart: () => {},
      cancelAutoStarts: () => {},
      dispatchChat,
      isSessionBusy: () => false,
      persistSystemMessage: () => {},
      broadcast: () => {},
      setTimer: (fn) => {
        timers.push(fn);
        return fn;
      },
      clearTimer: () => {},
    });
    after.resume();
    for (const fn of timers.splice(0)) fn();
    await Promise.resolve();

    // The file shares one database, so other epics' leftovers resume too.
    const mine = dispatchChat.mock.calls.filter(
      (call) => ((call as unknown[])[0] as { sessionId: string }).sessionId === manager.id,
    );
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0])).toContain('before restart');
  });
});

describe('EpicManager card diff across restarts', () => {
  it('a card that reached Done while the server was down is reported after restart', async () => {
    const h = setup();
    await briefed(h);
    const card = h.card('Shipped while down', 'Review');
    h.manager.observeCards(h.epic(), epicCards(h), columnNames(h));
    h.manager.stopAll();

    h.moveCard(card.id, 'Done');
    // A fresh manager instance, as after a restart, on the same database.
    const dispatchChat = vi.fn(async () => {});
    const timers: Array<() => void> = [];
    const after = new EpicManager({
      stmts: getStmts(),
      db: getDb(),
      findProject: () => undefined,
      getConfig: () => ({}) as never,
      setSessionOwner: () => {},
      enableAutoStart: () => {},
      cancelAutoStarts: () => {},
      dispatchChat,
      isSessionBusy: () => false,
      persistSystemMessage: () => {},
      broadcast: () => {},
      setTimer: (fn) => {
        timers.push(fn);
        return fn;
      },
      clearTimer: () => {},
    });
    after.observeCards(h.epic(), epicCards(h), columnNames(h));
    for (const fn of timers.splice(0)) fn();
    await Promise.resolve();

    const contents = dispatchChat.mock.calls.map(
      (call) => ((call as unknown[])[0] as { content: string }).content,
    );
    expect(contents.some((c) => c.includes(`Done: \`${card.id}\``))).toBe(true);
  });
});

describe('EpicManager phase completions', () => {
  it('keeps every phase completion queued during a busy manager turn', async () => {
    const h = setup();
    const manager = await briefed(h);
    h.busy.add(manager.id);
    // A cascade through already-complete phases while the manager works.
    for (const [id, name] of [
      ['phase-a', 'Data model'],
      ['phase-b', 'API'],
      ['phase-c', 'UI'],
    ]) {
      h.manager.noteWorkerEvent(h.epic().id, {
        kind: 'phase_complete',
        phaseId: id,
        detail: `phase "${name}" is complete`,
      });
    }
    await h.runTimers();
    expect(h.dispatchChat).not.toHaveBeenCalled();

    h.busy.delete(manager.id);
    h.manager.noteBroadcast({ type: 'awaiting_input', sessionId: manager.id });
    await h.runTimers();

    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
    const content = (h.dispatchChat.mock.calls[0][0] as { content: string }).content;
    for (const id of ['phase-a', 'phase-b', 'phase-c']) {
      expect(content).toContain(`phase complete: phase \`${id}\``);
    }
    expect(content).toContain('phase "Data model" is complete');
    expect(content).toContain('phase "UI" is complete');
  });
});
