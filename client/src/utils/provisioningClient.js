/**
 * Provisioning client — thin wrapper over the /api/projects/provision
 * endpoint + its WebSocket event stream.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Contract (to be implemented by hub-backend):
 *
 *   POST /api/projects/provision
 *     body:  provisioning payload from AdaptiveQuestionnaire.toProvisioningPayload()
 *     auth:  standard JWT / API key
 *     200:   { jobId: string, wsUrl: string }
 *     4xx:   { error: string }
 *
 *   WS <wsUrl>
 *     Server pushes newline-delimited JSON events (one per message frame):
 *       { type:'phase', phase:<id>, status:'started'|'ok'|'failed'|'skipped',
 *         message?:string, at:<ISO>, seq:<number> }
 *       { type:'log',   line:<string>, at:<ISO>, seq:<number> }
 *       { type:'done',  repoUrl?:<string>, partial?:boolean,
 *         error?:{ code:number, message:string, hint?:string }, seq:<number> }
 *     After a 'done' event the server closes the socket.
 *
 *     Reconnect: append `?since=<seq>` to resume after a dropped socket;
 *     the server replays only events with seq greater than `since`.
 *
 * The client helpers here own transport concerns (fetch, auth headers,
 * socket URL wiring, watchdog, reconnect) and hand raw events back to
 * the caller. State reduction happens in provisioningStatus.js.
 * ─────────────────────────────────────────────────────────────────────
 */

import { getApiBase, getAuthHeaders } from './connection.js';

/**
 * Kick off a provisioning job.
 * @param {object} payload — shape from adaptiveQuestionnaire.toProvisioningPayload()
 * @returns {Promise<{ jobId: string, wsUrl: string }>}
 */
