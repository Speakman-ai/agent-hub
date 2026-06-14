// Session replay (rrweb) recorder.
//
// Embeds rrweb `record()` behind a sampling gate and keeps a bounded, rolling
// in-memory buffer of the trailing window of DOM events. Nothing is uploaded
// while recording — the buffer only leaves the browser when explicitly flushed
// on a bug-report submit or an uncaught error (record-on-error + sampling).
//
// The flush target is the same central Agent Hub the bug-report intake posts
// to, so the returned `/uploads/replay-*.json` ref resolves on the hub whose
// intake agent investigates the report.

import { BUG_REPORT_ENDPOINT } from './bugReport.js';

// rrweb EventType constants (kept local so the pure helpers below don't depend
// on importing rrweb — they run in tests without a DOM). See rrweb's
// `EventType`: Meta = 4, FullSnapshot = 2.
export const RRWEB_FULL_SNAPSHOT = 2;
export const RRWEB_META = 4;

// Trailing window kept in the rolling buffer. 45s sits in the 30–60s range the
// product wants, while a periodic full-snapshot checkout at the same cadence
// guarantees the buffer always opens with a replayable snapshot.
export const DEFAULT_WINDOW_MS = 45_000;
// Hard safety cap on retained events so a chatty page can't grow the buffer
// without bound between checkouts.
export const DEFAULT_MAX_EVENTS = 5_000;
// Don't bother shipping a buffer that can't reconstruct anything.
const MIN_FLUSH_EVENTS = 2;
// Collapse a storm of uncaught errors into at most one upload per window.
const ERROR_FLUSH_THROTTLE_MS = 30_000;
// Hard ceiling on how long the ingest upload may run before it's aborted, so a
// slow/stalled `/api/replays` can never wedge a flush.
const UPLOAD_TIMEOUT_MS = 4_000;
// Backstop bound applied *inside* flush(). Strictly larger than the upload
// timeout so the fetch's own abort normally wins; this only fires if something
// upstream of the fetch hangs (serialization, a custom transport). Because it
// lives inside flush(), the `finally` always runs and `_flushing` is cleared
// even when the underlying submit never settles.
const FLUSH_TIMEOUT_MS = 5_000;

// Resolved by the internal flush timeout; distinct from a real (possibly null)
// submit result so we never cache a timeout as `lastResult`.
const FLUSH_TIMED_OUT = Symbol('flush-timed-out');

// Privacy contract for the recorder. Agent Hub screens routinely show user
// prompts, support content, terminal/session output, and possibly copied
// secrets, so the replay is privacy-first by default: every input value is
// masked and ALL text is masked (recorded as a same-length redaction) unless a
// region opts back in. The replay still captures structure, layout, navigation,
// clicks and interaction timing — enough to reproduce most UI bugs — without
// exfiltrating content.
//
// Opt-out conventions (apply the class to a DOM region):
//   - `ah-replay-block`   → element is fully blocked (recorded as a placeholder box)
//   - `ah-replay-ignore`  → element's input events are ignored
//   - `ah-replay-unmask`  → text inside is recorded verbatim (use sparingly)
export const DEFAULT_RECORD_PRIVACY_OPTIONS = Object.freeze({
  maskAllInputs: true,
  maskInputOptions: Object.freeze({ password: true }),
  maskTextSelector: '*',
  blockClass: 'ah-replay-block',
  ignoreClass: 'ah-replay-ignore',
  unmaskTextClass: 'ah-replay-unmask',
});

/** True when `events` contains at least one rrweb full-snapshot event. */
export function hasFullSnapshot(events) {
  return Array.isArray(events) && events.some((e) => e && e.type === RRWEB_FULL_SNAPSHOT);
}

/** Ingest endpoint, derived from the bug-report endpoint's origin. */
export const REPLAY_INGEST_ENDPOINT = BUG_REPORT_ENDPOINT.replace(
  /\/api\/bug-reports\/?$/,
  '/api/replays',
);

