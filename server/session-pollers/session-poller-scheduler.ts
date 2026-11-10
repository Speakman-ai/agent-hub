/**
 * Drives session pollers: on each tick, wake sessions whose poller is due and
 * close pollers whose window has ended.
 *
 * Runs dispatch through the same `handleChat(null, …)` seam as background
 * shell wakes and queue drains. A due run waits while the session is mid-turn,
 * finalizing, or waiting on the user, then fires on the first tick after; the
 * store schedules the following run on the original cadence so a long defer
 * does not cause back-to-back catch-up runs.
 */
import {
  expectedPollerRuns,
  formatPollerMinutes,
  type SessionPoller,
} from '../../shared/utils/sessionPoller.js';
import type { SessionPollerStore } from './session-poller-store.js';

export const SESSION_POLLER_TICK_MS = 30_000;
export const SESSION_POLLER_UPDATED_EVENT = 'session_poller_updated';
export const SESSION_POLLER_NOTIFY_EVENT = 'session_poller_notify';

const PREVIEW_MAX = 200;

export interface PollerSessionLike {
  id: string;
  agent_id: string;
  name?: string | null;
  owner_user_id?: string | null;
  deleted_at?: string | null;
}

export interface PollerChatMessage {
  type: 'chat';
  agentId: string;
  sessionId: string;
  content: string;
  _sessionPollerRun: true;
}

export interface SessionPollerSchedulerDeps {
  store: SessionPollerStore;
  getSession: (sessionId: string) => PollerSessionLike | undefined;
  resolveProjectId?: (session: PollerSessionLike) => string | null;
  isSessionBusy: (sessionId: string) => boolean;
  isSessionFinalizing?: (sessionId: string) => boolean;
  isSessionAwaitingUserInput?: (sessionId: string) => boolean;
  dispatchChat: (msg: PollerChatMessage) => Promise<unknown> | unknown;
  /** Text of the newest assistant message, for the per-run notification. */
  getLatestAssistantText?: (sessionId: string) => string | null;
  broadcast: (data: Record<string, unknown>) => void;
  persistSystemMessage?: (
    sessionId: string,
    content: string,
    meta: Record<string, unknown>,
  ) => void;
  now?: () => Date;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

export function buildPollerRunPrompt(poller: SessionPoller, now: Date): string {
  const run = poller.runCount + 1;
  const total = expectedPollerRuns(poller.intervalMinutes, poller.durationMinutes);
  const leftMin = Math.max(0, Math.round((Date.parse(poller.endsAt) - now.getTime()) / 60_000));
  return [
    `Scheduled poller check-in (run ${run} of about ${total}, every ${formatPollerMinutes(
      poller.intervalMinutes,
    )}, ${leftMin > 0 ? `${formatPollerMinutes(leftMin)} left` : 'final window'}).`,
    '',
    `Task: ${poller.task}`,
    '',
    'Do the check now and reply with a short report: what you found, and what changed since the previous run. This repeats automatically, so do not start another poller or set up your own schedule. If the task can no longer be done, say why in one line.',
  ].join('\n');
}

/** Plain one-line preview of an assistant reply for a notification body. */
export function pollerReplyPreview(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<agenthub:[a-z-]+>[\s\S]*?<\/agenthub:[a-z-]+>/g, ' ')
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  return plain.length > PREVIEW_MAX ? `${plain.slice(0, PREVIEW_MAX - 3)}...` : plain;
}

