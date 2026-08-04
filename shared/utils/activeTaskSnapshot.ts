/**
 * Reconcile the chat's streaming indicator against the server's
 * `active-tasks-snapshot`.
 *
 * The snapshot is the only server-sourced statement of "is a run live for this
 * session", and it is replayed on every WebSocket connect. Clients used to
 * *restore* streaming state from it but never *clear* it, which is what left a
 * session showing the green "streaming" dot and the Interrupt badge forever
 * after its process was killed without a terminal frame reaching that tab.
 *
 * The snapshot is authoritative in both directions. Treat a session missing
 * from it as proof the run is over.
 */

export interface ActiveTaskSnapshotEntry {
  messageId: string;
  agentId?: string | null;
  content?: string;
  engine?: string | null;
  model?: string | null;
}

export interface StreamingReconciliation {
  streamingMsgId: string | null;
  streamingContent: string;
  streamingEngine: string | null;
  agentId: string | null;
  thinking: boolean;
}

/**
 * What the viewed session's streaming state should be after this snapshot, or
 * `null` when there is no session in view and nothing to reconcile.
 */
export function resolveStreamingFromSnapshot(
  tasks: Readonly<Record<string, ActiveTaskSnapshotEntry>>,
  activeSessionId: string | null | undefined,
): StreamingReconciliation | null {
  if (!activeSessionId) return null;
  const task = tasks[activeSessionId];
  if (!task) {
    return {
      streamingMsgId: null,
      streamingContent: '',
      streamingEngine: null,
      agentId: null,
      thinking: false,
    };
  }
  const content = task.content ?? '';
  return {
    streamingMsgId: task.messageId,
    streamingContent: content,
    streamingEngine: task.engine ?? null,
    agentId: task.agentId ?? null,
    // No text yet means the turn is still spinning up.
    thinking: !content,
  };
}
