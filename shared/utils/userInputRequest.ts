import { extractAskBlocks } from './extractAskBlocks.js';
import { extractForwardBlocks } from './extractForwardBlocks.js';
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
 * What a turn handed to the human. `ask` and `credential` need an answer
 * before the conversation can go on; `forward` is a confirm-then-start card
 * for a *different* session, so it needs a press, not a reply.
 */
export type UserInputKind = 'ask' | 'credential' | 'forward';

/** Kinds of user-input request carried by `text`, in a stable order. */
export function userInputKindsInText(text: string | null | undefined): UserInputKind[] {
  if (typeof text !== 'string' || !text.includes('agenthub:')) return [];
  const kinds: UserInputKind[] = [];
  if (text.includes('agenthub:ask') && extractAskBlocks(text).asks.length > 0) kinds.push('ask');
  if (findCredentialRequestIds(text).length > 0) kinds.push('credential');
  if (text.includes('agenthub:forward') && extractForwardBlocks(text).forwards.length > 0) {
    kinds.push('forward');
  }
  return kinds;
}

/**
 * True when assistant text hands control to the human: it carries a rendered
 * `agenthub:ask` picker, an `agenthub:forward` card, or an
 * `agenthub:credential-request` card. The host must stop driving the session
 * on its own once this is true, because any further turn runs without the
 * answer the agent just asked for.
 */
export function textRequestsUserInput(text: string | null | undefined): boolean {
  return userInputKindsInText(text).length > 0;
}

const USER_INPUT_KINDS: ReadonlySet<string> = new Set(['ask', 'credential', 'forward']);

/**
 * The `awaitingUserInput` stamp on an assistant row. `kinds` is null for rows
 * stamped before the chat handler recorded which kind it was.
 */
function metadataUserInput(metadata: string | null | undefined): {
  flagged: boolean;
  kinds: UserInputKind[] | null;
} {
  const none = { flagged: false, kinds: null };
  if (typeof metadata !== 'string' || !metadata.includes('awaitingUserInput')) return none;
  try {
    const parsed = JSON.parse(metadata) as {
      awaitingUserInput?: unknown;
      awaitingUserInputKinds?: unknown;
    };
    if (parsed?.awaitingUserInput !== true) return none;
    const raw = parsed.awaitingUserInputKinds;
    const kinds = Array.isArray(raw)
      ? (raw.filter((k) => typeof k === 'string' && USER_INPUT_KINDS.has(k)) as UserInputKind[])
      : null;
    return { flagged: true, kinds: kinds && kinds.length > 0 ? kinds : null };
  } catch {
    return none;
  }
}

export interface AwaitingUserReplyOptions {
  /**
   * Request kinds that do not block the caller. A row stamped without kinds
   * still counts as awaiting, since what it asked for is unknown.
   */
  ignoreKinds?: ReadonlyArray<UserInputKind>;
}

/**
 * True when the latest assistant message asked the user for input and no user
 * message has arrived since. The chat handler stamps `awaitingUserInput` (and
 * `awaitingUserInputKinds`) on the row's metadata because ask and forward
 * fences are lifted out of the saved text; the text check covers credential
 * cards and rows written before the stamp existed. System rows (notices,
 * cancel lines) are skipped so they cannot mask a pending question.
 */
export function isAwaitingUserReply(
  messages: ReadonlyArray<MessageWithMetadataLike> | null | undefined,
  options: AwaitingUserReplyOptions = {},
): boolean {
  if (!Array.isArray(messages)) return false;
  const ignored = new Set<UserInputKind>(options.ignoreKinds ?? []);
  const blocks = (kinds: UserInputKind[]) => kinds.some((k) => !ignored.has(k));
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return false;
    if (m?.role === 'assistant') {
      const stamp = metadataUserInput(m.metadata);
      if (stamp.flagged && (stamp.kinds === null || blocks(stamp.kinds))) return true;
      return blocks(userInputKindsInText(m.content));
    }
  }
  return false;
}
