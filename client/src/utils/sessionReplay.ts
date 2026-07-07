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

import { BUG_REPORT_ENDPOINT } from './bugReport';

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

// ─── Continuous capture (whole-session streaming) ─────────────────
//
// When a project opts into the continuous tier, the recorder streams the WHOLE
// session as appended chunks to the chunked-ingest endpoint
// (`POST /api/replays/:id/events`) on a periodic interval plus a tab-close tail
// flush. This is OFF by default and additive to the always-on record-on-error
// path. v1 reuses the existing monolithic-append storage (no segmented rewrite),
// which is acceptable at ~5-min cadence (~6 flushes / 30-min session) but NOT at
// sub-minute cadence — hence the >=60s floor below. Sub-minute streaming is the
// deferred segmented-storage upgrade.

/** Default continuous-flush cadence (5 min) — the MVP interval. */
export const DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** Sub-minute cadence is not supported on the monolithic-append MVP storage. */
export const MIN_CONTINUOUS_FLUSH_INTERVAL_MS = 60 * 1000;
/** Bound the tail-loss window: at most this long between flushes. */
export const MAX_CONTINUOUS_FLUSH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Clamp a continuous-flush cadence into the deliverable range. A non-finite /
 * unset value resolves to the 5-min default; a sub-minute value is raised to the
 * floor (the MVP storage can't go faster), an excessive one capped to the
 * ceiling. Pure — unit-testable in isolation.
 */
export function clampContinuousFlushInterval(value: any) {
  // null / undefined are "unset" → default (NOT coerced to 0, which would floor).
  if (value == null) return DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS;
  if (n < MIN_CONTINUOUS_FLUSH_INTERVAL_MS) return MIN_CONTINUOUS_FLUSH_INTERVAL_MS;
  if (n > MAX_CONTINUOUS_FLUSH_INTERVAL_MS) return MAX_CONTINUOUS_FLUSH_INTERVAL_MS;
  return n;
}

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
export function buildRecordPrivacyOptions(mode: any) {
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
 * Resolve the active masking mode. The strict `mask-all` mode is the default,
 * and a server-delivered policy that enforces it wins over any per-browser
 * `passwords-only` choice — whole-session recording sharply widens the privacy
 * surface, so when the project enforces mask-all it is not overridable
 * client-side. Enforcement is the server's resolved decision (continuous on and
 * no Admin opt-out); when an Admin has opted the project out it is NOT enforced
 * and the per-browser choice governs. Otherwise the localStorage override the
 * RUM settings toggle writes is honoured; a missing value falls back to
 * `mask-all`.
 */
export function resolveMaskingMode() {
  // Server enforcement (resolved per-project policy) is non-negotiable.
  if (_serverMaskAllEnforced) return MASKING_MODES.ALL;
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
export function hasFullSnapshot(events: any) {
  return Array.isArray(events) && events.some((e: any) => e && e.type === RRWEB_FULL_SNAPSHOT);
}

/** Ingest endpoint, derived from the bug-report endpoint's origin. */
export const REPLAY_INGEST_ENDPOINT = BUG_REPORT_ENDPOINT.replace(
  /\/api\/bug-reports\/?$/,
  '/api/replays',
);

/**
 * Public per-project replay-policy endpoint (`GET /api/replays/config`), on the
 * same central hub the recorder uploads to. Server-delivered config is the
 * single source of truth for the sample rate so a project's policy applies to
 * ALL users, not whoever flipped their own localStorage toggle.
 */
export const REPLAY_CONFIG_ENDPOINT = `${REPLAY_INGEST_ENDPOINT}/config`;

// Hard bound on the boot-time policy fetch. The recorder must start promptly on
// its built-in default rather than hang behind a slow/stalled
// `/api/replays/config` — the fetch is best-effort and must never gate capture.
export const REPLAY_CONFIG_TIMEOUT_MS = 3_000;

// Server-delivered sample rate ([0,1]) once fetched, or null when the server
// has not set a per-project rate (the client then keeps its built-in default,
// so the always-on bug-report capture is never silently disabled). Set by
// `applyServerReplayConfig` / `fetchServerReplayConfig`.
let _serverSampleRate: number | null = null;
// Whether the server policy enforces mask-all (continuous capture on with no
// Admin opt-out). When true `resolveMaskingMode` returns `mask-all` regardless
// of the per-browser override — the privacy contract of the continuous tier.
let _serverMaskAllEnforced = false;
// Whether the server policy enables the continuous-capture tier for this
// project. Default OFF — whole-session recording is an explicit per-project
// opt-in, never a sampling default. When true (and the client samples in) the
// recorder additionally streams the WHOLE session as appended chunks (see
// `ContinuousReplayFlusher`), on top of the always-on record-on-error path.
let _serverContinuous = false;
// Server-delivered continuous-flush cadence (ms), or null when unset (the
// flusher then uses DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS). Floored at
// MIN_CONTINUOUS_FLUSH_INTERVAL_MS — the monolithic-append storage cannot
// support sub-minute cadence in the MVP.
let _serverFlushIntervalMs: number | null = null;

/**
 * Resolve the per-project id the Hub's own recorder should fetch policy for,
 * from the build-time `VITE_REPLAY_PROJECT_ID` env. Without it the boot fetch
 * has no project to resolve and the server returns the default policy — so a
 * deployment that wants its first-party recorder governed by a project's
 * server-side rate sets this env. Returns null when unset.
 */
export function resolveReplayProjectId() {
  try {
    const pid =
      typeof import.meta !== 'undefined' && import.meta.env
        ? import.meta.env.VITE_REPLAY_PROJECT_ID
        : undefined;
    return pid != null && pid !== '' ? String(pid) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the per-project RUM ingest token from the build-time
 * `VITE_REPLAY_RUM_TOKEN` env. Injected/third-party recorders that already
 * carry a token (the main cross-origin instrumentation path) use it both for
 * `/api/replays` ingest and to resolve their policy — the server resolves the
 * config project from `X-RUM-Token` first, ahead of `?projectId=`. Returns
 * null when unset.
 */
export function resolveReplayRumToken() {
  try {
    const t =
      typeof import.meta !== 'undefined' && import.meta.env
        ? import.meta.env.VITE_REPLAY_RUM_TOKEN
        : undefined;
    return t != null && t !== '' ? String(t) : null;
  } catch {
    return null;
  }
}

/**
 * Apply a server-delivered replay policy (shape: `{ sampleRate, continuous,
 * maskAllEnforced }`):
 *   - `sampleRate` (numeric) becomes authoritative over the localStorage
 *     override; a null/absent rate leaves the client on its built-in default.
 *   - `maskAllEnforced` forces the recorder into mask-all mode (see
 *     `resolveMaskingMode`). This is the SERVER's resolved decision: it is true
 *     when continuous capture is on AND an Admin has not opted the project out
 *     (`replay.maskAllEnforced === false`). The client trusts the flag verbatim
 *     and does NOT re-derive enforcement from `continuous`, so an Admin opt-out
 *     is honoured rather than overridden back on.
 *
 * Scope note: this module is the record-on-error recorder. Whole-session
 * (continuous) capture — driving the upload path off the `continuous` flag — is
 * the continuous-recorder card (1103); its admin opt-in + privacy guardrails are
 * card 1106. So this card intentionally consumes only `sampleRate` (the
 * server-delivered rate, this card's deliverable) and `maskAllEnforced` (the
 * privacy guarantee), and does NOT itself switch to whole-session capture.
 *
 * Pure setter — no fetch, no DOM — so it is unit-testable. Returns the stored
 * rate.
 */
export function applyServerReplayConfig(policy: any) {
  const rate = policy == null ? null : policy.sampleRate;
  _serverSampleRate =
    typeof rate === 'number' && Number.isFinite(rate) ? clampSampleRate(rate) : null;
  // Trust the server's resolved `maskAllEnforced` verbatim — it already folds in
  // the continuous-on default AND the Admin opt-out. Re-deriving from
  // `continuous` here would force mask-all back on even when an Admin has
  // explicitly opted the project out.
  _serverMaskAllEnforced = policy != null && policy.maskAllEnforced === true;
  _serverContinuous = policy != null && policy.continuous === true;
  const interval = policy == null ? null : policy.flushIntervalMs;
  _serverFlushIntervalMs =
    typeof interval === 'number' && Number.isFinite(interval)
      ? clampContinuousFlushInterval(interval)
      : null;
  return _serverSampleRate;
}

/** The server-delivered sample rate currently in effect, or null when unset. */
export function getServerSampleRate() {
  return _serverSampleRate;
}

/** True when the server policy forces mask-all (continuous on, no Admin opt-out). */
export function isServerMaskAllEnforced() {
  return _serverMaskAllEnforced;
}

/** True when the server policy enables the continuous-capture tier. */
export function isServerContinuousEnabled() {
  return _serverContinuous;
}

/**
 * The continuous-flush cadence currently in effect (server-delivered when set,
 * else the built-in 5-min default), already floored at the sub-minute minimum.
 */
export function getContinuousFlushIntervalMs() {
  return clampContinuousFlushInterval(_serverFlushIntervalMs);
}

/**
 * Fetch the server-delivered replay policy and apply it. The project is
 * resolved by the server from, in order: the `X-RUM-Token` header (sent when a
 * `rumToken` is given or `VITE_REPLAY_RUM_TOKEN` is set — the main cross-origin
 * instrumentation path), then the `?projectId=` query (from `projectId` or
 * `VITE_REPLAY_PROJECT_ID`). Without either, the endpoint can only return the
 * default policy.
 *
 * Accepts an options object: `{ projectId?, rumToken?, endpoint?, timeoutMs? }`.
 * Best-effort and HARD-BOUNDED by `timeoutMs` (default
 * `REPLAY_CONFIG_TIMEOUT_MS`): a slow/stalled endpoint loses to the timer and
 * resolves to the default (null) so it can never prevent the recorder from
 * starting. Any network/parse failure resolves to null too. No-op outside a
 * browser.
 */
export async function fetchServerReplayConfig(opts: any = {}) {
  if (typeof fetch !== 'function') return null;
  const endpoint = opts.endpoint ?? REPLAY_CONFIG_ENDPOINT;
  const projectId = opts.projectId ?? resolveReplayProjectId();
  const rumToken = opts.rumToken ?? resolveReplayRumToken();
  const timeoutMs = opts.timeoutMs ?? REPLAY_CONFIG_TIMEOUT_MS;
  let url = endpoint;
  if (projectId)
    url += `${url.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`;
  const headers: Record<string, string> = {};
  if (rumToken) headers['X-RUM-Token'] = rumToken;

  // Actually cancel the request on timeout when AbortSignal.timeout exists; the
  // fetch then rejects and resolves to the default below.
  let signal: AbortSignal | undefined;
  try {
    signal =
      typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function'
        ? (AbortSignal as any).timeout(timeoutMs)
        : undefined;
  } catch {
    signal = undefined;
  }

  // `timedOut` stops a late-settling fetch (an env that ignores the abort
  // signal, or a hang inside res.json()) from applying the policy after we've
  // already fallen back to the default.
  let timedOut = false;
  const work = (async () => {
    try {
      const res = await fetch(url, { method: 'GET', headers, ...(signal ? { signal } : {}) });
      if (timedOut || !res || !res.ok) return null;
      const policy = await res.json();
      if (timedOut) return null;
      return applyServerReplayConfig(policy);
    } catch {
      return null;
    }
  })();

  if (!(timeoutMs > 0) || typeof setTimeout !== 'function') return work;
  // Whichever settles first wins; a hung request loses to the timer and the
  // recorder proceeds on its built-in default.
  const timer = new Promise<null>((resolve) =>
    setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs),
  );
  return Promise.race([work, timer]);
}

// localStorage key holding the user's explicit on/off choice (and any
// fractional sample-rate an operator pokes in for repro). The RUM settings
// toggle reads and writes this; it is the single source of truth for whether
// the recorder runs, overriding the build-time env baseline.
export const REPLAY_SAMPLE_RATE_KEY = 'agent-hub-replay-sample-rate';

/** Clamp an arbitrary value to a valid sample rate in [0, 1]. */
export function clampSampleRate(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * Resolve the effective sample rate. **On (1) by default** — session replay is
 * the visual context that backs bug reports, so it records unless explicitly
 * turned off. Resolution order:
 *   1. server-delivered per-project rate (`fetchServerReplayConfig`) — when the
 *      project has set one it is authoritative for ALL users, overriding any
 *      per-browser localStorage toggle. Unset (null) falls through.
 *   2. localStorage override (the RUM settings toggle writes '1' / '0' here) —
 *      honoured only when the server has not set a rate.
 *   3. a build-time Vite env baseline (`VITE_SESSION_REPLAY_SAMPLE_RATE`) when
 *      set — lets an operator dial a fractional rollout.
 *   4. otherwise default to 1 (fully on).
 */
export function resolveSampleRate() {
  // Server-delivered per-project rate wins when present — the whole point of
  // moving config off localStorage is that the policy applies to every user.
  if (_serverSampleRate != null) return _serverSampleRate;
  let override: any;
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
export function shouldSample(rate: any, rng: any = Math.random) {
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
  events: any,
  now: any,
  windowMs: any = DEFAULT_WINDOW_MS,
  maxEvents: any = DEFAULT_MAX_EVENTS,
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
    const tailSnap = tail.findIndex((e: any) => e && e.type === RRWEB_FULL_SNAPSHOT);
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
export function countElementsInNode(root: any) {
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
export function countSnapshotElements(snapshotEvent: any) {
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
export function selectFlushWindow(events: any, now: any, windowMs: any = DEFAULT_WINDOW_MS) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const cutoff = now - windowMs;

  const inWindow: any[] = []; // indices of full snapshots with ts >= cutoff, oldest→newest
  let newestSnapshot = -1; // last full snapshot overall
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.type !== RRWEB_FULL_SNAPSHOT) continue;
    newestSnapshot = i;
    if (e.timestamp >= cutoff) inWindow.push(i);
  }

  if (newestSnapshot === -1) return events; // no snapshot — flush() declines it

  let startIdx: any;
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
    const counts = inWindow.map((i: any) => countSnapshotElements(events[i]));
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
export async function gzipString(text: any) {
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
  { events, meta }: any = {},
  endpoint: any = REPLAY_INGEST_ENDPOINT,
  timeoutMs: any = UPLOAD_TIMEOUT_MS,
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

/** The chunked-append URL for a given replay id. */
export function replayBatchEndpoint(id: any, base: any = REPLAY_INGEST_ENDPOINT) {
  return `${base}/${encodeURIComponent(String(id))}/events`;
}

/**
 * POST one chunk of a streamed replay to the chunked-ingest endpoint
 * (`POST /api/replays/:id/events`). The first (creating) chunk must carry a full
 * snapshot; later chunks append incremental events. Resolves with the parsed
 * running-totals response on success; throws on a non-2xx. gzip-compressed when
 * the platform supports it (same transport as `submitReplay`), falling back to
 * uncompressed JSON.
 *
 * `rumToken`, when present, is sent as the `X-RUM-Token` header so the server
 * attributes the capture to that project — exactly like the policy/config path.
 * Without it the creating chunk is anonymous, and (worse) a later chunk would be
 * rejected 403 if the capture was created under a token, so the token MUST ride
 * along on every chunk of a token-attributed stream.
 */
export async function submitReplayBatch(
  { id, events, meta }: any = {},
  {
    endpointBase = REPLAY_INGEST_ENDPOINT,
    timeoutMs = UPLOAD_TIMEOUT_MS,
    rumToken = null,
  }: any = {},
) {
  if (id == null || String(id) === '') throw new Error('submitReplayBatch requires a replay id');
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('No replay events to submit');
  }
  const url = replayBatchEndpoint(id, endpointBase);
  const signal =
    timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const json = JSON.stringify({ events, meta: meta || undefined });
  const gzipped = await gzipString(json);
  const headers: Record<string, string> = {
    'Content-Type': gzipped ? 'application/octet-stream' : 'application/json',
  };
  if (rumToken) headers['X-RUM-Token'] = String(rumToken);
  const res = await fetch(url, {
    method: 'POST',
    mode: 'cors',
    headers,
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
    throw new Error(bodyText || `Replay batch ingest failed (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * Streams the WHOLE session to the chunked-ingest endpoint as appended chunks.
 *
 * Fed every raw rrweb event (via the recorder's continuous sink, before the
 * rolling-buffer pruner runs) so it accumulates the complete event stream, not
 * the trailing window the record-on-error path keeps. On a periodic interval
 * (default 5 min, server-delivered) and on tab-close it drains the pending
 * events into one batch POST. The first batch creates the replay and carries the
 * initial full snapshot; later batches append incrementally — matching the
 * server's `requireSnapshotOnFirstChunk` contract.
 *
 * Durability: a hard crash between flushes loses up to one interval of tail
 * (accepted MVP tradeoff). A normal tab close is caught by `flushTail`, which
 * uses an unload-surviving transport (`navigator.sendBeacon`, or a keepalive
 * `fetch` when a RUM token must be attached as a header), falling back to a
 * best-effort async flush.
 *
 * Attribution: a per-project RUM token, when present, rides as `X-RUM-Token` on
 * every chunk (async and beacon) so the server attributes the stream to its
 * project — required for first-chunk creation and to keep later chunks from
 * being rejected 403 against an already-attributed capture.
 *
 * All side-effecting collaborators (the batch transport, the interval timer
 * functions, the beacon, the clock) are injected so the whole class is
 * unit-testable without a DOM, rrweb, or network.
 */
export class ContinuousReplayFlusher {
  [key: string]: any;
  constructor({
    replayId,
    submitBatch = submitReplayBatch,
    now = () => Date.now(),
    flushIntervalMs = DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
    minBatchEvents = 1,
    setIntervalFn = typeof setInterval === 'function' ? setInterval : null,
    clearIntervalFn = typeof clearInterval === 'function' ? clearInterval : null,
    beacon = defaultReplayBeacon,
    endpointBase = REPLAY_INGEST_ENDPOINT,
    meta = null,
    rumToken = null,
  }: any = {}) {
    if (replayId == null || String(replayId) === '') {
      throw new Error('ContinuousReplayFlusher requires a replayId');
    }
    this.replayId = String(replayId);
    this._submitBatch = submitBatch;
    this._now = now;
    // Clamp here too so a caller-supplied cadence can't sneak under the floor.
    this.flushIntervalMs = clampContinuousFlushInterval(flushIntervalMs);
    this.minBatchEvents = Math.max(1, minBatchEvents | 0);
    this._setIntervalFn = setIntervalFn;
    this._clearIntervalFn = clearIntervalFn;
    this._beacon = beacon;
    this._endpointBase = endpointBase;
    this._meta = meta;
    // Per-project RUM ingest token. Sent as `X-RUM-Token` on every chunk (async
    // and beacon) so a token-attributed stream is created and appended under its
    // project — null for the anonymous first-party recorder.
    this._rumToken = rumToken || null;

    this._pending = [];
    this._created = false; // true once the creating (first) chunk lands
    this.active = false;
    this._timer = null;
    this._flushing = null; // in-flight interval-flush promise (overlap guard)
    this.lastResult = null;
  }

  /** Buffer one raw rrweb event for the next flush. */
  addEvent(event: any) {
    if (event) this._pending.push(event);
  }

  /** Start the periodic flush timer. Idempotent. */
  start() {
    if (this.active) return;
    this.active = true;
    if (typeof this._setIntervalFn === 'function' && this.flushIntervalMs > 0) {
      this._timer = this._setIntervalFn(() => {
        // Fire-and-forget — the interval must never await an upload.
        void this.flush('interval');
      }, this.flushIntervalMs);
    }
  }

  /**
   * Build the meta for a batch. Only the CREATING chunk carries meta (the server
   * honors meta on the first chunk only), tagging the capture as continuous.
   */
  _batchMeta(reason: any) {
    if (this._created) return null;
    return { ...(this._meta || {}), trigger: 'continuous', reason: reason ?? 'interval' };
  }

  /**
   * Flush the pending events as one chunk. No-op (returns null) when there's
   * nothing to send, or when the replay hasn't been created yet and the pending
   * batch carries no full snapshot — the server requires the first chunk to be
   * replayable, so we wait for the snapshot rather than ship a batch it would
   * reject. Overlapping callers share the in-flight promise. Never throws.
   *
   * Drain semantics differ by phase, and deliberately so:
   *
   *   - CREATING chunk (uncreated): the pending batch holds the ONLY full
   *     snapshot, the single replayable anchor for the whole capture. We send a
   *     COPY and DO NOT clear `_pending` until the server confirms (2xx). If this
   *     async upload is killed during unload before its catch can re-queue — the
   *     classic case where `visibilitychange: hidden` kicks off the confirmed
   *     flush and a `pagehide` follows immediately — the snapshot is still in
   *     `_pending`, so the terminal beacon can send it. Without this, the drained
   *     snapshot would vanish and the whole short session would be lost.
   *   - INCREMENTAL tail (created): drain immediately. A delivered failure
   *     re-queues; an unload kill drops it — the accepted ≤interval loss, since
   *     these events are independent and the replay already exists server-side.
   */
  async flush(reason?: any) {
    if (this._flushing) return this._flushing;
    if (this._pending.length < this.minBatchEvents) return null;
    if (!this._created && !hasFullSnapshot(this._pending)) return null;
    const p = this._runFlush(reason);
    this._flushing = p;
    try {
      return await p;
    } finally {
      this._flushing = null;
    }
  }

  async _runFlush(reason: any) {
    // Uncreated → send a copy and retain `_pending` until confirmed; created →
    // drain now. (See `flush` for why the creating chunk must not be drained.)
    const creating = !this._created;
    const batch = creating ? this._pending.slice() : this._pending;
    if (!creating) this._pending = [];
    try {
      const result = await this._submitBatch(
        { id: this.replayId, events: batch, meta: this._batchMeta(reason) },
        { endpointBase: this._endpointBase, rumToken: this._rumToken },
      );
      this._created = true;
      this.lastResult = result || null;
      if (creating) {
        // Confirmed: NOW drop exactly the sent leading events. More may have been
        // appended behind them while in flight (the `_flushing` guard kept the
        // front stable); those stay queued for the next flush.
        this._pending = this._pending.slice(batch.length);
      }
      return this.lastResult;
    } catch {
      // creating: never drained → snapshot still in `_pending`, retained for a
      // retry or a terminal beacon. created: re-queue the drained batch ahead of
      // any newer events so order is preserved.
      if (!creating) this._pending = batch.concat(this._pending);
      return null;
    }
  }

  /**
   * Tail flush for a lifecycle event. For a TERMINAL flush it uses a synchronous
   * unload-surviving transport (`navigator.sendBeacon`, or a keepalive `fetch`
   * when a RUM token must ride along) so the final batch outlives page teardown,
   * returning true when that request was queued. For a NON-terminal flush it uses
   * the confirmed async path and returns false. Idempotent-safe to call from
   * `pagehide` and `visibilitychange`.
   *
   * Terminality matters: a flush is terminal only when the document is truly
   * being discarded and will never resume. `visibilitychange: hidden` is NOT
   * terminal (a backgrounded tab can return), and neither is a *persisted*
   * `pagehide` (the page entered the back/forward cache and can resume) — the
   * caller signals that via `{ terminal: false }`. Terminality defaults to
   * `reason === 'pagehide'` only for callers that don't pass the flag explicitly.
   */
  flushTail(reason: any = 'pagehide', { terminal = reason === 'pagehide' }: any = {}) {
    if (this._pending.length < this.minBatchEvents) return false;

    // NON-terminal flush (a backgrounded tab that can resume): the page is still
    // ALIVE, so NEVER optimistically beacon-and-drain. A beacon/keepalive request
    // only confirms the browser ENQUEUED it, not that the server accepted it — if
    // it is later dropped/rejected and the tab resumes, the drained events are
    // permanently lost even though we could have delivered them with a confirmed
    // upload. This holds for BOTH phases:
    //   - uncreated: the pending batch is the only full snapshot; an unconfirmed
    //     enqueue must not flip `_created`/drop it (a returning tab would then
    //     emit snapshot-less appends the server rejects, stranding the capture);
    //   - created: an unconfirmed enqueue must not drop the only copy of the
    //     incremental tail.
    // `_runFlush` clears `_pending` only on a real 2xx and re-queues on failure,
    // so the confirmed async path can't lose events while the page lives on.
    if (!terminal) {
      void this._drainAfterInflight(reason);
      return false;
    }

    // TERMINAL flush (document unloading, won't return). A snapshot-less uncreated
    // batch can't form a valid first chunk, so defer to the async path (no-ops
    // until a snapshot exists); everything else is beaconed best-effort below.
    if (!this._created && !hasFullSnapshot(this._pending)) {
      void this._drainAfterInflight(reason);
      return false;
    }

    const batch = this._pending;
    this._pending = [];
    const meta = this._batchMeta(reason);
    const url = replayBatchEndpoint(this.replayId, this._endpointBase);

    // The whole tail may exceed the unload transport's body budget
    // (KEEPALIVE_MAX_BYTES / sendBeacon's ~64KB) — a 5-min rrweb chunk routinely
    // does. We must NOT fall back to a normal async `fetch` on a terminal flush:
    // that request is not unload-safe and is killed when the document is
    // discarded, silently losing the batch. And we can't split into multiple
    // keepalive requests either — the keepalive budget is shared (~64KB total
    // across all in-flight keepalive requests), so on unload (where none complete
    // before discard) extra chunks are simply rejected. The honest maximum on a
    // terminal close is therefore ONE budget-sized request. So we send the
    // largest leading prefix that fits, on the unload-safe transport, and drop
    // the trailing remainder (the accepted unload tail loss). For an uncreated
    // capture the prefix must still carry the snapshot to be a valid first chunk;
    // if the snapshot alone overflows the budget no unload transport can deliver
    // it (we can't gzip synchronously here), so we retain rather than send junk.
    const send = (events: any) => {
      if (!Array.isArray(events) || events.length === 0) return false;
      if (!this._created && !hasFullSnapshot(events)) return false;
      const body = JSON.stringify({ events, meta: meta || undefined });
      try {
        // Pass the RUM token so the beacon transport can attribute the capture
        // (`navigator.sendBeacon` can't set headers, so the default beacon uses a
        // keepalive `fetch` carrying `X-RUM-Token` whenever a token is present).
        return this._beacon(url, body, this._rumToken) === true;
      } catch {
        return false;
      }
    };

    // Try the whole batch first; if the transport refuses it (over budget), send
    // the largest budget-sized leading prefix instead.
    let sent = send(batch);
    if (!sent) {
      const prefix = takeKeepalivePrefix(batch, meta, KEEPALIVE_MAX_BYTES);
      if (prefix.length < batch.length) sent = send(prefix);
    }

    if (sent) {
      // TERMINAL-only: the document is unloading and the tab won't return, so
      // flipping `_created` off an unconfirmed enqueue is safe — there is no later
      // flush for a dropped beacon to strand. The dropped remainder (if any) is
      // the accepted terminal tail loss.
      this._created = true;
      return true;
    }
    // Nothing could be sent on the unload-safe transport (no transport available,
    // or even the snapshot prefix overflows the budget). Retain the batch — it
    // survives a mislabeled/bfcache resume; on a true discard it is lost, which is
    // unavoidable for an oversized tail on unload.
    this._pending = batch.concat(this._pending);
    return false;
  }

  /**
   * Drain the currently-pending tail even when a periodic flush is already in
   * flight. `flush()` returns the existing `_flushing` promise without draining
   * the newly-pending events, so the tab-close path could otherwise drop the
   * final batch when an interval flush overlaps unload. This awaits any in-flight
   * flush so `flush()`'s `_flushing` short-circuit clears, then flushes the
   * remaining tail. Best-effort; never throws. Concurrent callers (pagehide +
   * visibilitychange) are safe — the second `flush()` shares the first's in-flight
   * promise rather than double-sending.
   */
  async _drainAfterInflight(reason: any) {
    try {
      const inflight = this._flushing;
      if (inflight) {
        try {
          await inflight;
        } catch {
          // ignore — the in-flight flush swallows its own errors
        }
      }
      await this.flush(reason);
    } catch {
      // ignore — tail flush is best-effort
    }
  }

  /** Stop the periodic timer. The pending buffer is left intact. */
  stop() {
    if (this._timer != null && typeof this._clearIntervalFn === 'function') {
      try {
        this._clearIntervalFn(this._timer);
      } catch {
        // ignore
      }
    }
    this._timer = null;
    this.active = false;
  }
}

/**
 * Conservative cap on a keepalive `fetch` body. The Fetch spec budgets ~64 KB
 * across ALL in-flight keepalive requests, and a body over that budget makes the
 * request reject ASYNCHRONOUSLY — after `defaultReplayBeacon` would already have
 * reported success and the caller had cleared its buffer. So the token path
 * refuses synchronously above this limit (returning false) rather than silently
 * losing the batch; the caller then retains it for the confirmed async path. Set
 * below 64 KB to leave headroom for headers and other keepalive traffic.
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

/** UTF-8 byte length of a string, best-effort across environments. */
function utf8ByteLength(s: any): number {
  const str = String(s);
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
  } catch {
    // fall through
  }
  try {
    if (typeof Blob !== 'undefined') return new Blob([str]).size;
  } catch {
    // fall through
  }
  return str.length; // last resort (undercounts multi-byte, but never throws)
}

/**
 * Largest leading run of `events` whose serialized `{ events, meta }` body fits
 * `maxBytes`. Used to salvage the deliverable head of an oversized tail on a
 * terminal flush, where only one budget-sized unload-safe request can land. The
 * first event is always included (so a single over-budget event is still
 * attempted — the transport then refuses it), and chronological order is
 * preserved so the snapshot (at the front of an uncreated capture) stays in the
 * prefix. Pure — no DOM/network — so it is unit-testable.
 */
export function takeKeepalivePrefix(events: any, meta: any, maxBytes: any) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const limit =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
      ? maxBytes
      : KEEPALIVE_MAX_BYTES;

  // Size candidates against the EXACT serialized body the caller sends —
  // `JSON.stringify({ events, meta: meta || undefined })` — so the returned
  // prefix is GUARANTEED to fit the keepalive budget. A constant-overhead
  // estimate under-counts: `meta`'s UTF-8 byte length differs from its UTF-16
  // string length, and the real `{"events":[…],"meta":…}` framing is larger than
  // a fixed guess. An under-count hands back an oversized prefix that the
  // transport then refuses, and `flushTail` drops the whole tail instead of
  // sending the largest deliverable head.
  const metaJson = meta != null ? JSON.stringify(meta) : undefined;
  const hasMeta = typeof metaJson === 'string';
  // Fixed framing bytes (all ASCII), matching JSON.stringify of the wrapper:
  //   `{"events":` (10) + `[` (1) + … + `]` (1) + `}` (1)
  //   + `,"meta":` (8) + metaJson when meta is present.
  // The `[` and `]` are counted here; per-event commas are added in the loop.
  const framing = 10 + 1 + 1 + 1 + (hasMeta ? 8 + utf8ByteLength(metaJson) : 0);

  let used = framing; // bytes for the empty wrapper `{"events":[]}` (+ meta)
  let count = 0;
  for (let i = 0; i < events.length; i++) {
    const evBytes = utf8ByteLength(JSON.stringify(events[i]));
    // Commas only appear BETWEEN events: the i-th event costs a separator only
    // when one is already in the prefix.
    const add = evBytes + (count > 0 ? 1 : 0);
    // Always include the first event even if it alone blows the budget (the
    // transport then refuses it); stop before any later event that would push the
    // real body over the limit.
    if (count > 0 && used + add > limit) break;
    used += add;
    count++;
  }
  return events.slice(0, count);
}

/**
 * Default tail-flush transport for an unloading page. Returns true ONLY when the
 * browser has actually accepted the body into a queue; false when no transport is
 * available, the body is refused, or it exceeds the synchronous size budget.
 * Never throws.
 *
 * Transport choice is driven by attribution:
 *   - With a `rumToken`: `navigator.sendBeacon` CANNOT attach an `X-RUM-Token`
 *     header, which the server requires to attribute the capture (and to accept
 *     later chunks of an already-attributed stream — an anonymous chunk is
 *     rejected 403). So we use a `fetch(..., { keepalive: true })`, which both
 *     survives page teardown (the modern sendBeacon replacement) AND carries
 *     custom headers. BUT keepalive fetch gives no synchronous accept signal and
 *     rejects async on an over-budget body, so we apply a synchronous size guard
 *     ({@link KEEPALIVE_MAX_BYTES}): over the limit we return false WITHOUT
 *     dispatching, so the caller keeps the batch and falls back to the confirmed
 *     async path (a live page) instead of silently dropping it. (5-min rrweb
 *     chunks routinely exceed the budget — this is the common case.)
 *   - Without a token (anonymous first-party recorder): plain `navigator.sendBeacon`,
 *     which already returns false synchronously when it can't enqueue the body.
 */
export function defaultReplayBeacon(url: any, body: any, rumToken: any = null) {
  try {
    if (rumToken) {
      if (typeof fetch !== 'function') return false;
      // Synchronous size guard: a keepalive body over the browser budget rejects
      // asynchronously (after we'd return), so refuse here rather than claim a
      // queue we can't guarantee. The caller retains the batch for a confirmed flush.
      if (utf8ByteLength(body) > KEEPALIVE_MAX_BYTES) return false;
      // Within budget → dispatched and allowed to complete after unload.
      void fetch(url, {
        method: 'POST',
        mode: 'cors',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-RUM-Token': String(rumToken) },
        body,
      }).catch(() => {});
      return true;
    }
    if (
      typeof navigator === 'undefined' ||
      typeof navigator.sendBeacon !== 'function' ||
      typeof Blob === 'undefined'
    ) {
      return false;
    }
    const blob = new Blob([body], { type: 'application/json' });
    return navigator.sendBeacon(url, blob) === true;
  } catch {
    return false;
  }
}

// ─── Segment capture (Datadog view-scoped segments) ───────────────
//
// The forward write path that replaces monolithic continuous append. Instead of
// re-uploading a growing blob each flush (O(n²)), the recorder emits VIEW-SCOPED
// segments: each flush writes ONE gzipped object (server `appendSegment`, O(1)),
// indexed by the `rum_segments` manifest. Datadog segment constants govern
// rollover — a new segment after ~5s OR ~60KB — plus a flush on view change (a
// new view opens a FRESH full snapshot at index_in_view=0) and on page-exit.
// Sub-minute cadence is now safe because the append is O(1): the monolithic
// >=60s floor (`MIN_CONTINUOUS_FLUSH_INTERVAL_MS`) no longer applies here.

/** Roll a new segment after ~5s of wall-clock in the current segment. */
export const SEGMENT_MAX_DURATION_MS = 5_000;
/**
 * Roll a new segment once the current segment's RAW serialized byte size crosses
 * this budget. Datadog's target is ~60KB COMPRESSED, but gzip-sizing every event
 * synchronously in the emit hot path isn't feasible, so we bound the raw
 * serialized size as a cheap synchronous proxy. rrweb JSON gzips ~10-20x (see
 * `submitReplay`), so ~600KB raw approximates the ~60KB-compressed target.
 * Injectable per-flusher so tests can force a rollover at a tiny threshold.
 */
export const SEGMENT_MAX_RAW_BYTES = 600 * 1024;
/** Default cadence of the idle-rollover check timer (segments still flush on
 *  the ~5s duration bound even when no new events arrive to drive `addEvent`). */
export const SEGMENT_IDLE_CHECK_MS = 1_000;

/**
 * The per-segment append URL for a `(session, view, index_in_view)` slot. The
 * server keys the object + manifest row on exactly these three components, so
 * the path carries all three. Pure.
 */
export function segmentBatchEndpoint(
  sessionId: any,
  viewId: any,
  indexInView: any,
  base: any = REPLAY_INGEST_ENDPOINT,
) {
  const s = encodeURIComponent(String(sessionId));
  const v = encodeURIComponent(String(viewId));
  const i = Math.max(0, Math.floor(Number(indexInView) || 0));
  return `${base}/sessions/${s}/views/${v}/segments/${i}`;
}

/**
 * POST one view-scoped segment to the segment-ingest endpoint. The view-opening
 * segment (index_in_view=0) MUST carry a full snapshot (the server rejects it
 * otherwise); later segments in the view append incremental events. gzip-compressed
 * when the platform supports it (same transport as `submitReplayBatch`), falling
 * back to uncompressed JSON. `rumToken`, when present, rides as `X-RUM-Token` so
 * the server attributes the segment to its project. Resolves with the parsed
 * response on success; throws on a non-2xx.
 */
export async function submitReplaySegment(
  { sessionId, viewId, indexInView, events, meta }: any = {},
  {
    endpointBase = REPLAY_INGEST_ENDPOINT,
    timeoutMs = UPLOAD_TIMEOUT_MS,
    rumToken = null,
  }: any = {},
) {
  if (sessionId == null || String(sessionId) === '')
    throw new Error('submitReplaySegment requires a sessionId');
  if (viewId == null || String(viewId) === '')
    throw new Error('submitReplaySegment requires a viewId');
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('No replay events to submit');
  }
  const url = segmentBatchEndpoint(sessionId, viewId, indexInView, endpointBase);
  const signal =
    timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const json = JSON.stringify({ events, meta: meta || undefined });
  const gzipped = await gzipString(json);
  const headers: Record<string, string> = {
    'Content-Type': gzipped ? 'application/octet-stream' : 'application/json',
  };
  if (rumToken) headers['X-RUM-Token'] = String(rumToken);
  const res = await fetch(url, {
    method: 'POST',
    mode: 'cors',
    headers,
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
    throw new Error(bodyText || `Replay segment ingest failed (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * Streams a session to the segment-ingest endpoint as view-scoped segments with
 * Datadog semantics.
 *
 * Fed every raw rrweb event (via the recorder's continuous sink) it accumulates a
 * CURRENT segment and rolls it over — flushing one gzipped object — when the
 * segment crosses ~5s OR ~60KB (`maxDurationMs` / `maxBytes`). On a VIEW CHANGE
 * (`notifyViewChange`) it flushes the outgoing view's tail, resets to
 * index_in_view=0 for the new view, and asks the recorder (via `requestSnapshot`)
 * to emit a fresh full snapshot so the new view opens replayable. On PAGE-EXIT
 * (`flushTail`) it beacons the current segment on an unload-surviving transport.
 *
 * Segment sequencing within a view mirrors the server's `appendSegment` contract:
 * index_in_view=0 is the view-opening segment and MUST carry a full snapshot;
 * later indices are incremental appends. The view-opening segment is treated like
 * `ContinuousReplayFlusher`'s creating chunk — it holds the view's only snapshot
 * anchor, so it is sent as a COPY and retained until confirmed (a killed unload
 * flush can then still beacon it); incremental segments drain immediately.
 *
 * All side-effecting collaborators (the segment transport, the timer functions,
 * the beacon, the clock, the snapshot request) are injected so the whole class is
 * unit-testable without a DOM, rrweb, or network.
 */
export class SegmentReplayFlusher {
  [key: string]: any;
  constructor({
    sessionId,
    viewId,
    submitSegment = submitReplaySegment,
    now = () => Date.now(),
    maxDurationMs = SEGMENT_MAX_DURATION_MS,
    maxBytes = SEGMENT_MAX_RAW_BYTES,
    setIntervalFn = typeof setInterval === 'function' ? setInterval : null,
    clearIntervalFn = typeof clearInterval === 'function' ? clearInterval : null,
    idleCheckMs = SEGMENT_IDLE_CHECK_MS,
    beacon = defaultReplayBeacon,
    endpointBase = REPLAY_INGEST_ENDPOINT,
    meta = null,
    rumToken = null,
    requestSnapshot = null,
  }: any = {}) {
    if (sessionId == null || String(sessionId) === '') {
      throw new Error('SegmentReplayFlusher requires a sessionId');
    }
    if (viewId == null || String(viewId) === '') {
      throw new Error('SegmentReplayFlusher requires a viewId');
    }
    this.sessionId = String(sessionId);
    this._viewId = String(viewId);
    this._submitSegment = submitSegment;
    this._now = now;
    this.maxDurationMs = maxDurationMs > 0 ? maxDurationMs : SEGMENT_MAX_DURATION_MS;
    this.maxBytes = maxBytes > 0 ? maxBytes : SEGMENT_MAX_RAW_BYTES;
    this._setIntervalFn = setIntervalFn;
    this._clearIntervalFn = clearIntervalFn;
    this._idleCheckMs = Math.max(250, idleCheckMs | 0);
    this._beacon = beacon;
    this._endpointBase = endpointBase;
    this._meta = meta;
    this._rumToken = rumToken || null;
    this._requestSnapshot = typeof requestSnapshot === 'function' ? requestSnapshot : null;

    this._indexInView = 0;
    this._pending = [];
    this._segmentBytes = 0;
    this._segmentStartTs = null;
    this._flushing = null; // in-flight flush promise (overlap guard)
    this.active = false;
    this._timer = null;
    this.lastResult = null;
  }

  /** The view id the current segment rolls up under. */
  get viewId() {
    return this._viewId;
  }

  /** The index_in_view the current (pending) segment will be flushed as. */
  get indexInView() {
    return this._indexInView;
  }

  /** Buffer one raw rrweb event into the current segment, rolling over when it
   *  crosses the ~5s / ~60KB bound. */
  addEvent(event: any) {
    if (!event) return;
    this._pending.push(event);
    this._segmentBytes += utf8ByteLength(JSON.stringify(event));
    if (this._segmentStartTs == null) {
      this._segmentStartTs = typeof event.timestamp === 'number' ? event.timestamp : this._now();
    }
    void this._maybeRollover();
  }

  /** Recompute the byte + start-ts accounting from the current `_pending` (after
   *  a partial drain, a re-queue, or a view switch). */
  _recomputeAccounting() {
    this._segmentBytes = 0;
    this._segmentStartTs = null;
    for (const e of this._pending) {
      this._segmentBytes += utf8ByteLength(JSON.stringify(e));
      if (this._segmentStartTs == null) {
        this._segmentStartTs = typeof e.timestamp === 'number' ? e.timestamp : this._now();
      }
    }
  }

  /** True when the current segment has crossed its size/duration bound and is a
   *  valid, flushable segment (a view-opening segment first needs its snapshot). */
  _shouldRollover() {
    if (this._pending.length === 0) return false;
    // A view-opening segment can't roll over until it holds the snapshot that
    // makes it a valid first chunk — wait rather than ship a rejectable segment.
    if (this._indexInView === 0 && !hasFullSnapshot(this._pending)) return false;
    if (this._segmentBytes >= this.maxBytes) return true;
    const start = this._segmentStartTs == null ? this._now() : this._segmentStartTs;
    return this._now() - start >= this.maxDurationMs;
  }

  async _maybeRollover() {
    if (!this._shouldRollover()) return null;
    return this.flush('rollover');
  }

  /** Start the idle-rollover timer so a segment still flushes on the duration
   *  bound during a quiet stretch with no new events. Idempotent. */
  start() {
    if (this.active) return;
    this.active = true;
    if (typeof this._setIntervalFn === 'function') {
      this._timer = this._setIntervalFn(() => {
        void this._maybeRollover();
      }, this._idleCheckMs);
    }
  }

  /** Stop the idle-rollover timer. The pending segment is left intact. */
  stop() {
    if (this._timer != null && typeof this._clearIntervalFn === 'function') {
      try {
        this._clearIntervalFn(this._timer);
      } catch {
        // ignore
      }
    }
    this._timer = null;
    this.active = false;
  }

  /** Meta for a segment: only the view-opening segment (index 0) carries it,
   *  tagging the capture as a segmented continuous stream. */
  _segmentMeta(reason: any) {
    if (this._indexInView !== 0) return null;
    return {
      ...(this._meta || {}),
      trigger: 'continuous',
      storage: 'segmented',
      reason: reason ?? 'rollover',
    };
  }

  /**
   * Flush the current segment as one object. No-op (null) when nothing is
   * pending, or when the view-opening segment carries no snapshot yet. Overlapping
   * callers share the in-flight promise. Never throws.
   */
  async flush(reason?: any) {
    if (this._flushing) return this._flushing;
    if (this._pending.length === 0) return null;
    if (this._indexInView === 0 && !hasFullSnapshot(this._pending)) return null;
    const p = this._runFlush(reason);
    this._flushing = p;
    try {
      return await p;
    } finally {
      this._flushing = null;
    }
  }

  async _runFlush(reason: any) {
    // The view-opening segment (index 0) holds the view's only snapshot anchor,
    // so send a COPY and retain `_pending` until confirmed (see class doc);
    // incremental segments drain immediately.
    const creating = this._indexInView === 0;
    const viewId = this._viewId;
    const indexInView = this._indexInView;
    const meta = this._segmentMeta(reason);
    const batch = creating ? this._pending.slice() : this._pending;
    if (!creating) {
      this._pending = [];
      this._recomputeAccounting();
    }
    try {
      const result = await this._submitSegment(
        { sessionId: this.sessionId, viewId, indexInView, events: batch, meta },
        { endpointBase: this._endpointBase, rumToken: this._rumToken },
      );
      this.lastResult = result || null;
      // A view change during the await already reset the index/pending for the
      // new view — don't clobber it. Only advance when still on the same view.
      if (this._viewId === viewId && this._indexInView === indexInView) {
        this._indexInView = indexInView + 1;
        if (creating) {
          // Drop exactly the sent leading events; anything appended behind them
          // while in flight stays queued as the next (incremental) segment.
          this._pending = this._pending.slice(batch.length);
          this._recomputeAccounting();
        }
      }
      return this.lastResult;
    } catch {
      // incremental: re-queue ahead of newer events so order is preserved.
      // creating: never drained → the snapshot stays in `_pending` for a retry
      // or a terminal beacon.
      if (!creating && this._viewId === viewId) {
        this._pending = batch.concat(this._pending);
        this._recomputeAccounting();
      }
      return null;
    }
  }

  /**
   * Switch to a new view: flush the outgoing view's tail (confirmed async path),
   * reset to index_in_view=0 for the new view, and ask the recorder to emit a
   * fresh full snapshot so the new view's opening segment is replayable. A no-op
   * when the id is empty or unchanged. Callers may fire-and-forget; the internal
   * await sequences the switch after the outgoing flush.
   */
  async notifyViewChange(newViewId: any) {
    const id = newViewId == null ? '' : String(newViewId);
    if (!id || id === this._viewId) return null;
    await this._drainAfterInflight('view_change');
    this._viewId = id;
    this._indexInView = 0;
    this._pending = [];
    this._segmentBytes = 0;
    this._segmentStartTs = null;
    if (this._requestSnapshot) {
      try {
        this._requestSnapshot(id);
      } catch {
        // ignore — a snapshot request failure must not break the view switch
      }
    }
    return null;
  }

  /**
   * Tail flush for a lifecycle event. TERMINAL (document unloading): beacon the
   * current segment on an unload-surviving transport, returning true when queued.
   * NON-terminal (a backgrounded tab that can resume): take the confirmed async
   * path and return false. Mirrors `ContinuousReplayFlusher.flushTail` — see that
   * method for the terminality contract and the unload-budget prefix salvage.
   */
  flushTail(reason: any = 'pagehide', { terminal = reason === 'pagehide' }: any = {}) {
    if (this._pending.length === 0) return false;
    if (!terminal) {
      void this._drainAfterInflight(reason);
      return false;
    }
    // A snapshot-less view-opening segment can't be a valid first chunk — defer.
    if (this._indexInView === 0 && !hasFullSnapshot(this._pending)) {
      void this._drainAfterInflight(reason);
      return false;
    }

    const viewId = this._viewId;
    const indexInView = this._indexInView;
    const batch = this._pending;
    this._pending = [];
    this._segmentBytes = 0;
    this._segmentStartTs = null;
    const meta = this._segmentMeta(reason);
    const url = segmentBatchEndpoint(this.sessionId, viewId, indexInView, this._endpointBase);

    const send = (events: any) => {
      if (!Array.isArray(events) || events.length === 0) return false;
      if (indexInView === 0 && !hasFullSnapshot(events)) return false;
      const body = JSON.stringify({ events, meta: meta || undefined });
      try {
        return this._beacon(url, body, this._rumToken) === true;
      } catch {
        return false;
      }
    };

    // Try the whole segment; if the transport refuses it (over the unload
    // budget), send the largest budget-sized leading prefix and drop the rest
    // (accepted terminal tail loss). An uncreated prefix must still carry the
    // snapshot to be a valid first chunk.
    let sent = send(batch);
    if (!sent) {
      const prefix = takeKeepalivePrefix(batch, meta, KEEPALIVE_MAX_BYTES);
      if (prefix.length < batch.length) sent = send(prefix);
    }

    if (sent) {
      // Terminal: the tab won't return, so advancing off an unconfirmed enqueue
      // is safe — no later flush can be stranded by a dropped beacon.
      if (this._viewId === viewId && this._indexInView === indexInView) {
        this._indexInView = indexInView + 1;
      }
      return true;
    }
    // Nothing sendable on the unload-safe transport → retain (survives a
    // mislabeled/bfcache resume; lost only on a true discard of an oversized tail).
    this._pending = batch.concat(this._pending);
    this._recomputeAccounting();
    return false;
  }

  /**
   * Drain the current segment even when a rollover flush is already in flight.
   * Awaits any in-flight flush (so `flush()`'s overlap guard clears) then flushes
   * the remaining tail. Best-effort; never throws.
   */
  async _drainAfterInflight(reason: any) {
    try {
      const inflight = this._flushing;
      if (inflight) {
        try {
          await inflight;
        } catch {
          // ignore — the in-flight flush swallows its own errors
        }
      }
      await this.flush(reason);
    } catch {
      // ignore — tail flush is best-effort
    }
  }

  /** Test/teardown helper: await any in-flight flush so assertions see the
   *  settled transport calls. */
  async settle() {
    if (this._flushing) {
      try {
        await this._flushing;
      } catch {
        // ignore
      }
    }
  }
}

// ─── Sessionization (Datadog session→view model) ──────────────────
//
// The producer that MINTS the client-side session.id / view.id the segment
// ingest path keys on (`segmentBatchEndpoint` embeds both in the URL, so minting
// them here is how the ids "flow on every segment ingest"). Mirrors Datadog
// exactly: a session is a client-generated id, ended by 15 min of inactivity OR
// 4h of continuous duration — new activity after either mints a FRESH session.id.
// Views (view.id) are per-navigation and roll up under a session: each navigation
// mints a fresh view.id, and a fresh session always opens with a fresh view. IDs
// are minted client-side (not server-derived) so an offline→online session stays
// deterministically the same session.
//
// Pure and clock-injected — no DOM, no rrweb, no network — so the rollover rules
// are unit-testable in isolation. The recorder-wiring layer feeds it activity
// (every rrweb event) and navigation (route change), then threads the returned
// ids into a `SegmentReplayFlusher` (rebuilding it on a session change, calling
// `notifyViewChange` on a view change).

/** End a session after this long with no activity (Datadog parity: 15 min). */
export const SESSION_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
/** Hard cap on one session's continuous duration (Datadog parity: 4h). */
export const SESSION_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

/**
 * Mint an id for a session or a view. Prefers `crypto.randomUUID()`; falls back
 * to a timestamp+random id. The result matches the server's
 * `^[A-Za-z0-9._-]{8,200}$` id charset (same scheme as {@link generateReplayId}).
 */
export function generateRumId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `rum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Minted session/view context plus change flags. `sessionChanged` is true when a
 * fresh session.id was minted (the wiring layer rebuilds the segment flusher);
 * `viewChanged` is true when a fresh view.id was minted (a fresh session always
 * changes the view too).
 */
export interface RumSessionContext {
  sessionId: string;
  viewId: string;
  sessionChanged: boolean;
  viewChanged: boolean;
}

/** Injected collaborators + rollover bounds for {@link RumSessionManager}. */
export interface RumSessionManagerOptions {
  /** Clock source (ms). Injected so rollover is testable without real time. */
  now?: () => number;
  /** Session/view id minter. Defaults to {@link generateRumId}. */
  generateId?: () => string;
  /** Inactivity timeout (ms) before a session ends. Defaults to 15 min. */
  inactivityTimeoutMs?: number;
  /** Hard cap (ms) on a session's continuous duration. Defaults to 4h. */
  maxDurationMs?: number;
}

/**
 * Client-side session/view id minter with Datadog rollover semantics. All timing
 * comes from the injected `now` clock and all ids from the injected `generateId`,
 * so inactivity/max-duration rollover and per-navigation view minting are
 * deterministically testable without a DOM or real time.
 *
 * Fields are declared explicitly (no index-signature escape hatch) so a mistyped
 * field name in the hand-rolled rollover logic fails to compile rather than
 * silently creating a stray property.
 */
export class RumSessionManager {
  /** Inactivity timeout (ms) after which a session ends. */
  readonly inactivityTimeoutMs: number;
  /** Hard cap (ms) on one session's continuous duration. */
  readonly maxDurationMs: number;
  private readonly _now: () => number;
  private readonly _generateId: () => string;
  private _sessionId: string | null = null;
  private _viewId: string | null = null;
  private _sessionStart = 0;
  private _lastActivity = 0;

  constructor({
    now = () => Date.now(),
    generateId = generateRumId,
    inactivityTimeoutMs = SESSION_INACTIVITY_TIMEOUT_MS,
    maxDurationMs = SESSION_MAX_DURATION_MS,
  }: RumSessionManagerOptions = {}) {
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._generateId = typeof generateId === 'function' ? generateId : generateRumId;
    this.inactivityTimeoutMs =
      inactivityTimeoutMs > 0 ? inactivityTimeoutMs : SESSION_INACTIVITY_TIMEOUT_MS;
    this.maxDurationMs = maxDurationMs > 0 ? maxDurationMs : SESSION_MAX_DURATION_MS;
  }

  /** Current session.id, or null before the first activity/navigation. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Current view.id, or null before the first activity/navigation. */
  get viewId(): string | null {
    return this._viewId;
  }

  /**
   * True when there is no session yet, or the current one has expired — 15-min
   * inactivity (`now - lastActivity`) OR 4h continuous duration
   * (`now - sessionStart`). Checked against the PREVIOUS activity, before the
   * caller refreshes it.
   */
  _isExpired(now: number): boolean {
    if (this._sessionId == null) return true;
    if (now - this._lastActivity >= this.inactivityTimeoutMs) return true;
    if (now - this._sessionStart >= this.maxDurationMs) return true;
    return false;
  }

  /** Mint a fresh session.id + opening view.id, anchoring both clocks at `now`. */
  _startSession(now: number): void {
    this._sessionId = String(this._generateId());
    this._viewId = String(this._generateId());
    this._sessionStart = now;
    this._lastActivity = now;
  }

  /**
   * Read the current context WITHOUT registering activity or rolling over.
   * Returns nulls before the first session is minted. Use for diagnostics; the
   * ingest path should go through {@link notifyActivity}/{@link notifyViewChange}.
   */
  peek(): { sessionId: string | null; viewId: string | null } {
    return { sessionId: this._sessionId, viewId: this._viewId };
  }

  /**
   * Register activity (e.g. one rrweb event). Mints a fresh session (+ opening
   * view) when none exists or the current one has expired; otherwise refreshes
   * the inactivity clock and keeps the ids. Returns the resolved context and the
   * change flags.
   */
  notifyActivity(): RumSessionContext {
    const now = this._now();
    if (this._isExpired(now)) {
      this._startSession(now);
      return {
        sessionId: this._sessionId!,
        viewId: this._viewId!,
        sessionChanged: true,
        viewChanged: true,
      };
    }
    this._lastActivity = now;
    return {
      sessionId: this._sessionId!,
      viewId: this._viewId!,
      sessionChanged: false,
      viewChanged: false,
    };
  }

  /**
   * Register a navigation. Navigation is activity, so an expired/absent session
   * first rolls over to a fresh session — whose fresh opening view already covers
   * the new route (no double view mint). Otherwise a new view.id is minted under
   * the SAME session. Either way `viewChanged` is true.
   */
  notifyViewChange(): RumSessionContext {
    const now = this._now();
    if (this._isExpired(now)) {
      this._startSession(now);
      return {
        sessionId: this._sessionId!,
        viewId: this._viewId!,
        sessionChanged: true,
        viewChanged: true,
      };
    }
    this._lastActivity = now;
    this._viewId = String(this._generateId());
    return {
      sessionId: this._sessionId!,
      viewId: this._viewId!,
      sessionChanged: false,
      viewChanged: true,
    };
  }

  /** Reset to the unstarted state (test/teardown). */
  reset(): void {
    this._sessionId = null;
    this._viewId = null;
    this._sessionStart = 0;
    this._lastActivity = 0;
  }
}

/**
 * Install a route-change detector that fires `onViewChange(url)` on every SPA
 * navigation: `history.pushState` / `history.replaceState` (monkey-patched) and
 * the `popstate` / `hashchange` events. Only fires when the URL actually changes,
 * so a `replaceState` that rewrites state without moving the route is ignored.
 * Returns an uninstall fn that restores the patched history methods and removes
 * the listeners; a no-op (returning a noop uninstall) outside a browser.
 * Best-effort — a handler throw never breaks navigation.
 */
export function installViewChangeDetector(onViewChange: any): () => void {
  const noop = () => {};
  if (typeof window === 'undefined' || !window.history || typeof window.location === 'undefined') {
    return noop;
  }
  const cb = typeof onViewChange === 'function' ? onViewChange : noop;
  const currentUrl = () => {
    try {
      return String(window.location.href);
    } catch {
      return '';
    }
  };
  let lastUrl = currentUrl();
  const fire = () => {
    const url = currentUrl();
    // Ignore navigations that don't move the route (e.g. a state-only
    // replaceState) — Datadog opens a new view per real navigation, not per
    // history write.
    if (url === lastUrl) return;
    lastUrl = url;
    try {
      cb(url);
    } catch {
      // best-effort — a view-change consumer must not break navigation
    }
  };

  const history = window.history;
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  const wrap = (orig: any) =>
    function (this: any, ...args: any[]) {
      const ret = orig.apply(this, args);
      fire();
      return ret;
    };
  let patched = false;
  try {
    history.pushState = wrap(origPush);
    history.replaceState = wrap(origReplace);
    patched = true;
  } catch {
    // some environments freeze history — fall back to event listeners only
  }

  const onNav = () => fire();
  window.addEventListener('popstate', onNav);
  window.addEventListener('hashchange', onNav);

  return () => {
    if (patched) {
      try {
        history.pushState = origPush;
      } catch {
        // ignore
      }
      try {
        history.replaceState = origReplace;
      } catch {
        // ignore
      }
    }
    try {
      window.removeEventListener('popstate', onNav);
    } catch {
      // ignore
    }
    try {
      window.removeEventListener('hashchange', onNav);
    } catch {
      // ignore
    }
  };
}

/**
 * Rolling-buffer rrweb recorder. The rrweb `record` function and the upload
 * transport are injected so the recorder is testable without a DOM or network.
 */
export class SessionReplayRecorder {
  [key: string]: any;
  constructor({
    // Wrap `submitReplay` so the recorder can drive the upload's fetch-abort
    // deadline from the active flush budget (see `_runFlush`). Calling
    // `submitReplay` directly would put the timeout in the `endpoint` slot, so
    // the wrapper keeps the default endpoint and forwards only the timeout.
    submit = (payload: any, uploadTimeoutMs: any) =>
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
  }: any = {}) {
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
    // Optional consumer fed every raw emitted event (the continuous-capture
    // flusher). Null when continuous capture is off, which is the default.
    this._continuousSink = null;
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
  start(recordFn: any) {
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
        emit: (event: any) => this._handleEmit(event),
        checkoutEveryNms: this.windowMs,
      }) || null;
  }

  _handleEmit(event: any) {
    // Feed the continuous flusher (when wired) the RAW event BEFORE the rolling
    // buffer is pruned — continuous capture needs the whole stream, not the
    // trailing window the record-on-error path keeps. Never let a sink failure
    // break the recorder.
    if (typeof this._continuousSink === 'function') {
      try {
        this._continuousSink(event);
      } catch {
        // ignore — continuous streaming is best-effort
      }
    }
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
  _maybeSnapshotOnMount(event: any) {
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
  async flush(meta?: any, { timeoutMs = this.flushTimeoutMs }: any = {}) {
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
  async _runFlush(events: any, meta: any, timeoutMs: any) {
    let timer: any;
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
          ? new Promise((resolve: any) => {
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
  async handleError(meta: any) {
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

let _recorder: any = null;
let _initialized = false;
let _errorListenersWired = false;
// The active continuous-capture flusher, or null when the continuous tier is off
// (the default) or recording hasn't started.
let _continuousFlusher: any = null;
let _tailFlushListenersWired = false;
// Effective per-project RUM ingest token for this page, resolved once at init
// (`initSessionReplay` opts.rumToken, else `VITE_REPLAY_RUM_TOKEN`). Threaded
// into the continuous flusher so its chunk uploads carry `X-RUM-Token`.
let _rumToken: string | null = null;

export function getRecorder() {
  if (!_recorder) _recorder = new SessionReplayRecorder({});
  return _recorder;
}

/** The active continuous flusher, or null. Test/diagnostic accessor. */
export function getContinuousFlusher() {
  return _continuousFlusher;
}

/**
 * Mint a per-session replay id for the continuous stream. Prefers
 * `crypto.randomUUID()`; falls back to a timestamp+random id. The result matches
 * the server's `^[A-Za-z0-9._-]{8,200}$` id charset.
 */
export function generateReplayId() {
  try {
    if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
      return (crypto as any).randomUUID();
    }
  } catch {
    // fall through
  }
  return `replay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Wire the tab-close tail-flush listeners exactly once. `pagehide` is the
 * reliable end-of-page signal; `visibilitychange → hidden` covers mobile
 * background/app-switch where `pagehide` may not fire. Idempotent and a no-op
 * outside a browser.
 *
 * Terminality is derived per-event, not assumed: a `pagehide` is terminal ONLY
 * when `event.persisted` is false. A persisted pagehide means the page entered
 * the back/forward cache and can later resume, so it is forwarded as NON-terminal
 * — an uncreated capture then takes the confirmed async path instead of an
 * optimistic beacon-create that could strand the capture if the bfcache page
 * resumes and the beacon was never accepted. `visibilitychange: hidden` is always
 * non-terminal (the tab can return).
 */
function ensureTailFlushListeners() {
  if (_tailFlushListenersWired || typeof window === 'undefined') return;
  _tailFlushListenersWired = true;
  const onTail = (reason: any, terminal: any) => {
    if (_continuousFlusher) _continuousFlusher.flushTail(reason, { terminal });
  };
  window.addEventListener('pagehide', (e: any) => {
    // A persisted pagehide (bfcache) is NOT terminal — the page can resume.
    onTail('pagehide', !(e && e.persisted));
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onTail('visibilitychange', false);
    });
  }
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
  // Wire the continuous flusher BEFORE record() so the Meta + FullSnapshot that
  // rrweb emits synchronously at record() start is captured as the creating
  // chunk — without it the first batch would lack a snapshot and be rejected.
  // Off by default; only when the project opts into the continuous tier.
  if (_serverContinuous && !_continuousFlusher) {
    _continuousFlusher = new ContinuousReplayFlusher({
      replayId: generateReplayId(),
      flushIntervalMs: getContinuousFlushIntervalMs(),
      // Attribute chunks to the project, matching the config path. Falls back to
      // the build-time env when init didn't capture one (e.g. a runtime toggle).
      rumToken: _rumToken ?? resolveReplayRumToken(),
    });
    rec._continuousSink = (e: any) => _continuousFlusher.addEvent(e);
  }
  try {
    const mod = await import('rrweb');
    rec.start(mod.record);
  } catch {
    // rrweb failed to load — tear down the half-wired flusher so it can't leak.
    if (_continuousFlusher) {
      _continuousFlusher.stop();
      _continuousFlusher = null;
      rec._continuousSink = null;
    }
    return null;
  }
  ensureErrorListeners();
  // Start the periodic timer + tab-close listeners now that events are flowing.
  if (_continuousFlusher) {
    _continuousFlusher.start();
    ensureTailFlushListeners();
  }
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
export async function setSessionReplayEnabled(enabled: any) {
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
    // Tear down continuous streaming too. Unlike a tab close, a runtime disable
    // happens while the page is ALIVE, so we can (and must) AWAIT a confirmed
    // flush of whatever is buffered before dropping the flusher — `flushTail`'s
    // non-terminal path is fire-and-forget and would be orphaned by the teardown
    // below. Detach first (stop the timer, unwire the sink, null the singleton)
    // so no new events queue and a concurrent pagehide can't double-flush, then
    // drain the captured instance to completion. `_drainAfterInflight` waits out
    // any in-flight interval flush before sending the remaining pending batch.
    if (_continuousFlusher) {
      const flusher = _continuousFlusher;
      _continuousFlusher = null;
      _recorder._continuousSink = null;
      flusher.stop();
      try {
        await flusher._drainAfterInflight('disabled');
      } catch {
        // ignore — best-effort
      }
    }
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
export async function setReplayMaskingMode(maskAll: any) {
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
export async function initSessionReplay(opts: any = {}) {
  if (typeof window === 'undefined') return null;
  if (_initialized) return _recorder;
  _initialized = true;

  // Capture the effective RUM token once so the continuous flusher can attribute
  // its chunk uploads (and the config fetch below uses the same one).
  _rumToken = opts.rumToken ?? resolveReplayRumToken();

  // Pull the server-delivered per-project policy before sampling so a
  // project-set rate (and mask-all enforcement) governs this client. The server
  // resolves the project from the RUM token (`opts.rumToken` /
  // `VITE_REPLAY_RUM_TOKEN`) then the project id (`opts.projectId` /
  // `VITE_REPLAY_PROJECT_ID`); without either it returns the default policy.
  // Best-effort and skippable for tests (`opts.skipServerConfig` / an injected
  // `opts.sampleRate`).
  if (opts.sampleRate == null && !opts.skipServerConfig) {
    await fetchServerReplayConfig({ projectId: opts.projectId, rumToken: opts.rumToken });
  }

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

// The closed set of reasons a flush can yield no replay ref. Exported so the
// bug-report path (and the server's intake validation) share one vocabulary —
// a "didn't capture replay" ticket records WHICH of these fired.
export const REPLAY_MISS_REASONS = Object.freeze([
  'recorder-not-initialized',
  'recorder-inactive',
  'buffer-too-small',
  'no-full-snapshot',
  'upload-failed',
]);

function defaultBreadcrumbSink(entry: any) {
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
export function setReplayBreadcrumbSink(sink: any) {
  _breadcrumbSink = typeof sink === 'function' ? sink : defaultBreadcrumbSink;
}

function reportNullFlush(reason: any, meta: any) {
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
export async function flushSessionReplayRef(meta?: any, timeoutMs?: any) {
  const { ref } = await flushSessionReplayRefWithReason(meta, timeoutMs);
  return ref;
}

/**
 * Like `flushSessionReplayRef`, but returns BOTH the resolved ref and the
 * miss-reason so a caller (the bug-report modal) can record WHY a replay didn't
 * attach. On success: `{ ref: '/uploads/replay-…json', reason: null }`. On every
 * null path: `{ ref: null, reason: <one of REPLAY_MISS_REASONS> }`. The same
 * breadcrumb still fires, so console/telemetry behaviour is unchanged; this just
 * surfaces the reason to the caller instead of dropping it on the floor.
 */
export async function flushSessionReplayRefWithReason(meta?: any, timeoutMs?: any) {
  if (!_recorder) {
    reportNullFlush('recorder-not-initialized', meta);
    return { ref: null, reason: 'recorder-not-initialized' };
  }
  if (!_recorder.active) {
    reportNullFlush('recorder-inactive', meta);
    return { ref: null, reason: 'recorder-inactive' };
  }
  // Pre-classify the no-op cases that `flush()` would otherwise collapse into a
  // silent null, so the breadcrumb can name *why* nothing shipped. These mirror
  // flush()'s own guards (pure checks), leaving its behaviour unchanged.
  const buffered = _recorder.snapshot();
  if (buffered.length < _recorder.minFlushEvents) {
    reportNullFlush('buffer-too-small', meta);
    return { ref: null, reason: 'buffer-too-small' };
  }
  if (!hasFullSnapshot(buffered)) {
    reportNullFlush('no-full-snapshot', meta);
    return { ref: null, reason: 'no-full-snapshot' };
  }
  const opts = timeoutMs != null ? { timeoutMs } : undefined;
  const result = await _recorder.flush(meta, opts);
  const ref = result?.replayRef || null;
  // A replayable buffer that still produced no ref means the ingest upload
  // failed, timed out, or was rate-limited.
  if (!ref) {
    reportNullFlush('upload-failed', meta);
    return { ref: null, reason: 'upload-failed' };
  }
  return { ref, reason: null };
}

/** Test-only: reset the module singleton. */
export function _resetSessionReplayForTest() {
  if (_continuousFlusher) {
    try {
      _continuousFlusher.stop();
    } catch {
      // ignore
    }
  }
  _recorder = null;
  _initialized = false;
  _errorListenersWired = false;
  _breadcrumbSink = defaultBreadcrumbSink;
  _serverSampleRate = null;
  _serverMaskAllEnforced = false;
  _serverContinuous = false;
  _serverFlushIntervalMs = null;
  _continuousFlusher = null;
  _tailFlushListenersWired = false;
  _rumToken = null;
}
