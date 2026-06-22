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
// A full snapshot whose captured DOM has at most this many element nodes is
// treated as a pre-mount "shell" (e.g. the app's initial loading spinner before
// the SPA mounts real content) rather than a populated page. Real app screens
// have hundreds of elements; a boot splash has a handful. Used both to decide
// whether the recording opened on a shell (so the recorder takes an early
// post-mount checkout) and to skip such a shell as the replay's OPENING frame.
export const PREMOUNT_SHELL_MAX_ELEMENTS = 50;
// How many nodes the SPA must add (via mutation incrementals) after a pre-mount
// shell snapshot before we consider it "mounted" and take a fresh full snapshot
// — so the rolling buffer holds a populated anchor near the start of the
// session, not just the empty boot splash.
const MOUNT_NODE_THRESHOLD = 50;
// Collapse a storm of uncaught errors into at most one upload per window.
const ERROR_FLUSH_THROTTLE_MS = 30_000;
// Hard ceiling on how long the ingest upload may run before it's aborted, so a
// slow/stalled `/api/replays` can never wedge a flush.
//
// This is the REAL upload deadline (the fetch's own AbortSignal), so it must be
// sized for actual replay payloads, not a token few seconds. A mask-all full
// snapshot of a populated Agent Hub page routinely gzips to hundreds of KB and,
// for a heavy board / long session, into the multi-MB range (observed up to
// ~7 MB gzipped). At a typical home/office uplink (a few Mbps) a 4 s ceiling
// aborts any capture past ~1.5 MB mid-flight — the upload silently fails, the
// flush returns null, and the bug report lands with NO replay attached. That is
// exactly the "replays are not attaching" failure: the capture records fine, the
// upload just never finishes in time. 10 s covers the bulk of real captures
// while still bounding a genuinely stalled endpoint.
export const UPLOAD_TIMEOUT_MS = 10_000;
// Small margin between the upload deadline and the flush backstop below, so the
// fetch's own (clean, null-resolving) abort wins the race ahead of the backstop.
const BACKSTOP_MARGIN_MS = 2_000;
// Backstop bound applied *inside* flush(). Strictly larger than the upload
// timeout so the fetch's own abort normally wins; this only fires if something
// upstream of the fetch hangs (serialization, a custom transport). Because it
// lives inside flush(), the `finally` always runs and `_flushing` is cleared
// even when the underlying submit never settles.
export const FLUSH_TIMEOUT_MS = UPLOAD_TIMEOUT_MS + BACKSTOP_MARGIN_MS;

// Resolved by the internal flush timeout; distinct from a real (possibly null)
// submit result so we never cache a timeout as `lastResult`.
const FLUSH_TIMED_OUT = Symbol('flush-timed-out');

// Privacy contract for the recorder. Two modes, selectable per deployment:
//
//   - 'mask-all'  (default) — every input value AND all text is masked
//     (recorded as a same-length redaction) unless a region opts back in with
//     `ah-replay-unmask`. This is the right default for Agent Hub itself, whose
//     screens routinely show user prompts, support content, terminal/session
//     output, and copied secrets. The replay still captures structure, layout,
//     navigation, clicks and timing — enough to reproduce most UI bugs —
//     without exfiltrating content.
//
//   - 'passwords-only' — masks only `<input type="password">`; all other input
//     values and visible text are recorded verbatim. Appropriate for instrumenting
//     OTHER apps that don't surface secrets as text, where a readable replay is
//     worth more than blanket redaction. Opt into this deliberately — it ships
//     page content to the central hub.
//
// In every mode the class-based opt-outs still apply:
//   - `ah-replay-block`   → element is fully blocked (recorded as a placeholder box)
//   - `ah-replay-ignore`  → element's input events are ignored
//   - `ah-replay-unmask`  → text inside is recorded verbatim (use sparingly)
export const MASKING_MODE_KEY = 'agent-hub-replay-masking-mode';

export const MASKING_MODES = Object.freeze({
  ALL: 'mask-all',
  PASSWORDS: 'passwords-only',
});

