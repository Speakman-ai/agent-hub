/**
 * Dedicated agent-browser WebSocket transport.
 *
 * Route: `/api/sessions/:sessionId/browser/ws`
 *
 * Streams the session's public-web Chromium (the `browser` ReAct tool) to a
 * human viewer as JPEG frames, and carries the viewer's mouse / keyboard /
 * URL-bar input back. Deliberately separate from the Hub chat WebSocket: a
 * frame stream on the global broadcast bus would hit every connected client
 * before per-recipient filtering, and would be throttled by chat traffic.
 *
 * Client frames:
 *   - `{type:'attach', maxWidth?, maxHeight?, quality?}`
 *   - `{type:'detach'}`
 *   - `{type:'input', input: BrowserViewerInput}`
 *   - `{type:'navigate', url}`
 *
 * Server frames:
 *   - `{type:'state', status:'waiting'|'live'|'closed', url, viewport}`
 *   - `{type:'frame', data(base64 jpeg), width, height, viewportWidth, viewportHeight, url}`
 *   - `{type:'input_result', ok, code?, message?}`
 *   - `{type:'navigated', ok, url?, code?, message?}`
 *   - `{type:'detached'}`
 *   - `{type:'error', code, message}`
 *
 * Backpressure: frames are dropped (never queued) while the socket buffer is
 * above the cap, so a slow viewer sees a lower frame rate rather than a
 * growing lag. Control frames are still delivered.
 *
 * Auth is the same query-token / API-key handshake as the chat WS, then the
 * strict `userOwnsSession` write predicate — the pane can *act* on the browser,
 * so read-only shared visibility is not enough.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { authenticateWsDetailed, type WsAuthResult } from './auth.js';
import {
  userOwnsSession as defaultUserOwnsSession,
  type OwnerResolvable,
} from './session-ownership.js';
import {
  attachBrowserScreencastViewer,
  dispatchBrowserViewerInput,
  navigateBrowserViewer,
  SCREENCAST_MAX_DIMENSION,
  SCREENCAST_MIN_DIMENSION,
  type BrowserViewerInput,
  type BrowserViewerInputResult,
  type BrowserViewerNavigateResult,
  type ScreencastFrame,
  type ScreencastState,
  type ScreencastViewer,
} from './browser-screencast.js';

export const BROWSER_SCREENCAST_WEBSOCKET_PATH = '/api/sessions/:sessionId/browser/ws';
export const DEFAULT_BROWSER_WS_MAX_PAYLOAD_BYTES = 64 * 1024;
/** Above this many buffered bytes, video frames are skipped for that viewer. */
export const DEFAULT_BROWSER_WS_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
export const DEFAULT_BROWSER_WS_ATTACH_TIMEOUT_MS = 10_000;
export const BROWSER_WS_MAX_TEXT_INPUT_CHARS = 4_000;
export const BROWSER_WS_MAX_URL_CHARS = 4_000;

const BROWSER_WEBSOCKET_PATH_RE = /^\/api\/sessions\/([^/]+)\/browser\/ws\/?$/;

const Dim = z.number().int().min(SCREENCAST_MIN_DIMENSION).max(SCREENCAST_MAX_DIMENSION);
const Coord = z.number().finite().min(-100_000).max(100_000);
const Modifiers = z
  .object({
    alt: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    shift: z.boolean().optional(),
  })
  .strict()
  .optional();

const ViewerInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('mouse'),
      type: z.enum(['move', 'down', 'up', 'click']),
      x: Coord,
      y: Coord,
      button: z.enum(['left', 'right', 'middle']).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wheel'),
      x: Coord,
      y: Coord,
      deltaX: Coord,
      deltaY: Coord,
    })
    .strict(),
  z
    .object({
      kind: z.literal('key'),
      type: z.enum(['press', 'down', 'up']),
      key: z.string().min(1).max(32),
      modifiers: Modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      text: z.string().min(1).max(BROWSER_WS_MAX_TEXT_INPUT_CHARS),
    })
    .strict(),
]);

const BrowserClientFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('attach'),
      maxWidth: Dim.optional(),
      maxHeight: Dim.optional(),
      quality: z.number().int().min(10).max(100).optional(),
    })
    .strict(),
  z.object({ type: z.literal('detach') }).strict(),
  z.object({ type: z.literal('input'), input: ViewerInputSchema }).strict(),
  z
    .object({ type: z.literal('navigate'), url: z.string().min(1).max(BROWSER_WS_MAX_URL_CHARS) })
    .strict(),
]);

export type BrowserClientFrame = z.infer<typeof BrowserClientFrameSchema>;

export type BrowserServerFrame =
  | ({ type: 'state' } & ScreencastState)
  | ({ type: 'frame' } & ScreencastFrame)
  | ({ type: 'input_result' } & BrowserViewerInputResult)
  | ({ type: 'navigated' } & BrowserViewerNavigateResult)
  | { type: 'detached' }
  | { type: 'error'; code: string; message: string };

export interface BrowserScreencastFeedHost {
  attach(browserSessionId: string, viewer: ScreencastViewer): () => void;
  input(browserSessionId: string, input: BrowserViewerInput): Promise<BrowserViewerInputResult>;
  navigate(browserSessionId: string, url: string): Promise<BrowserViewerNavigateResult>;
}

const defaultFeedHost: BrowserScreencastFeedHost = {
  attach: attachBrowserScreencastViewer,
  input: dispatchBrowserViewerInput,
  navigate: navigateBrowserViewer,
};

export interface BrowserScreencastWebSocketDeps {
  /** Reject unknown ids before ownership, so arbitrary URLs never open feeds. */
  sessionExists: (sessionId: string) => boolean;
  /** Per-session gate: is the generic browser tool enabled for this session's agent? */
  browserToolsEnabled?: (sessionId: string) => boolean;
  feedHost?: BrowserScreencastFeedHost;
  authenticate?: (request: IncomingMessage) => WsAuthResult;
  userOwnsSession?: (req: OwnerResolvable | undefined, sessionId: string) => boolean;
  maxPayloadBytes?: number;
  maxBufferedBytes?: number;
  attachTimeoutMs?: number;
  logger?: { warn: (message: string) => void };
}

export interface BrowserScreencastWebSocketHandle {
  wss: WebSocketServer;
  close(): void;
}

