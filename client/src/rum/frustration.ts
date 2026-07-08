/**
 * frustration.ts: client-side frustration-signal detection for RUM.
 *
 * Datadog-parity signals, all detected in the browser from the rrweb event
 * stream plus JS-error notifications:
 *   - rage click : more than RAGE_CLICK_THRESHOLD clicks on the SAME element
 *                  within RAGE_CLICK_WINDOW_MS. One signal per burst, NOT one
 *                  per click — the 5th click of a burst does not re-fire.
 *   - dead click : a click with NO DOM change within DEAD_CLICK_WINDOW_MS.
 *   - error click: a click followed by a JS error within ERROR_CLICK_WINDOW_MS.
 *
 * The detector is a pure, DOM-free state machine. It is fed target ids +
 * timestamps for clicks, DOM-mutation timestamps, and JS-error timestamps, and
 * hands back per-action frustration types plus rolled-up counts. Every clock
 * value comes from the caller (the rrweb event `timestamp`, or an injected
 * `now`), so each threshold is deterministically testable without a real DOM or
 * real time.
 *
 * Counting model (documented so the segment/session rollup is unambiguous):
 *   - actionCount     = number of clicks observed (each click is one action).
 *   - rage            = one per detected burst on an element.
 *   - dead            = one per click that saw no DOM mutation in its window.
 *   - error           = one per click followed by a JS error in its window.
 *   - frustrationCount = rage + dead + error (a single click can be both dead
 *                        AND error, contributing 2).
 *
 * Rage is resolved at click time; dead/error can only be known once the click's
 * window elapses (or an activity/error arrives), so those clicks stay PENDING
 * until {@link FrustrationDetector.collect} matures them.
 */

/** More than this many same-element clicks inside the window is a rage burst. */
export const RAGE_CLICK_THRESHOLD = 3;
/** Sliding window for the same-element rage-click count. */
export const RAGE_CLICK_WINDOW_MS = 1000;
/** A click with no DOM mutation within this window after it is a dead click. */
export const DEAD_CLICK_WINDOW_MS = 1000;
/** A click followed by a JS error within this window is an error click. */
export const ERROR_CLICK_WINDOW_MS = 1000;

/**
 * Soft cap on distinct clicked-target ids tracked for rage detection. Beyond
 * this, {@link FrustrationDetector.recordClick} sweeps entries whose newest
 * click has aged out of the rage window, so a long-lived single-view SPA
 * session (many unique elements clicked) can't grow the tracking maps without
 * bound. Aged entries are safe to drop: a fresh click re-creates the entry.
 */
export const MAX_TRACKED_TARGETS = 256;

/** Per-action frustration type strings (Datadog parity). */
export const FRUSTRATION_RAGE = 'rage_click';
export const FRUSTRATION_DEAD = 'dead_click';
export const FRUSTRATION_ERROR = 'error_click';

export type FrustrationType =
  | typeof FRUSTRATION_RAGE
  | typeof FRUSTRATION_DEAD
  | typeof FRUSTRATION_ERROR;

// rrweb event-shape constants (mirrors rrweb's EventType / IncrementalSource /
// MouseInteractions enums — inlined so this module carries no rrweb dependency).
export const RRWEB_INCREMENTAL = 3;
export const INCREMENTAL_SOURCE_MUTATION = 0;
export const INCREMENTAL_SOURCE_MOUSE_INTERACTION = 2;
export const MOUSE_INTERACTION_CLICK = 2;

/**
 * The minimal slice of an rrweb event this module reads. Deliberately narrow
 * (and all-optional) so the shape checks stay strict-typed at the otherwise
 * untyped rrweb boundary without pulling in rrweb's full `eventWithTime` type.
 */
export interface RRWebEvent {
  type?: number;
  timestamp?: number;
  data?: {
    source?: number;
    /** MouseInteractions sub-type on a MouseInteraction event. */
    type?: number;
    /** Target node id on a MouseInteraction event. */
    id?: number | string;
    [key: string]: unknown;
  };
}