const REPLAY_CLASS_OPTIONS = Object.freeze({
  blockClass: 'ah-replay-block',
  ignoreClass: 'ah-replay-ignore',
  unmaskTextClass: 'ah-replay-unmask',
});

/**
 * Build the rrweb `record()` privacy options for a masking mode. Pure — no DOM,
 * no rrweb import — so it is unit-testable in isolation. Unknown modes fall back
 * to the strict `mask-all` default (the safe direction).
 */
export function buildRecordPrivacyOptions(mode) {
  if (mode === MASKING_MODES.PASSWORDS) {
    return Object.freeze({
      ...REPLAY_CLASS_OPTIONS,
      maskAllInputs: false,
      maskInputOptions: Object.freeze({ password: true }),
    });
  }
  return Object.freeze({
    ...REPLAY_CLASS_OPTIONS,
    maskAllInputs: true,
    maskInputOptions: Object.freeze({ password: true }),
    maskTextSelector: '*',
  });
}

/**
 * Resolve the active masking mode from the localStorage override the RUM
 * settings toggle writes. Defaults to the strict `mask-all` mode — a missing or
 * unrecognised value is always treated as the safe, content-redacting default.
 */
export function resolveMaskingMode() {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(MASKING_MODE_KEY);
      if (v === MASKING_MODES.PASSWORDS) return MASKING_MODES.PASSWORDS;
    }
  } catch {
    // ignore — fall through to the safe default
  }
  return MASKING_MODES.ALL;
}

// Strict, content-redacting options. Kept as the recorder's constructor default
// and the resolved options for `mask-all` mode.
export const DEFAULT_RECORD_PRIVACY_OPTIONS = buildRecordPrivacyOptions(MASKING_MODES.ALL);

/** True when `events` contains at least one rrweb full-snapshot event. */
export function hasFullSnapshot(events) {
  return Array.isArray(events) && events.some((e) => e && e.type === RRWEB_FULL_SNAPSHOT);
}

/** Ingest endpoint, derived from the bug-report endpoint's origin. */
export const REPLAY_INGEST_ENDPOINT = BUG_REPORT_ENDPOINT.replace(
  /\/api\/bug-reports\/?$/,
  '/api/replays',
);

// localStorage key holding the user's explicit on/off choice (and any
// fractional sample-rate an operator pokes in for repro). The RUM settings
// toggle reads and writes this; it is the single source of truth for whether
// the recorder runs, overriding the build-time env baseline.
export const REPLAY_SAMPLE_RATE_KEY = 'agent-hub-replay-sample-rate';

/** Clamp an arbitrary value to a valid sample rate in [0, 1]. */
export function clampSampleRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * Resolve the effective sample rate. **On (1) by default** — session replay is
 * the visual context that backs bug reports, so it records unless explicitly
 * turned off. Resolution order:
 *   1. localStorage override (the RUM settings toggle writes '1' / '0' here) —
 *      always wins when present, so a user's explicit choice is honoured.
 *   2. a build-time Vite env baseline (`VITE_SESSION_REPLAY_SAMPLE_RATE`) when
 *      set — lets an operator dial a fractional rollout.
 *   3. otherwise default to 1 (fully on).
 */
export function resolveSampleRate() {
  let override;
  try {
    if (typeof localStorage !== 'undefined') {
      override = localStorage.getItem(REPLAY_SAMPLE_RATE_KEY);
    }
  } catch {
    override = undefined;
  }
  if (override != null && override !== '') return clampSampleRate(override);
  const envRate =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_SESSION_REPLAY_SAMPLE_RATE
      : undefined;
  // Env unset → on by default. Env set (even "0") → honour the operator baseline.
  if (envRate == null || envRate === '') return 1;
  return clampSampleRate(envRate);
}

