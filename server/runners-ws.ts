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
      return;
    }
  });

  ws.on('close', teardown);
  ws.on('error', (err) => {
    console.warn('[runner-ws] socket error:', (err as Error).message);
    teardown();
  });
}
