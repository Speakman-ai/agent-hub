/**
 * Server-side Auto start for Orchestrate forward cards.
 *
 * With Auto start on, a forward card an Orchestrate chat posts starts its
 * session 30 seconds after the turn ends. The server is the only place this
 * runs, so a turn nobody watches (a session poller run, a background-shell
 * wake) starts its cards too; clients show the server's countdown and send
 * cancels to it.
 *
 * Countdowns are saved so a restart resumes them at their original deadline.
 * The server dispatches with the card's idempotency key, the one a manual
 * press sends, so a press and the countdown racing on one card start one
 * session between them.
 */
import type { BroadcastFn, MessageRow, Project, SessionRow, Stmts } from './types.js';
import {
  extractForwardBlocks,
  parseSessionForwardMode,
  sessionForwardModesFor,
  type ExtractedForward,
} from '../shared/utils/extractForwardBlocks.js';
import { sessionForwardDispatchKey } from '../shared/utils/sessionForwardDispatchKey.js';
import { orchestrateLaunchMode } from '../shared/utils/orchestrateForwardMode.js';
import {
  ORCHESTRATE_AUTO_START_ENDED_EVENT,
  ORCHESTRATE_AUTO_START_SCHEDULED_EVENT,
  ORCHESTRATE_AUTO_START_SECONDS,
} from '../shared/utils/orchestrateLaunchClient.js';
import { isOrchestrateModeActive } from './session-mode.js';
import { forwardIdOfPayload } from './session-needs-input.js';
import type { OrchestrateLaunchStore } from './orchestrate-launch-store.js';
import type { SessionDispatchOutcome, DispatchSessionRequest } from './routes/session-dispatch.js';

export {
  ORCHESTRATE_AUTO_START_CANCELLED_EVENT,
  ORCHESTRATE_AUTO_START_ENDED_EVENT,
  ORCHESTRATE_AUTO_START_SCHEDULED_EVENT,
  ORCHESTRATE_LAUNCH_UPDATED_EVENT,
  SESSION_FORWARD_STARTED_EVENT,
} from '../shared/utils/orchestrateLaunchClient.js';
export const ORCHESTRATE_AUTO_START_MS = ORCHESTRATE_AUTO_START_SECONDS * 1000;
/** Wait before retrying a card whose dispatch claim someone else holds. */
export const CLAIM_RETRY_MS = 60_000;

export interface AutoStartRefusal {
  error: string;
  code: 'auto_start_off' | 'auto_start_cancelled';
}

/**
 * Whether the server may start a card automatically now: the chat must be a
 * live Orchestrate chat with Auto start on, and the card (when given) must
 * not have been cancelled.
 */
export function automaticStartRefusal(
  store: Pick<OrchestrateLaunchStore, 'getSettings' | 'isCancelled'>,
  session: Pick<SessionRow, 'id' | 'session_mode' | 'deleted_at'> | null | undefined,
  dispatchKey: string | null,
): AutoStartRefusal | null {
  if (!session || session.deleted_at || !isOrchestrateModeActive(session)) {
    return { error: 'Auto start only runs from an Orchestrate chat', code: 'auto_start_off' };
  }
  if (!store.getSettings(session.id).autoStart) {
    return { error: 'Auto start is off for this chat', code: 'auto_start_off' };
  }
  if (dispatchKey && store.isCancelled(dispatchKey)) {
    return { error: 'Auto start for this card was cancelled', code: 'auto_start_cancelled' };
  }
  return null;
}

/** How far back a chat's forward cards are considered for Auto start. */
const RECENT_MESSAGE_WINDOW = 25;

export interface ForwardCard {
  dispatchKey: string;
  messageId: string;
  forward: ExtractedForward;
}

