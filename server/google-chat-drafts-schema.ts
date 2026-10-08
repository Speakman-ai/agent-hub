/**
 * Google Chat reply drafts and the per-user auto-send setting. Kept apart from
 * `google-chat-drafts-store.ts` so `orgs.ts` can apply the DDL without
 * importing the store (which depends on `orgs.ts`). Mirrors
 * `google-connections-schema.ts`.
 *
 * A draft is a Chat message an agent asked to post from a session. It goes out
 * under the session owner's Google identity, so it waits here until that user
 * approves it.
 *
 * Status flow: pending → sending → sent, or pending/unconfirmed → discarded.
 *
 * Each send attempt carries a Google `requestId`, which makes messages.create
 * idempotent for identical requests. When Google refuses a fresh attempt (a
 * 4xx response) nothing was posted: the draft returns to pending and the id is
 * cleared, so an edited retry is a new request. When the outcome is unknown
 * (no response, timeout, 5xx), the draft becomes `unconfirmed` with its
 * request id, text, and resolved reply thread frozen: a retry repeats the
 * identical request and can post at most once, and editing is refused. The
 * attempt (request id, reply thread, owning boot) is stored when it is claimed,
 * before anything is sent, so a `sending` row left by a restart or crash is
 * recovered as `unconfirmed` and never re-sent automatically.
 */
export const GOOGLE_CHAT_DRAFTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS google_chat_drafts (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id        TEXT NOT NULL,
    space_id          TEXT NOT NULL,
    thread_name       TEXT,
    text              TEXT NOT NULL,
    -- Bumped on every text change. Approve, edit, and discard name the
    -- revision the user reviewed, so a concurrent edit is never acted on unseen.
    revision          INTEGER NOT NULL DEFAULT 1,
    status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','sending','unconfirmed','sent','discarded')),
    error             TEXT,
    sent_message_name TEXT,
    -- Google messages.create requestId for the current or last uncertain attempt.
    request_id        TEXT,
    -- Thread the attempt replies in (null: posted to the conversation). Only
    -- meaningful while request_id is set.
    request_reply_thread TEXT,
    -- Boot id of the process running the current attempt. A 'sending' row
    -- owned by another boot was abandoned and reads as 'unconfirmed'.
    attempt_owner     TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_google_chat_drafts_user_status
    ON google_chat_drafts(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_google_chat_drafts_session
    ON google_chat_drafts(session_id);

  CREATE TABLE IF NOT EXISTS google_chat_settings (
    user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auto_send_agent_replies  INTEGER NOT NULL DEFAULT 0,
    updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;
