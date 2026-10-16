/**
 * Persistent records of agent desktops, one per (user, agent, project). See
 * desktop-containers-schema.ts for what each column means.
 *
 * The control token is encrypted at rest and only leaves this module as the
 * return value of `readDesktopControlToken`.
 */
import { randomUUID } from 'crypto';
import { getOrgsDb } from '../orgs.js';
import { decryptSecret, encryptSecret } from '../secret-crypto.js';
import type { DesktopComputerKey } from './desktop-runtime.js';
import type { DesktopContainerPlacement } from './desktop-runtime-selection.js';

/** What a parked runner does with a home the Hub refused. */
export type DesktopHomeDecision = 'hold' | 'retry' | 'discard';

export interface DesktopComputerRecord {
  id: string;
  userId: string;
  agentId: string;
  projectId: string;
  placement: DesktopContainerPlacement;
  runnerRef: string | null;
  homeRef: string | null;
  /** Every placement that may hold a home for this computer. */
  homePlacements: DesktopContainerPlacement[];
  /** Why starts are refused (a home that could not be saved), or null. */
  homeBlocked: string | null;
  homeDecision: DesktopHomeDecision | null;
  lastActiveAt: number | null;
}

interface Row {
  id: string;
  user_id: string;
  agent_id: string;
  project_id: string;
  placement: string;
  runner_ref: string | null;
  home_ref: string | null;
  home_placements: string;
  home_blocked: string | null;
  home_decision: string | null;
  last_active_at: number | null;
}

const COLUMNS = `id, user_id, agent_id, project_id, placement, runner_ref, home_ref, home_placements, home_blocked, home_decision, last_active_at`;

function parsePlacement(p: string): DesktopContainerPlacement {
  return p === 'runner-fleet' ? 'runner-fleet' : 'hub-docker';
}

function toRecord(r: Row): DesktopComputerRecord {
  return {
    id: r.id,
    userId: r.user_id,
    agentId: r.agent_id,
    projectId: r.project_id,
    placement: parsePlacement(r.placement),
    runnerRef: r.runner_ref,
    homeRef: r.home_ref,
    homeBlocked: r.home_blocked,
    homeDecision:
      r.home_decision === 'retry' || r.home_decision === 'discard' || r.home_decision === 'hold'
        ? r.home_decision
        : null,
    homePlacements: [
      ...new Set((r.home_placements ?? '').split(',').filter(Boolean).map(parsePlacement)),
    ],
    lastActiveAt: r.last_active_at,
  };
}

function assertKey(key: DesktopComputerKey): void {
  if (!key.userId || !key.agentId || !key.projectId) {
    throw new Error('desktop computer key needs userId, agentId and projectId');
  }
}

export function getDesktopComputer(key: DesktopComputerKey): DesktopComputerRecord | null {
  assertKey(key);
  const row = getOrgsDb()
    .prepare(
      `SELECT ${COLUMNS} FROM desktop_containers WHERE user_id=? AND agent_id=? AND project_id=?`,
    )
    .get(key.userId, key.agentId, key.projectId) as Row | undefined;
  return row ? toRecord(row) : null;
}

export function getDesktopComputerById(id: string): DesktopComputerRecord | null {
  const row = getOrgsDb()
    .prepare(`SELECT ${COLUMNS} FROM desktop_containers WHERE id=?`)
    .get(id) as Row | undefined;
  return row ? toRecord(row) : null;
}

/**
 * Create the record on first use. An existing record keeps its id (and so its
 * home); a placement change is recorded and the caller decides what the old
 * home means on the new placement.
 */
export function getOrCreateDesktopComputer(
  key: DesktopComputerKey,
  placement: DesktopContainerPlacement,
): DesktopComputerRecord {
  assertKey(key);
  getOrgsDb()
    .prepare(
      `INSERT INTO desktop_containers (id, user_id, agent_id, project_id, placement)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, agent_id, project_id) DO NOTHING`,
    )
    .run(randomUUID(), key.userId, key.agentId, key.projectId, placement);
  return getDesktopComputer(key)!;
}

export function hasDesktopContainers(): boolean {
  return !!getOrgsDb().prepare('SELECT 1 FROM desktop_containers LIMIT 1').get();
}

/** Computers the Hub believes are running or starting (adopted after a restart). */
export function listActiveDesktopComputers(): DesktopComputerRecord[] {
  return (
    getOrgsDb()
      .prepare(`SELECT ${COLUMNS} FROM desktop_containers WHERE runner_ref IS NOT NULL`)
      .all() as Row[]
  ).map(toRecord);
}

/**
 * The computer a fleet job belongs to. The runner ref is kept until the job's
 * runner acknowledged the stop, so this covers the home upload after a stop.
 */
