export interface QueuedMessageRow {
  id: string;
  content?: string | null;
  attachments?: string | unknown[] | null;
}

export interface PersistedUploadAttachment {
  url?: string;
  contentType?: string;
  dataUrl?: string;
  uri?: string;
  file?: unknown;
  [key: string]: unknown;
}

export function attachmentsFromQueuedMessage(
  message: { attachments?: string | unknown[] | null } | null | undefined,
): unknown[] {
  if (!message?.attachments) return [];
  try {
    const parsed =
      typeof message.attachments === 'string'
        ? JSON.parse(message.attachments)
        : message.attachments;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function isPersistedUploadAttachment(att: unknown): att is PersistedUploadAttachment {
  if (!att || typeof att !== 'object') return false;
  const row = att as PersistedUploadAttachment;
  return Boolean(row.url && row.contentType && !row.dataUrl && !row.uri && !row.file);
}

export function buildInterruptQueuedChatWsMessage({
  message,
  agentId,
  sessionId,
}: {
  message: QueuedMessageRow;
  agentId: string;
  sessionId: string;
}): Record<string, unknown> {
  const images = attachmentsFromQueuedMessage(message);
  return {
    type: 'chat',
    agentId,
    sessionId,
    content: message?.content || '',
    ...(images.length > 0 ? { images } : {}),
    interrupt: true,
    _existingMsgId: message.id,
  };
}

export function buildInterruptQueuedMessageDispatch(params: {
  message: QueuedMessageRow;
  agentId: string;
  sessionId: string;
}): { chat: Record<string, unknown> } {
  return {
    chat: buildInterruptQueuedChatWsMessage(params),
  };
}
