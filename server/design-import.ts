/**
 * Design Studio → design-mode session importer.
 *
 * Background: Design Studio is being folded into the normal session flow as a
 * first-class `session_mode = 'design'` (see the architecture spec
 * `design-mode-fold-into-session-mode-picker`). Standalone `designs` rows must
 * be migrated into real sessions so the standalone module can be retired
 * without losing user work.
 *
 * Per design this importer:
 *   1. creates a `design`-mode session for a target agent (one whose project
 *      has a git worktree — design mode writes artifacts under the worktree
 *      `design/` dir and must never fall back to the shared project checkout),
 *   2. provisions that session's worktree,
 *   3. copies the design's artifact dir into `<worktree>/design/`,
 *   4. replays `design_messages` as session messages (timestamps preserved),
 *   5. records `designs.imported_session_id` so the standalone routes redirect
 *      and the design becomes read-only.
 *
 * It is **non-destructive**: designs and their messages/files are left intact
 * for one release before the tables are dropped (card: removal, gated on
 * production parity). Re-running on an already-imported design is a no-op.
 *
 * The mapping logic (target-agent resolution, session naming, message mapping,
 * skip detection) is split into pure functions so it unit-tests without a DB,
 * a filesystem, or worktree provisioning. The executor at the bottom wires them
 * to the real stores.
 */
import { cpSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { DESIGN_MODE_SUBDIR } from './design-mode-prompt.js';
import { designDir } from './designs-store.js';
import type { DesignMessageRow, DesignWithProjects, SessionRow, Stmts } from './types.js';

/** A session message produced from a design message, ready to persist. */
export interface ImportedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Preserved from the source design message so transcript order survives. */
  created_at: string;
}

/** Successful import plan for a single design. */
export interface DesignImportPlan {
  targetAgentId: string;
  sessionName: string;
  /** Always `design` — the whole point of the migration. */
  sessionMode: 'design';
  messages: ImportedMessage[];
}

/** Reasons a design cannot / need not be imported. */
export type DesignImportSkip =
  | { skip: 'already-imported'; sessionId: string }
  | { skip: 'no-target-agent' };

export type DesignImportPlanResult = DesignImportPlan | DesignImportSkip;

/** Narrowing helper so callers can branch on plan vs. skip. */
export function isDesignImportSkip(result: DesignImportPlanResult): result is DesignImportSkip {
  return 'skip' in result;
}

const VALID_ROLES = new Set<ImportedMessage['role']>(['user', 'assistant', 'system']);
const MAX_SESSION_NAME = 100;

/**
 * Session name for an imported design. Prefixed so it reads as a migrated
 * design in the session list, and truncated to the session-name column budget.
 */
export function designSessionName(designName: string): string {
  const base = (designName || '').trim() || 'Untitled design';
  return `[Design] ${base}`.slice(0, MAX_SESSION_NAME);
}

/**
 * Map `design_messages` rows to importable session messages, preserving order
 * and timestamps. Unknown roles and empty content are dropped (the standalone
 * studio only ever wrote user/assistant/system, but defend against drift).
 */
export function mapDesignMessages(rows: DesignMessageRow[]): ImportedMessage[] {
  const out: ImportedMessage[] = [];
  for (const row of rows) {
    const role = row.role as ImportedMessage['role'];
    if (!VALID_ROLES.has(role)) continue;
    if (typeof row.content !== 'string' || row.content.length === 0) continue;
    out.push({ role, content: row.content, created_at: row.created_at });
  }
  return out;
}

/** Minimal agent shape the importer needs to pick a migration target. */
export interface ImportCandidateAgent {
  id: string;
  projectId: string;
  engine?: string | null;
  /** Reviewer/intake/etc. agents are skipped as import targets. */
  role?: string | null;
}

/**
 * Choose the agent that should own the imported session.
 *
 * A design links to N projects. Design mode needs a worktree, which means a
 * real project repo, so we only consider agents in one of the design's linked
 * projects. Preference order:
 *   1. an agent in a linked project whose engine matches the design's engine,
 *   2. otherwise the first agent in the first linked project (in input order).
 *
 * Reviewer agents are never chosen (their sessions are webhook-only). Returns
 * null when the design links to no project that has a usable agent — the
 * executor surfaces this as a `no-target-agent` skip rather than guessing a
 * project, because writing design artifacts into an unrelated repo's worktree
 * would be wrong.
 */