/** Clamp an arbitrary value to a valid sample rate in [0, 1]. */
export function clampSampleRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * Resolve the effective sample rate. Off (0) by default. A build-time Vite env
 * var sets the baseline; a localStorage override (handy for support repro /
 * manual enablement) wins when present.
 */
export function resolveSampleRate() {
  let override;
  try {
    if (typeof localStorage !== 'undefined') {
      override = localStorage.getItem('agent-hub-replay-sample-rate');
    }
  } catch {
    override = undefined;
  }
  if (override != null && override !== '') return clampSampleRate(override);
  const envRate =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_SESSION_REPLAY_SAMPLE_RATE
      : undefined;
  return clampSampleRate(envRate);
}

/** Decide, once per session, whether this client samples in. */
export function shouldSample(rate, rng = Math.random) {
  const r = clampSampleRate(rate);
  if (r <= 0) return false;
  if (r >= 1) return true;
  return rng() < r;
}

/**
 * Prune a rolling buffer to the trailing window while preserving replayability.
 *
 * Keeps every event newer than `now - windowMs`, plus the most recent full
 * snapshot at or before that cutoff (and its preceding Meta event) so the
 * retained slice always opens with a snapshot rrweb can replay from. `maxEvents`
 * is a coarse memory guard: when exceeded, the buffer is trimmed to the most
 * recent `maxEvents` and re-anchored to the first full snapshot within them.
 *
 * Pure function — no DOM, no rrweb import — so it is unit-testable in isolation.
 */
export function pruneBuffer(
  events,
  now,
  windowMs = DEFAULT_WINDOW_MS,
  maxEvents = DEFAULT_MAX_EVENTS,
) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const cutoff = now - windowMs;

  let anchor = -1; // latest full snapshot at/before cutoff
  let firstSnapshot = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i] && events[i].type === RRWEB_FULL_SNAPSHOT) {
      if (firstSnapshot === -1) firstSnapshot = i;
      if (events[i].timestamp <= cutoff) anchor = i;
    }
  }

  let startIdx = anchor !== -1 ? anchor : firstSnapshot !== -1 ? firstSnapshot : 0;
  // Include the Meta event that rrweb emits immediately before a snapshot.
  if (startIdx > 0 && events[startIdx - 1] && events[startIdx - 1].type === RRWEB_META) {
    startIdx -= 1;
  }

  let pruned = startIdx > 0 ? events.slice(startIdx) : events;

  if (pruned.length > maxEvents) {
    const tail = pruned.slice(pruned.length - maxEvents);
    const tailSnap = tail.findIndex((e) => e && e.type === RRWEB_FULL_SNAPSHOT);
    if (tailSnap !== -1) {
      // The retained tail still contains a snapshot — re-anchor to it (and its
      // preceding Meta) so the slice opens replayable.
      let s = tailSnap;
      if (s > 0 && tail[s - 1] && tail[s - 1].type === RRWEB_META) s -= 1;
      pruned = s > 0 ? tail.slice(s) : tail;
    } else {
      // The tail dropped every snapshot. Find the most-recent snapshot still in
      // `pruned` and prepend it (+ its Meta) so the cap never strands a
      // non-replayable tail of incremental events.
      let lastSnap = -1;
      for (let i = pruned.length - 1; i >= 0; i--) {
        if (pruned[i] && pruned[i].type === RRWEB_FULL_SNAPSHOT) {
          lastSnap = i;
          break;
        }
      }
      if (lastSnap === -1) {
        // No snapshot anywhere — keep the most-recent events; flush() declines a
        // snapshot-less buffer since it can't be replayed.
        pruned = tail;
      } else {
        let head = lastSnap;
        if (head > 0 && pruned[head - 1] && pruned[head - 1].type === RRWEB_META) head -= 1;
        const anchor = pruned.slice(head, lastSnap + 1); // Meta? + FullSnapshot
        const room = Math.max(0, maxEvents - anchor.length);
        pruned = anchor.concat(pruned.slice(pruned.length - room));
      }
    }
  }

  return pruned;
}