export interface OrchestrateAutoStartDeps {
  stmts: Pick<
    Stmts,
    | 'getSession'
    | 'getMessagesPageLatest'
    | 'getMessageSessionForwardEvents'
    | 'getSessionDispatchKey'
  >;
  store: OrchestrateLaunchStore;
  findProject: (projectId: string) => Project | undefined;
  /** Whether the session's owner may start a session in this project. */
  canUseProject: (project: Project, ownerUserId: string) => boolean;
  dispatch: (args: {
    project: Project;
    body: DispatchSessionRequest;
    ownerUserId: string;
    callingSession: SessionRow;
  }) => SessionDispatchOutcome;
  broadcast?: BroadcastFn;
  delayMs?: number;
  now?: () => number;
  /** A message's insert order; defaults to its rowid in the store's database. */
  messageOrder?: (messageId: string) => number | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function parsePayload(payload: unknown): ExtractedForward | null {
  if (typeof payload !== 'string') return null;
  try {
    const raw = JSON.parse(payload) as Partial<ExtractedForward>;
    if (
      typeof raw.forwardId !== 'string' ||
      typeof raw.projectId !== 'string' ||
      typeof raw.prompt !== 'string' ||
      !raw.prompt.trim()
    ) {
      return null;
    }
    return {
      forwardId: raw.forwardId,
      projectId: raw.projectId,
      agentId: typeof raw.agentId === 'string' ? raw.agentId : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      prompt: raw.prompt,
      mode: parseSessionForwardMode(raw.mode),
    };
  } catch {
    // A long payload can be clamped into invalid JSON; that card has no full
    // prompt to start, so it stays a manual press.
    return null;
  }
}

/**
 * The forward cards a message shows, numbered the way the clients number them
 * (occurrence counts repeats of one forward id). Events are the source; a row
 * whose fences stayed in the text falls back to those.
 */
export function forwardCardsForMessage(
  stmts: Pick<Stmts, 'getMessageSessionForwardEvents'>,
  sessionId: string,
  message: Pick<MessageRow, 'id' | 'content'>,
): ForwardCard[] {
  const rows = stmts.getMessageSessionForwardEvents.all(message.id) as Array<{ payload?: unknown }>;
  const entries: Array<{ forwardId: string; forward: ExtractedForward | null }> =
    rows.length > 0
      ? rows.map((row) => {
          const forward = parsePayload(row.payload);
          return { forwardId: forward?.forwardId ?? forwardIdOfPayload(row.payload), forward };
        })
      : extractForwardBlocks(message.content ?? '').forwards.map((forward) => ({
          forwardId: forward.forwardId,
          forward,
        }));
  const seen = new Map<string, number>();
  const cards: ForwardCard[] = [];
  for (const entry of entries) {
    const occurrence = seen.get(entry.forwardId) ?? 0;
    seen.set(entry.forwardId, occurrence + 1);
    if (!entry.forward) continue;
    const dispatchKey = sessionForwardDispatchKey({
      sessionId,
      messageId: message.id,
      forwardId: entry.forwardId,
      occurrence,
    });
    if (dispatchKey)
      cards.push({ dispatchKey, messageId: String(message.id), forward: entry.forward });
  }
  return cards;
}

/** A saved countdown's card, or null when the saved shape is unusable. */
function restoreCard(raw: unknown): ForwardCard | null {
  const value = raw as { dispatchKey?: unknown; messageId?: unknown; forward?: unknown } | null;
  if (typeof value?.dispatchKey !== 'string' || typeof value.messageId !== 'string') return null;
  const forward = parsePayload(JSON.stringify(value.forward ?? null));
  return forward ? { dispatchKey: value.dispatchKey, messageId: value.messageId, forward } : null;
}

export class OrchestrateAutoStarter {
  // The authoritative countdowns: clients count down to these deadlines.
  private readonly timers = new Map<string, { handle: unknown; deadline: number }>();
  private readonly now: () => number;
  private readonly messageOrder: (messageId: string) => number | null;
  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: OrchestrateAutoStartDeps) {
    this.delayMs = deps.delayMs ?? ORCHESTRATE_AUTO_START_MS;
    this.now = deps.now ?? Date.now;
    this.messageOrder = deps.messageOrder ?? ((id) => deps.store.messageOrder(id));
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Dispatch keys with a countdown running. */
  pendingKeys(): string[] {
    return [...this.timers.keys()];
  }

  /**
   * This chat's running countdowns as time left, not a timestamp, so a client
   * with a skewed clock still ends its countdown when the server fires.
   */
  pendingCountdowns(sessionId: string): Array<{ dispatchKey: string; remainingMs: number }> {
    const prefix = `session-forward:${sessionId}:`;
    const now = this.now();
    return [...this.timers.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([dispatchKey, timer]) => ({
        dispatchKey,
        remainingMs: Math.max(0, timer.deadline - now),
      }));
  }

  /**
   * Start the countdown for every forward card in the chat's recent messages
   * that has not started, been cancelled, or begun counting, when the chat is
   * in Orchestrate with Auto start on. Called when a turn ends, so a card
   * from an earlier turn is not left behind by a later one. Only cards posted
   * after Auto start was switched on count (see activationBoundary).
   */
  noteTurnEnded(sessionId: string): void {
    try {
      const session = this.eligibleSession(sessionId);
      if (!session) return;
      const boundary = this.deps.store.activationBoundary(sessionId);
      if (boundary === null) return;
      for (const message of this.recentAssistantMessages(sessionId)) {
        const order = this.messageOrder(String(message.id));
        if (order === null || order <= boundary) continue;
        for (const card of forwardCardsForMessage(this.deps.stmts, sessionId, message)) {
          if (this.timers.has(card.dispatchKey)) continue;
          if (this.isSettled(session, card.dispatchKey)) continue;
          this.arm(session, card, this.now() + this.delayMs);
        }
      }
    } catch (err) {
      console.error(
        `[orchestrate-auto-start] could not schedule cards for ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * After a restart: resume every saved countdown at its original deadline
   * (firing at once if it passed while the server was down), then pick up
   * any eligible card that was never scheduled.
   */
  sweep(): void {
    for (const saved of this.deps.store.listPending()) {
      try {
        const card = restoreCard(saved.card);
        const session = this.eligibleSession(saved.sessionId);
        if (!card || !session || this.isSettled(session, saved.dispatchKey)) {
          this.deps.store.deletePending(saved.dispatchKey);
          // A client that loaded this countdown before the restart stops it.
          if (!session || !this.hasStarted(session, saved.dispatchKey)) {
            this.publishEnded(saved.sessionId, session?.owner_user_id ?? null, saved.dispatchKey);
          }
          continue;
        }
        this.arm(session, card, saved.deadlineMs);
      } catch (err) {
        console.error(
          `[orchestrate-auto-start] could not resume ${saved.dispatchKey}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    for (const sessionId of this.deps.store.listAutoStartSessionIds()) {
      this.noteTurnEnded(sessionId);
    }
  }

  private arm(session: SessionRow, card: ForwardCard, deadline: number): void {
    const sessionId = session.id;
    const remainingMs = Math.max(0, deadline - this.now());
    const handle = this.setTimer(() => this.fire(sessionId, card), remainingMs);
    this.timers.set(card.dispatchKey, { handle, deadline });
    this.deps.store.savePending(card.dispatchKey, sessionId, card, deadline);
    this.deps.broadcast?.({
      type: ORCHESTRATE_AUTO_START_SCHEDULED_EVENT,
      sessionId,
      ownerUserId: session.owner_user_id,
      dispatchKey: card.dispatchKey,
      remainingMs,
    });
  }

  /** Stop a card's countdown and remember the cancel. */
  cancel(dispatchKey: string): void {
    this.deps.store.cancel(dispatchKey);
    this.clear(dispatchKey);
  }

  /** Auto start was switched off or the chat left Orchestrate. */
  stopSession(sessionId: string): void {
    const prefix = `session-forward:${sessionId}:`;
    const session = this.deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
    for (const key of [...this.timers.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.clear(key);
      this.publishEnded(sessionId, session?.owner_user_id ?? null, key);
    }
    this.deps.store.deletePendingForSession(sessionId);
  }

  /** Tell clients a countdown is over without a start, so cards stop counting. */
  private publishEnded(sessionId: string, ownerUserId: string | null, dispatchKey: string): void {
    this.deps.broadcast?.({
      type: ORCHESTRATE_AUTO_START_ENDED_EVENT,
      sessionId,
      ownerUserId,
      dispatchKey,
    });
  }

  /** Drop the in-memory timers only (shutdown); saved countdowns resume on boot. */
  stopAll(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer.handle);
    this.timers.clear();
  }

  private clear(dispatchKey: string): void {
    const timer = this.timers.get(dispatchKey);
    if (timer !== undefined) this.clearTimer(timer.handle);
    this.timers.delete(dispatchKey);
    this.deps.store.deletePending(dispatchKey);
  }

  private eligibleSession(sessionId: string): SessionRow | null {
    const session = this.deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session?.owner_user_id) return null;
    return automaticStartRefusal(this.deps.store, session, null) ? null : session;
  }

  /** Assistant messages among the chat's most recent rows, oldest first. */
  private recentAssistantMessages(sessionId: string): MessageRow[] {
    const rows = this.deps.stmts.getMessagesPageLatest.all(
      sessionId,
      RECENT_MESSAGE_WINDOW,
    ) as MessageRow[];
    // Rows come newest first.
    return rows.filter((row) => row.role === 'assistant' && row.id).reverse();
  }

  /** Cancelled, or already started by a client or an earlier countdown. */
  private isSettled(session: SessionRow, dispatchKey: string): boolean {
    if (automaticStartRefusal(this.deps.store, session, dispatchKey)) return true;
    return this.hasStarted(session, dispatchKey);
  }

  /**
   * Only a completed dispatch record means the card started. A claim without
   * a session is a start in progress, or one a crash abandoned; the dispatch
   * route clears those after a few minutes, so the card stays eligible.
   */
  private hasStarted(session: SessionRow, dispatchKey: string): boolean {
    const prior = this.deps.stmts.getSessionDispatchKey.get(session.owner_user_id, dispatchKey) as
      | { session_id?: string | null }
      | undefined;
    return Boolean(prior?.session_id);
  }

  private fire(sessionId: string, card: ForwardCard): void {
    this.timers.delete(card.dispatchKey);
    // Gone from the saved countdowns means it was ended elsewhere (the chat
    // left Orchestrate): the timer is stale even if the chat is back.
    const stillPending = this.deps.store.hasPending(card.dispatchKey);
    this.deps.store.deletePending(card.dispatchKey);
    if (!stillPending) {
      const owner = (this.deps.stmts.getSession.get(sessionId) as SessionRow | undefined)
        ?.owner_user_id;
      this.publishEnded(sessionId, owner ?? null, card.dispatchKey);
      return;
    }
    let session: SessionRow | null = null;
    try {
      session = this.eligibleSession(sessionId);
      // Started elsewhere: that start was already published (see dispatchProjectSession).
      if (session && this.hasStarted(session, card.dispatchKey)) return;
      if (!session?.owner_user_id || this.isSettled(session, card.dispatchKey)) {
        this.publishEnded(sessionId, session?.owner_user_id ?? null, card.dispatchKey);
        return;
      }
      const ownerUserId = session.owner_user_id;
      const project = this.deps.findProject(card.forward.projectId);
      if (!project || !this.deps.canUseProject(project, ownerUserId)) {
        this.publishEnded(sessionId, ownerUserId, card.dispatchKey);
        return;
      }
      const allowed = sessionForwardModesFor(project.mode === 'workflow', card.forward.mode);
      const mode = orchestrateLaunchMode(allowed, this.deps.store.getSettings(sessionId).mode);
      const outcome = this.deps.dispatch({
        project,
        ownerUserId,
        callingSession: session,
        body: {
          prompt: card.forward.prompt,
          ...(card.forward.agentId ? { agentId: card.forward.agentId } : {}),
          ...(card.forward.name.trim() ? { name: card.forward.name.trim().slice(0, 120) } : {}),
          mode,
          idempotencyKey: card.dispatchKey,
        },
      });
      if (outcome.status === 409 && outcome.body.code === 'dispatch_in_progress') {
        // Someone holds the claim: another client finishing the start, or a
        // claim a crash left behind (cleared after a few minutes). Check
        // again later; a finished start then reads as already started.
        this.arm(session, card, this.now() + CLAIM_RETRY_MS);
        return;
      }
      if (outcome.status !== 200 && outcome.status !== 201) {
        console.warn(
          `[orchestrate-auto-start] card ${card.dispatchKey} did not start (${outcome.status}): ${String(outcome.body.error ?? '')}`,
        );
        this.publishEnded(sessionId, ownerUserId, card.dispatchKey);
      }
      // A start is published by dispatchProjectSession, for presses and countdowns alike.
    } catch (err) {
      console.error(
        `[orchestrate-auto-start] card ${card.dispatchKey} failed:`,
        err instanceof Error ? err.message : err,
      );
      this.publishEnded(sessionId, session?.owner_user_id ?? null, card.dispatchKey);
    }
  }
}

let activeStarter: OrchestrateAutoStarter | null = null;

/** Install the process-wide starter the broadcast tap feeds. */
export function setOrchestrateAutoStarter(starter: OrchestrateAutoStarter | null): void {
  activeStarter = starter;
}

/**
 * Broadcast tap. The chat `done` path emits `awaiting_input`, so every turn
 * end passes here. Deferred so the turn's rows have settled.
 */
export function noteBroadcastForOrchestrateAutoStart(data: Record<string, unknown>): void {
  if (!activeStarter || data?.type !== 'awaiting_input') return;
  const sessionId = data.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;
  const starter = activeStarter;
  queueMicrotask(() => starter.noteTurnEnded(sessionId));
}