export class SessionPollerScheduler {
  private readonly deps: SessionPollerSchedulerDeps;
  private readonly now: () => Date;
  private readonly logger: NonNullable<SessionPollerSchedulerDeps['logger']>;
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SessionPollerSchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
    };
  }

  start(intervalMs: number = SESSION_POLLER_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Test seam and route hook: whether a run for this poller is mid-turn. */
  isRunning(pollerId: string): boolean {
    return this.inFlight.has(pollerId);
  }

  tick(): void {
    let pollers: SessionPoller[];
    try {
      pollers = this.deps.store.listActive();
    } catch (err) {
      this.logger.warn(`[pollers] list failed: ${errMessage(err)}`);
      return;
    }
    // One run per session per tick: two pollers due together would otherwise
    // both see the session idle and start overlapping turns. Pollers sharing
    // a session take turns (see byFairness) so none of them starves.
    const claimedSessions = new Set<string>();
    for (const poller of byFairness(pollers)) {
      try {
        this.tickOne(poller, claimedSessions);
      } catch (err) {
        this.logger.warn(`[pollers] tick failed poller=${poller.id}: ${errMessage(err)}`);
      }
    }
  }

  private tickOne(poller: SessionPoller, claimedSessions: Set<string>): void {
    const now = this.now();
    const session = this.deps.getSession(poller.sessionId);
    if (!session || session.deleted_at) {
      const cancelled = this.deps.store.finish(poller.id, 'cancelled', now);
      if (cancelled) this.emitUpdate(cancelled);
      return;
    }
    if (this.inFlight.has(poller.id)) return;

    const endsAtMs = Date.parse(poller.endsAt);
    const nextRunMs = poller.nextRunAt ? Date.parse(poller.nextRunAt) : Number.NaN;
    // A run deferred (or missed while the Hub was down) past the end of the
    // window is dropped, not replayed.
    if (now.getTime() >= endsAtMs) {
      this.complete(poller, session, now);
      return;
    }
    const runDue = Number.isFinite(nextRunMs) && nextRunMs <= now.getTime();
    if (!runDue || claimedSessions.has(session.id)) return;
    if (
      this.deps.isSessionBusy(session.id) ||
      this.probe(this.deps.isSessionFinalizing, session.id, true) ||
      this.probe(this.deps.isSessionAwaitingUserInput, session.id, false)
    ) {
      return;
    }
    claimedSessions.add(session.id);
    this.run(poller, session, now);
  }

  private run(poller: SessionPoller, session: PollerSessionLike, now: Date): void {
    const content = buildPollerRunPrompt(poller, now);
    const updated = this.deps.store.recordRun(poller.id, now);
    if (!updated) return;
    this.inFlight.add(poller.id);
    this.emitUpdate(updated);
    this.logger.log(
      `[pollers] run session=${session.id} poller=${poller.id} run=${updated.runCount}`,
    );
    const settle = (ok: boolean): void => {
      this.inFlight.delete(poller.id);
      if (ok && updated.notifyEachRun) this.notifyRun(updated, session);
      // Close promptly when that was the last run instead of waiting a tick.
      const current = this.deps.store.get(poller.id);
      if (current?.status === 'active' && this.now().getTime() >= Date.parse(current.endsAt)) {
        this.complete(current, session, this.now());
      }
    };
    try {
      Promise.resolve(
        this.deps.dispatchChat({
          type: 'chat',
          agentId: session.agent_id,
          sessionId: session.id,
          content,
          _sessionPollerRun: true,
        }),
      ).then(
        () => settle(true),
        (err: unknown) => {
          this.logger.warn(`[pollers] run failed poller=${poller.id}: ${errMessage(err)}`);
          settle(false);
        },
      );
    } catch (err) {
      this.logger.warn(`[pollers] run threw poller=${poller.id}: ${errMessage(err)}`);
      settle(false);
    }
  }

  private complete(poller: SessionPoller, session: PollerSessionLike, now: Date): void {
    const done = this.deps.store.finish(poller.id, 'completed', now);
    if (!done) return;
    this.emitUpdate(done);
    const runs = `${done.runCount} run${done.runCount === 1 ? '' : 's'}`;
    try {
      this.deps.persistSystemMessage?.(session.id, `Poller finished after ${runs}: ${done.task}`, {
        kind: 'session_poller_completed',
        pollerId: done.id,
      });
    } catch (err) {
      this.logger.warn(`[pollers] system message failed: ${errMessage(err)}`);
    }
    if (done.notifyOnComplete) {
      this.notify(done, session, 'complete', `Poller finished: ${truncate(done.task, 80)}`, runs);
    }
  }

  private notifyRun(poller: SessionPoller, session: PollerSessionLike): void {
    let preview: string | null = null;
    try {
      preview = pollerReplyPreview(this.deps.getLatestAssistantText?.(session.id));
    } catch {
      preview = null;
    }
    this.notify(
      poller,
      session,
      'run',
      `Poller run ${poller.runCount}: ${truncate(poller.task, 80)}`,
      preview ?? 'Check finished',
    );
  }

  private notify(
    poller: SessionPoller,
    session: PollerSessionLike,
    kind: 'run' | 'complete',
    title: string,
    body: string,
  ): void {
    let projectId: string | null = null;
    try {
      projectId = this.deps.resolveProjectId?.(session) ?? null;
    } catch {
      projectId = null;
    }
    this.safeBroadcast({
      type: SESSION_POLLER_NOTIFY_EVENT,
      kind,
      sessionId: session.id,
      agentId: session.agent_id,
      projectId,
      ownerUserId: session.owner_user_id ?? null,
      pollerId: poller.id,
      runCount: poller.runCount,
      title,
      body,
    });
  }

  private emitUpdate(poller: SessionPoller): void {
    this.safeBroadcast({ type: SESSION_POLLER_UPDATED_EVENT, sessionId: poller.sessionId, poller });
  }

  private safeBroadcast(data: Record<string, unknown>): void {
    try {
      this.deps.broadcast(data);
    } catch (err) {
      this.logger.warn(`[pollers] broadcast failed: ${errMessage(err)}`);
    }
  }

  private probe(
    fn: ((sessionId: string) => boolean) | undefined,
    sessionId: string,
    onError: boolean,
  ): boolean {
    if (!fn) return false;
    try {
      return fn(sessionId);
    } catch {
      return onError;
    }
  }
}

/**
 * Order for claiming a session's single run slot: the poller that has gone
 * longest without running first (never-run pollers before all others), then
 * the earliest due. Ordering by due time alone is not enough: a punctual
 * poller keeps the earliest slot on its cadence, while late ones skip ahead
 * past missed slots, so it would keep winning.
 */
export function byFairness(pollers: SessionPoller[]): SessionPoller[] {
  const ms = (iso: string | null, missing: number) => {
    const n = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(n) ? n : missing;
  };
  return [...pollers].sort(
    (a, b) =>
      ms(a.lastRunAt, Number.NEGATIVE_INFINITY) - ms(b.lastRunAt, Number.NEGATIVE_INFINITY) ||
      ms(a.nextRunAt, Number.POSITIVE_INFINITY) - ms(b.nextRunAt, Number.POSITIVE_INFINITY) ||
      a.startedAt.localeCompare(b.startedAt),
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
