/**
 * Runner WebSocket handler — control-plane side of the runner protocol.
 *
 * One outbound connection per runner. Auth is via runner-token (not the
 * browser API key) so this path bypasses `authenticateWs`. The flow:
 *
 *   1. Runner opens WS at `/ws/runner`.
 *   2. Server waits up to AUTH_TIMEOUT_MS for an `auth` frame.
 *   3. Server validates: runner exists, token matches, version compatible.
 *   4. On success: row marked `online`, capabilities updated, `registered`
 *      sent, periodic pings begin.
 *   5. On any failure: `auth_error` sent + socket closed with code 4401.
 *
 * Live connections are tracked in a process-local Map (`activeRunners`)
 * for the duration of phase 1 — phase 2 will replace this with a runner
 * dispatcher that fans `spawn`/`fs`/`git` commands across many runners.
 */
import type { IncomingMessage } from 'http';
import { WebSocket as WsClient } from 'ws';
import {
  RUNNER_PROTOCOL_VERSION,
  isCompatibleVersion,
  parseRunnerInbound,
  type RunnerAuthErrorMessage,
  type RunnerInbound,
  type RunnerPingMessage,
  type RunnerRegisteredMessage,
} from '../shared/runner-protocol.js';
import { setRunnerStatus, verifyRunnerToken, getRunner } from './runners-store.js';
import { v4 as uuidv4 } from 'uuid';

export const AUTH_TIMEOUT_MS = 5_000;
export const PING_INTERVAL_MS = 30_000;
/**
 * Maximum consecutive missed pongs before closing the socket. With a 30 s
 * ping interval, the socket closes on the tick that reaches this count —
 * 3 missed pongs ≈ 90 s of silence before we declare the runner wedged.
 */
export const MAX_MISSED_PONGS = 3;
/** Close codes (4xxx range is reserved for app-level codes per RFC 6455). */
const CLOSE_AUTH_FAILED = 4401;
const CLOSE_PROTOCOL = 4400;
const CLOSE_STALE = 4408;

interface ActiveRunner {
  ws: WsClient;
  runnerId: string;
  /** ISO of the most recent successful pong. */
  lastPongAt: string;
  /** Number of pings sent since the last pong was received. */
  missedPongs: number;
}

/**
 * Process-local registry of currently-connected runners. Exported for
 * future dispatcher logic and for tests that want to assert live state.
 */
export const activeRunners = new Map<string, ActiveRunner>();

/**
 * Per-runner inbound-frame subscribers. `RemoteRunnerTransport` (and any
 * other consumer) registers a listener here; the WS message handler
 * fires every listener for every parsed `RunnerInbound` after auth.
 *
 * Subscribers are responsible for filtering on `id` — multiple sessions
 * can share one runner connection, so every listener will see every
 * frame and must drop frames addressed to other spawn ids.
 *
 * Implementation note: we use a Set per runner so unsubscribe is O(1)
 * and we never accidentally hold duplicate listeners on reconnect.
 */
const runnerSubscribers = new Map<string, Set<(msg: RunnerInbound) => void>>();

/**
 * Per-runner disconnect listeners. Fires once when the WS for a given
 * runner closes (normal close, stale-keepalive close, network drop —
 * any path that runs `teardown` and owns the active slot). The
 * dispatcher delivers a single notification per registration, then
 * drops the listener; the disconnect signal is one-shot by design so
 * `RemoteProcessHandle` instances and any other consumer can unwind
 * exactly once and replace whatever guarantee `child_process` would
 * have given them via `'close'`.
 *
 * This is intentionally a separate channel from `runnerSubscribers`
 * because the contracts differ: inbound frames may stream forever, but
 * disconnect fires exactly once and never afterwards (a reconnect
 * spawns a new socket whose subscribers / disconnect listeners are
 * independent).
 */
const runnerDisconnectListeners = new Map<string, Set<() => void>>();

/**
 * Send a JSON-encoded frame to a connected runner. Returns `null` when
 * the runner has no live socket — callers (e.g. `RemoteRunnerTransport`)
 * use this to detect the offline case and surface a typed error.
 */
export function getRunnerSender(runnerId: string): ((frame: object) => void) | null {
  const entry = activeRunners.get(runnerId);
  if (!entry) return null;
  const ws = entry.ws;
  return (frame: object) => {
    if (ws.readyState !== WsClient.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* socket closed mid-send; the close handler will fire shortly */
    }
  };
}

/**
 * Subscribe to runner→server frames for a specific runner. The returned
 * function unsubscribes — callers MUST invoke it on teardown to avoid
 * leaking listeners across reconnects.
 *
 * Listeners receive every parsed inbound frame including `pong`. The
 * subscriber is responsible for filtering by `type` and `id`.
 */
