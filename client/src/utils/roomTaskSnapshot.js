/**
 * Hydrate conference-room streaming UI from an `active-room-tasks-snapshot` row.
 * Pure helpers so reconnect race logic is unit-testable without mounting App.
 */

/**
 * Apply snapshot only when no live room_* WS event arrived after this socket
 * connected — avoids clobbering newer `room_stream` output with stale DB text.
 *
 * @param {number} lastLiveRoomEventAtMs
 * @param {number} wsReconnectAtMs
 */
export function shouldApplyRoomTaskSnapshot(lastLiveRoomEventAtMs, wsReconnectAtMs) {
  return lastLiveRoomEventAtMs <= wsReconnectAtMs;
}

/**
 * @param {Record<string, unknown>} task row from `active_room_tasks` (snake or camel)
 */
export function roomStreamingStateFromSnapshotTask(task) {
  const agentId = task.agent_id ?? task.agentId;
  const agentName = task.agent_name ?? task.agentName;
  const agentColor = task.agent_color ?? task.agentColor;
  const messageId = task.message_id ?? task.messageId;
  const output = task.streamed_output ?? task.streamedOutput ?? '';
  if (output) {
    return {
      roomProcessing: true,
      roomThinking: null,
      roomStreaming: {
        agentId,
        agentName,
        agentColor,
        messageId,
        content: output,
      },
    };
  }
  return {
    roomProcessing: true,
    roomThinking: { agentId, agentName, agentColor },
    roomStreaming: null,
  };
}
