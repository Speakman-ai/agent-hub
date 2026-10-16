/**
 * DDL for container-backend desktops (orgs.db). Kept apart from the store so
 * `orgs.ts` can apply it without importing the store, which imports `orgs.ts`.
 * The Firecracker backend keeps its VM records separately; this table only
 * describes containers.
 *
 * One row per (user, agent, project), the same scope as a browser profile.
 * The row outlives every stop: it is what ties a resumed computer back to its
 * persistent home.
 *
 * Columns:
 *   - placement: where the computer last ran (`hub-docker` | `runner-fleet`).
 *     `home_ref` is only meaningful for that placement.
 *   - runner_ref: container name (hub-docker) or runner job id (fleet). Set
 *     before the container can exist (the Hub-docker name is written ahead
 *     of `docker run`) and cleared only once its host confirms it is gone, so
 *     a non-null value always means "a container may exist".
 *   - control_token_enc: bearer token of the running container's control
 *     daemon, encrypted with `encryptSecret`. Kept so a restarted Hub can keep
 *     driving a computer it adopts.
 *   - home_placements: comma-separated placements that may still hold a home
 *     for this computer. A placement switch starts a fresh home on the new
 *     placement but leaves the old one in place; deletion cleans every one.
 *   - home_ref: docker volume name (hub-docker) or snapshot key in the
 *     desktop home store (fleet). Null on the fleet until the first snapshot.
 *   - home_blocked: set when a run's home could not be saved (the Hub refused
 *     it, e.g. too large). The runner then parks: container removed, volume
 *     kept, job still held, so the job remains this computer's runner ref and
 *     the Hub still owns that data. Starts are refused while it is set, so
 *     the computer never silently resumes on an older home.
 *   - home_decision: what the parked runner does with the kept home: `hold`
 *     (default), `retry` (snapshot and upload again, e.g. after the cap was
 *     raised) or `discard` (remove the volume). Profile deletion sets
 *     `discard` and stays pending until the runner confirms by finishing.
 *   - last_active_at: epoch ms of the last tool call, persisted (throttled) so
 *     idle stop still fires for computers adopted after a Hub restart.
 */
export const DESKTOP_CONTAINERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS desktop_containers (
    id                     TEXT PRIMARY KEY,
    user_id                TEXT NOT NULL,
    agent_id               TEXT NOT NULL,
    project_id             TEXT NOT NULL,
    placement              TEXT NOT NULL,
    runner_ref             TEXT,
    control_token_enc      TEXT,
    home_ref               TEXT,
    home_placements        TEXT NOT NULL DEFAULT '',
    home_blocked           TEXT,
    home_decision          TEXT,
    last_active_at         INTEGER,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, agent_id, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_containers_runner_ref
    ON desktop_containers(runner_ref);

  -- Every home object written to the store, tracked from before it exists
  -- until it is either the committed home (row removed in the same
  -- transaction as the commit) or confirmed deleted. Not tied to the
  -- computer row, so cleanup outlives profile deletion. state: 'writing'
  -- (put in progress, or the Hub died during it) or 'orphan' (must be
  -- deleted; retried by the janitor until the delete succeeds).
  CREATE TABLE IF NOT EXISTS desktop_home_objects (
    key         TEXT PRIMARY KEY,
    computer_id TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('writing', 'orphan')),
    since       INTEGER NOT NULL,
    last_error  TEXT
  );
`;