export function subscribeToRunner(
  runnerId: string,
  listener: (msg: RunnerInbound) => void,
): () => void {
  let set = runnerSubscribers.get(runnerId);
  if (!set) {
    set = new Set();
    runnerSubscribers.set(runnerId, set);
  }
  set.add(listener);
  return () => {
    const current = runnerSubscribers.get(runnerId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) runnerSubscribers.delete(runnerId);
  };
}

/** Fire all subscribers for a runner with the given parsed frame.
 * Errors in individual listeners must not break the dispatch loop. */
function fireSubscribers(runnerId: string, msg: RunnerInbound): void {
  const set = runnerSubscribers.get(runnerId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(msg);
    } catch (err) {
      console.warn(`[runner-ws] subscriber threw for runner ${runnerId}:`, (err as Error).message);
    }
  }
}

/**
 * Subscribe to the one-shot disconnect signal for a runner. Returns the
 * unsubscribe function. The listener fires at most once — even if the
 * runner reconnects, that's a fresh socket and any code that wants
 * disconnect coverage on the new connection has to re-subscribe.
 *
 * Used by `RemoteRunnerTransport` to surface a synthetic close to every
 * in-flight `RemoteProcessHandle` when its runner goes away, replacing
 * the implicit `child_process`'s `'close'` guarantee that the local
 * transport relies on.
 */
export function subscribeToRunnerDisconnect(runnerId: string, listener: () => void): () => void {
  let set = runnerDisconnectListeners.get(runnerId);
  if (!set) {
    set = new Set();
    runnerDisconnectListeners.set(runnerId, set);
  }
  set.add(listener);
  return () => {
    const current = runnerDisconnectListeners.get(runnerId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) runnerDisconnectListeners.delete(runnerId);
  };
}

/**
 * Fire every disconnect listener for a runner exactly once, then drop
 * both the disconnect set AND the inbound subscriber set — any pending
 * subscriber is now waiting on a dead socket, so leaving them around
 * would be a memory leak with no upside.
 *
 * Called from `teardown` and exposed via `notifyRunnerDisconnect` for
 * tests that want to drive the failure mode without bouncing a real
 * socket.
 */
function fireDisconnectListeners(runnerId: string): void {
  const set = runnerDisconnectListeners.get(runnerId);
  // Snapshot before invoking — listeners may unregister themselves /
  // others mid-iteration.
  const snapshot = set ? [...set] : [];
  runnerDisconnectListeners.delete(runnerId);
  runnerSubscribers.delete(runnerId);
  for (const listener of snapshot) {
    try {
      listener();
    } catch (err) {
      console.warn(
        `[runner-ws] disconnect listener threw for runner ${runnerId}:`,
        (err as Error).message,
      );
    }
  }
}

/**
 * Test seam — fire the disconnect channel for a runner without closing
 * its socket. Production code uses the natural `teardown` path; this
 * exists so disconnect-propagation tests don't have to dance with WS
 * close timing.
 */
export function notifyRunnerDisconnect(runnerId: string): void {
  fireDisconnectListeners(runnerId);
}

/**
 * Detect the runner WS path. Currently `/ws/runner` (with optional query
 * string). Returns true if the request should be handled by this module.
 */
export function isRunnerWsPath(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  const pathOnly = rawUrl.split('?')[0] ?? '';
  return pathOnly === '/ws/runner' || pathOnly === '/ws/runner/';
}

function sendJson(ws: WsClient, msg: object): void {
  if (ws.readyState !== WsClient.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket may have closed mid-send */
  }
}

function sendAuthError(ws: WsClient, code: RunnerAuthErrorMessage['code'], message: string): void {
  const frame: RunnerAuthErrorMessage = { type: 'auth_error', code, message };
  sendJson(ws, frame);
  try {
    ws.close(CLOSE_AUTH_FAILED, message.slice(0, 120));
  } catch {
    /* already closed */
  }
}

/**
 * Wire up the auth handshake + post-auth keepalive on a freshly opened
 * runner WS. Caller is `websocket.ts`'s connection dispatcher; this
 * function fully owns the socket lifecycle from this point on.
 */
