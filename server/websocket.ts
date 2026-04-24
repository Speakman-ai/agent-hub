import { WebSocketServer, WebSocket as WsClient } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import { authenticateWs } from './auth.js';
import { stmts } from './db.js';
import { handleBroadcastForPush } from './push.js';
import type {
  WebSocketDeps,
  BroadcastFn,
  ActiveRoomTaskRow,
  MessageQueueRow,
  RoomMessageQueueRow,
} from './types.js';
import { buildActiveTasksSnapshotLenient } from './active-tasks.js';
import { subscribeToJob, isJobFinished } from './provisioning/orchestrator.js';

/**
 * Match `/api/provisioning/<jobId>/events` and return the jobId. Returns
 * null if the URL is not a provisioning subscription — callers fall
 * through to the normal agent-chat connection handler.
 */
export function parseProvisioningPath(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  // Strip query string; we don't consult it here.
  const pathOnly = rawUrl.split('?')[0] ?? '';
  const m = pathOnly.match(/^\/api\/provisioning\/([^/]+)\/events\/?$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Parse the `?since=<seq>` query parameter from a provisioning WS URL.
 * Returns the non-negative integer seq, or `null` if absent/invalid.
 * Callers use this to resume a dropped stream without re-processing
 * already-received events. Malformed / negative / non-integer values
 * are treated as absent rather than errors — the server just replays
 * the whole buffer, which is a safe degradation.
 */
export function parseProvisioningSince(rawUrl: string | undefined): number | null {
  if (!rawUrl) return null;
  const qIndex = rawUrl.indexOf('?');
  if (qIndex < 0) return null;
  const query = rawUrl.slice(qIndex + 1);
  let since: string | null = null;
  for (const part of query.split('&')) {
    const [k, v] = part.split('=', 2);
    if (k === 'since') {
      since = v ?? '';
      break;
    }
  }
  if (since == null || since === '') return null;
  try {
    const decoded = decodeURIComponent(since);
    if (decoded === '') return null;
    const n = Number(decoded);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    return n;
  } catch {
    return null;
  }
}

export default function createWebSocket(
  server: Server,
  deps: WebSocketDeps,
): { wss: WebSocketServer; broadcast: BroadcastFn } {
  const wss = new WebSocketServer({ server });

  const {
    getProjects,
    handleChat,
    handleRoomChat,
    handleCancel,
    handleRoomCancel,
    handleDelegationCancel,
    handleDequeue,
    handleEditQueueItem,
    handleRoomDequeue,
    handleDesignChat,
    handleDesignCancel,
  } = deps;

  function broadcast(data: Record<string, unknown>): void {
    const msg = JSON.stringify(data);
    wss.clients.forEach((client: WsClient) => {
      if (client.readyState === WsClient.OPEN) {
        client.send(msg);
      }
    });
    // Fan out relevant broadcasts to mobile clients via Expo push. Fire-and-
    // forget: push dispatch must never block the WebSocket hot path.
    void handleBroadcastForPush(data).catch((err: unknown) => {
      console.error('[push] broadcast handler failed:', (err as Error).message);
    });
  }

  wss.on('connection', (ws: WsClient, request: IncomingMessage) => {
    if (!authenticateWs(request)) {
      ws.close(4401, 'Unauthorized — invalid or missing API key');
      return;
    }

    // Provisioning subscription — a dedicated URL hands this connection
    // off to the orchestrator's event stream rather than the normal
    // agent-chat pipeline. Every buffered event replays, then live
    // events stream in; the socket is closed automatically once the
    // orchestrator emits `done`.
    const provisioningJobId = parseProvisioningPath(request.url);
    if (provisioningJobId) {
      const since = parseProvisioningSince(request.url);
      handleProvisioningSubscription(ws, provisioningJobId, since);
      return;
    }

    console.log('Client connected');

    try {
      ws.send(
        JSON.stringify({
          type: 'active-tasks-snapshot',
          tasks: buildActiveTasksSnapshotLenient(stmts!),
        }),
      );
    } catch {
      /* send failure — client may have disconnected */
    }

    try {
      const roomTasks = stmts!.getAllActiveRoomTasks.all() as ActiveRoomTaskRow[];
      if (roomTasks.length > 0) {
        ws.send(JSON.stringify({ type: 'active-room-tasks-snapshot', tasks: roomTasks }));
      }
    } catch {}

    try {
      const queuedSessions = stmts!.getAllQueuedSessions.all() as Array<{ session_id: string }>;
      for (const { session_id } of queuedSessions) {
        ws.send(
          JSON.stringify({
            type: 'queue_updated',
            sessionId: session_id,
            queue: stmts!.getQueuedMessages.all(session_id) as MessageQueueRow[],
          }),
        );
      }
    } catch {}

    try {
      const queuedRooms = stmts!.getAllQueuedRooms.all() as Array<{ room_id: string }>;
      for (const { room_id } of queuedRooms) {
        ws.send(
          JSON.stringify({
            type: 'room_queue_updated',
            roomId: room_id,
            queue: stmts!.getQueuedRoomMessages.all(room_id) as RoomMessageQueueRow[],
          }),
        );
      }
    } catch {}

    ws.on('message', (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      const { type } = msg;
      if (type === 'chat' && typeof msg.agentId === 'string' && typeof msg.sessionId === 'string') {
        handleChat(ws, msg as unknown as import('./types.js').ChatMessage);
      } else if (
        type === 'room_chat' &&
        typeof msg.roomId === 'string' &&
        typeof msg.content === 'string'
      ) {
        handleRoomChat(ws, msg as unknown as import('./types.js').RoomChatMessage);
      } else if (type === 'cancel' && typeof msg.sessionId === 'string') {
        handleCancel(msg.sessionId);
      } else if (type === 'room_cancel' && typeof msg.roomId === 'string') {
        handleRoomCancel(msg.roomId);
      } else if (
        type === 'room_dequeue' &&
        typeof msg.roomId === 'string' &&
        typeof msg.messageId === 'string'
      ) {
        handleRoomDequeue(msg.roomId, msg.messageId);
      } else if (
        type === 'design_chat' &&
        typeof msg.designId === 'string' &&
        typeof msg.content === 'string'
      ) {
        handleDesignChat(ws, msg as unknown as import('./types.js').DesignChatMessage);
      } else if (type === 'design_cancel' && typeof msg.designId === 'string') {
        handleDesignCancel(msg.designId);
      } else if (type === 'delegation_cancel' && typeof msg.sessionId === 'string') {
        handleDelegationCancel(msg.sessionId);
      } else if (
        type === 'dequeue' &&
        typeof msg.sessionId === 'string' &&
        typeof msg.messageId === 'string'
      ) {
        handleDequeue(msg.sessionId, msg.messageId);
      } else if (
        type === 'edit_queue_item' &&
        typeof msg.sessionId === 'string' &&
        typeof msg.messageId === 'string' &&
        typeof msg.content === 'string'
      ) {
        handleEditQueueItem(msg.sessionId, msg.messageId, msg.content);
      } else if (type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
    });
  });

  return { wss, broadcast };
}

/**
 * Attach a freshly-opened WebSocket to a provisioning job. Replays every
 * buffered event, then streams live events. Closes the socket on the
 * terminal `done` event (or on error if the job id is unknown).
 *
 * `since` (optional): the last seq id the client already received; only
 * events with `seq > since` are replayed. Used by the client's reconnect
 * path so a dropped stream can resume without re-processing.
 */
function handleProvisioningSubscription(
  ws: WsClient,
  jobId: string,
  since: number | null = null,
): void {
  const send = (data: Record<string, unknown>): void => {
    if (ws.readyState !== WsClient.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* caller disconnected */
    }
  };

  const unsubscribe = subscribeToJob(
    jobId,
    (ev) => {
      send(ev as unknown as Record<string, unknown>);
      if (ev.type === 'done') {
        try {
          ws.close(1000, 'Job complete');
        } catch {
          /* ignore */
        }
      }
    },
    since != null ? { since } : {},
  );

  if (!unsubscribe) {
    send({ type: 'done', error: { code: 404, message: `Unknown job ${jobId}` } });
    try {
      ws.close(4404, 'Unknown provisioning job');
    } catch {
      /* ignore */
    }
    return;
  }

  // Edge case: if the job already finished before we subscribed (tight
  // race between POST and WS open), `subscribeToJob` replays the
  // terminal done and we still need to close the socket.
  if (isJobFinished(jobId)) {
    try {
      ws.close(1000, 'Job already complete');
    } catch {
      /* ignore */
    }
    return;
  }

  ws.on('close', () => {
    unsubscribe();
  });
  ws.on('error', () => {
    unsubscribe();
  });
}
