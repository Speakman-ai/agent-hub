import { WebSocketServer } from 'ws';
import { authenticateWs } from './auth.js';
import { stmts } from './db.js';

/**
 * Create a WebSocket server and attach it to the given HTTP server.
 *
 * Returns { wss, broadcast } — the WebSocketServer instance and a broadcast
 * helper that sends a JSON message to every connected client.
 *
 * @param {import('http').Server} server - HTTP server to attach to
 * @param {object} deps - Handler functions injected from index.js
 * @param {function} deps.getProjects - Returns the current projects array
 * @param {function} deps.handleChat - Chat message handler
 * @param {function} deps.handleRoomChat - Room chat message handler
 * @param {function} deps.handleCancel - Cancel a session's active process
 * @param {function} deps.handleRoomCancel - Cancel a room's active process
 * @param {function} deps.handleDelegationCancel - Cancel delegation for a session
 * @param {function} deps.handleDequeue - Remove a queued message
 * @param {function} deps.handleEditQueueItem - Edit a queued message
 * @param {function} deps.handleRoomDequeue - Remove a queued room message
 */
export default function createWebSocket(server, deps) {
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
  } = deps;

  // Broadcast to all connected clients
  function broadcast(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(msg);
      }
    });
  }

  // Snapshot of currently running tasks — sent to new WS clients so they can
  // reattach streaming state after a reload or reconnect.
  function activeTasksSnapshot() {
    try {
      return stmts.getAllActiveTasks.all().map((t) => ({
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

  wss.on('connection', (ws, request) => {
    // Authenticate WebSocket connections when API key is configured
    if (!authenticateWs(request)) {
      ws.close(4401, 'Unauthorized — invalid or missing API key');
      return;
    }

    console.log('Client connected');

    // Send snapshot of in-flight tasks so the client can restore streaming state.
    try {
      ws.send(JSON.stringify({ type: 'active-tasks-snapshot', tasks: activeTasksSnapshot() }));
    } catch {}

    // Send snapshot of in-flight room tasks so client can restore room streaming state.
    try {
      const roomTasks = stmts.getAllActiveRoomTasks.all();
      if (roomTasks.length > 0) {
        ws.send(JSON.stringify({ type: 'active-room-tasks-snapshot', tasks: roomTasks }));
      }
    } catch {}

    // Send queue state for all sessions with queued messages.
    try {
      const queuedSessions = stmts.getAllQueuedSessions.all();
      for (const { session_id } of queuedSessions) {
        ws.send(
          JSON.stringify({
            type: 'queue_updated',
            sessionId: session_id,
            queue: stmts.getQueuedMessages.all(session_id),
          }),
        );
      }
    } catch {}

    // Send room queue state for all rooms with queued messages.
    try {
      const queuedRooms = stmts.getAllQueuedRooms.all();
      for (const { room_id } of queuedRooms) {
        ws.send(
          JSON.stringify({
            type: 'room_queue_updated',
            roomId: room_id,
            queue: stmts.getQueuedRoomMessages.all(room_id),
          }),
        );
      }
    } catch {}

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      if (msg.type === 'chat') {
        handleChat(ws, msg);
      } else if (msg.type === 'room_chat') {
        handleRoomChat(ws, msg);
      } else if (msg.type === 'cancel') {
        handleCancel(msg.sessionId);
      } else if (msg.type === 'room_cancel') {
        handleRoomCancel(msg.roomId);
      } else if (msg.type === 'room_dequeue') {
        handleRoomDequeue(msg.roomId, msg.messageId);
      } else if (msg.type === 'delegation_cancel') {
        handleDelegationCancel(msg.sessionId);
      } else if (msg.type === 'dequeue') {
        handleDequeue(msg.sessionId, msg.messageId);
      } else if (msg.type === 'edit_queue_item') {
        handleEditQueueItem(msg.sessionId, msg.messageId, msg.content);
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
    });
  });

  return { wss, broadcast };
}