export function findDesktopComputerByJob(jobId: string): DesktopComputerRecord | null {
  const row = getOrgsDb()
    .prepare(`SELECT ${COLUMNS} FROM desktop_containers WHERE runner_ref=? LIMIT 1`)
    .get(jobId) as Row | undefined;
  return row ? toRecord(row) : null;
}

const ADD_HOME_PLACEMENT = `home_placements=CASE
                WHEN (',' || home_placements || ',') LIKE ('%,' || @placement || ',%')
                  THEN home_placements
                WHEN home_placements = '' THEN @placement
                ELSE home_placements || ',' || @placement END`;

/**
 * Write a runner ref ahead of creating its container, so a crash or a failed
 * create can never leave a container no record points at.
 */
export function recordDesktopReserved(args: {
  id: string;
  placement: DesktopContainerPlacement;
  runnerRef: string;
  controlToken: string;
}): void {
  const res = getOrgsDb()
    .prepare(
      `UPDATE desktop_containers
          SET runner_ref=@runnerRef, control_token_enc=@token,
              -- A home ref only means something on the placement that wrote
              -- it; switching placement drops it in the same statement, so
              -- no crash can leave a ref of one placement on the other.
              home_ref=CASE WHEN placement=@placement THEN home_ref ELSE NULL END,
              placement=@placement,
              updated_at=datetime('now'), ${ADD_HOME_PLACEMENT}
        WHERE id=@id`,
    )
    .run({
      id: args.id,
      placement: args.placement,
      runnerRef: args.runnerRef,
      token: encryptSecret(args.controlToken),
    });
  // Without the record nothing would own what the caller is about to create.
  if (res.changes !== 1) throw new Error(`desktop computer ${args.id} no longer exists`);
}

export function recordDesktopStarted(args: {
  id: string;
  placement: DesktopContainerPlacement;
  runnerRef: string;
  controlToken: string;
  homeRef: string | null;
  now: number;
}): void {
  getOrgsDb()
    .prepare(
      `UPDATE desktop_containers
          SET placement=@placement, runner_ref=@runnerRef, control_token_enc=@token,
              home_ref=@homeRef, last_active_at=@now, updated_at=datetime('now'),
              ${ADD_HOME_PLACEMENT}
        WHERE id=@id`,
    )
    .run({
      id: args.id,
      placement: args.placement,
      runnerRef: args.runnerRef,
      token: encryptSecret(args.controlToken),
      homeRef: args.homeRef,
      now: args.now,
    });
}

/** The host confirmed the container is gone. */
export function recordDesktopStopped(args: { id: string; now: number }): void {
  getOrgsDb()
    .prepare(
      `UPDATE desktop_containers
          SET runner_ref=NULL, control_token_enc=NULL, updated_at=datetime('now')
        WHERE id=@id`,
    )
    .run({ id: args.id });
}

export function readDesktopControlToken(id: string): string | null {
  const row = getOrgsDb()
    .prepare('SELECT control_token_enc FROM desktop_containers WHERE id=?')
    .get(id) as { control_token_enc: string | null } | undefined;
  if (!row?.control_token_enc) return null;
  try {
    return decryptSecret(row.control_token_enc);
  } catch {
    return null;
  }
}

export function touchDesktopComputer(id: string, now: number): void {
  getOrgsDb().prepare('UPDATE desktop_containers SET last_active_at=? WHERE id=?').run(now, id);
}

/**
 * A fleet job's home snapshot landed. Commits only while the job still owns
 * the computer (its runner ref). In the same transaction the object's
 * tracking row resolves: cleared when committed (it is now the home), marked
 * orphan when not; the snapshot a commit replaces is marked orphan too.
 * Orphans are deleted by the caller and, failing that, by the janitor.
 */
export function recordDesktopHomeSnapshot(args: {
  id: string;
  jobId: string;
  homeRef: string;
  now: number;
}): { committed: boolean; previous: string | null } {
  const db = getOrgsDb();
  return db.transaction(() => {
    const prev = db
      .prepare(`SELECT home_ref FROM desktop_containers WHERE id=@id AND runner_ref=@jobId`)
      .get(args) as { home_ref: string | null } | undefined;
    if (!prev) {
      markDesktopHomeObjectOrphan(args.homeRef, args.id, args.now);
      return { committed: false, previous: null };
    }
    // An accepted upload (a retry after a refusal included) ends any block.
    db.prepare(
      `UPDATE desktop_containers
          SET home_ref=@homeRef, home_blocked=NULL, home_decision=NULL, updated_at=datetime('now')
        WHERE id=@id`,
    ).run(args);
    db.prepare('DELETE FROM desktop_home_objects WHERE key=?').run(args.homeRef);
    const previous = prev.home_ref && prev.home_ref !== args.homeRef ? prev.home_ref : null;
    if (previous) markDesktopHomeObjectOrphan(previous, args.id, args.now);
    return { committed: true, previous };
  })();
}

