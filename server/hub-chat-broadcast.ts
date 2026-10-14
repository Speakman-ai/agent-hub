/**
 * Message shaping and live fan-out shared by the chat routes and the
 * server-side posters (agent channel replies). Event names and the recipient
 * rule live in `hub-chat-events.ts`.
 */
import { findAgent } from './project-model.js';
import { getUserById } from './users-store.js';
import { listMembers } from './hub-chat-store.js';
import { HUB_ASSISTANT_AGENT_ID } from '../shared/utils/hub.js';
import { recipientsOf } from './hub-chat-events.js';
import type { BroadcastFn, HubChatChannelRow, HubChatMessageRow } from './types.js';

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function agentDisplayName(agentId: string): string {
  if (agentId === HUB_ASSISTANT_AGENT_ID) return 'Agent Hub';
  return findAgent(agentId)?.agent.name || agentId;
}

export function shapeMessage(m: HubChatMessageRow) {
  const refs = parseJson(m.refs_json);
  return {
    id: m.id,
    channelId: m.channel_id,
    seq: m.seq,
    authorKind: m.author_kind,
    authorUserId: m.author_user_id,
    authorAgentId: m.author_agent_id,
    authorAgentName: m.author_agent_id ? agentDisplayName(m.author_agent_id) : null,
    body: m.body,
    refs: Array.isArray(refs) ? refs : [],
    payload: parseJson(m.payload_json),
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    createdAt: m.created_at,
  };
}

/** Broadcasts a new or changed message to the channel's members. */
export function broadcastHubChatMessage(
  broadcast: BroadcastFn | undefined,
  type: string,
  channel: HubChatChannelRow,
  message: HubChatMessageRow,
): void {
  const recipientUserIds = recipientsOf(listMembers(channel.id));
  if (!broadcast || recipientUserIds.length === 0) return;
  broadcast({
    type,
    recipientUserIds,
    orgId: channel.org_id,
    channelId: channel.id,
    channelKind: channel.kind,
    channelName: channel.name,
    authorName:
      message.author_kind === 'agent' && message.author_agent_id
        ? agentDisplayName(message.author_agent_id)
        : message.author_kind === 'trigger'
          ? 'Trigger'
          : message.author_user_id
            ? (getUserById(message.author_user_id)?.username ?? null)
            : null,
    message: shapeMessage(message),
  });
}
