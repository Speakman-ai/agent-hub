/**
 * Epic manager threads.
 *
 * An epic is managed by one Orchestrate session a person started and linked
 * (`kanban_epics.manager_session_id`). The server never creates it: an epic
 * with no live manager gets no ready cards offered. The autonomous tick still decides which cards are
 * ready (phase order, blockers, routing, open spec decisions). Instead of
 * spawning workers itself, it hands the ready set to the manager, which writes
 * each worker's brief and starts it from an `agenthub:forward` card carrying
 * the card id. Orchestrate Auto start launches those cards; the dispatch path
 * routes them back to `spawnEpicWorkerForCard`, which claims the card and
 * links the worker to it and to the manager's rail.
 *
 * Worker outcomes (merged / Done, Finalize failures, errors, needs input,
 * finished turns) wake the manager too. Wakes are batched per epic and never
 * sent while the manager's own turn is running; they wait for it to end.
 */
import type { Database } from 'better-sqlite3';
import type {
  BroadcastFn,
  KanbanCardRow,
  KanbanColumnRow,
  KanbanEpicRow,
  KanbanPhaseRow,
  MessageRow,
  SessionRow,
  Stmts,
} from './types.js';
import type {
  EpicManagerPort,
  EpicWorkerEvent,
  EpicWorkerEventKind,
  ReadyCardOffer,
} from './autonomous.js';
import { isOrchestrateModeActive } from './session-mode.js';
import { listEpicWorkers } from './epic-session-close.js';
import {
  EPIC_MANAGER_HOLD_LABEL,
  EPIC_MANAGER_STALLED_EVENT,
  hasHoldLabel,
} from './epic-manager-events.js';
import { SESSION_NEEDS_INPUT_EVENT } from './session-needs-input.js';
import { formatEpicSpecDecisionsForContext, loadChosenSpecItemsForEpic } from './epic-spec.js';
import { isColumnCancelled, isColumnDone } from './kanban-blockers.js';
import { formatHubChatRefToken } from '../shared/utils/hubChatRefTokens.js';

/** Events collected for this long before one wake message goes out. */
export const EPIC_MANAGER_WAKE_DEBOUNCE_MS = 60_000;
/** Kickoff waits this long so the first tick's ready cards join the brief. */
export const EPIC_MANAGER_KICKOFF_DELAY_MS = 3_000;
/** An offer the manager has not acted on lapses after this and is re-offered. */
export const EPIC_MANAGER_OFFER_TTL_MS = 20 * 60_000;
/** Workers the manager may start for one card before it needs a human. */
export const EPIC_MANAGER_MAX_WORKER_ATTEMPTS = 3;
/** Offers that lapse unused this many times mean the manager is stuck on the card. */
export const EPIC_MANAGER_MAX_UNUSED_OFFERS = 3;

export { EPIC_MANAGER_HOLD_LABEL, EPIC_MANAGER_STALLED_EVENT };

const FINALIZE_FAILED_STATUSES = new Set(['failed', 'timed_out', 'infra_error']);
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_DETAIL_CHARS = 300;

