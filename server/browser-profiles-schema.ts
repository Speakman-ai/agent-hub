/**
 * Browser profile DDL. Kept apart from `browser-profiles-store.ts` so
 * `orgs.ts` can apply it without importing the store (which imports
 * `orgs.ts` for `getOrgsDb`).
 *
 * One row per (user, agent, project): logins belong to the human who owns
 * the session, so two users talking to the same agent never share cookies.
 *
 * Columns:
 *   - storage_state_enc: Playwright storageState JSON encrypted with
 *     `encryptSecret` (`iv:tag:ciphertext`). Empty string means "no state
 *     saved yet". Never plaintext.
 *   - domains_json: JSON array of hostnames present in the saved state.
 *     Not secret; kept in the clear so policy and listing code can read it
 *     without decrypting the blob.
 *   - lease_holder / lease_expires_at: single write lease. `lease_expires_at`
 *     is epoch milliseconds so expiry compares exactly against the caller's
 *     clock. A crashed holder simply stops renewing and the lease lapses.
 *
 * browser_profile_domain_policies: what the host does when the agent acts on
 * a site through this profile. A policy on `example.com` also covers its
 * subdomains; the most specific entry wins. Sites with no entry are `allow`.
 */
export const BROWSER_PROFILES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS browser_profiles (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id          TEXT NOT NULL,
    project_id        TEXT NOT NULL,
    storage_state_enc TEXT NOT NULL DEFAULT '',
    domains_json      TEXT NOT NULL DEFAULT '[]',
    lease_holder      TEXT,
    lease_expires_at  INTEGER,
    last_saved_at     TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, agent_id, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_browser_profiles_project_agent
    ON browser_profiles(project_id, agent_id);

  CREATE TABLE IF NOT EXISTS browser_profile_domain_policies (
    profile_id  TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
    domain      TEXT NOT NULL,
    policy      TEXT NOT NULL CHECK (policy IN ('allow', 'ask', 'block')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, domain)
  );
`;