export async function provisionProject(payload) {
  const base = getApiBase();
  const res = await fetch(`${base}/projects/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || body.message || JSON.stringify(body);
    } catch {
      /* response wasn't JSON */
    }
    throw new Error(detail ? `${res.status}: ${detail}` : `Provisioning failed: ${res.status}`);
  }
  return res.json();
}

/** Default watchdog window: if no event arrives in this many ms, treat the
 * stream as stalled and synthesize a terminal failure so the UI can recover.
 * Overridable via the `watchdogMs` option (tests pass a small value; env
 * override is honoured for E2E). */
export const DEFAULT_WATCHDOG_MS = 45_000;

/** Reconnect backoff — kept short because we only attempt once before
 * surfacing a failure. The server's ring buffer replays missed events. */
export const DEFAULT_RECONNECT_BACKOFF_MS = 500;

function readEnvNumber(name) {
  try {
    // Vite exposes env vars on import.meta.env; fall back to globalThis.process
    // for node test runners. Both are optional — a missing value returns null.
    const viteEnv = typeof import.meta !== 'undefined' ? import.meta.env : null;
    const nodeEnv =
      typeof globalThis !== 'undefined' && globalThis.process ? globalThis.process.env : null;
    const raw = (viteEnv && viteEnv[name]) || (nodeEnv && nodeEnv[name]);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function appendSinceQuery(wsUrl, since) {
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) return wsUrl;
  const sep = wsUrl.includes('?') ? '&' : '?';
  return `${wsUrl}${sep}since=${since}`;
}

/**
 * Structured TOOL_ERROR line — emitted to console so Agent Hub's session
 * capture can pick it up. Severity `soft` + resolution tag matches the
 * SOUL.md guidance for stall/reconnect observability.
 */
function logToolError({ action, code, summary, severity = 'soft', resolution = 'recovered' }) {
  try {
    const ts = new Date().toISOString();
    // Format matches SOUL.md's TOOL_ERROR spec with optional severity /
    // resolution columns appended — downstream aggregators tolerate extras.

    console.warn(
      `TOOL_ERROR | ${ts} | provisioning-stream | ${action} | ${code} | ${summary} | severity:${severity} | resolution:${resolution}`,
    );
  } catch {
    /* never let telemetry block the caller */
  }
}

/**
 * Subscribe to the event stream for a provisioning job.
 *
 * The server's WebSocket URL (returned from provisionProject) is opened
 * here; events arrive as JSON-per-frame. Adds two reliability layers on
 * top of a raw socket:
 *
 *   • Watchdog timer — if no event arrives within `watchdogMs` (default
 *     45s, override via `VITE_PROVISIONING_WATCHDOG_MS`), a synthesized
 *     `done` event with `error.code = 'STREAM_STALLED'` is emitted so
 *     the UI can render the failure card and offer retry.
 *
 *   • Reconnect — on an unexpected close (i.e. the socket closed without
 *     a terminal `done`), one silent reconnect is attempted using
 *     `?since=<lastSeq>` so the server replays only missed events. A
 *     second drop surfaces a terminal failure with onRetry available.
 *
 * The returned handle exposes `close()` for callers to tear down on
 * unmount / cancellation.
 *
 * @param {string} wsUrl
 * @param {{
 *   onEvent: (ev) => void,
 *   onClose?: () => void,
 *   onError?: (err) => void,
 *   watchdogMs?: number,
 *   reconnectBackoffMs?: number,
 *   maxReconnects?: number,
 *   webSocketFactory?: (url: string) => WebSocket,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} handlers
 * @returns {{ close: () => void }}
 */
export function subscribeProvisioningEvents(wsUrl, handlers) {
  const {
    onEvent,
    onClose,
    onError,
    watchdogMs,
    reconnectBackoffMs,
    maxReconnects,
    webSocketFactory,
    setTimeoutFn,
    clearTimeoutFn,
  } = handlers || {};

  const effectiveWatchdogMs =
    typeof watchdogMs === 'number' && watchdogMs > 0
      ? watchdogMs
      : (readEnvNumber('VITE_PROVISIONING_WATCHDOG_MS') ?? DEFAULT_WATCHDOG_MS);

  const effectiveBackoffMs =
    typeof reconnectBackoffMs === 'number' && reconnectBackoffMs >= 0
      ? reconnectBackoffMs
      : (readEnvNumber('VITE_PROVISIONING_RECONNECT_BACKOFF_MS') ?? DEFAULT_RECONNECT_BACKOFF_MS);

  const effectiveMaxReconnects =
    typeof maxReconnects === 'number' && maxReconnects >= 0 ? maxReconnects : 1;

  const makeSocket = webSocketFactory || ((url) => new WebSocket(url));
  const setT = setTimeoutFn || setTimeout;
  const clearT = clearTimeoutFn || clearTimeout;

  // Shared state across the initial connection and any reconnects.
  const state = {
    closed: false, // caller invoked handle.close() OR terminal failure landed
    doneReceived: false, // saw a terminal `done` event
    lastSeq: -1, // highest seq observed; used for ?since=<seq>
    reconnects: 0, // how many reconnects we've already attempted
    socket: null, // current underlying socket
    watchdogHandle: null, // active watchdog timer
    reconnectHandle: null, // pending reconnect timeout
  };

  function clearWatchdog() {
    if (state.watchdogHandle != null) {
      try {
        clearT(state.watchdogHandle);
      } catch {
        /* ignore */
      }
      state.watchdogHandle = null;
    }
  }

  function armWatchdog() {
    clearWatchdog();
    if (state.closed || state.doneReceived) return;
    state.watchdogHandle = setT(() => {
      state.watchdogHandle = null;
      if (state.closed || state.doneReceived) return;
      // Watchdog fired — the stream has gone silent past the threshold.
      // Tear down the current socket and synthesize a terminal failure so
      // the UI can render the failure card and offer retry.
      logToolError({
        action: 'watchdog',
        code: 'STREAM_STALLED',
        summary: `no event for ${effectiveWatchdogMs}ms`,
        resolution: 'escalated',
      });
      state.doneReceived = true;
      state.closed = true;
      try {
        state.socket?.close?.();
      } catch {
        /* ignore */
      }
      try {
        onEvent?.({
          type: 'done',
          error: {
            code: 'STREAM_STALLED',
            message: `Provisioning stream silent for ${effectiveWatchdogMs}ms`,
          },
        });
      } catch {
        /* swallow — caller error shouldn't mask the stall */
      }
      try {
        onClose?.();
      } catch {
        /* ignore */
      }
    }, effectiveWatchdogMs);
  }

  function attachSocket(url, { isReconnect }) {
    let socket;
    try {
      socket = makeSocket(url);
    } catch (err) {
      onError?.(err);
      // If the initial construction fails we can't recover — let the
      // caller see an error and surface a close so their UI settles.
      state.closed = true;
      clearWatchdog();
      return;
    }
    state.socket = socket;
    armWatchdog();

    socket.onmessage = (msg) => {
      if (state.closed) return;
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch (err) {
        onError?.(err);
        return;
      }
      // Track seq for reconnects. Only update when the event carries one
      // so legacy / synthesized events don't clobber a real cursor.
      if (
        data &&
        typeof data.seq === 'number' &&
        Number.isFinite(data.seq) &&
        data.seq > state.lastSeq
      ) {
        state.lastSeq = data.seq;
      }
      if (data && data.type === 'done') {
        state.doneReceived = true;
      }
      // Any event resets the watchdog — we're not stalled.
      armWatchdog();
      try {
        onEvent?.(data);
      } catch {
        /* subscriber errors never block the stream */
      }
      if (state.doneReceived) {
        clearWatchdog();
      }
    };

    socket.onclose = () => {
      if (state.closed) return;
      // Clean close after terminal done — normal teardown.
      if (state.doneReceived) {
        state.closed = true;
        clearWatchdog();
        try {
          onClose?.();
        } catch {
          /* ignore */
        }
        return;
      }
      // Unexpected close without a terminal done. Try one reconnect,
      // replaying from the last seq we saw so no events are lost.
      if (state.reconnects < effectiveMaxReconnects) {
        state.reconnects += 1;
        clearWatchdog();
        logToolError({
          action: 'reconnect',
          code: 'SOCKET_DROPPED',
          summary: `unexpected close; reconnect ${state.reconnects}/${effectiveMaxReconnects} (since=${state.lastSeq})`,
          resolution: 'recovered',
        });
        state.reconnectHandle = setT(() => {
          state.reconnectHandle = null;
          if (state.closed) return;
          const nextUrl = appendSinceQuery(wsUrl, state.lastSeq >= 0 ? state.lastSeq : undefined);
          attachSocket(nextUrl, { isReconnect: true });
        }, effectiveBackoffMs);
        return;
      }
      // Out of reconnect budget — surface a failure so the caller's UI
      // can render the failure card with `onRetry`. We synthesize a
      // `done` with a structured error code so downstream consumers
      // (ProvisioningStatus) don't have to branch on close state.
      logToolError({
        action: 'reconnect-give-up',
        code: 'STREAM_DROPPED',
        summary: `no further reconnects after ${state.reconnects} attempt(s)`,
        resolution: 'escalated',
      });
      state.doneReceived = true;
      state.closed = true;
      try {
        onEvent?.({
          type: 'done',
          error: {
            code: 'STREAM_DROPPED',
            message: 'Provisioning stream dropped and could not be resumed.',
          },
        });
      } catch {
        /* ignore */
      }
      try {
        onClose?.();
      } catch {
        /* ignore */
      }
    };

    socket.onerror = (err) => {
      if (state.closed) return;
      try {
        onError?.(err);
      } catch {
        /* ignore */
      }
      // Don't close on error alone — the browser usually fires onclose
      // right after, which drives the reconnect/teardown path.
    };

    // Mark the reconnect as successful once we've wired handlers; the
    // watchdog is already armed above and will re-fire if the server
    // stays silent.
    if (isReconnect) {
      // No-op — hook kept for future observability (e.g. "reconnect succeeded").
    }
  }

  attachSocket(wsUrl, { isReconnect: false });

  return {
    close: () => {
      state.closed = true;
      clearWatchdog();
      if (state.reconnectHandle != null) {
        try {
          clearT(state.reconnectHandle);
        } catch {
          /* ignore */
        }
        state.reconnectHandle = null;
      }
      try {
        state.socket?.close?.();
      } catch {
        /* ignore */
      }
    },
  };
}