/** True when session replay is currently enabled (effective sample rate > 0). */
export function isSessionReplayEnabled() {
  return resolveSampleRate() > 0;
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
 * Count the element nodes (rrweb serialized NodeType.Element === 2 — distinct
 * from the rrweb EventType.FullSnapshot, which is also 2) inside a serialized
 * rrweb node and its entire `childNodes` subtree. Returns 0 for a null/leaf
 * node. Iterative to stay safe on deep DOMs. Pure — no DOM, no rrweb import.
 */
export function countElementsInNode(root) {
  if (!root) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 2) count += 1; // serialized element node
    const kids = node.childNodes;
    if (Array.isArray(kids)) {
      for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
  }
  return count;
}

/**
 * Count the element nodes inside a full-snapshot event's captured DOM tree.
 * Returns 0 when the event carries no node tree (synthetic/legacy events), so
 * callers treat "unknown" as "don't skip / not a shell". Pure.
 */
export function countSnapshotElements(snapshotEvent) {
  return countElementsInNode(snapshotEvent && snapshotEvent.data && snapshotEvent.data.node);
}

/**
 * Select the slice of a rolling buffer to upload as a replay, opening on a
 * RECENT full snapshot.
 *
 * The buffer can span far more than the trailing window when rrweb's
 * activity-gated `checkoutEveryNms` doesn't fire: the page idles for minutes
 * (no events → no checkout), or the very first snapshot is taken at `record()`
 * start before the SPA has mounted (an empty `#root`). The memory pruner
 * (`pruneBuffer`) anchors to "the newest snapshot at/before the cutoff" to keep
 * a full window of context — but when that snapshot is stale or pre-mount, the
 * upload opens on a blank page and replays the whole dead gap.
 *
 * For a flush we instead prefer a recent snapshot:
 *   - cutoff = now - windowMs.
 *   - If any full snapshot falls inside the trailing window (ts >= cutoff),
 *     anchor to the OLDEST such snapshot — the most recent context that still
 *     opens on a populated, replayable state, with any older pre-mount/idle
 *     snapshot and its dead gap dropped.
 *   - Otherwise (every snapshot predates the window) anchor to the NEWEST
 *     snapshot overall — the freshest state available rather than the oldest.
 * The Meta event rrweb emits immediately before a snapshot is included so the
 * slice always opens replayable.
 *
 * Pure — no DOM, no rrweb import — so it is unit-testable in isolation. Returns
 * the array unchanged when it holds no full snapshot (flush() then declines it
 * as non-replayable).
 */
export function selectFlushWindow(events, now, windowMs = DEFAULT_WINDOW_MS) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const cutoff = now - windowMs;

  const inWindow = []; // indices of full snapshots with ts >= cutoff, oldest→newest
  let newestSnapshot = -1; // last full snapshot overall
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.type !== RRWEB_FULL_SNAPSHOT) continue;
    newestSnapshot = i;
    if (e.timestamp >= cutoff) inWindow.push(i);
  }

  if (newestSnapshot === -1) return events; // no snapshot — flush() declines it

  let startIdx;
  if (inWindow.length === 0) {
    // Every snapshot predates the window → open on the freshest state available.
    startIdx = newestSnapshot;
  } else {
    // Default: the oldest in-window snapshot, to keep a full window of context.
    //
    // But a session SHORTER than the trailing window keeps its very first,
    // pre-mount snapshot in-window — a near-empty app shell (e.g. a loading
    // spinner captured before the SPA mounted). Opening there makes the replay
    // look blank for the whole lead-in. So skip leading pre-mount SHELLS as long
    // as a later in-window snapshot is more populated: the replay opens on the
    // first real, rendered state while still preserving the interaction history
    // that follows it. (The time-based cutoff above already drops shells that
    // fall outside the window; this also handles the short-session case the
    // cutoff can't.) When counts are unknown (no node tree) nothing is skipped,
    // so the behaviour is unchanged for callers that don't carry DOM trees.
    const counts = inWindow.map((i) => countSnapshotElements(events[i]));
    const maxCount = Math.max(...counts);
    let pos = 0;
    while (
      pos < inWindow.length - 1 &&
      counts[pos] <= PREMOUNT_SHELL_MAX_ELEMENTS &&
      counts[pos] < maxCount
    ) {
      pos += 1;
    }
    startIdx = inWindow[pos];
  }

  // Include the Meta event rrweb emits immediately before a snapshot.
  if (startIdx > 0 && events[startIdx - 1] && events[startIdx - 1].type === RRWEB_META) {
    startIdx -= 1;
  }
  return startIdx > 0 ? events.slice(startIdx) : events;
}

