/**
 * Dedicated terminal WebSocket transport.
 *
 * Route: `/api/sessions/:sessionId/terminal/ws`
 *
 * This channel is deliberately separate from the Hub chat WebSocket. Clients
 * send JSON control frames; terminal byte strings are base64 encoded so NUL,
 * escape sequences, and multibyte UTF-8 survive JSON framing unchanged.
 *
 * Client frames:
 *   - `{type:'attach', cols, rows}`
 *   - `{type:'input', encoding:'base64', data}`
 *   - `{type:'resize', cols, rows}`
 *   - `{type:'detach'}`
 *
 * Server frames:
 *   - `{type:'attached', encoding:'base64', data}` (serialized snapshot)
 *   - `{type:'output', encoding:'base64', data}`
 *   - `{type:'detached'}`
 *   - `{type:'exit', exitCode, signal?}`
 *   - `{type:'error', code, message}`
 *
 * There is no REST bootstrap endpoint, so this wire protocol is not part of
 * the OpenAPI registry. Authentication is the same query-token/API-key
 * handshake as the chat WS, followed by the strict `userOwnsSession` write
 * predicate before the HTTP upgrade is accepted.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { TextDecoder } from 'node:util';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { authenticateWsDetailed, type WsAuthResult } from '../auth.js';
import {
  userOwnsSession as defaultUserOwnsSession,
  type OwnerResolvable,
} from '../session-ownership.js';
import type { PtyHost } from './pty-host.js';
import type { PtySession, PtySessionAttachResult, PtySessionExit } from './pty-session.js';

export const TERMINAL_WEBSOCKET_PATH = '/api/sessions/:sessionId/terminal/ws';
export const DEFAULT_TERMINAL_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_TERMINAL_WS_MAX_BUFFERED_BYTES = 1024 * 1024;
export const DEFAULT_TERMINAL_WS_MAX_INPUT_BYTES = 64 * 1024;
export const DEFAULT_TERMINAL_WS_ATTACH_TIMEOUT_MS = 10_000;

const TERMINAL_WEBSOCKET_PATH_RE = /^\/api\/sessions\/([^/]+)\/terminal\/ws\/?$/;
const MAX_TERMINAL_DIMENSION = 10_000;

const TerminalDimensionSchema = z.number().int().min(1).max(MAX_TERMINAL_DIMENSION);
const TerminalClientFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('attach'),
      cols: TerminalDimensionSchema,
      rows: TerminalDimensionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('input'),
      encoding: z.literal('base64'),
      data: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('resize'),
      cols: TerminalDimensionSchema,
      rows: TerminalDimensionSchema,
    })
    .strict(),
  z.object({ type: z.literal('detach') }).strict(),
]);

export type TerminalClientFrame = z.infer<typeof TerminalClientFrameSchema>;

export type TerminalServerFrame =
  | { type: 'attached'; encoding: 'base64'; data: string }
  | { type: 'output'; encoding: 'base64'; data: string }
  | { type: 'detached' }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'error'; code: string; message: string };

export interface TerminalPtyHost {
  attach(
    sessionId: string,
    viewer: {
      id: string;
      cols: number;
      rows: number;
      onData: (data: string) => void;
    },
  ): Promise<PtySessionAttachResult>;
  get(sessionId: string): Pick<PtySession, 'resize' | 'write' | 'onExit'> | undefined;
}

export interface TerminalWebSocketDeps {
  ptyHost: TerminalPtyHost | PtyHost;
  /** Reject unknown ids before ownership, so arbitrary URLs never spawn PTYs. */
  sessionExists: (sessionId: string) => boolean;
  authenticate?: (request: IncomingMessage) => WsAuthResult;
  userOwnsSession?: (req: OwnerResolvable | undefined, sessionId: string) => boolean;
  maxPayloadBytes?: number;
  maxBufferedBytes?: number;
  maxInputBytes?: number;
  attachTimeoutMs?: number;
  logger?: { warn: (message: string) => void };
}

export interface TerminalWebSocketHandle {
  wss: WebSocketServer;
  close(): void;
}