export interface EpicManagerDeps {
  stmts: Stmts;
  db: Database;
  setSessionOwner: (sessionId: string, ownerUserId: string) => void;
  /** Cancel the manager's running Auto start countdowns (pause). */
  cancelAutoStarts: (sessionId: string) => void;
  dispatchChat: (msg: Record<string, unknown>) => Promise<void> | void;
  isSessionBusy: (sessionId: string) => boolean;
  persistSystemMessage: (sessionId: string, content: string, meta: Record<string, unknown>) => void;
  broadcast: BroadcastFn;
  /** Re-run readiness for a project (after a board change the manager made). */
  requestReevaluation?: (projectId: string) => void;
  /** Present the session to clients (sidebar row). */
  enrichSession?: (row: SessionRow) => unknown;
  debounceMs?: number;
  kickoffDelayMs?: number;
  offerTtlMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface OfferRow {
  card_id: string;
  epic_id: string;
  agent_id: string | null;
  offered_at: number | null;
  offer_count: number;
  attempts: number;
  stalled_at: number | null;
}

/** One queued item in the manager's outbox (`epic_manager_wake_queue`). */
interface WakeRow {
  id: number;
  epic_id: string;
  kind: EpicWorkerEventKind | 'ready' | 'kickoff';
  card_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  phase_id: string | null;
  detail: string | null;
}

/** Delivery state per epic. The queued items themselves live in the database. */
interface WakeTimer {
  timer: unknown;
  /** The debounce fired while the manager was busy; send when its turn ends. */
  waitingForTurn: boolean;
  /** A wake is being delivered; its rows are deleted only once it lands. */
  inFlight: boolean;
  /** Consecutive failed deliveries, for the bounded retry. */
  failures: number;
}

/** Retries after a failed wake delivery: 30s doubling to 10 minutes, then wait for news. */
export const EPIC_MANAGER_WAKE_MAX_RETRIES = 5;
const WAKE_RETRY_BASE_MS = 30_000;
const WAKE_RETRY_MAX_MS = 10 * 60_000;
const COMPLETION_KINDS = new Set(['epic_complete', 'phase_complete']);

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Whether an epic is running: the epic itself, or any of its phases. */
function epicIsRunning(stmts: Stmts, epic: KanbanEpicRow): boolean {
  if (epic.autonomous) return true;
  const phases = (stmts.getKanbanPhasesByEpic?.all(epic.id) as KanbanPhaseRow[] | undefined) ?? [];
  return phases.some((p) => p.autonomous_running);
}

const EVENT_LABEL: Record<EpicWorkerEventKind, string> = {
  done: 'Done',
  cancelled: 'Cancelled',
  requeued: 'back in To Do',
  turn_finished: 'turn finished',
  needs_input: 'waiting on input',
  finalize_failed: 'Finalize failed',
  error: 'error',
  phase_complete: 'phase complete',
  epic_complete: 'epic complete',
};

// Lower sorts first in the wake message; also decides which of a worker's
// events survives when one turn produced several.
const EVENT_RANK: Record<EpicWorkerEventKind, number> = {
  epic_complete: 0,
  phase_complete: 1,
  finalize_failed: 2,
  error: 3,
  needs_input: 4,
  done: 5,
  cancelled: 6,
  requeued: 7,
  turn_finished: 8,
};

export class EpicManager implements EpicManagerPort {
  private readonly wakes = new Map<string, WakeTimer>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly debounceMs: number;
  private readonly kickoffDelayMs: number;
  private readonly offerTtlMs: number;