/** True for an rrweb incremental MouseInteraction Click event. */
export function isClickEvent(ev: RRWebEvent | null | undefined): boolean {
  return (
    !!ev &&
    ev.type === RRWEB_INCREMENTAL &&
    !!ev.data &&
    ev.data.source === INCREMENTAL_SOURCE_MOUSE_INTERACTION &&
    ev.data.type === MOUSE_INTERACTION_CLICK
  );
}

/** True for an rrweb incremental DOM-mutation event. */
export function isDomMutationEvent(ev: RRWebEvent | null | undefined): boolean {
  return (
    !!ev &&
    ev.type === RRWEB_INCREMENTAL &&
    !!ev.data &&
    ev.data.source === INCREMENTAL_SOURCE_MUTATION
  );
}

/** The target node id an rrweb click carries in `data.id`, as a string key. */
export function clickTargetId(ev: RRWebEvent | null | undefined): string {
  const id = ev?.data?.id;
  return id == null ? '' : String(id);
}

/** Counts drained from the detector for one segment (or one collect call). */
export interface FrustrationDrain {
  /** Clicks observed since the last drain (each click = one action). */
  actionCount: number;
  /** rage + dead + error signals finalized in this drain. */
  frustrationCount: number;
  /** Per-type breakdown for dashboard drill-down. */
  byType: { rage: number; dead: number; error: number };
}

/** A finalized frustration signal — one entry per (action, type). */
export interface FrustrationSignal {
  type: FrustrationType;
  /** The click timestamp the signal is attributed to. */
  timestamp: number;
  /** The rrweb target node id, when known (empty for a whole-burst rage). */
  targetId: string;
}

export interface FrustrationDetectorOptions {
  rageThreshold?: number;
  rageWindowMs?: number;
  deadWindowMs?: number;
  errorWindowMs?: number;
  /** Clock used to mature pending clicks in {@link FrustrationDetector.collect}. */
  now?: () => number;
}

interface PendingClick {
  ts: number;
  targetId: string;
  /** A DOM mutation landed inside the dead-click window → not a dead click. */
  hadActivity: boolean;
  /** A JS error landed inside the error-click window → an error click. */
  isError: boolean;
}

/**
 * Pure frustration-signal state machine. See file header for the model.
 */
export class FrustrationDetector {
  readonly rageThreshold: number;
  readonly rageWindowMs: number;
  readonly deadWindowMs: number;
  readonly errorWindowMs: number;
  private readonly _now: () => number;

  // Recent same-element click timestamps, pruned to the rage window per click.
  private _recentByTarget = new Map<string, number[]>();
  // Whether a rage burst is already flagged for a target (debounce: one signal
  // per burst until the window empties back below the threshold).
  private _burstActive = new Map<string, boolean>();
  // Clicks awaiting dead/error resolution.
  private _pending: PendingClick[] = [];
  // Finalized signals not yet drained (kept so callers can stamp per-action).
  private _signals: FrustrationSignal[] = [];

  // Drain accumulators.
  private _actions = 0;
  private _rage = 0;
  private _dead = 0;
  private _error = 0;

  constructor(opts: FrustrationDetectorOptions = {}) {
    this.rageThreshold =
      opts.rageThreshold != null && opts.rageThreshold >= 0
        ? opts.rageThreshold
        : RAGE_CLICK_THRESHOLD;
    this.rageWindowMs =
      opts.rageWindowMs && opts.rageWindowMs > 0 ? opts.rageWindowMs : RAGE_CLICK_WINDOW_MS;
    this.deadWindowMs =
      opts.deadWindowMs && opts.deadWindowMs > 0 ? opts.deadWindowMs : DEAD_CLICK_WINDOW_MS;
    this.errorWindowMs =
      opts.errorWindowMs && opts.errorWindowMs > 0 ? opts.errorWindowMs : ERROR_CLICK_WINDOW_MS;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  }

  /** Longest resolution window — a pending click matures once this elapses. */
  private get _maturityMs(): number {
    return Math.max(this.deadWindowMs, this.errorWindowMs);
  }