export function handleRunnerConnection(ws: WsClient, _request: IncomingMessage): void {
  let authed = false;
  let pingTimer: NodeJS.Timeout | null = null;
  let activeRunnerId: string | null = null;

  const authTimeout = setTimeout(() => {
    if (!authed) {
      sendAuthError(ws, 'malformed', 'No auth frame received within timeout');
    }
  }, AUTH_TIMEOUT_MS);

  function startPings(runnerId: string): void {
    pingTimer = setInterval(() => {
      const entry = activeRunners.get(runnerId);
      if (entry) {
        entry.missedPongs += 1;
        if (entry.missedPongs >= MAX_MISSED_PONGS) {
          console.warn(
            `[runner-ws] runner ${runnerId} missed ${entry.missedPongs} pongs — closing as stale`,
          );
          try {
            ws.close(CLOSE_STALE, 'Pong timeout — runner appears wedged');
          } catch {
            /* already closed */
          }
          return;
        }
      }
      const ping: RunnerPingMessage = {
        type: 'ping',
        id: uuidv4(),
        ts: new Date().toISOString(),
      };
      sendJson(ws, ping);
    }, PING_INTERVAL_MS);
    // Don't keep the event loop alive solely for pings — node will
    // happily exit if nothing else is pending.
    pingTimer.unref?.();
  }

  function teardown(): void {
    clearTimeout(authTimeout);
    if (pingTimer) clearInterval(pingTimer);
    if (activeRunnerId) {
      // Guard against reconnect race: if a replacement socket has already
      // authed and taken over the activeRunners entry, this stale close
      // handler must not clobber it. Only clean up if we still own the slot.
      if (activeRunners.get(activeRunnerId)?.ws === ws) {
        activeRunners.delete(activeRunnerId);
        try {
          setRunnerStatus(activeRunnerId, 'offline');
        } catch (err) {
          console.warn('[runner-ws] failed to mark runner offline:', (err as Error).message);
        }
        // Notify every in-flight RemoteProcessHandle that this runner is
        // gone. Without this, transport listeners are waiting forever on
        // result/stream/exit frames that will never arrive — the chat
        // session stays in a permanent "thinking" state because
        // `proc.on('close')` never fires. Ordering matters: drop the
        // active slot FIRST so a disconnect listener that synchronously
        // tries to send a `cancel` (via getRunnerSender) sees `null`
        // instead of the dying socket.
        fireDisconnectListeners(activeRunnerId);
      }
    }
  }

  ws.on('message', (raw) => {
    const msg = parseRunnerInbound(raw as Buffer | string);
    if (!msg) {
      if (!authed) {
        sendAuthError(ws, 'malformed', 'Malformed JSON or unknown frame type');
        return;
      }
      // Post-auth: a malformed frame is a protocol violation. Close
      // rather than silently dropping — the runner needs to know.
      try {
        ws.close(CLOSE_PROTOCOL, 'Malformed frame');
      } catch {}
      return;
    }

    if (msg.type === 'auth') {
      if (authed) {
        // Re-auth on the same socket isn't supported — close.
        sendAuthError(ws, 'already_authed', 'Already authenticated');
        return;
      }
      if (!isCompatibleVersion(msg.version)) {
        sendAuthError(
          ws,
          'incompatible_version',
          `Runner protocol ${msg.version} incompatible with server ${RUNNER_PROTOCOL_VERSION}`,
        );
        return;
      }
      const runner = getRunner(msg.runnerId);
      if (!runner) {
        sendAuthError(ws, 'unknown_runner', 'Runner id not found — re-register required');
        return;
      }
      if (!verifyRunnerToken(msg.runnerId, msg.token)) {
        sendAuthError(ws, 'bad_token', 'Token does not match');
        return;
      }

      authed = true;
      clearTimeout(authTimeout);
      activeRunnerId = msg.runnerId;
      try {
        setRunnerStatus(msg.runnerId, 'online', msg.capabilities as Record<string, unknown>);
      } catch (err) {
        console.warn('[runner-ws] failed to mark runner online:', (err as Error).message);
      }
      activeRunners.set(msg.runnerId, {
        ws,
        runnerId: msg.runnerId,
        lastPongAt: new Date().toISOString(),
        missedPongs: 0,
      });

      const reg: RunnerRegisteredMessage = {
        type: 'registered',
        runnerId: msg.runnerId,
        serverVersion: RUNNER_PROTOCOL_VERSION,
        connectedAt: new Date().toISOString(),
      };
      sendJson(ws, reg);
      startPings(msg.runnerId);
      return;
    }

    if (msg.type === 'pong') {
      if (!authed || !activeRunnerId) {
        try {
          ws.close(CLOSE_PROTOCOL, 'Pong before auth');
        } catch {}
        return;
      }
      const entry = activeRunners.get(activeRunnerId);
      if (entry) {
        entry.lastPongAt = new Date().toISOString();
        entry.missedPongs = 0;
      }
      fireSubscribers(activeRunnerId, msg);
      return;
    }

    // Phase 2 inbound frames (`result` / `stream` / `exit`) are routed
    // to subscribers — typically `RemoteRunnerTransport` instances, one
    // per active spawn. Pre-auth frames are rejected as protocol
    // violations to avoid leaking spawn state to unauthenticated peers.
    if (msg.type === 'result' || msg.type === 'stream' || msg.type === 'exit') {
      if (!authed || !activeRunnerId) {
        try {
          ws.close(CLOSE_PROTOCOL, `${msg.type} before auth`);
        } catch {}
        return;
      }
      fireSubscribers(activeRunnerId, msg);
      return;
    }
  });

  ws.on('close', teardown);
  ws.on('error', (err) => {
    console.warn('[runner-ws] socket error:', (err as Error).message);
    teardown();
  });
}
