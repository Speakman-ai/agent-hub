import { extractAskBlocks } from './extractAskBlocks.js';
import type { ChatMessageLike } from './awaitingInput.js';

export interface MessageWithMetadataLike extends ChatMessageLike {
  metadata?: string | null;
}

const CREDENTIAL_FENCE_RE = /```agenthub:credential-request\s*\n?([\s\S]*?)\n?```/g;

/**
 * Request ids of well-formed `agenthub:credential-request` fences in `text`.
 * A block counts only when it parses to an object with a non-empty `fields`
 * array, the same minimum the clients need to render the masked card.
 */
export function findCredentialRequestIds(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || !text.includes('agenthub:credential-request')) return [];
  const out: string[] = [];
  CREDENTIAL_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREDENTIAL_FENCE_RE.exec(text)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]?.trim() ?? '');
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const env = parsed as { requestId?: unknown; fields?: unknown };
    if (!Array.isArray(env.fields) || env.fields.length === 0) continue;
    const id =
      typeof env.requestId === 'string' && env.requestId.trim()
        ? env.requestId.trim()
        : 'credential-request';
    out.push(id);
  }
  return out;
}

/**
 * True when assistant text hands control to the human: it carries a rendered
 * `agenthub:ask` picker or an `agenthub:credential-request` card. The host
 * must stop driving the session on its own once this is true, because any
 * further turn runs without the answer the agent just asked for.
 */
export function textRequestsUserInput(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || !text.includes('agenthub:')) return false;
  if (findCredentialRequestIds(text).length > 0) return true;
  if (!text.includes('agenthub:ask')) return false;
  return extractAskBlocks(text).asks.length > 0;
}

function metadataFlagsUserInput(metadata: string | null | undefined): boolean {
  if (typeof metadata !== 'string' || !metadata.includes('awaitingUserInput')) return false;
  try {
    const parsed = JSON.parse(metadata) as { awaitingUserInput?: unknown };
    return parsed?.awaitingUserInput === true;
  } catch {
    return false;
  }
}

/**
 * True when the latest assistant message asked the user for input and no user
 * message has arrived since. The chat handler stamps `awaitingUserInput` on the
 * row's metadata because ask fences are lifted out of the saved text; the text
 * check covers credential cards and rows written before the stamp existed.
 * System rows (notices, cancel lines) are skipped so they cannot mask a
 * pending question.
 */
export function isAwaitingUserReply(
  messages: ReadonlyArray<MessageWithMetadataLike> | null | undefined,
): boolean {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return false;
    if (m?.role === 'assistant') {
      return metadataFlagsUserInput(m.metadata) || textRequestsUserInput(m.content);
    }
  }
  return false;
}