  /**
   * Register a click. Increments the action count, resolves rage immediately
   * (one signal per burst), and queues the click for dead/error resolution.
   */
  recordClick(targetId: any, ts: number): void {
    const key = targetId == null ? '' : String(targetId);
    this._actions += 1;

    const recent = this._recentByTarget.get(key) ?? [];
    // Drop clicks older than the rage window relative to THIS click.
    const cutoff = ts - this.rageWindowMs;
    const kept = recent.filter((t) => t > cutoff);
    kept.push(ts);
    this._recentByTarget.set(key, kept);

    if (kept.length > this.rageThreshold) {
      if (!this._burstActive.get(key)) {
        this._burstActive.set(key, true);
        this._rage += 1;
        this._signals.push({ type: FRUSTRATION_RAGE, timestamp: ts, targetId: key });
      }
    } else {
      // Window fell back at/below the threshold (a gap reset it) — allow the
      // next over-threshold run to fire a fresh burst.
      this._burstActive.set(key, false);
    }

    this._maybeSweepAged(cutoff);
    this._pending.push({ ts, targetId: key, hadActivity: false, isError: false });
  }

  /**
   * Bound the rage-tracking maps: once more than {@link MAX_TRACKED_TARGETS}
   * distinct targets are tracked, drop every target whose most-recent click has
   * already aged past the rage window (`newest <= cutoff`) — it can no longer
   * contribute to a burst, and a later click re-creates it fresh. Amortized
   * O(1): the O(n) sweep only runs when the cap is exceeded. The just-clicked
   * target is never swept (its newest click `ts > cutoff`).
   */
  private _maybeSweepAged(cutoff: number): void {
    if (this._recentByTarget.size <= MAX_TRACKED_TARGETS) return;
    for (const [k, arr] of this._recentByTarget) {
      // Clicks are pushed in monotonic time order, so the last entry is newest.
      if (arr.length === 0 || arr[arr.length - 1] <= cutoff) {
        this._recentByTarget.delete(k);
        this._burstActive.delete(k);
      }
    }
  }

  /**
   * Register a DOM mutation. Any pending click whose dead-click window covers
   * `ts` is marked as having caused activity, so it will NOT be a dead click.
   */
  recordMutation(ts: number): void {
    for (const p of this._pending) {
      if (ts >= p.ts && ts - p.ts <= this.deadWindowMs) p.hadActivity = true;
    }
  }

  /**
   * Register a JS error. Any pending click whose error-click window covers `ts`
   * is marked as an error click.
   */
  recordError(ts: number): void {
    for (const p of this._pending) {
      if (ts >= p.ts && ts - p.ts <= this.errorWindowMs) p.isError = true;
    }
  }

  /**
   * Feed a raw rrweb event: dispatches clicks and DOM mutations. Errors are NOT
   * carried by the rrweb stream — call {@link recordError} from the page's
   * error listener. `ts` defaults to the event's own `timestamp`.
   */
  recordEvent(ev: RRWebEvent | null | undefined, ts?: number): void {
    if (!ev) return;
    const at =
      typeof ts === 'number' ? ts : typeof ev.timestamp === 'number' ? ev.timestamp : this._now();
    if (isClickEvent(ev)) {
      this.recordClick(clickTargetId(ev), at);
    } else if (isDomMutationEvent(ev)) {
      this.recordMutation(at);
    }
  }

  /** Number of clicks still awaiting dead/error resolution (for tests). */
  get pendingCount(): number {
    return this._pending.length;
  }

  /** Distinct clicked-target ids currently tracked for rage detection (tests). */
  get trackedTargetCount(): number {
    return this._recentByTarget.size;
  }