export function resolveImportTargetAgentId(
  linkedProjectIds: string[],
  agents: ImportCandidateAgent[],
  preferredEngine?: string | null,
): string | null {
  if (!linkedProjectIds.length) return null;
  const linked = new Set(linkedProjectIds);
  const eligible = agents.filter((a) => linked.has(a.projectId) && a.role !== 'reviewer');
  if (!eligible.length) return null;

  if (preferredEngine && preferredEngine.trim()) {
    const wanted = preferredEngine.trim();
    const engineMatch = eligible.find((a) => (a.engine || '').trim() === wanted);
    if (engineMatch) return engineMatch.id;
  }

  // Fall back to the first agent of the first linked project (project order is
  // the design's link order, which the caller passes through verbatim).
  for (const projectId of linkedProjectIds) {
    const inProject = eligible.find((a) => a.projectId === projectId);
    if (inProject) return inProject.id;
  }
  return null;
}

/**
 * Pure plan for importing a single design. No DB / FS access — the executor
 * resolves `targetAgentId` and message rows and passes them in.
 */
export function planDesignImport(
  design: Pick<DesignWithProjects, 'id' | 'name' | 'imported_session_id'>,
  messages: DesignMessageRow[],
  opts: { targetAgentId: string | null },
): DesignImportPlanResult {
  if (design.imported_session_id) {
    return { skip: 'already-imported', sessionId: design.imported_session_id };
  }
  if (!opts.targetAgentId) {
    return { skip: 'no-target-agent' };
  }
  return {
    targetAgentId: opts.targetAgentId,
    sessionName: designSessionName(design.name),
    sessionMode: 'design',
    messages: mapDesignMessages(messages),
  };
}

/**
 * Copy a design's artifact directory into a session worktree's `design/` dir.
 * Idempotent-ish: existing files in the destination are overwritten. Symlinks
 * are not dereferenced (cpSync copies them as links), matching the no-follow
 * posture of the static mounts. A missing source dir is a no-op (a design that
 * never produced a file still imports cleanly, just with an empty canvas).
 */
export function copyDesignArtifacts(
  designsRoot: string,
  designId: string,
  worktreePath: string,
  subdir: string = DESIGN_MODE_SUBDIR,
): void {
  const src = designDir(designsRoot, designId);
  if (!existsSync(src)) return;
  const dest = path.join(path.resolve(worktreePath), subdir);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

// ─── Executor ────────────────────────────────────────────────────

/** Outcome of a single design import. */
export interface DesignImportResult {
  designId: string;
  /** The design-mode session the design now lives in (existing or new). */
  sessionId: string;
  agentId: string;
  /** Number of design messages replayed into the session. */
  importedMessages: number;
  /** Set when the import was a no-op; absent on a fresh import. */
  skipped?: DesignImportSkip['skip'];
}

/** Collaborators the executor needs; injected so it tests without a server boot. */
export interface DesignImportDeps {
  stmts: Stmts;
  getDesignsRoot: () => string;
  /** Clone/attach the session worktree; returns its absolute path. */
  provisionSessionWorkspace: (sessionId: string) => Promise<string>;
  /** Resolve the engine + model to stamp on the new session for an agent. */
  resolveEngineModel: (agentId: string) => { engine: string; model: string };
  /** Persist session ownership (NULL for system/migration runs). */
  setSessionOwner: (sessionId: string, ownerUserId: string | null) => void;
  ownerUserId?: string | null;
  /** Candidate agents to pick a migration target from. */
  agents: () => ImportCandidateAgent[];
  broadcast: (event: Record<string, unknown>) => void;
}

/**
 * Build an `already-imported` result for the session a design already maps to,
 * or null when that session no longer exists (stale pointer) / is absent.
 */
function alreadyImportedResult(
  deps: DesignImportDeps,
  designId: string,
  sessionId: string | null | undefined,
): DesignImportResult | null {
  if (!sessionId) return null;
  const existing = deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!existing) return null;
  return {
    designId,
    sessionId: existing.id,
    agentId: existing.agent_id,
    importedMessages: 0,
    skipped: 'already-imported',
  };
}

