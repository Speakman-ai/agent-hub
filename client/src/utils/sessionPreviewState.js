/**
 * sessionPreviewState — pure helpers for the SessionPreviewPane.
 *
 * The pane is fed by `agenthub_preview` WS events whose shape is defined
 * in `server/preview/preview-block.ts` (`PreviewBroadcastEvent`).  We
 * derive a small, render-friendly state object from the latest event
 * for the active session, and we throttle iframe-activity touches so we
 * never call the runtime more often than once per `intervalMs`.
 *
 * Everything in this file is intentionally framework-free so it can be
 * unit-tested without React.
 */

/**
 * Discriminated-union state shape consumed by SessionPreviewPane.
 *
 *   { status: 'idle' }                                  — no event yet
 *   { status: 'starting',       previewId, target, route, agentReason } — block dispatched, runtime spawning
 *   { status: 'ready',  url, port, route, target, previewId, screenshotPath, agentReason }
 *     (`url` = fullUrl || previewUrl — the canonical URL to load in the iframe)
 *   { status: 'failed', error, logTail, previewId, target, route, agentReason }
 *   { status: 'unavailable', reason, wizard, wizardUrl, target, route, agentReason }
 *
 * Callers should switch on `status` for rendering. Unknown / malformed
 * events collapse to `{ status: 'idle' }` so the pane never crashes.
 */
export function derivePaneState(event) {
  if (!event || typeof event !== 'object') return { status: 'idle' };
  const { kind, target, route, agentReason, previewId } = event;
  if (kind === 'preview') {
    const url = event.fullUrl || event.previewUrl || '';
    return {
      status: 'ready',
      url,
      port: typeof event.port === 'number' ? event.port : null,
      route: route || '/',
      target: target || null,
      previewId: previewId || '',
      screenshotPath: event.screenshotPath || null,
      agentReason: agentReason || '',
    };
  }
  if (kind === 'preview_failed') {
    return {
      status: 'failed',
      error: event.error || 'preview failed',
      logTail: Array.isArray(event.logTail) ? event.logTail : [],
      previewId: previewId || '',
      target: target || null,
      route: route || '/',
      agentReason: agentReason || '',
    };
  }
  if (kind === 'preview_unavailable') {
    return {
      status: 'unavailable',
      reason: event.unavailableReason || 'no-pr-env',
      wizard: event.wizard || null,
      wizardUrl: event.wizardUrl || null,
      target: target || null,
      route: route || '/',
      agentReason: agentReason || '',
    };
  }
  // Optional `starting` shape — handy if a future broadcast adds a
  // pre-ready event; not currently emitted by the server.
  if (kind === 'preview_starting') {
    return {
      status: 'starting',
      previewId: previewId || '',
      target: target || null,
      route: route || '/',
      agentReason: agentReason || '',
    };
  }
  return { status: 'idle' };
}

/**
 * Build a throttled activity-touch caller. The returned `notify()` invokes
 * `callback()` at most once per `intervalMs`. Subsequent calls within the
 * window are dropped. Test-friendly: pass `now` to override `Date.now`.
 *
 * Why: AC requires touch-on-activity (focus/blur/mousemove) to be
 * debounced to ~30 s so a fast-moving cursor doesn't melt the runtime.
 */
export function createActivityTouch(callback, intervalMs = 30_000, now = () => Date.now()) {
  // Start "infinitely far in the past" so the first call always fires
  // regardless of where the caller's clock starts.
  let last = Number.NEGATIVE_INFINITY;
  return function notify() {
    const ts = now();
    if (ts - last < intervalMs) return false;
    last = ts;
    try {
      callback();
    } catch {
      // Touch failures are non-fatal — keep the clock advanced so we
      // don't burst-retry on every mousemove after an error.
    }
    return true;
  };
}

/**
 * localStorage key for the pane open/closed state, scoped per session.
 * Exposed so tests don't have to duplicate the key format.
 */
export function paneOpenStorageKey(sessionId) {
  if (!sessionId) return null;
  return `previewPaneOpen:${sessionId}`;
}

/**
 * localStorage key for the pane width (px). The pane is resizable and we
 * persist the user's preferred width across reloads, scoped per session
 * so a wide multi-monitor session doesn't drag a narrow laptop one wider.
 */
export function paneWidthStorageKey(sessionId) {
  if (!sessionId) return null;
  return `previewPaneWidth:${sessionId}`;
}

/**
 * Default pane width in pixels. Used as the `useState` initial value in
 * SessionPreviewPane and as the `fallback` in `clampPaneWidth`, so the two
 * stay in sync from a single source of truth.
 */
export const DEFAULT_PANE_WIDTH = 560;

/**
 * Validate a pane width pulled from localStorage. Returns the clamped
 * number on success, or `null` if the input is unusable.
 */
export function clampPaneWidth(value, { min = 320, max = 1400, fallback = DEFAULT_PANE_WIDTH } = {}) {
  // null / undefined / empty-string read out of localStorage means
  // "never persisted" — return the fallback rather than coercing to 0
  // and then clamping up to `min`.
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  // Infinity is technically out of bounds — clamp it like any other
  // too-large value so callers using `clampPaneWidth(Infinity, {max})`
  // get the ceiling, not the fallback.
  if (n === Number.POSITIVE_INFINITY) return max;
  if (n === Number.NEGATIVE_INFINITY) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