  /**
   * Finalize matured pending clicks and return the CURRENT accumulated counts
   * WITHOUT resetting them.
   *
   * A pending click matures once its longest window has elapsed
   * (`now - ts >= max(deadWindow, errorWindow)`), or immediately when `force`
   * is set (view close / teardown / terminal flush) — a forced-immature click
   * is resolved with whatever is known so far (dead if it never saw a mutation).
   * Maturation is monotonic: a click is removed from the pending queue as it
   * finalizes, so repeated peeks never double-count it.
   *
   * This is the read half of a two-phase drain: peek to build a segment's meta,
   * then {@link commitDrain} ONLY after the segment is confirmed delivered.
   * Because the accumulators survive until commit, a failed-and-retried flush
   * re-sends the SAME counts instead of silently dropping them to zero.
   */
  matureAndPeek(now?: number, { force = false }: { force?: boolean } = {}): FrustrationDrain {
    const at = typeof now === 'number' ? now : this._now();
    const stillPending: PendingClick[] = [];
    for (const p of this._pending) {
      const matured = force || at - p.ts >= this._maturityMs;
      if (!matured) {
        stillPending.push(p);
        continue;
      }
      if (!p.hadActivity) {
        this._dead += 1;
        this._signals.push({ type: FRUSTRATION_DEAD, timestamp: p.ts, targetId: p.targetId });
      }
      if (p.isError) {
        this._error += 1;
        this._signals.push({ type: FRUSTRATION_ERROR, timestamp: p.ts, targetId: p.targetId });
      }
    }
    this._pending = stillPending;

    return {
      actionCount: this._actions,
      frustrationCount: this._rage + this._dead + this._error,
      byType: { rage: this._rage, dead: this._dead, error: this._error },
    };
  }

  /**
   * Commit a previously PEEKED drain after a confirmed delivery — the commit
   * half of the two-phase drain (see {@link matureAndPeek}).
   *
   * Subtracts EXACTLY the snapshot's amounts from the live accumulators (and
   * drops that many leading signals), rather than zeroing live state. This is
   * the crucial difference: `matureAndPeek` runs BEFORE `await submitSegment`,
   * but events keep arriving on the rrweb emit callback WHILE the submit is in
   * flight — a click bumps `_actions`, a completed burst bumps `_rage`. Zeroing
   * on commit would wipe those post-peek increments even though they were not in
   * the meta just sent, silently dropping them from the next segment. Subtracting
   * the snapshot leaves exactly the post-peek accumulation intact for the next
   * flush. `_signals` mirrors `_rage + _dead + _error` one-to-one and is appended
   * in order, so removing the leading `frustrationCount` entries drops precisely
   * the committed signals and keeps any that accrued after the peek.
   *
   * Passing no snapshot zeroes everything (legacy one-shot commit) — only safe
   * when nothing can accumulate between peek and commit.
   */
  commitDrain(snapshot?: FrustrationDrain): void {
    if (!snapshot) {
      this._actions = 0;
      this._rage = 0;
      this._dead = 0;
      this._error = 0;
      this._signals = [];
      return;
    }
    this._actions = Math.max(0, this._actions - snapshot.actionCount);
    this._rage = Math.max(0, this._rage - snapshot.byType.rage);
    this._dead = Math.max(0, this._dead - snapshot.byType.dead);
    this._error = Math.max(0, this._error - snapshot.byType.error);
    const committedSignals = snapshot.byType.rage + snapshot.byType.dead + snapshot.byType.error;
    if (committedSignals > 0) this._signals.splice(0, committedSignals);
  }

  /**
   * Finalize matured pending clicks and drain the accumulated counts in one
   * step (peek + commit). Returns the deltas SINCE THE LAST DRAIN and resets the
   * drained amounts, so successive calls partition counts with no double-counting.
   * Use this for the standalone/one-shot case; the flusher uses the two-phase
   * {@link matureAndPeek} + {@link commitDrain} so counts survive a failed submit
   * AND post-peek increments during an in-flight submit are not lost.
   */
  collect(now?: number, { force = false }: { force?: boolean } = {}): FrustrationDrain {
    const drain = this.matureAndPeek(now, { force });
    this.commitDrain(drain);
    return drain;
  }

  /**
   * Drain the finalized signals accumulated since the last {@link collect}.
   * Non-destructive of counts; used by callers that want per-action stamping.
   * Note: {@link collect} clears signals too, so read this BEFORE collecting if
   * both are needed.
   */
  drainSignals(): FrustrationSignal[] {
    const out = this._signals;
    this._signals = [];
    return out;
  }

  /** Reset to the empty state (view change / teardown). */
  reset(): void {
    this._recentByTarget.clear();
    this._burstActive.clear();
    this._pending = [];
    this._signals = [];
    this._actions = 0;
    this._rage = 0;
    this._dead = 0;
    this._error = 0;
  }
}