  constructor(private readonly deps: EpicManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.debounceMs = deps.debounceMs ?? EPIC_MANAGER_WAKE_DEBOUNCE_MS;
    this.kickoffDelayMs = deps.kickoffDelayMs ?? EPIC_MANAGER_KICKOFF_DELAY_MS;
    this.offerTtlMs = deps.offerTtlMs ?? EPIC_MANAGER_OFFER_TTL_MS;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  // Offers

  private offer(cardId: string): OfferRow | undefined {
    return this.deps.db
      .prepare('SELECT * FROM epic_manager_offers WHERE card_id = ?')
      .get(cardId) as OfferRow | undefined;
  }

  private offerIsLive(row: OfferRow | undefined): boolean {
    return !!row && row.offered_at !== null && this.now() - row.offered_at < this.offerTtlMs;
  }

  isOffered(cardId: string): boolean {
    return this.offerIsLive(this.offer(cardId));
  }

  isAtRetryCap(cardId: string): boolean {
    return (this.offer(cardId)?.attempts ?? 0) >= EPIC_MANAGER_MAX_WORKER_ATTEMPTS;
  }

  isHeld(cardId: string): boolean {
    const row = this.offer(cardId);
    if (row?.stalled_at != null) return true;
    if ((row?.attempts ?? 0) >= EPIC_MANAGER_MAX_WORKER_ATTEMPTS) return true;
    const card = this.deps.stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
    return hasHoldLabel(card?.labels);
  }

  /**
   * Cards with an unexpired offer. The tick re-checks each against the same
   * readiness rules a worker start uses before letting it hold a slot.
   */
  liveOffers(epicId: string): string[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM epic_manager_offers WHERE epic_id = ? AND offered_at IS NOT NULL')
      .all(epicId) as OfferRow[];
    return rows.filter((row) => this.offerIsLive(row)).map((row) => row.card_id);
  }

  /**
   * A worker started for the card. Upserts, so a card the manager forwarded
   * without a live offer still counts toward the retry cap.
   */
  noteWorkerStarted(cardId: string, epicId: string): void {
    this.deps.db
      .prepare(
        `INSERT INTO epic_manager_offers (card_id, epic_id, offered_at, offer_count, attempts)
         VALUES (?, ?, NULL, 0, 1)
         ON CONFLICT(card_id) DO UPDATE SET
           epic_id = excluded.epic_id,
           offered_at = NULL,
           offer_count = 0,
           attempts = epic_manager_offers.attempts + 1`,
      )
      .run(cardId, epicId);
  }

  withdrawOffer(cardId: string): void {
    this.deps.db
      .prepare('UPDATE epic_manager_offers SET offered_at = NULL WHERE card_id = ?')
      .run(cardId);
  }

  // Manager session

  /** The epic's live manager session, if it has one. */
  managerFor(epic: Pick<KanbanEpicRow, 'manager_session_id'>): SessionRow | null {
    const id = epic.manager_session_id;
    if (!id) return null;
    const session = this.deps.stmts.getSession.get(id) as SessionRow | undefined;
    if (!session || session.deleted_at || !isOrchestrateModeActive(session)) return null;
    return session;
  }

  /** The epic a manager session runs, if it is one. */
  epicForManager(sessionId: string): KanbanEpicRow | null {
    return (
      (this.deps.stmts.getEpicByManagerSession.get(sessionId) as KanbanEpicRow | undefined) ?? null
    );
  }

  /**
   * The epic's manager, read fresh: the caller's epic row can be stale
   * (overlapping epic and phase ticks hold their own copies). Nothing here
   * creates a session; a person starts the manager.
   */
  private currentManager(epicId: string): SessionRow | null {
    const current = this.deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
    return current ? this.managerFor(current) : null;
  }

  hasLiveManager(epicId: string): boolean {
    return this.currentManager(epicId) !== null;
  }

  /** Live sessions linked to the epic's In Progress / Review cards. */
  private runningWorkers(epic: KanbanEpicRow): SessionRow[] {
    return listEpicWorkers(this.deps.stmts, epic).map((w) => w.session);
  }

  // Kickoff, offers, events

  /**
   * A different person explicitly kicked the epic (or one of its phases) off:
   * the manager becomes theirs, so its forwards start workers under their
   * credentials and they can open it. Workers already running keep their
   * owner. Only explicit kickoffs call this; boot restores and settings saves
   * reuse the manager as it is.
   */
  handOver(epicId: string, ownerUserId: string): boolean {
    const epic = this.deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
    const manager = epic ? this.managerFor(epic) : null;
    if (!epic || !manager) return false;
    const previous = manager.owner_user_id ?? null;
    if (previous === ownerUserId) return false;
    this.deps.setSessionOwner(manager.id, ownerUserId);
    try {
      this.deps.persistSystemMessage(
        manager.id,
        'This epic was kicked off again by another person, so this manager now runs as them. New workers start under their account; workers already running keep theirs.',
        { kind: 'epic_manager_handover', epicId, previousOwnerUserId: previous, ownerUserId },
      );
    } catch (err) {
      console.error('[epic-manager] handover notice failed:', (err as Error).message);
    }
    const row = this.deps.stmts.getSession.get(manager.id) as SessionRow | undefined;
    if (row) {
      this.deps.broadcast({
        type: 'session-updated',
        session: this.deps.enrichSession ? this.deps.enrichSession(row) : row,
      });
    }
    return true;
  }

  /**
   * Kicking off targets the epic's live manager; one that has not been
   * briefed yet gets its brief. Without a live manager this does nothing.
   */
  kickoff(_projectId: string, epic: KanbanEpicRow, _ownerUserId: string): SessionRow | null {
    const manager = this.currentManager(epic.id);
    if (!manager) return null;
    if (!this.hasMessages(manager.id) && !this.queued(epic.id).some((r) => r.kind === 'kickoff')) {
      this.enqueue(epic.id, { kind: 'kickoff' });
      this.schedule(epic.id, this.kickoffDelayMs);
    }
    return manager;
  }

  offerReady(args: {
    projectId: string;
    epic: KanbanEpicRow;
    phase: KanbanPhaseRow | null;
    ready: ReadyCardOffer[];
    ownerUserId: string;
  }): void {
    const { epic, ready } = args;
    const manager = this.currentManager(epic.id);
    if (!manager) return;
    let queuedAny = false;
    // offer_count counts offers that lapsed unanswered, the only sign the
    // manager is stuck on a card. An offer that was withdrawn (pause, hold,
    // the card moving) has offered_at cleared and does not count.
    const upsert = this.deps.db.prepare(
      `INSERT INTO epic_manager_offers (card_id, epic_id, agent_id, offered_at, offer_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET
         epic_id = excluded.epic_id,
         agent_id = excluded.agent_id,
         offered_at = excluded.offered_at,
         offer_count = excluded.offer_count`,
    );
    for (const offer of ready) {
      const prior = this.offer(offer.card.id);
      const lapsed = prior?.offered_at != null && !this.offerIsLive(prior);
      const unused = (prior?.offer_count ?? 0) + (lapsed ? 1 : 0);
      if (unused >= EPIC_MANAGER_MAX_UNUSED_OFFERS) {
        this.reportStall(
          epic,
          manager,
          offer.card,
          'it was offered several times and never started',
        );
        continue;
      }
      upsert.run(offer.card.id, epic.id, offer.agentId, this.now(), unused);
      this.enqueue(epic.id, {
        kind: 'ready',
        cardId: offer.card.id,
        agentId: offer.agentId,
        phaseId: offer.phaseId,
      });
      queuedAny = true;
    }
    if (!queuedAny) return;
    // The first wake carries the brief; nobody should wait a minute for it.
    if (!this.hasMessages(manager.id)) {
      this.schedule(epic.id, 0);
    } else {
      this.schedule(epic.id, this.debounceMs);
    }
  }

  noteWorkerEvent(epicId: string, event: EpicWorkerEvent): void {
    const epic = this.deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
    if (!epic || !this.managerFor(epic)) return;
    this.enqueue(epicId, {
      kind: event.kind,
      cardId: event.cardId ?? null,
      sessionId: event.sessionId ?? null,
      phaseId: event.phaseId ?? null,
      detail: event.detail ? clip(event.detail, MAX_DETAIL_CHARS) : null,
    });
    const completion = event.kind === 'epic_complete' || event.kind === 'phase_complete';
    this.schedule(epicId, completion ? 0 : this.debounceMs);
  }

  observeCards(
    epic: KanbanEpicRow,
    cards: KanbanCardRow[],
    columnNameById: Record<string, string>,
  ): void {
    // The last look is persisted, so moves made while the server was down
    // still reach the manager after a restart.
    const seen = this.deps.db
      .prepare('SELECT card_id, column_name FROM epic_manager_card_columns WHERE epic_id = ?')
      .all(epic.id) as Array<{ card_id: string; column_name: string }>;
    const previous = new Map(seen.map((r) => [r.card_id, r.column_name]));
    const record = this.deps.db.prepare(
      `INSERT INTO epic_manager_card_columns (card_id, epic_id, column_name) VALUES (?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET epic_id = excluded.epic_id, column_name = excluded.column_name`,
    );
    for (const card of cards) {
      const column = columnNameById[card.column_id] ?? '';
      const before = previous.get(card.id);
      if (before !== column) record.run(card.id, epic.id, column);
      // A card seen for the first time only records; there is nothing to compare.
      if (before === undefined || before === column) continue;
      // Stall release is not decided here: a person's change releases a held
      // card in the write itself (trg_epic_manager_release_stall).
      if (column.trim().toLowerCase() !== 'to do') this.withdrawOffer(card.id);
      if (isColumnDone(column) && !isColumnDone(before)) {
        this.noteWorkerEvent(epic.id, { kind: 'done', cardId: card.id });
      } else if (isColumnCancelled(column) && !isColumnCancelled(before)) {
        this.noteWorkerEvent(epic.id, { kind: 'cancelled', cardId: card.id });
      } else if (column.trim().toLowerCase() === 'to do') {
        this.noteWorkerEvent(epic.id, { kind: 'requeued', cardId: card.id });
      }
    }
  }

  /**
   * The epic stopped (paused, or the last running phase stopped). No more
   * wakes for work events, offers lapse, and the manager's pending Auto start
   * countdowns are cancelled so a paused epic starts nothing. A completion
   * notice still goes out.
   */
  pause(epicId: string): void {
    const epic = this.deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
    const manager = epic ? this.managerFor(epic) : null;
    if (manager) this.deps.cancelAutoStarts(manager.id);
    this.deps.db
      .prepare('UPDATE epic_manager_offers SET offered_at = NULL WHERE epic_id = ?')
      .run(epicId);
    // Only a completion notice outlives a pause.
    this.deps.db
      .prepare(
        `DELETE FROM epic_manager_wake_queue
          WHERE epic_id = ? AND kind NOT IN ('epic_complete', 'phase_complete')`,
      )
      .run(epicId);
    if (this.queued(epicId).length === 0) {
      this.clearWakeTimer(epicId);
      return;
    }
    this.schedule(epicId, 0);
  }

  /** A start refused for a card at the retry cap: tell the thread and the owner once. */
  noteRetryCapRefusal(epicId: string, cardId: string): void {
    const epic = this.deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
    const manager = epic ? this.managerFor(epic) : null;
    const card = this.deps.stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
    if (!epic || !manager || !card) return;
    this.reportStall(
      epic,
      manager,
      card,
      `${EPIC_MANAGER_MAX_WORKER_ATTEMPTS} workers have already tried it`,
    );
  }

  /**
   * The manager cannot move a card forward on its own. Say so in its thread
   * and notify the epic owner, once per card until the card moves.
   */
  private reportStall(
    epic: KanbanEpicRow,
    manager: SessionRow,
    card: KanbanCardRow,
    why: string,
  ): void {
    const row = this.offer(card.id);
    if (row?.stalled_at != null) return;
    const content =
      `**Epic manager needs a person.** Card \`${card.id}\` "${card.title}" is held: ${why}. ` +
      'Decide what to do with it, then move or edit the card (its column, phase, labels, title, description or priority) to hand it back. That resets its worker attempts.';
    try {
      this.deps.persistSystemMessage(manager.id, content, {
        kind: 'epic_manager_stalled',
        epicId: epic.id,
        cardId: card.id,
      });
    } catch (err) {
      // Not marked stalled, so the next tick reports it again.
      console.error('[epic-manager] stall notice failed:', (err as Error).message);
      return;
    }
    // Marked only once the thread has the notice.
    this.deps.db
      .prepare(
        `INSERT INTO epic_manager_offers (card_id, epic_id, offered_at, offer_count, stalled_at)
         VALUES (?, ?, NULL, 0, ?)
         ON CONFLICT(card_id) DO UPDATE SET offered_at = NULL, stalled_at = excluded.stalled_at`,
      )
      .run(card.id, epic.id, this.now());
    this.deps.broadcast({
      type: EPIC_MANAGER_STALLED_EVENT,
      sessionId: manager.id,
      ownerUserId: manager.owner_user_id ?? null,
      projectId: this.projectIdForEpic(epic),
      epicId: epic.id,
      epicName: epic.name,
      cardId: card.id,
      cardTitle: card.title,
      reason: why,
    });
  }

  // Broadcast tap

  /** Feed every server broadcast through here. */
  noteBroadcast(data: Record<string, unknown>): void {
    const type = data?.type;
    if (typeof type !== 'string') return;
    if (type === 'kanban_update') {
      const projectId = typeof data.projectId === 'string' ? data.projectId : '';
      if (projectId) this.deps.requestReevaluation?.(projectId);
      return;
    }
    const sessionId =
      typeof data.sessionId === 'string'
        ? data.sessionId
        : typeof data.session_id === 'string'
          ? data.session_id
          : '';
    if (!sessionId) return;
    if (type === 'awaiting_input' && this.epicForManager(sessionId)) {
      this.onManagerTurnEnded(sessionId);
      return;
    }
    let event: EpicWorkerEvent | null = null;
    if (type === 'awaiting_input') {
      event = { kind: 'turn_finished', sessionId };
    } else if (type === 'error') {
      const detail = typeof data.error === 'string' ? data.error : null;
      event = { kind: 'error', sessionId, detail };
    } else if (type === 'finalize_run_completed') {
      const status = typeof data.status === 'string' ? data.status : '';
      if (!FINALIZE_FAILED_STATUSES.has(status)) return;
      const reason = typeof data.failure_reason === 'string' ? data.failure_reason : status;
      event = { kind: 'finalize_failed', sessionId, detail: reason };
    } else if (type === SESSION_NEEDS_INPUT_EVENT) {
      if (!data.needsInput) return;
      event = { kind: 'needs_input', sessionId, detail: String(data.needsInput) };
    }
    if (!event) return;
    const card = this.deps.stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
    if (!card?.epic_id) return;
    this.noteWorkerEvent(card.epic_id, { ...event, cardId: card.id });
  }

  private onManagerTurnEnded(sessionId: string): void {
    const epic = this.epicForManager(sessionId);
    if (!epic) return;
    if (this.wakes.get(epic.id)?.waitingForTurn) this.schedule(epic.id, 0);
  }

  // Wakes

  private enqueue(
    epicId: string,
    item: {
      kind: WakeRow['kind'];
      cardId?: string | null;
      sessionId?: string | null;
      agentId?: string | null;
      phaseId?: string | null;
      detail?: string | null;
    },
  ): void {
    this.deps.db
      .prepare(
        `INSERT INTO epic_manager_wake_queue
           (epic_id, kind, card_id, session_id, agent_id, phase_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        epicId,
        item.kind,
        item.cardId ?? null,
        item.sessionId ?? null,
        item.agentId ?? null,
        item.phaseId ?? null,
        item.detail ?? null,
        this.now(),
      );
  }

  /** The epic's queued wake items, oldest first. */
  private queued(epicId: string): WakeRow[] {
    return this.deps.db
      .prepare('SELECT * FROM epic_manager_wake_queue WHERE epic_id = ? ORDER BY id')
      .all(epicId) as WakeRow[];
  }

  private deleteQueuedThrough(epicId: string, maxId: number): void {
    this.deps.db
      .prepare('DELETE FROM epic_manager_wake_queue WHERE epic_id = ? AND id <= ?')
      .run(epicId, maxId);
  }

  private wakeFor(epicId: string): WakeTimer {
    let wake = this.wakes.get(epicId);
    if (!wake) {
      wake = { timer: null, waitingForTurn: false, inFlight: false, failures: 0 };
      this.wakes.set(epicId, wake);
    }
    return wake;
  }

  /** Arm the flush, keeping an earlier deadline when one is already set. */
  private schedule(epicId: string, delayMs: number): void {
    const wake = this.wakeFor(epicId);
    if (wake.timer !== null) {
      if (delayMs > 0) return;
      this.clearTimer(wake.timer);
    }
    wake.timer = this.setTimer(() => {
      wake.timer = null;
      this.flush(epicId);
    }, delayMs);
  }

  private clearWakeTimer(epicId: string): void {
    const wake = this.wakes.get(epicId);
    if (wake?.timer != null) this.clearTimer(wake.timer);
    if (wake && !wake.inFlight) this.wakes.delete(epicId);
  }

  /** Forget everything queued for the epic (it is gone, or its manager is). */
  private discardQueued(epicId: string): void {
    this.deps.db.prepare('DELETE FROM epic_manager_wake_queue WHERE epic_id = ?').run(epicId);
    this.clearWakeTimer(epicId);
  }

  /** After a restart: re-arm every epic that still has undelivered wake items. */
  resume(): void {
    const epics = this.deps.db
      .prepare('SELECT DISTINCT epic_id FROM epic_manager_wake_queue')
      .all() as Array<{ epic_id: string }>;
    for (const { epic_id } of epics) this.schedule(epic_id, 0);
  }

  /**
   * Send the queued wake now, or hold it until the manager's turn ends. The
   * rows sent are deleted only after delivery succeeds; a failed delivery
   * keeps them and retries with backoff, and items queued meanwhile wait for
   * the next wake.
   */
  flush(epicId: string): void {
    const wake = this.wakeFor(epicId);
    if (wake.inFlight) return;
    const epic = this.deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
    const manager = epic ? this.managerFor(epic) : null;
    if (!epic || !manager) {
      this.discardQueued(epicId);
      return;
    }
    const rows = this.queued(epicId);
    if (rows.length === 0) {
      this.clearWakeTimer(epicId);
      return;
    }
    const maxId = rows[rows.length - 1].id;
    const completion = rows.some((r) => COMPLETION_KINDS.has(r.kind));
    if (!completion && !epicIsRunning(this.deps.stmts, epic)) {
      this.discardQueued(epicId);
      return;
    }
    if (this.deps.isSessionBusy(manager.id)) {
      wake.waitingForTurn = true;
      return;
    }
    wake.waitingForTurn = false;
    const kickoff = rows.some((r) => r.kind === 'kickoff');
    // Ready cards come from the board as they are now; ones that moved on
    // since they were offered are not news.
    const ready = new Map<string, ReadyCardOffer>();
    for (const row of rows) {
      if (row.kind !== 'ready' || !row.card_id || !this.isOffered(row.card_id)) continue;
      const card = this.deps.stmts.getKanbanCard.get(row.card_id) as KanbanCardRow | undefined;
      if (!card) continue;
      ready.set(card.id, { card, agentId: row.agent_id ?? '', phaseId: row.phase_id });
    }
    const events = this.collapseEvents(
      rows
        .filter((r) => r.kind !== 'ready' && r.kind !== 'kickoff')
        .map((r) => ({
          kind: r.kind as EpicWorkerEventKind,
          cardId: r.card_id,
          sessionId: r.session_id,
          phaseId: r.phase_id,
          detail: r.detail,
        })),
    );
    if (!kickoff && ready.size === 0 && events.length === 0) {
      this.deleteQueuedThrough(epicId, maxId);
      this.clearWakeTimer(epicId);
      return;
    }
    const content = this.composeWake(
      epic,
      [...ready.values()],
      events,
      !this.hasMessages(manager.id),
    );
    wake.inFlight = true;
    const delivered = () => {
      wake.inFlight = false;
      wake.failures = 0;
      this.deleteQueuedThrough(epicId, maxId);
      // Items queued while this wake was out go in the next one.
      if (this.queued(epicId).length > 0) this.schedule(epicId, 0);
      else this.clearWakeTimer(epicId);
    };
    const failed = (err: unknown) => {
      wake.inFlight = false;
      wake.failures += 1;
      console.error(
        `[epic-manager] wake for epic "${epic.name}" failed (attempt ${wake.failures}):`,
        err instanceof Error ? err.message : err,
      );
      if (wake.failures > EPIC_MANAGER_WAKE_MAX_RETRIES) {
        // Stay queued; the next event or manager turn end tries again.
        wake.failures = 0;
        return;
      }
      const delay = Math.min(WAKE_RETRY_BASE_MS * 2 ** (wake.failures - 1), WAKE_RETRY_MAX_MS);
      this.schedule(epicId, delay);
    };
    try {
      void Promise.resolve(
        this.deps.dispatchChat({
          type: 'chat',
          agentId: manager.agent_id,
          sessionId: manager.id,
          content,
          _epicManagerWake: true,
        }),
      ).then(delivered, failed);
    } catch (err) {
      failed(err);
    }
  }

  /** One line per card and kind; a worker's turn end hides behind anything sharper. */
  private collapseEvents(events: EpicWorkerEvent[]): EpicWorkerEvent[] {
    const byKey = new Map<string, EpicWorkerEvent>();
    for (const event of events) {
      // Keyed by what the event is about, so two phases (or two cards)
      // finishing in one batch stay two lines.
      const subject = event.cardId
        ? `card:${event.cardId}`
        : event.sessionId
          ? `session:${event.sessionId}`
          : event.phaseId
            ? `phase:${event.phaseId}`
            : 'epic';
      const key = `${subject}:${event.kind}`;
      byKey.set(key, event);
    }
    const sharper = new Set(
      [...byKey.values()]
        .filter((e) => e.kind !== 'turn_finished' && (e.cardId || e.sessionId))
        .map((e) => e.cardId ?? e.sessionId),
    );
    return [...byKey.values()]
      .filter((e) => e.kind !== 'turn_finished' || !sharper.has(e.cardId ?? e.sessionId))
      .sort((a, b) => EVENT_RANK[a.kind] - EVENT_RANK[b.kind]);
  }

  private hasMessages(sessionId: string): boolean {
    const rows = this.deps.stmts.getMessagesPageLatest.all(sessionId, 1) as MessageRow[];
    return rows.length > 0;
  }

  private projectIdForEpic(epic: KanbanEpicRow): string | null {
    const board = this.deps.stmts.getKanbanBoardById?.get(epic.board_id) as
      | { project_id?: string }
      | undefined;
    return board?.project_id ?? null;
  }

  private cardLine(card: KanbanCardRow, columnName: string): string {
    const pr = card.pr_url ? ` · PR ${card.pr_url}` : '';
    return `- \`${card.id}\` [${columnName || '?'}] ${card.title}${pr}`;
  }

  /** The first message: what the epic is and where every card stands. */
  private composeBrief(epic: KanbanEpicRow): string {
    const { stmts } = this.deps;
    const columns = stmts.getKanbanColumns.all(epic.board_id) as KanbanColumnRow[];
    const colName = new Map(columns.map((c) => [c.id, c.name]));
    const cards = stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
    const phases = (stmts.getKanbanPhasesByEpic.all(epic.id) as KanbanPhaseRow[]) ?? [];
    const blockers =
      (stmts.getBlockersForBoard.all(epic.board_id) as Array<{
        card_id: string;
        blocked_by_card_id: string;
      }>) ?? [];
    const blockedBy = new Map<string, string[]>();
    for (const b of blockers) {
      const list = blockedBy.get(b.card_id) ?? [];
      list.push(b.blocked_by_card_id);
      blockedBy.set(b.card_id, list);
    }
    const line = (card: KanbanCardRow) => {
      const deps = blockedBy.get(card.id);
      const tail = deps?.length ? ` — blocked by ${deps.map((id) => `\`${id}\``).join(', ')}` : '';
      return `${this.cardLine(card, colName.get(card.column_id) ?? '')}${tail}`;
    };
    const out: string[] = [
      `# Epic brief: ${epic.name}`,
      '',
      `Epic \`${epic.id}\`. You are its manager thread.`,
    ];
    if (epic.description?.trim()) out.push('', '## Spec', '', epic.description.trim());
    const decisions = formatEpicSpecDecisionsForContext(loadChosenSpecItemsForEpic(stmts, epic.id));
    if (decisions) out.push('', decisions);
    out.push('', '## Phases and cards (in order)');
    for (const [index, phase] of phases.entries()) {
      const state = phase.autonomous_running ? 'running' : phase.autonomous ? 'armed' : 'not armed';
      out.push('', `### ${index + 1}. ${phase.name} (\`${phase.id}\`, ${state})`);
      const inPhase = cards.filter((c) => c.phase_id === phase.id);
      out.push(...(inPhase.length ? inPhase.map(line) : ['- (no cards)']));
    }
    const unphased = cards.filter((c) => !c.phase_id || !phases.some((p) => p.id === c.phase_id));
    if (unphased.length)
      out.push('', phases.length ? '### Not in a phase' : '', ...unphased.map(line));
    const running = this.runningWorkers(epic);
    if (running.length) {
      out.push('', '## Workers already running');
      for (const session of running) {
        const card = stmts.getKanbanCardBySession.get(session.id) as KanbanCardRow | undefined;
        const ref = formatHubChatRefToken(session.name || 'worker', 'session', session.id) ?? '';
        out.push(`- ${ref || session.id} on \`${card?.id ?? '?'}\` ${card?.title ?? ''}`.trimEnd());
      }
    }
    return out.join('\n');
  }

