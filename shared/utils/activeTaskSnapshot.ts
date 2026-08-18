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
  streamingModel: string | null;
  agentId: string | null;
  thinking: boolean;
}

/** Who/what is producing the in-flight assistant turn (may differ from the session agent). */
export interface LiveStreamingAgent {
  agentId: string;
  agentName: string;
  agentColor?: string | null;
  engine?: string | null;
  model?: string | null;
}

/**
 * Header identity for the live tail. Prefer the streamer's agent/engine/model
 * (e.g. an in-session Reviewer on grok-cli) over the session's Claude/Opus
 * dropdown — otherwise the bubble looks like the session agent is still typing.
 */
export function resolveLiveStreamIdentity(input: {
  streamingAgent: LiveStreamingAgent | null | undefined;
  streamingEngine?: string | null;
  sessionAgentName?: string | null;
  sessionAgentColor?: string | null;
  sessionModel?: string | null;
}): {
  agentName: string | undefined;
  agentColor: string | undefined;
  engine: string | null;
  model: string | null | undefined;
} {
  return {
    agentName: input.streamingAgent?.agentName || input.sessionAgentName || undefined,
    agentColor: input.streamingAgent?.agentColor || input.sessionAgentColor || undefined,
    engine: input.streamingEngine || input.streamingAgent?.engine || null,
    model: input.streamingAgent?.model || input.sessionModel || undefined,
  };
}

export function buildStreamingAgentState(
  data: {
    agentId?: string | null;
    agentName?: string | null;
    agentColor?: string | null;
    engine?: string | null;
    model?: string | null;
  },
  agents?: ReadonlyArray<{ id: string; name?: string | null; color?: string | null }>,
  prev?: LiveStreamingAgent | null,
): LiveStreamingAgent | null {
  if (!data.agentId) return null;
  const agent = agents?.find((a) => a.id === data.agentId);
  return {
    agentId: data.agentId,
    agentName: data.agentName || agent?.name || data.agentId,
    agentColor: data.agentColor ?? agent?.color,
    engine: data.engine ?? prev?.engine ?? null,
    model: data.model ?? prev?.model ?? null,
  };
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
      streamingModel: null,
      agentId: null,
      thinking: false,
    };
  }
  const content = task.content ?? '';
  return {
    streamingMsgId: task.messageId,
    streamingContent: content,
    streamingEngine: task.engine ?? null,
    streamingModel: task.model ?? null,
    agentId: task.agentId ?? null,
    // No text yet means the turn is still spinning up.
    thinking: !content,
  };
}
