import type { Response } from 'express';
import type { MessageRow } from './types.js';

/** Conservative cap so JSON.stringify stays under V8's max string length. */
export const SESSION_MESSAGES_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

export interface SessionMessagesResponseMeta {
  truncated: boolean;
  omitted: number;
  total: number;
}

export type SessionMessagesResponse =
  | MessageRow[]
  | (SessionMessagesResponseMeta & { messages: MessageRow[] });

function estimateMessageJsonBytes(m: MessageRow): number {
  const content = m.content ?? '';
  const metadata = m.metadata ?? '';
  const attachments = m.attachments ?? '';
  return content.length + metadata.length + attachments.length + 240;
}

export function applyMessagesLimitQuery(messages: MessageRow[], limitRaw: unknown): MessageRow[] {
  if (typeof limitRaw !== 'string') return messages;
  const n = parseInt(limitRaw, 10);
  if (!Number.isFinite(n) || n <= 0) return messages;
  if (messages.length <= n) return messages;
  return messages.slice(messages.length - n);
}

export function capMessagesForJsonResponse(
  messages: MessageRow[],
  maxBytes: number = SESSION_MESSAGES_RESPONSE_MAX_BYTES,
): { messages: MessageRow[]; truncated: boolean; omitted: number; total: number } {
  const total = messages.length;
  if (total === 0) {
    return { messages: [], truncated: false, omitted: 0, total: 0 };
  }

  let estimated = 2;
  for (const m of messages) {
    estimated += estimateMessageJsonBytes(m) + 1;
  }
  if (estimated <= maxBytes) {
    return { messages, truncated: false, omitted: 0, total };
  }

  const kept: MessageRow[] = [];
  let size = 2;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const msgSize = estimateMessageJsonBytes(m) + 1;
    if (size + msgSize > maxBytes && kept.length > 0) break;
    kept.unshift(m);
    size += msgSize;
  }

  if (kept.length === 0) {
    kept.push(messages[messages.length - 1]!);
  }

  return {
    messages: kept,
    truncated: true,
    omitted: total - kept.length,
    total,
  };
}

export function buildSessionMessagesHttpBody(
  messages: MessageRow[],
  maxBytes: number = SESSION_MESSAGES_RESPONSE_MAX_BYTES,
): SessionMessagesResponse {
  const capped = capMessagesForJsonResponse(messages, maxBytes);
  if (!capped.truncated) {
    return capped.messages;
  }
  return {
    messages: capped.messages,
    truncated: true,
    omitted: capped.omitted,
    total: capped.total,
  };
}

export function sendSessionMessagesJson(
  res: Pick<Response, 'json'>,
  body: SessionMessagesResponse,
  fallbackMaxBytes = 4 * 1024 * 1024,
): void {
  try {
    res.json(body);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const rows = Array.isArray(body) ? body : body.messages;
    const retry = capMessagesForJsonResponse(rows, fallbackMaxBytes);
    const priorOmitted = Array.isArray(body) ? 0 : (body.omitted ?? 0);
    res.json({
      messages: retry.messages,
      truncated: true,
      omitted: priorOmitted + retry.omitted,
      total: Array.isArray(body) ? body.length : (body.total ?? rows.length),
    });
  }
}
