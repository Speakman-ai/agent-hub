import { WebSocketServer, WebSocket as WsClient } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import { authenticateWs } from './auth.js';
import { stmts } from './db.js';
import { handleBroadcastForPush } from './push.js';
import type {
  WebSocketDeps,
  BroadcastFn,
  ActiveTaskRow,
  ActiveRoomTaskRow,
  MessageQueueRow,
  RoomMessageQueueRow,
} from './types.js';

interface ActiveTaskSnapshot {
  sessionId: string;
  messageId: string;
  agentId: string;
  engine: string;
  model: string | null;
  prompt: string;
  content: string;
  startedAt: string;
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

  function activeTasksSnapshot(): ActiveTaskSnapshot[] {
    try {
      return (stmts!.getAllActiveTasks.all() as ActiveTaskRow[]).map((t) => ({
        sessionId: t.session_id,
        messageId: t.message_id,
        agentId: t.agent_id,
        engine: t.engine,
        model: t.model,
        prompt: t.prompt,
        content: t.streamed_output || '',
        startedAt: t.started_at,
      }));
    } catch {
      return [];
    }
  }

  wss.on('connection', (ws: WsClient, request: IncomingMessage) => {
    if (!authenticateWs(request)) {
      ws.close(4401, 'Unauthorized — invalid or missing API key');
      return;
    }

    console.log('Client connected');

    try {
      ws.send(JSON.stringify({ type: 'active-tasks-snapshot', tasks: activeTasksSnapshot() }));
    } catch {}

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