  private composeWake(
    epic: KanbanEpicRow,
    ready: ReadyCardOffer[],
    events: EpicWorkerEvent[],
    withBrief: boolean,
  ): string {
    const { stmts } = this.deps;
    const out: string[] = [];
    if (withBrief) out.push(this.composeBrief(epic), '', '---', '');
    out.push(
      `## Epic manager wake-up: ${epic.name}`,
      '',
      'Sent by the server; no person wrote this turn.',
    );
    if (events.length) {
      out.push('', '### What happened');
      for (const event of events) {
        const card = event.cardId
          ? (stmts.getKanbanCard.get(event.cardId) as KanbanCardRow | undefined)
          : undefined;
        const session = event.sessionId ?? card?.session_id ?? null;
        const who = card
          ? `\`${card.id}\` "${card.title}"`
          : event.phaseId
            ? `phase \`${event.phaseId}\``
            : 'the epic';
        const ref = session
          ? ` (worker ${formatHubChatRefToken('worker', 'session', session) ?? session})`
          : '';
        const detail = event.detail ? `: ${event.detail}` : '';
        out.push(`- ${EVENT_LABEL[event.kind]}: ${who}${ref}${detail}`);
      }
    }
    if (ready.length) {
      out.push(
        '',
        '### Ready to start',
        '',
        'The server checked phase order, blockers, open decisions and the concurrency cap. Write each worker a self-contained brief and emit one `agenthub:forward` per card with its `cardId`.',
      );
      const phases = new Map(
        ((stmts.getKanbanPhasesByEpic.all(epic.id) as KanbanPhaseRow[]) ?? []).map((p) => [
          p.id,
          p.name,
        ]),
      );
      for (const offer of ready) {
        const card = offer.card;
        const meta = [
          offer.phaseId && phases.get(offer.phaseId)
            ? `phase "${phases.get(offer.phaseId)}"`
            : null,
          `suggested agent \`${offer.agentId}\``,
          card.priority ? `priority ${card.priority}` : null,
          card.labels ? `labels ${card.labels}` : null,
          card.card_kind === 'spike' ? 'spike (scoping session)' : null,
        ].filter(Boolean);
        out.push('', `#### \`${card.id}\` ${card.title}`, meta.join(' · '));
        if (card.description?.trim()) {
          out.push('', clip(card.description.trim(), MAX_DESCRIPTION_CHARS));
        }
      }
      out.push(
        '',
        'On start the server gives the worker the full card (title, description, priority, labels), the epic spec decisions, any session replay, support-ticket comments and image attachments. Descriptions above may be shortened; the worker still gets them whole. Your brief adds what the card cannot say on its own.',
      );
    }
    if (!ready.length && !events.length) {
      out.push(
        '',
        'Nothing is ready yet. The server wakes you again when cards unblock or workers report.',
      );
    }
    return out.join('\n');
  }

  /** Drop every timer (shutdown). */
  stopAll(): void {
    for (const wake of this.wakes.values()) {
      if (wake.timer != null) this.clearTimer(wake.timer);
    }
    this.wakes.clear();
  }
}

let activeManager: EpicManager | null = null;

export function setEpicManager(manager: EpicManager | null): void {
  activeManager = manager;
}

export function getEpicManager(): EpicManager | null {
  return activeManager;
}

/** Broadcast tap, deferred so the event's rows have settled. */
export function noteBroadcastForEpicManager(data: Record<string, unknown>): void {
  const manager = activeManager;
  if (!manager) return;
  queueMicrotask(() => {
    try {
      manager.noteBroadcast(data);
    } catch (err) {
      console.error('[epic-manager] broadcast tap failed:', (err as Error).message);
    }
  });
}
