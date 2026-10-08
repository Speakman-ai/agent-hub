/**
 * Persistence for Google Chat reply drafts and the per-user auto-send setting.
 * Schema and status flow: `google-chat-drafts-schema.ts`.
 *
 * Every read and write is keyed by the owning user, so one user can never see
 * or act on another user's drafts by guessing an id.
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';

export type GoogleChatDraftStatus = 'pending' | 'sending' | 'unconfirmed' | 'sent' | 'discarded';

export const OPEN_DRAFT_STATUSES: GoogleChatDraftStatus[] = ['pending', 'sending', 'unconfirmed'];

export interface GoogleChatDraft {
  id: string;
  userId: string;
  sessionId: string;
  spaceId: string;
  threadName: string | null;
  text: string;
  /** Bumped on every text change; actions must name the revision they saw. */
  revision: number;
  status: GoogleChatDraftStatus;
  /** Last send failure, cleared when the draft is sent or edited. */
  error: string | null;
  /** `spaces/{space}/messages/{message}` once sent. */
  sentMessageName: string | null;
  /** Google requestId of the current or last uncertain send; internal. */
  requestId: string | null;
  /** Reply thread resolved for that request (null: the conversation); internal. */
  requestReplyThread: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawDraftRow {
  id: string;
  user_id: string;
  session_id: string;
  space_id: string;
  thread_name: string | null;
  text: string;
  revision: number;
  status: GoogleChatDraftStatus;
  error: string | null;
  sent_message_name: string | null;
  request_id: string | null;
  request_reply_thread: string | null;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function toDraft(row: RawDraftRow): GoogleChatDraft {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    spaceId: row.space_id,
    threadName: row.thread_name,
    text: row.text,
    revision: row.revision,
    status: row.status,
    error: row.error,
    sentMessageName: row.sent_message_name,
    requestId: row.request_id,
    requestReplyThread: row.request_reply_thread,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createChatDraft(input: {
  userId: string;
  sessionId: string;
  spaceId: string;
  threadName?: string | null;
  text: string;
}): GoogleChatDraft {
  const id = uuidv4();
  getOrgsDb()
    .prepare(
      `INSERT INTO google_chat_drafts (id, user_id, session_id, space_id, thread_name, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.userId, input.sessionId, input.spaceId, input.threadName ?? null, input.text);
  return getChatDraft(id, input.userId) as GoogleChatDraft;
}

export function getChatDraft(id: string, userId: string): GoogleChatDraft | null {
  recoverAbandonedSends(userId);
  const row = getOrgsDb()
    .prepare('SELECT * FROM google_chat_drafts WHERE id = ? AND user_id = ?')
    .get(id, userId) as RawDraftRow | undefined;
  return row ? toDraft(row) : null;
}

export function listChatDrafts(
  userId: string,
  filter: {
    sessionId?: string;
    spaceId?: string;
    status?: GoogleChatDraftStatus | GoogleChatDraftStatus[];
  } = {},
): GoogleChatDraft[] {
  recoverAbandonedSends(userId);
  const where = ['user_id = ?'];
  const args: string[] = [userId];
  if (filter.sessionId) {
    where.push('session_id = ?');
    args.push(filter.sessionId);
  }
  if (filter.spaceId) {
    where.push('space_id = ?');
    args.push(filter.spaceId);
  }
  const statuses = filter.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : [];
  if (statuses.length) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM google_chat_drafts WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC, rowid ASC LIMIT 200`,
    )
    .all(...args) as RawDraftRow[];
  return rows.map(toDraft);
}

/** Why an action on a draft was refused. */
export type DraftActionRefusal = 'not_found' | 'not_pending' | 'revision_mismatch';

export type DraftActionResult =
  | { ok: true; draft: GoogleChatDraft }
  | { ok: false; reason: DraftActionRefusal; draft: GoogleChatDraft | null };

function refusal(
  draft: GoogleChatDraft | null,
  expectedRevision: number,
  allowed: GoogleChatDraftStatus[],
): DraftActionResult | null {
  if (!draft) return { ok: false, reason: 'not_found', draft: null };
  if (!allowed.includes(draft.status)) return { ok: false, reason: 'not_pending', draft };
  if (draft.revision !== expectedRevision) return { ok: false, reason: 'revision_mismatch', draft };
  return null;
}

/**
 * Replace a pending draft's text, if it is still the revision the user edited.
 * The read, check, and write run in one transaction.
 */
export function updateChatDraftText(
  id: string,
  userId: string,
  text: string,
  expectedRevision: number,
): DraftActionResult {
  const db = getOrgsDb();
  return db.transaction((): DraftActionResult => {
    const refused = refusal(getChatDraft(id, userId), expectedRevision, ['pending']);
    if (refused) return refused;
    db.prepare(
      `UPDATE google_chat_drafts
       SET text = ?, revision = revision + 1, error = NULL, updated_at = ${NOW}
       WHERE id = ? AND user_id = ?`,
    ).run(text, id, userId);
    return { ok: true, draft: getChatDraft(id, userId)! };
  })();
}

/**
 * A send attempt is durable from the moment it is claimed: the request id, the
 * reply thread, and the attempt owner are written in one statement, before
 * anything is sent. The owner is this process's boot id. A `sending` row owned
 * by any other boot belongs to an attempt that can no longer finish (restart,
 * crash), so it reads as `unconfirmed`: Google may have the message, and the
 * stored request makes a retry idempotent.
 */
let bootId = uuidv4();

/** Simulate a server restart in tests: every in-flight attempt is abandoned. */
export function restartChatDraftAttemptsForTests(): void {
  bootId = uuidv4();
}

export const INTERRUPTED_SEND_ERROR =
  'Agent Hub restarted while sending this reply, so it may have posted. Check the conversation. Retry repeats the same request and posts at most once; to change the text, discard this draft.';

function recoverAbandonedSends(userId: string): void {
  getOrgsDb()
    .prepare(
      `UPDATE google_chat_drafts
       SET status = 'unconfirmed', error = ?, attempt_owner = NULL, updated_at = ${NOW}
       WHERE user_id = ? AND status = 'sending'
         AND (attempt_owner IS NULL OR attempt_owner != ?)`,
    )
    .run(INTERRUPTED_SEND_ERROR, userId, bootId);
}

/** Identifies one claimed attempt; completions only apply to their own attempt. */
export interface ChatDraftAttempt {
  id: string;
  userId: string;
  requestId: string;
}

/**
 * Claim a draft for one send attempt. The status guard makes this the single
 * claim: two concurrent approvals cannot both send.
 *
 *   - pending: start a new request with `replyThread` (resolved by the caller
 *     before claiming) and optionally replace the text.
 *   - unconfirmed (including an abandoned send): retry the earlier request.
 *     Text, request id, and reply thread stay as they were so Google sees an
 *     identical request. A `text` that differs is refused (`text_changed`).
 */
export function claimChatDraftForSend(
  id: string,
  userId: string,
  opts: { expectedRevision: number; text?: string; replyThread?: string | null },
):
  | { ok: true; draft: GoogleChatDraft; attempt: ChatDraftAttempt; retry: boolean }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'not_sendable'
        | 'revision_mismatch'
        | 'text_changed'
        | 'thread_unresolved';
      draft: GoogleChatDraft | null;
    } {
  const db = getOrgsDb();
  return db.transaction(() => {
    const draft = getChatDraft(id, userId);
    if (!draft) return { ok: false as const, reason: 'not_found' as const, draft: null };
    // The approver must have reviewed exactly this revision; an edit from
    // another tab or device in between means they haven't seen what would go out.
    if (
      (draft.status === 'pending' || draft.status === 'unconfirmed') &&
      draft.revision !== opts.expectedRevision
    ) {
      return { ok: false as const, reason: 'revision_mismatch' as const, draft };
    }
    let retry: boolean;
    if (draft.status === 'pending') {
      if (opts.replyThread === undefined) {
        return { ok: false as const, reason: 'thread_unresolved' as const, draft };
      }
      db.prepare(
        `UPDATE google_chat_drafts
         SET status = 'sending', text = ?, error = NULL, request_id = ?,
             revision = revision + CASE WHEN ? = text THEN 0 ELSE 1 END,
             request_reply_thread = ?, attempt_owner = ?, updated_at = ${NOW}
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
      ).run(
        opts.text ?? draft.text,
        uuidv4(),
        opts.text ?? draft.text,
        opts.replyThread,
        bootId,
        id,
        userId,
      );
      retry = false;
    } else if (draft.status === 'unconfirmed') {
      if (opts.text !== undefined && opts.text !== draft.text) {
        return { ok: false as const, reason: 'text_changed' as const, draft };
      }
      db.prepare(
        `UPDATE google_chat_drafts SET status = 'sending', attempt_owner = ?, updated_at = ${NOW}
         WHERE id = ? AND user_id = ? AND status = 'unconfirmed'`,
      ).run(bootId, id, userId);
      retry = true;
    } else {
      return { ok: false as const, reason: 'not_sendable' as const, draft };
    }
    const claimed = getChatDraft(id, userId)!;
    return {
      ok: true as const,
      draft: claimed,
      attempt: { id, userId, requestId: claimed.requestId! },
      retry,
    };
  })();
}

/** Guard shared by every completion: the row is still this attempt, in this boot. */
const ATTEMPT_GUARD =
  "id = ? AND user_id = ? AND status = 'sending' AND request_id = ? AND attempt_owner = ?";

export function markChatDraftSent(
  attempt: ChatDraftAttempt,
  messageName: string | null,
): GoogleChatDraft | null {
  getOrgsDb()
    .prepare(
      `UPDATE google_chat_drafts
       SET status = 'sent', sent_message_name = ?, error = NULL, attempt_owner = NULL,
           updated_at = ${NOW}
       WHERE ${ATTEMPT_GUARD}`,
    )
    .run(messageName, attempt.id, attempt.userId, attempt.requestId, bootId);
  return getChatDraft(attempt.id, attempt.userId);
}

/**
 * Google refused a fresh attempt, so nothing was posted. Back to pending with
 * the request cleared: the next attempt (possibly with edited text) is new.
 * Never use this for a retry, whose earlier attempt may have posted.
 */
export function releaseChatDraftAfterRejection(
  attempt: ChatDraftAttempt,
  error: string,
): GoogleChatDraft | null {
  getOrgsDb()
    .prepare(
      `UPDATE google_chat_drafts
       SET status = 'pending', error = ?, request_id = NULL, request_reply_thread = NULL,
           attempt_owner = NULL, updated_at = ${NOW}
       WHERE ${ATTEMPT_GUARD}`,
    )
    .run(error, attempt.id, attempt.userId, attempt.requestId, bootId);
  return getChatDraft(attempt.id, attempt.userId);
}

/**
 * The attempt may or may not have posted. Keep the request id, text, and
 * thread so the only way forward is an identical (idempotent) retry or a
 * discard.
 */
export function markChatDraftUnconfirmed(
  attempt: ChatDraftAttempt,
  error: string,
): GoogleChatDraft | null {
  getOrgsDb()
    .prepare(
      `UPDATE google_chat_drafts
       SET status = 'unconfirmed', error = ?, attempt_owner = NULL, updated_at = ${NOW}
       WHERE ${ATTEMPT_GUARD}`,
    )
    .run(error, attempt.id, attempt.userId, attempt.requestId, bootId);
  return getChatDraft(attempt.id, attempt.userId);
}

/** Discard a pending or unconfirmed draft, if it is still the revision the user saw. */
export function discardChatDraft(
  id: string,
  userId: string,
  expectedRevision: number,
): DraftActionResult {
  const db = getOrgsDb();
  return db.transaction((): DraftActionResult => {
    const refused = refusal(getChatDraft(id, userId), expectedRevision, ['pending', 'unconfirmed']);
    if (refused) return refused;
    db.prepare(
      `UPDATE google_chat_drafts SET status = 'discarded', updated_at = ${NOW}
       WHERE id = ? AND user_id = ?`,
    ).run(id, userId);
    return { ok: true, draft: getChatDraft(id, userId)! };
  })();
}

export interface GoogleChatSettings {
  /** Post agent replies immediately instead of holding them for approval. */
  autoSendAgentReplies: boolean;
}

export function getChatSettings(userId: string): GoogleChatSettings {
  const row = getOrgsDb()
    .prepare('SELECT auto_send_agent_replies FROM google_chat_settings WHERE user_id = ?')
    .get(userId) as { auto_send_agent_replies: number } | undefined;
  return { autoSendAgentReplies: row?.auto_send_agent_replies === 1 };
}

export function setChatSettings(userId: string, settings: GoogleChatSettings): GoogleChatSettings {
  getOrgsDb()
    .prepare(
      `INSERT INTO google_chat_settings (user_id, auto_send_agent_replies, updated_at)
       VALUES (?, ?, ${NOW})
       ON CONFLICT(user_id) DO UPDATE SET
         auto_send_agent_replies = excluded.auto_send_agent_replies,
         updated_at = excluded.updated_at`,
    )
    .run(userId, settings.autoSendAgentReplies ? 1 : 0);
  return getChatSettings(userId);
}