/**
 * Gzip a UTF-8 string into raw gzip-framed bytes using the platform
 * `CompressionStream`, or return null when compression isn't available or
 * fails. The server sniffs the gzip magic bytes (no `Content-Encoding` header
 * needed), so the returned bytes can be POSTed as `application/octet-stream`.
 * Best-effort — any failure falls back to an uncompressed JSON upload.
 */
export async function gzipString(text) {
  try {
    if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined') return null;
    const stream = new Response(text).body?.pipeThrough(new CompressionStream('gzip'));
    if (!stream) return null;
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * POST a buffered replay to the ingest endpoint. Resolves with the parsed
 * `{ replayId, replayRef }` on success; throws on a non-2xx response.
 *
 * The body is gzip-compressed when the platform supports it — rrweb JSON
 * compresses ~10-20x, so a heavy page's snapshot that would blow past the
 * server's body-size limit as raw JSON (HTTP 413) fits comfortably once
 * gzipped. Compressed bytes are sent as `application/octet-stream` with the
 * gzip magic bytes intact; the server inflates them transparently. Falls back
 * to uncompressed JSON when `CompressionStream` is unavailable.
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
  const json = JSON.stringify({ events, meta: meta || undefined });
  const gzipped = await gzipString(json);
  const res = await fetch(endpoint, {
    method: 'POST',
    mode: 'cors',
    headers: gzipped
      ? { 'Content-Type': 'application/octet-stream' }
      : { 'Content-Type': 'application/json' },
    body: gzipped || json,
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
    // Wrap `submitReplay` so the recorder can drive the upload's fetch-abort
    // deadline from the active flush budget (see `_runFlush`). Calling
    // `submitReplay` directly would put the timeout in the `endpoint` slot, so
    // the wrapper keeps the default endpoint and forwards only the timeout.
    submit = (payload, uploadTimeoutMs) =>
      submitReplay(payload, REPLAY_INGEST_ENDPOINT, uploadTimeoutMs),
    record = null,
    now = () => Date.now(),
    windowMs = DEFAULT_WINDOW_MS,
    maxEvents = DEFAULT_MAX_EVENTS,
    minFlushEvents = MIN_FLUSH_EVENTS,
    errorThrottleMs = ERROR_FLUSH_THROTTLE_MS,
    flushTimeoutMs = FLUSH_TIMEOUT_MS,
    recordOptions = DEFAULT_RECORD_PRIVACY_OPTIONS,
    takeFullSnapshot = null,
  } = {}) {
    this._record = record;
    this._submit = submit;
    // An explicitly-injected snapshot fn (tests) always wins; otherwise it's
    // picked up from rrweb's `record.takeFullSnapshot` static in start().
    this._injectedTakeFullSnapshot = takeFullSnapshot;
    this._takeFullSnapshot = takeFullSnapshot;
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

    // Post-mount checkout state. When a recording opens on a pre-mount shell
    // (empty #root + a boot spinner), the only snapshot near the start is
    // un-replayable blank. We watch the mutations that mount the SPA and, once
    // enough nodes have been added, take ONE fresh full snapshot so the buffer
    // holds a populated anchor early in the session (see _maybeSnapshotOnMount).
    this._sawInitialSnapshot = false;
    this._initialSnapshotWasShell = false;
    this._mountedNodesAdded = 0;
    this._tookMountSnapshot = false;
  }

  /** Begin recording. `recordFn` overrides the injected rrweb `record`. */
  start(recordFn) {
    if (this.active) return;
    const record = recordFn || this._record;
    if (typeof record !== 'function') {
      throw new Error('SessionReplayRecorder.start requires an rrweb record function');
    }
    // rrweb exposes `takeFullSnapshot` as a static on the record fn; capture it
    // so flush() can force a fresh checkout. An injected fn (tests) wins.
    this._takeFullSnapshot =
      this._injectedTakeFullSnapshot ||
      (typeof record.takeFullSnapshot === 'function' ? record.takeFullSnapshot : null);
    // Fresh mount-detection state for this recording session (record() emits a
    // new initial snapshot we must re-classify after a stop/start, e.g. on a
    // masking-mode change).
    this._sawInitialSnapshot = false;
    this._initialSnapshotWasShell = false;
    this._mountedNodesAdded = 0;
    this._tookMountSnapshot = false;
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
    this._maybeSnapshotOnMount(event);
  }

  /**
   * Take a single fresh full snapshot the moment the SPA first mounts real
   * content, when the recording opened on a pre-mount shell.
   *
   * rrweb's first snapshot is taken at `record()` start — if the app's #root is
   * still an empty loading splash then, that boot snapshot is a near-empty
   * shell. For a short session (shorter than the trailing window) that shell
   * stays in-window and becomes the replay's opening frame, so the replay looks
   * blank until playback reaches the mount mutations. By forcing one checkout
   * once enough nodes have been added, the buffer gains a populated snapshot
   * early in the session; `selectFlushWindow` then opens the upload on THAT real
   * state while keeping every interaction that follows it.
   *
   * One-shot and self-guarding: only fires when the initial snapshot was a shell,
   * never re-enters (the forced snapshot's own emit is ignored), and is a no-op
   * for recordings that already opened populated — so it changes nothing for the
   * common case.
   */
  _maybeSnapshotOnMount(event) {
    if (this._tookMountSnapshot || !event) return;
    if (event.type === RRWEB_FULL_SNAPSHOT) {
      // Classify the FIRST snapshot: did the recording open on a shell?
      if (!this._sawInitialSnapshot) {
        this._sawInitialSnapshot = true;
        this._initialSnapshotWasShell = countSnapshotElements(event) <= PREMOUNT_SHELL_MAX_ELEMENTS;
      }
      return;
    }
    // Only chase a mount when the recording opened on a shell. A session that
    // started populated needs no extra checkout.
    if (!this._initialSnapshotWasShell) return;
    // Accumulate ELEMENT nodes added by mutation incrementals
    // (IncrementalSource.Mutation === 0). rrweb can serialize a whole mounted
    // subtree under a SINGLE `adds` entry (one top-level node with a large
    // `childNodes` subtree), so `adds.length` undercounts — an SPA mount that
    // adds hundreds of elements in one add would never reach the threshold.
    // Count the elements inside each added node's subtree instead. Fall back to
    // the add count when an add carries no serialized node (element-less / legacy
    // shapes) so a stream of node-less adds can't stall the detector.
    const data = event.type === 3 ? event.data : null;
    if (data && data.source === 0 && Array.isArray(data.adds)) {
      let added = 0;
      for (let i = 0; i < data.adds.length; i++) {
        added += countElementsInNode(data.adds[i] && data.adds[i].node);
      }
      if (added === 0) added = data.adds.length;
      this._mountedNodesAdded += added;
      if (this._mountedNodesAdded >= MOUNT_NODE_THRESHOLD) {
        // Set the guard BEFORE forcing the snapshot — forceFullSnapshot() emits
        // synchronously back into _handleEmit, and this prevents re-entry.
        this._tookMountSnapshot = true;
        this.forceFullSnapshot();
      }
    }
  }

  /** Snapshot the current buffer (defensive copy). */
  snapshot() {
    return this.buffer.slice();
  }

  /**
   * Force rrweb to emit a fresh full snapshot (a checkout) of the current DOM,
   * so the next flush can open on the exact state at flush time rather than a
   * stale or pre-mount snapshot left behind when no periodic checkout fired
   * during an idle stretch. The snapshot lands in the buffer via the normal
   * emit handler. Best-effort: a no-op when recording is inactive or no
   * snapshot fn was wired, and never throws into the caller's flow. Returns
   * true when a snapshot was taken.
   */
  forceFullSnapshot() {
    if (!this.active || typeof this._takeFullSnapshot !== 'function') return false;
    try {
      this._takeFullSnapshot(true); // isCheckout=true → emits Meta + FullSnapshot
      return true;
    } catch {
      return false;
    }
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
    // Capture the current DOM as a fresh checkout first, so the upload opens on
    // the exact state at flush time even when no periodic checkout fired during
    // an idle stretch (otherwise the only snapshot may be stale or pre-mount).
    this.forceFullSnapshot();
    // Open the replay on a recent snapshot rather than the memory pruner's
    // "newest snapshot before the cutoff" — which, after an idle gap or a
    // pre-mount initial snapshot, would open blank and replay the dead gap.
    const events = selectFlushWindow(this.snapshot(), this._now(), this.windowMs);
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
      // Drive the upload's own fetch-abort from the flush budget so a caller's
      // generous timeout actually extends the upload instead of being silently
      // capped by submitReplay's own default. Kept a margin below the backstop
      // race so the fetch's clean (null-resolving) abort wins first. When no
      // backstop is set, fall back to submitReplay's default deadline.
      const uploadTimeoutMs =
        timeoutMs > 0 ? Math.max(1_000, timeoutMs - BACKSTOP_MARGIN_MS) : undefined;
      // Bound the whole submit here, not in an outer race: if the submit hangs
      // upstream of its own AbortSignal, this timeout still settles the race.
      const submitPromise = Promise.resolve().then(() =>
        this._submit({ events, meta }, uploadTimeoutMs),
      );
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
let _errorListenersWired = false;

export function getRecorder() {
  if (!_recorder) _recorder = new SessionReplayRecorder({});
  return _recorder;
}

/**
 * Wire record-on-error listeners exactly once per page. Idempotent so both the
 * boot path (`initSessionReplay`) and a runtime enable (`setSessionReplayEnabled`)
 * can call it without stacking duplicate handlers.
 */
function ensureErrorListeners() {
  if (_errorListenersWired || typeof window === 'undefined') return;
  _errorListenersWired = true;
  const rec = getRecorder();
  window.addEventListener('error', () => {
    rec.handleError({ trigger: 'window.error' });
  });
  window.addEventListener('unhandledrejection', () => {
    rec.handleError({ trigger: 'unhandledrejection' });
  });
}

/** Lazy-load rrweb and start the rolling buffer. No-op if already recording. */
async function startRecorder() {
  const rec = getRecorder();
  if (rec.active) return rec;
  // Resolve the masking mode at start — rrweb fixes privacy options when
  // `record()` is called, so the mode is applied here (and re-applied via a
  // stop/start in setMaskingMode when it changes at runtime).
  rec.recordOptions = buildRecordPrivacyOptions(resolveMaskingMode());
  try {
    const mod = await import('rrweb');
    rec.start(mod.record);
  } catch {
    return null;
  }
  ensureErrorListeners();
  return rec;
}

/**
 * Turn session replay on or off at runtime and persist the choice. Writes the
 * localStorage override `resolveSampleRate` reads ('1' / '0') so the decision
 * survives reloads, then live-applies it: enabling starts the recorder (and
 * record-on-error wiring); disabling stops it. Returns the new boolean state.
 *
 * Best-effort and never throws — a storage or rrweb-import failure must not
 * break the settings UI that calls it.
 */
export async function setSessionReplayEnabled(enabled) {
  const next = !!enabled;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(REPLAY_SAMPLE_RATE_KEY, next ? '1' : '0');
    }
  } catch {
    // ignore — persistence is best-effort
  }
  if (next) {
    await startRecorder();
  } else if (_recorder) {
    _recorder.stop();
  }
  return next;
}

/** True when the active masking mode is the strict, content-redacting default. */
export function isMaskAllEnabled() {
  return resolveMaskingMode() === MASKING_MODES.ALL;
}

/**
 * Set the masking mode and persist it. `maskAll === true` selects the strict
 * `mask-all` mode (redact all inputs + text); `false` selects `passwords-only`
 * (mask only password inputs, record everything else). rrweb privacy options are
 * fixed when `record()` starts, so when recording is live this stops and
 * restarts the recorder to apply the new mode. Returns the persisted mode.
 *
 * Best-effort and never throws — a storage or rrweb-import failure must not
 * break the settings UI that calls it.
 */
export async function setReplayMaskingMode(maskAll) {
  const next = maskAll ? MASKING_MODES.ALL : MASKING_MODES.PASSWORDS;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MASKING_MODE_KEY, next);
    }
  } catch {
    // ignore — persistence is best-effort
  }
  // Re-apply live if currently recording: rrweb only reads privacy options at
  // record() start, so a running recorder must be restarted to switch modes.
  if (_recorder && _recorder.active) {
    _recorder.stop();
    await startRecorder();
  }
  return next;
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

  return startRecorder();
}

