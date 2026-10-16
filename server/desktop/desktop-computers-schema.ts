/**
 * Desktop computer DDL. Kept apart from the store so `orgs.ts` can apply it
 * without importing the store.
 *
 * One row per (user, agent, project, backend): the identity of a persistent
 * computer, independent of any chat session.
 *
 * Columns:
 *   - vm_id: stable backend resource name (Firecracker VM id). Derived from
 *     the key, stored so a rename of the derivation never orphans a disk.
 *   - slot: Firecracker network slot (guest IP, MAC, tap, vsock CID). Held
 *     for the life of the row, including while the computer is stopped, so
 *     the slot pool can reserve it again at Hub boot and the computer keeps
 *     its address across restarts. Null for backends without slots.
 *   - last_active_at: epoch ms of the last tool call.
 *   - snapshot: compatibility fingerprint of the Firecracker snapshot taken
 *     at the last stop, which the next start resumes. Null when the next
 *     start is a cold boot. The snapshot files live beside the VM's disks and
 *     go with them.
 */
export const DESKTOP_COMPUTERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS desktop_computers (
    user_id        TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('container', 'firecracker')),
    vm_id          TEXT NOT NULL,
    slot           INTEGER,
    last_active_at INTEGER,
    snapshot       TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, agent_id, project_id, kind)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_computers_slot
    ON desktop_computers(kind, slot) WHERE slot IS NOT NULL;
`;