/**
 * SQLite datetime modifier after which an `import_lock` is considered stale and
 * may be reclaimed (a crashed import shouldn't wedge a design forever). Five
 * minutes comfortably exceeds a real worktree-clone + copy + replay.
 */
const IMPORT_LOCK_STALE_MODIFIER = '-300 seconds';

/**
 * Import one design into a fresh `design`-mode session.
 *
 * Idempotent and concurrency-safe via a two-state lock that keeps
 * `imported_session_id` meaning "fully committed import" at all times:
 *
 * - `imported_session_id` is published ONLY after the worktree, artifacts, and
 *   transcript have all landed (`completeDesignImport`).
 * - while an import runs, the in-progress session id lives in `import_lock`
 *   instead — so a concurrent caller never mistakes an in-flight (or
 *   about-to-be-rolled-back) session for a completed import.
 *
 * Outcomes for a concurrent caller that does not win the lock:
 * - the winner already finished → returns the winner's session
 *   (`already-imported`);
 * - the winner is still working → throws {@link DesignImportInProgressError}
 *   (HTTP 409, retryable) rather than returning a half-built session.
 *
 * A slow importer whose lock is reclaimed mid-flight (after the stale window)
 * detects the lost ownership at commit time (`completeDesignImport` updates zero
 * rows), discards its now-orphan session, and returns the reclaiming importer's
 * completed session (or throws in-progress if that one hasn't committed yet) —
 * so it never publishes a duplicate or hands back the wrong redirect target.
 *
 * A *stale* `imported_session_id` (its session was deleted) is cleared first so
 * the design re-imports. If any step throws after the lock is held, the partial
 * session is deleted (cascading its messages) and the lock released, so a retry
 * starts clean. Throws {@link DesignImportError} when no eligible target agent
 * exists (before any lock or write).
 */