/** Parse the dedicated agent-browser route without accepting sibling session paths. */
export function parseBrowserScreencastWebSocketSessionId(
  rawUrl: string | undefined,
): string | null {
  if (!rawUrl) return null;
  const pathOnly = rawUrl.split('?')[0] ?? '';
  const match = pathOnly.match(BROWSER_WEBSOCKET_PATH_RE);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function denyUpgrade(socket: Duplex, statusLine: string): void {
  if (socket.destroyed) return;
  socket.write(`${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function authOwnerRequest(auth: WsAuthResult): OwnerResolvable {
  return {
    authUserId: auth.userId,
    // Global API key, bundled-local, and fully-open installs have no per-user
    // id. Mirror the chat WS localBypass so their handshake stays usable.
    authViaApiKey: Boolean(auth.viaApiKey) || !auth.userId,
  };
}

/** Attach the agent-browser upgrade handler to the Hub HTTP server. */
export function attachBrowserScreencastWebSocket(
  server: Server,
  deps: BrowserScreencastWebSocketDeps,
): BrowserScreencastWebSocketHandle {
  const authenticate = deps.authenticate ?? authenticateWsDetailed;
  const ownsSession = deps.userOwnsSession ?? defaultUserOwnsSession;
  const feedHost = deps.feedHost ?? defaultFeedHost;
  const logger = deps.logger ?? { warn: (message: string) => console.warn(message) };
  const maxPayloadBytes = deps.maxPayloadBytes ?? DEFAULT_BROWSER_WS_MAX_PAYLOAD_BYTES;
  const maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_BROWSER_WS_MAX_BUFFERED_BYTES;
  const attachTimeoutMs = deps.attachTimeoutMs ?? DEFAULT_BROWSER_WS_ATTACH_TIMEOUT_MS;

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const sessionId = parseBrowserScreencastWebSocketSessionId(request.url);
    if (!sessionId) return;

    const auth = authenticate(request);
    if (!auth.ok) {
      denyUpgrade(socket, 'HTTP/1.1 401 Unauthorized');
      return;
    }
    // Mask missing and foreign sessions alike as 404.
    if (!deps.sessionExists(sessionId) || !ownsSession(authOwnerRequest(auth), sessionId)) {
      denyUpgrade(socket, 'HTTP/1.1 404 Not Found');
      return;
    }
    if (deps.browserToolsEnabled && !deps.browserToolsEnabled(sessionId)) {
      denyUpgrade(socket, 'HTTP/1.1 403 Forbidden');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, sessionId);
    });
  };

  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, sessionId: string) => {
    const viewerId = randomUUID();
    let detach: (() => void) | null = null;
    let droppedFrames = 0;

    const sendFrame = (frame: BrowserServerFrame): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const encoded = JSON.stringify(frame);
      if (frame.type === 'frame' && ws.bufferedAmount > maxBufferedBytes) {
        droppedFrames += 1;
        if (droppedFrames === 1 || droppedFrames % 100 === 0) {
          logger.warn(
            `Browser WS ${sessionId}/${viewerId}: dropping video frames (buffer > ${maxBufferedBytes} bytes, dropped ${droppedFrames})`,
          );
        }
        return false;
      }
      ws.send(encoded, (err) => {
        if (!err) return;
        logger.warn(`Browser WS ${sessionId}/${viewerId}: send failed: ${err.message}`);
      });
      return true;
    };

    const sendError = (code: string, message: string): void => {
      sendFrame({ type: 'error', code, message });
    };

    const detachCurrent = (): void => {
      const d = detach;
      detach = null;
      d?.();
    };

    const attachTimer = setTimeout(() => {
      if (detach || ws.readyState !== WebSocket.OPEN) return;
      sendError('attach_timeout', 'Attach frame not received in time');
      ws.close(1008, 'Attach timeout');
    }, attachTimeoutMs);
    attachTimer.unref?.();

    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        sendError('invalid_frame', 'Browser control frames must be JSON text');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        sendError('invalid_frame', 'Browser frame must be valid JSON');
        return;
      }
      const validated = BrowserClientFrameSchema.safeParse(parsed);
      if (!validated.success) {
        sendError('invalid_frame', 'Browser frame does not match the protocol');
        return;
      }
      const frame = validated.data;
      if (frame.type === 'attach') {
        clearTimeout(attachTimer);
        if (detach) {
          sendError('already_attached', 'This connection already has a browser attachment');
          return;
        }
        detach = feedHost.attach(sessionId, {
          id: viewerId,
          maxWidth: frame.maxWidth,
          maxHeight: frame.maxHeight,
          quality: frame.quality,
          onFrame: (f) => {
            sendFrame({ type: 'frame', ...f });
          },
          onState: (s) => {
            sendFrame({ type: 'state', ...s });
          },
        });
        return;
      }
      if (frame.type === 'detach') {
        if (!detach) {
          sendError('not_attached', 'No browser is attached');
          return;
        }
        detachCurrent();
        sendFrame({ type: 'detached' });
        return;
      }
      if (!detach) {
        sendError('not_attached', 'Attach the browser before sending input');
        return;
      }
      if (frame.type === 'input') {
        void feedHost
          .input(sessionId, frame.input)
          .then((r) => sendFrame({ type: 'input_result', ...r }))
          .catch((err: unknown) =>
            sendFrame({
              type: 'input_result',
              ok: false,
              code: 'input_failed',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        return;
      }
      void feedHost
        .navigate(sessionId, frame.url)
        .then((r) => sendFrame({ type: 'navigated', ...r }))
        .catch((err: unknown) =>
          sendFrame({
            type: 'navigated',
            ok: false,
            code: 'refused',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
    });

    ws.on('close', () => {
      clearTimeout(attachTimer);
      detachCurrent();
    });
    ws.on('error', (err) => {
      logger.warn(`Browser WS ${sessionId}/${viewerId}: ${err.message}`);
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