/** Parse the dedicated terminal route without accepting sibling session paths. */
export function parseTerminalWebSocketSessionId(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  const pathOnly = rawUrl.split('?')[0] ?? '';
  const match = pathOnly.match(TERMINAL_WEBSOCKET_PATH_RE);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** UTF-8 terminal string -> binary-safe JSON payload. */
export function encodeTerminalData(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64');
}

/**
 * Strict base64 + UTF-8 decoder. `Buffer.from(..., 'base64')` is permissive
 * (it silently ignores junk), which would turn a corrupt input frame into
 * different keystrokes. Reject malformed or non-UTF-8 payloads instead.
 */
export function decodeTerminalData(data: string, maxBytes: number): string {
  if (!isCanonicalBase64(data)) throw new Error('Input data must be canonical base64');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Input payload exceeds ${maxBytes} bytes`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Input data must contain valid UTF-8');
  }
}

function isCanonicalBase64(data: string): boolean {
  if (data.length === 0) return true;
  if (data.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data);
}

function denyUpgrade(socket: Duplex, statusLine: string): void {
  if (socket.destroyed) return;
  socket.write(`${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function authOwnerRequest(auth: WsAuthResult): OwnerResolvable {
  return {
    authUserId: auth.userId,
    // Global API key, bundled-local, and fully-open installs intentionally
    // have no per-user id. Mirror the chat WS localBypass behavior so their
    // full-privilege handshake remains usable under strict ownership code.
    authViaApiKey: Boolean(auth.viaApiKey) || !auth.userId,
  };
}

/** Attach the terminal upgrade handler to the Hub HTTP server. */
export function attachTerminalWebSocket(
  server: Server,
  deps: TerminalWebSocketDeps,
): TerminalWebSocketHandle {
  const authenticate = deps.authenticate ?? authenticateWsDetailed;
  const ownsSession = deps.userOwnsSession ?? defaultUserOwnsSession;
  const logger = deps.logger ?? { warn: (message: string) => console.warn(message) };
  const maxPayloadBytes = deps.maxPayloadBytes ?? DEFAULT_TERMINAL_WS_MAX_PAYLOAD_BYTES;
  const maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_TERMINAL_WS_MAX_BUFFERED_BYTES;
  const maxInputBytes = deps.maxInputBytes ?? DEFAULT_TERMINAL_WS_MAX_INPUT_BYTES;
  const attachTimeoutMs = deps.attachTimeoutMs ?? DEFAULT_TERMINAL_WS_ATTACH_TIMEOUT_MS;

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const sessionId = parseTerminalWebSocketSessionId(request.url);
    if (!sessionId) return;

    const auth = authenticate(request);
    if (!auth.ok) {
      denyUpgrade(socket, 'HTTP/1.1 401 Unauthorized');
      return;
    }
    // Mask both missing and foreign sessions as 404. Authentication is known
    // to be valid at this point, but the caller must not learn which id exists.
    if (!deps.sessionExists(sessionId) || !ownsSession(authOwnerRequest(auth), sessionId)) {
      denyUpgrade(socket, 'HTTP/1.1 404 Not Found');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, sessionId);
    });
  };

  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, sessionId: string) => {
    const viewerId = randomUUID();
    let state: 'detached' | 'attaching' | 'attached' = 'detached';
    let attachGeneration = 0;
    let attached: PtySessionAttachResult | null = null;
    let unsubscribeExit: (() => void) | null = null;
    let pendingOutput: string[] = [];
    let pendingOutputBytes = 0;
    let closingForBackpressure = false;

    const detachCurrent = (): void => {
      attachGeneration += 1;
      state = 'detached';
      pendingOutput = [];
      pendingOutputBytes = 0;
      unsubscribeExit?.();
      unsubscribeExit = null;
      attached?.detach();
      attached = null;
    };

    const closeSlowClient = (): void => {
      if (closingForBackpressure) return;
      closingForBackpressure = true;
      detachCurrent();
      logger.warn(
        `Terminal WS ${sessionId}/${viewerId}: closing slow client (buffer > ${maxBufferedBytes} bytes)`,
      );
      if (ws.readyState === WebSocket.OPEN) ws.close(1013, 'Terminal client is too slow');
    };

    const sendFrame = (frame: TerminalServerFrame): boolean => {
      if (ws.readyState !== WebSocket.OPEN || closingForBackpressure) return false;
      const encoded = JSON.stringify(frame);
      const bytes = Buffer.byteLength(encoded);
      if (ws.bufferedAmount + bytes > maxBufferedBytes) {
        closeSlowClient();
        return false;
      }
      ws.send(encoded, (err) => {
        if (!err) return;
        logger.warn(`Terminal WS ${sessionId}/${viewerId}: send failed: ${err.message}`);
      });
      return true;
    };

    const sendError = (code: string, message: string): void => {
      sendFrame({ type: 'error', code, message });
    };

    const onLiveData = (data: string): void => {
      if (state === 'attaching') {
        pendingOutput.push(data);
        pendingOutputBytes += Buffer.byteLength(data, 'utf8');
        if (pendingOutputBytes > maxBufferedBytes) closeSlowClient();
        return;
      }
      if (state === 'attached') {
        sendFrame({ type: 'output', encoding: 'base64', data: encodeTerminalData(data) });
      }
    };

    const onExit = (exit: PtySessionExit): void => {
      if (state === 'detached') return;
      sendFrame({
        type: 'exit',
        exitCode: exit.exitCode,
        ...(exit.signal === undefined ? {} : { signal: exit.signal }),
      });
      detachCurrent();
    };

    const handleAttach = async (cols: number, rows: number): Promise<void> => {
      if (state !== 'detached') {
        sendError('already_attached', 'This connection already has a terminal attachment');
        return;
      }
      state = 'attaching';
      pendingOutput = [];
      pendingOutputBytes = 0;
      const generation = ++attachGeneration;
      try {
        const result = await deps.ptyHost.attach(sessionId, {
          id: viewerId,
          cols,
          rows,
          onData: onLiveData,
        });
        // Socket close / explicit detach / backpressure may win while the PTY
        // and serialized snapshot are starting. Never strand that late viewer.
        if (
          generation !== attachGeneration ||
          state !== 'attaching' ||
          ws.readyState !== WebSocket.OPEN
        ) {
          result.detach();
          return;
        }
        attached = result;
        const session = deps.ptyHost.get(sessionId);
        if (!session) {
          result.detach();
          attached = null;
          state = 'detached';
          sendError('terminal_unavailable', 'Terminal session is no longer available');
          return;
        }
        unsubscribeExit = session.onExit(onExit);
        // `onExit` fires synchronously for an already-exited PtySession. In
        // that case it detached the viewer above; do not follow the exit frame
        // with a stale `attached` snapshot.
        if (generation !== attachGeneration || state !== 'attaching') return;

        // Snapshot must be the first terminal data the client receives. PTY
        // output produced while `attach()` flushes/serializes was buffered by
        // onLiveData and is released only after this attached frame.
        if (
          !sendFrame({
            type: 'attached',
            encoding: 'base64',
            data: encodeTerminalData(result.snapshot),
          })
        ) {
          return;
        }
        state = 'attached';
        const queued = pendingOutput;
        pendingOutput = [];
        pendingOutputBytes = 0;
        for (const data of queued) {
          if (!sendFrame({ type: 'output', encoding: 'base64', data: encodeTerminalData(data) })) {
            return;
          }
        }
      } catch (err) {
        if (generation !== attachGeneration || ws.readyState !== WebSocket.OPEN) return;
        state = 'detached';
        sendError(
          'attach_failed',
          err instanceof Error ? err.message : 'Failed to attach terminal',
        );
      }
    };

    const attachTimer = setTimeout(() => {
      if (state !== 'detached' || ws.readyState !== WebSocket.OPEN) return;
      sendError('attach_timeout', 'Attach frame not received in time');
      ws.close(1008, 'Attach timeout');
    }, attachTimeoutMs);
    attachTimer.unref?.();

    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        sendError('invalid_frame', 'Terminal control frames must be JSON text');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        sendError('invalid_frame', 'Terminal frame must be valid JSON');
        return;
      }
      const validated = TerminalClientFrameSchema.safeParse(parsed);
      if (!validated.success) {
        sendError('invalid_frame', 'Terminal frame does not match the protocol');
        return;
      }
      const frame = validated.data;
      if (frame.type === 'attach') {
        clearTimeout(attachTimer);
        void handleAttach(frame.cols, frame.rows);
        return;
      }
      if (frame.type === 'detach') {
        if (state === 'detached') {
          sendError('not_attached', 'No terminal is attached');
          return;
        }
        detachCurrent();
        sendFrame({ type: 'detached' });
        return;
      }
      if (state !== 'attached') {
        sendError('not_attached', 'Attach the terminal before sending input or resize');
        return;
      }
      const session = deps.ptyHost.get(sessionId);
      if (!session) {
        detachCurrent();
        sendError('terminal_unavailable', 'Terminal session is no longer available');
        return;
      }
      if (frame.type === 'resize') {
        session.resize(viewerId, frame.cols, frame.rows);
        return;
      }
      try {
        const input = decodeTerminalData(frame.data, maxInputBytes);
        if (!session.write(input)) {
          sendError('input_backpressure', 'Terminal input was not accepted');
        }
      } catch (err) {
        sendError('invalid_input', err instanceof Error ? err.message : 'Invalid terminal input');
      }
    });

    ws.on('close', () => {
      clearTimeout(attachTimer);
      detachCurrent();
    });
    ws.on('error', (err) => {
      logger.warn(`Terminal WS ${sessionId}/${viewerId}: ${err.message}`);
    });
  });

  return {
    wss,
    close: () => {
      server.off('upgrade', onUpgrade);
      for (const client of wss.clients) client.close(1001, 'Server shutting down');
      wss.close();
    },
  };
}