export async function importDesignToSession(
  deps: DesignImportDeps,
  design: DesignWithProjects,
  messages: DesignMessageRow[],
): Promise<DesignImportResult> {
  const observedSessionId = design.imported_session_id ?? null;

  // Fast path: a completed import whose session still exists wins outright.
  const fastPath = alreadyImportedResult(deps, design.id, observedSessionId);
  if (fastPath) return fastPath;

  // A non-null but dangling `imported_session_id` is stale (session deleted).
  // Clear it (CAS on the observed value) so the lock acquire below — which
  // requires `imported_session_id IS NULL` — can proceed. If a concurrent
  // importer already swapped in a fresh id this no-ops and we fall through to
  // the lock contention handling.
  if (observedSessionId) {
    deps.stmts.clearStaleImportedSession.run(design.id, observedSessionId);
  }

  // Resolve the target agent and build the plan BEFORE locking, so a
  // no-target-agent design fails without ever touching the row. Ignore the
  // observed `imported_session_id`: a stale pointer must NOT short-circuit
  // planDesignImport to `already-imported` (the recovery path re-imports).
  const linkedProjectIds = (design.linkedProjects ?? []).map((p) => p.id);
  const targetAgentId = resolveImportTargetAgentId(
    linkedProjectIds,
    deps.agents(),
    design.agent_engine,
  );
  const plan = planDesignImport({ ...design, imported_session_id: null }, messages, {
    targetAgentId,
  });
  if (isDesignImportSkip(plan)) {
    throw new DesignImportError(plan.skip, design.id);
  }

  const sessionId = uuidv4();

  // Acquire the import lock. Succeeds only if the design isn't already imported
  // and no live lock is held (a stale lock is reclaimable). This serializes
  // concurrent imports — exactly one caller proceeds per design.
  const lock = deps.stmts.acquireDesignImportLock.run(
    sessionId,
    design.id,
    IMPORT_LOCK_STALE_MODIFIER,
  );
  if (lock.changes !== 1) {
    // Did not get the lock. Either the winner already finished (return its
    // completed session) or it's still importing (tell the caller to retry).
    const current = deps.stmts.getDesign.get(design.id) as
      | { imported_session_id: string | null }
      | undefined;
    const winnerResult = alreadyImportedResult(deps, design.id, current?.imported_session_id);
    if (winnerResult) return winnerResult;
    throw new DesignImportInProgressError(design.id);
  }

  // Lock held. `imported_session_id` is still NULL; `import_lock` carries our
  // sessionId. Everything below must clean up on failure so we never strand an
  // orphan session or leave the design locked.
  let committed: { changes: number } = { changes: 0 };
  try {
    const { engine, model } = deps.resolveEngineModel(plan.targetAgentId);
    // worktree=1, ask_mode=0, wiki budget version=1 (matches createSession arity).
    deps.stmts.createSession.run(
      sessionId,
      plan.targetAgentId,
      plan.sessionName,
      engine,
      model,
      1,
      0,
      1,
    );
    deps.stmts.updateSessionMode.run(plan.sessionMode, sessionId);
    deps.setSessionOwner(sessionId, deps.ownerUserId ?? null);

    // Provision the worktree before copying artifacts into it.
    const worktreePath = await deps.provisionSessionWorkspace(sessionId);
    copyDesignArtifacts(deps.getDesignsRoot(), design.id, worktreePath);

    // Replay the transcript with original timestamps so ordering is preserved.
    for (const msg of plan.messages) {
      deps.stmts.addMessageWithCreatedAt.run(
        uuidv4(),
        sessionId,
        msg.role,
        msg.content,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        msg.created_at,
      );
    }

    // Commit: publish the completed import and drop the lock atomically — but
    // only if we STILL hold the lock (`completeDesignImport` is scoped to
    // `import_lock = our sessionId`). `changes` is captured for the
    // lost-ownership check below.
    committed = deps.stmts.completeDesignImport.run(sessionId, design.id, sessionId);
  } catch (err) {
    // Compensate: drop the partial session (cascades messages) and release our
    // lock, so a retry re-imports cleanly. `imported_session_id` was never set,
    // so no dangling completed-import pointer is left behind.
    try {
      deps.stmts.deleteSession.run(sessionId);
    } catch {
      /* best-effort cleanup */
    }
    try {
      deps.stmts.releaseDesignImportLock.run(design.id, sessionId);
    } catch {
      /* best-effort lock release */
    }
    throw err;
  }

  if (committed.changes !== 1) {
    // Lost ownership: our lock was reclaimed as stale (>5 min) and another
    // importer now owns the design. Our session was never published, so it's an
    // orphan — drop it (cascading messages) rather than broadcasting/returning
    // a session that `imported_session_id` doesn't point at. Do NOT release the
    // lock here: we no longer hold it (releaseDesignImportLock is scoped to our
    // sessionId and would no-op anyway).
    try {
      deps.stmts.deleteSession.run(sessionId);
    } catch {
      /* best-effort cleanup */
    }
    const current = deps.stmts.getDesign.get(design.id) as
      | { imported_session_id: string | null }
      | undefined;
    const winner = alreadyImportedResult(deps, design.id, current?.imported_session_id);
    if (winner) return winner;
    // The reclaiming importer hasn't committed yet — tell the caller to retry.
    throw new DesignImportInProgressError(design.id);
  }

  const session = deps.stmts.getSession.get(sessionId) as SessionRow;
  deps.broadcast({ type: 'session_created', agentId: plan.targetAgentId, session });
  deps.broadcast({ type: 'design_imported', designId: design.id, sessionId });

  return {
    designId: design.id,
    sessionId,
    agentId: plan.targetAgentId,
    importedMessages: plan.messages.length,
  };
}

/** Thrown when a design cannot be imported (no eligible target agent). */
export class DesignImportError extends Error {
  constructor(
    public readonly reason: DesignImportSkip['skip'],
    public readonly designId: string,
  ) {
    super(`Cannot import design ${designId}: ${reason}`);
    this.name = 'DesignImportError';
  }
}

/**
 * Thrown when another import for the same design is already in flight. The
 * caller should retry shortly; it is transient, not a permanent failure. Maps
 * to HTTP 409 `import_in_progress`.
 */
export class DesignImportInProgressError extends Error {
  constructor(public readonly designId: string) {
    super(`An import for design ${designId} is already in progress`);
    this.name = 'DesignImportInProgressError';
  }
}