/** Record a home object before it is written (write-ahead). */
export function recordDesktopHomeObjectWriting(key: string, computerId: string, now: number): void {
  getOrgsDb()
    .prepare(
      `INSERT INTO desktop_home_objects (key, computer_id, state, since) VALUES (?, ?, 'writing', ?)
       ON CONFLICT (key) DO UPDATE SET state='writing', since=excluded.since`,
    )
    .run(key, computerId, now);
}

export function markDesktopHomeObjectOrphan(
  key: string,
  computerId: string,
  now: number,
  error?: string,
): void {
  getOrgsDb()
    .prepare(
      `INSERT INTO desktop_home_objects (key, computer_id, state, since, last_error)
       VALUES (@key, @computerId, 'orphan', @now, @error)
       ON CONFLICT (key) DO UPDATE SET state='orphan', last_error=@error`,
    )
    .run({ key, computerId, now, error: error ?? null });
}

export function hasTrackedDesktopHomeObjects(): boolean {
  return !!getOrgsDb().prepare('SELECT 1 FROM desktop_home_objects LIMIT 1').get();
}

/** The object is confirmed deleted (or is the committed home): stop tracking it. */
export function forgetDesktopHomeObject(key: string): void {
  getOrgsDb().prepare('DELETE FROM desktop_home_objects WHERE key=?').run(key);
}

/**
 * Objects the janitor must delete: orphans, and writes that never resolved
 * (the Hub died mid-put) once older than `staleWritingBefore`. A key that is
 * some computer's committed home is never returned (and its row is dropped).
 */
export function listDesktopHomeObjectsToDelete(
  staleWritingBefore: number,
): Array<{ key: string; computerId: string }> {
  const db = getOrgsDb();
  return db.transaction(() => {
    db.prepare(
      `DELETE FROM desktop_home_objects
        WHERE key IN (SELECT home_ref FROM desktop_containers WHERE home_ref IS NOT NULL)`,
    ).run();
    return db
      .prepare(
        `SELECT key, computer_id AS computerId FROM desktop_home_objects
          WHERE state='orphan' OR (state='writing' AND since < ?)
          ORDER BY since`,
      )
      .all(staleWritingBefore) as Array<{ key: string; computerId: string }>;
  })();
}

/**
 * A run's home was refused for good. Only while `jobId` still owns the
 * computer (a stale report must not block a newer run). True when recorded.
 */
export function recordDesktopHomeBlocked(args: { jobId: string; detail: string }): boolean {
  const res = getOrgsDb()
    .prepare(
      `UPDATE desktop_containers
          SET home_blocked=@detail,
              home_decision=CASE WHEN home_decision='discard' THEN 'discard' ELSE 'hold' END,
              updated_at=datetime('now')
        WHERE runner_ref=@jobId`,
    )
    .run(args);
  return res.changes === 1;
}

/**
 * The decision for the parked runner of `jobId`. A job that no longer owns
 * any computer (deleted, or moved past) gets `discard`: its home is not
 * wanted by anyone.
 */
export function desktopHomeDecisionForJob(jobId: string): DesktopHomeDecision {
  const row = getOrgsDb()
    .prepare('SELECT home_decision FROM desktop_containers WHERE runner_ref=?')
    .get(jobId) as { home_decision: string | null } | undefined;
  if (!row) return 'discard';
  return row.home_decision === 'retry' || row.home_decision === 'discard'
    ? row.home_decision
    : 'hold';
}

export function setDesktopHomeDecision(id: string, decision: DesktopHomeDecision): void {
  getOrgsDb()
    .prepare(`UPDATE desktop_containers SET home_decision=?, updated_at=datetime('now') WHERE id=?`)
    .run(decision, id);
}

/**
 * The parked runner discarded the kept home and finished. Unless the
 * computer is being deleted anyway, this means "resume from the previous
 * snapshot", so the block ends.
 */
export function clearDesktopHomeBlock(id: string): void {
  getOrgsDb()
    .prepare(
      `UPDATE desktop_containers SET home_blocked=NULL, home_decision=NULL,
              updated_at=datetime('now') WHERE id=?`,
    )
    .run(id);
}

export function deleteDesktopComputerRecord(id: string): void {
  getOrgsDb().prepare('DELETE FROM desktop_containers WHERE id=?').run(id);
}