// ─── Null-flush breadcrumbs ───────────────────────────────────────
//
// A bug-report flush that yields no replay ref is best-effort by design (it
// must never block the report). That historically made a missing replay
// *silent* — indistinguishable from "replay was turned off" — so a captured
// bug report with no attached session showed up with no trace of why. Emit a
// single structured breadcrumb naming the reason instead, so a missing capture
// is diagnosable from the console (and hookable by telemetry) rather than
// invisible.
//
// Reasons: 'recorder-not-initialized' | 'recorder-inactive' |
//          'buffer-too-small' | 'no-full-snapshot' | 'upload-failed'

function defaultBreadcrumbSink(entry) {
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[session-replay] no replay ref produced', entry);
    }
  } catch {
    // ignore — diagnostics must never throw into the caller's flow
  }
}

let _breadcrumbSink = defaultBreadcrumbSink;

/**
 * Override the sink that receives null-flush breadcrumbs (default:
 * `console.warn`). Pass a function to forward `{ reason, trigger }` to
 * telemetry; pass anything else to restore the default. Best-effort: the sink
 * is invoked inside a try/catch so a faulty sink never breaks a flush.
 */
export function setReplayBreadcrumbSink(sink) {
  _breadcrumbSink = typeof sink === 'function' ? sink : defaultBreadcrumbSink;
}

