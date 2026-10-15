/**
 * Approval DDL, kept apart from `approvals-store.ts` so `orgs.ts` can apply
 * it without importing the store (which imports `orgs.ts`).
 *
 * approval_requests: one row per agent request to perform an irreversible
 * action. Times are epoch milliseconds so the 24h expiry compares exactly.
 *   - status: pending | allowed | denied | cancelled
 *   - resolution: allow_once | always_allow | auto_allowed | deny | timeout |
 *     aborted (null while pending)
 *   - profile_id / domain: what an always-allow rule would be keyed on. Both
 *     null when the request has no site (then no rule can be saved).
 *
 * approval_rules: remembered answers scoped to (browser profile, domain,
 * action). `effect = 'require'` always asks, even when an allow rule matches.
 */
export const APPROVALS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS approval_requests (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    user_id      TEXT,
    agent_id     TEXT NOT NULL,
    project_id   TEXT,
    profile_id   TEXT,
    action       TEXT NOT NULL,
    target       TEXT NOT NULL,
    domain       TEXT,
    details      TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'allowed', 'denied', 'cancelled')),
    resolution   TEXT,
    rule_id      TEXT,
    resolved_by  TEXT,
    requested_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    resolved_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_approval_requests_user_status
    ON approval_requests(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_approval_requests_session
    ON approval_requests(session_id);

  CREATE TABLE IF NOT EXISTS approval_rules (
    id                TEXT PRIMARY KEY,
    profile_id        TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
    user_id           TEXT NOT NULL,
    domain            TEXT NOT NULL,
    action            TEXT NOT NULL,
    effect            TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'require')),
    source_request_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (profile_id, domain, action, effect)
  );
  CREATE INDEX IF NOT EXISTS idx_approval_rules_user ON approval_rules(user_id);
`;