/**
 * POST a buffered replay to the ingest endpoint. Resolves with the parsed
 * `{ replayId, replayRef }` on success; throws on a non-2xx response.
 */
export async function submitReplay(
  { events, meta } = {},
  endpoint = REPLAY_INGEST_ENDPOINT,
  timeoutMs = UPLOAD_TIMEOUT_MS,
) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('No replay events to submit');
  }
  // Abort a slow/stalled ingest so a flush can never block its caller. Falls
  // back gracefully where AbortSignal.timeout isn't available.
  const signal =
    timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const res = await fetch(endpoint, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events, meta: meta || undefined }),
    signal,
  });
  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      // ignore
    }
    throw new Error(bodyText || `Replay ingest failed (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * Rolling-buffer rrweb recorder. The rrweb `record` function and the upload
 * transport are injected so the recorder is testable without a DOM or network.
 */
export class SessionReplayRecorder {
  constructor({
    record = null,
    submit = submitReplay,
    now = () => Date.now(),
    windowMs = DEFAULT_WINDOW_MS,
    maxEvents = DEFAULT_MAX_EVENTS,
    minFlushEvents = MIN_FLUSH_EVENTS,
    errorThrottleMs = ERROR_FLUSH_THROTTLE_MS,
    flushTimeoutMs = FLUSH_TIMEOUT_MS,
    recordOptions = DEFAULT_RECORD_PRIVACY_OPTIONS,
  } = {}) {
    this._record = record;
    this._submit = submit;
    this._now = now;
    this.windowMs = windowMs;
    this.maxEvents = maxEvents;
    this.minFlushEvents = minFlushEvents;
    this.errorThrottleMs = errorThrottleMs;
    this.flushTimeoutMs = flushTimeoutMs;
    this.recordOptions = recordOptions;

    this.buffer = [];
    this.active = false;
    this._stopFn = null;
    // The in-flight flush promise, or null when idle. Overlapping callers share
    // it (see flush) rather than getting a stale lastResult.
    this._activeFlush = null;
    // -Infinity so the very first error-triggered flush is never throttled.
    this._lastErrorFlushAt = -Infinity;
    this.lastResult = null;
  }

  /** Begin recording. `recordFn` overrides the injected rrweb `record`. */
  start(recordFn) {
    if (this.active) return;
    const record = recordFn || this._record;
    if (typeof record !== 'function') {
      throw new Error('SessionReplayRecorder.start requires an rrweb record function');
    }
    this.active = true;
    this._stopFn =
      record({
        // Privacy options first so an explicit emit/checkout below can't be
        // accidentally clobbered by a caller-supplied recordOptions.
        ...this.recordOptions,
        emit: (event) => this._handleEmit(event),
        checkoutEveryNms: this.windowMs,
      }) || null;
  }

  _handleEmit(event) {
    this.buffer.push(event);
    this.buffer = pruneBuffer(this.buffer, this._now(), this.windowMs, this.maxEvents);
  }

  /** Snapshot the current buffer (defensive copy). */
  snapshot() {
    return this.buffer.slice();
  }

  /**
   * Flush the trailing window to the ingest endpoint. Returns the ingest result
   * (`{ replayId, replayRef }`) or null when there's nothing worth sending or
   * the upload fails (never throws — a flush must not break the caller's flow).
   */
  async flush(meta, { timeoutMs = this.flushTimeoutMs } = {}) {
    // Share an in-flight flush: overlapping callers (e.g. a bug-report submit
    // arriving while an error-triggered flush is mid-upload) await the same
    // promise and get the same fresh result, instead of an immediate stale
    // lastResult.
    if (this._activeFlush) return this._activeFlush;
    const events = this.snapshot();
    if (events.length < this.minFlushEvents) return null;
    // A buffer with no full snapshot can't be replayed — don't ship a ref that
    // would later be surfaced (untrusted) into an intake prompt.
    if (!hasFullSnapshot(events)) return null;

    const p = this._runFlush(events, meta, timeoutMs);
    this._activeFlush = p;
    try {
      return await p;
    } finally {
      // Cleared once the bounded flush settles. Because _runFlush is itself
      // timeout-bounded, this always runs even if the upload never settles —
      // a wedged upload can never disable replay for the rest of the session.
      this._activeFlush = null;
    }
  }

  /** Bounded single upload attempt. Never throws; resolves null on failure/timeout. */
  async _runFlush(events, meta, timeoutMs) {
    let timer;
    try {
      // Bound the whole submit here, not in an outer race: if the submit hangs
      // upstream of its own AbortSignal, this timeout still settles the race.
      const submitPromise = Promise.resolve().then(() => this._submit({ events, meta }));
      // Swallow a late rejection (after the timeout already won) so it never
      // surfaces as an unhandledrejection.
      submitPromise.catch(() => {});
      const timeout =
        timeoutMs > 0
          ? new Promise((resolve) => {
              timer = setTimeout(() => resolve(FLUSH_TIMED_OUT), timeoutMs);
            })
          : null;
      const result = await (timeout ? Promise.race([submitPromise, timeout]) : submitPromise);
      if (result === FLUSH_TIMED_OUT) return null;
      this.lastResult = result || null;
      return this.lastResult;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Record-on-error entry point: throttled flush triggered by an uncaught error. */
  async handleError(meta) {
    const now = this._now();
    if (now - this._lastErrorFlushAt < this.errorThrottleMs) return null;
    this._lastErrorFlushAt = now;
    return this.flush({ ...(meta || {}), trigger: meta?.trigger || 'error' });
  }

  stop() {
    if (this._stopFn) {
      try {
        this._stopFn();
      } catch {
        // ignore
      }
    }
    this._stopFn = null;
    this.active = false;
  }
}

// ─── Module singleton wiring ──────────────────────────────────────

let _recorder = null;
let _initialized = false;

export function getRecorder() {
  if (!_recorder) _recorder = new SessionReplayRecorder({});
  return _recorder;
}

/**
 * Initialise session replay once on app boot. Resolves the sample rate, and
 * only when this client samples in does it lazy-load rrweb, start the rolling
 * buffer, and wire record-on-error listeners. Off by default and a complete
 * no-op when not sampled in. Safe to call outside a browser.
 */
export async function initSessionReplay(opts = {}) {
  if (typeof window === 'undefined') return null;
  if (_initialized) return _recorder;
  _initialized = true;

  const sampleRate = opts.sampleRate ?? resolveSampleRate();
  const rng = opts.rng ?? Math.random;
  if (!shouldSample(sampleRate, rng)) return null;

  const rec = getRecorder();
  try {
    const mod = await import('rrweb');
    rec.start(mod.record);
  } catch {
    return null;
  }

  window.addEventListener('error', () => {
    rec.handleError({ trigger: 'window.error' });
  });
  window.addEventListener('unhandledrejection', () => {
    rec.handleError({ trigger: 'unhandledrejection' });
  });

  return rec;
}

/**
 * Flush the active replay buffer and return its `/uploads/...` ref, or null if
 * recording is inactive / empty / not replayable / the upload failed or stalled.
 * Used by the bug-report modal to attach a replay to a submitted report.
 *
 * The flush is best-effort and self-bounded inside `flush()` (which clears its
 * own `_flushing` state on timeout), so this helper never leaves the recorder
 * wedged and the report always proceeds. `timeoutMs`, when given, overrides the
 * recorder's default flush bound.
 */
export async function flushSessionReplayRef(meta, timeoutMs) {
  if (!_recorder || !_recorder.active) return null;
  const opts = timeoutMs != null ? { timeoutMs } : undefined;
  const result = await _recorder.flush(meta, opts);
  return result?.replayRef || null;
}

/** Test-only: reset the module singleton. */
export function _resetSessionReplayForTest() {
  _recorder = null;
  _initialized = false;
}
