/**
 * One live list of Google Chat reply drafts for one session or space.
 *
 * Web and mobile both render drafts from this controller, so the sync rules
 * live in one place:
 *
 *   - **One filter per controller.** A view creates a controller for its
 *     session/space and disposes it when the filter changes. Every entry point
 *     (`reload`, `apply`, timers, load completions) is a no-op once disposed, so
 *     a late response or a card's action result from the previous filter can
 *     never touch the new list or start a load that supersedes it.
 *   - **Newest load wins.** Each load has a sequence number; an older response
 *     is dropped. Updates that arrive while a load is in flight are replayed on
 *     top of its snapshot (see `reconcileDraftSnapshot`).
 *   - **Failures keep what is shown.** A failed load leaves the last good list
 *     in place, reports `error`, and retries with backoff until a load succeeds
 *     or the view calls `reload` (e.g. Refresh).
 *   - **Live updates are a fast path, not the source of truth.** Every active
 *     list is re-read periodically (`IDLE_REFRESH_MS`), so a draft created,
 *     edited, or discarded while the socket was down still shows up. Views
 *     also call `reload` when their socket reconnects. While any draft shows
 *     `sending` the re-read is faster (`SENDING_RECHECK_MS`): if the server
 *     restarted mid-send no live update comes, and the re-read returns the
 *     draft as `unconfirmed`.
 */
import {
  EMPTY_DRAFT_STATE,
  applyDraftUpdate,
  reconcileDraftSnapshot,
  type ChatDraft,
  type DraftFilter,
  type DraftListState,
} from './googleChatDrafts';

export interface DraftListSnapshot {
  drafts: ChatDraft[];
  /** Last load failure, cleared by the next successful load. */
  error: string | null;
  /** True until the first load settles. */
  loading: boolean;
}

export interface DraftListPage {
  drafts?: ChatDraft[];
  asOf?: string | null;
}

export interface DraftListDeps {
  fetch: (filter: DraftFilter) => Promise<DraftListPage>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const SENDING_RECHECK_MS = 15_000;
export const IDLE_REFRESH_MS = 60_000;
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 60_000;

export const EMPTY_DRAFT_SNAPSHOT: DraftListSnapshot = {
  drafts: [],
  error: null,
  loading: false,
};

export class DraftListController {
  private state: DraftListState = EMPTY_DRAFT_STATE;
  private snapshot: DraftListSnapshot = { drafts: [], error: null, loading: true };
  private listeners = new Set<() => void>();
  private seq = 0;
  private inFlight: ChatDraft[] | null = null;
  private timer: unknown = null;
  private timerDelay = 0;
  private failures = 0;
  private disposed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly filter: DraftFilter,
    private readonly deps: DraftListDeps,
  ) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DraftListSnapshot => this.snapshot;

  /** Start (or restart) a load. Ignored after `dispose`. */
  reload = (): void => {
    if (this.disposed) return;
    this.cancelTimer();
    const seq = ++this.seq;
    this.inFlight = [];
    this.deps.fetch(this.filter).then(
      (page) => this.settle(seq, page),
      (err: unknown) => this.fail(seq, err),
    );
  };

  /** Fold a live update or an action result into the list. Ignored after `dispose`. */
  apply = (draft: ChatDraft | null | undefined): void => {
    if (this.disposed || !draft?.id) return;
    this.inFlight?.push(draft);
    this.setState(applyDraftUpdate(this.state, draft, this.filter));
    this.scheduleRecheck();
  };

  dispose = (): void => {
    this.disposed = true;
    this.cancelTimer();
    this.inFlight = null;
    this.listeners.clear();
  };

  private settle(seq: number, page: DraftListPage): void {
    if (this.disposed || seq !== this.seq) return;
    const inFlight = this.inFlight ?? [];
    this.inFlight = null;
    this.failures = 0;
    this.setState(
      reconcileDraftSnapshot(
        this.state,
        page?.drafts ?? [],
        typeof page?.asOf === 'string' ? page.asOf : null,
        inFlight,
        this.filter,
      ),
      null,
    );
    this.scheduleRecheck();
  }

  private fail(seq: number, err: unknown): void {
    if (this.disposed || seq !== this.seq) return;
    this.inFlight = null;
    this.failures += 1;
    const message = err instanceof Error && err.message ? err.message : 'Could not load drafts';
    // Keep the last good list; only the error changes.
    this.setState(this.state, message);
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    this.startTimer(delay);
  }

  /** Schedule the next re-read; a sending draft shortens a pending idle wait. */
  private scheduleRecheck(): void {
    if (this.inFlightLoad()) return;
    const delay = this.state.drafts.some((d) => d.status === 'sending')
      ? SENDING_RECHECK_MS
      : IDLE_REFRESH_MS;
    if (this.timer !== null && this.timerDelay <= delay) return;
    this.startTimer(delay);
  }

  private startTimer(delay: number): void {
    this.cancelTimer();
    this.timerDelay = delay;
    this.timer = this.setTimer(this.reload, delay);
  }

  private inFlightLoad(): boolean {
    return this.inFlight !== null;
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private setState(next: DraftListState, error: string | null = this.snapshot.error): void {
    this.state = next;
    this.snapshot = { drafts: next.drafts, error, loading: false };
    for (const listener of this.listeners) listener();
  }
}