function reportNullFlush(reason, meta) {
  try {
    _breadcrumbSink({ reason, trigger: meta?.trigger ?? null });
  } catch {
    // ignore
  }
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
 *
 * Whenever it returns null it first emits a breadcrumb (see above) naming the
 * reason, so a "captured the report but no replay" case is never silent.
 */
export async function flushSessionReplayRef(meta, timeoutMs) {
  if (!_recorder) {
    reportNullFlush('recorder-not-initialized', meta);
    return null;
  }
  if (!_recorder.active) {
    reportNullFlush('recorder-inactive', meta);
    return null;
  }
  // Pre-classify the no-op cases that `flush()` would otherwise collapse into a
  // silent null, so the breadcrumb can name *why* nothing shipped. These mirror
  // flush()'s own guards (pure checks), leaving its behaviour unchanged.
  const buffered = _recorder.snapshot();
  if (buffered.length < _recorder.minFlushEvents) {
    reportNullFlush('buffer-too-small', meta);
    return null;
  }
  if (!hasFullSnapshot(buffered)) {
    reportNullFlush('no-full-snapshot', meta);
    return null;
  }
  const opts = timeoutMs != null ? { timeoutMs } : undefined;
  const result = await _recorder.flush(meta, opts);
  const ref = result?.replayRef || null;
  // A replayable buffer that still produced no ref means the ingest upload
  // failed, timed out, or was rate-limited.
  if (!ref) reportNullFlush('upload-failed', meta);
  return ref;
}

/** Test-only: reset the module singleton. */
export function _resetSessionReplayForTest() {
  _recorder = null;
  _initialized = false;
  _errorListenersWired = false;
  _breadcrumbSink = defaultBreadcrumbSink;
}
