/**
 * Session purge — hard-delete soft-archived sessions past the 24-hour recovery
 * window and reclaim every stale clone under `~/.agent-hub/workspaces/`.
 *
 * Two responsibilities, run together by `runWorkspacePurge` from an hourly
 * cron + once on server startup:
 *
 * 1. **Archived-session purge.** Every row with `deleted_at < now - 1 day`
 *    is removed: its worktree clone is deleted via `removeWorkspace` (which
 *    enforces the `WORKSPACES_ROOT` safety guard), then the row itself is
 *    hard-deleted. FK cascades (`ON DELETE CASCADE` on `messages`,
 *    `session_progress`, `delegations`, `handoffs`, etc.) take care of the
 *    children. This implements the contract documented at
 *    `server/routes/sessions.ts:492-499` — soft delete now, hard delete
 *    after 24 hours.
 *
 * 2. **Stale clone sweep.** For every project, walk the workspace dir and
 *    delete `cron-* / heartbeat-*` clones older than 24h, plus `session-*`
 *    dirs whose backing row is missing or already past the recovery window.
 *    The decision is delegated to `cleanupStaleWorkspaces` via an
 *    `isSessionRecoverable` callback so `worktree.ts` stays free of DB
 *    handles.
 *
 * 3. **Browser-screenshot store sweep.** Captures are written per session by
 *    `browser-screenshot-store.ts`, which caps files *within* a session but
 *    not the number of session dirs. The archived-session purge above drops a
 *    session's dir as part of its hard delete; `sweepBrowserScreenshotStore`
 *    then enforces an age + total-size bound over the whole store, which is
 *    the only collector for dirs whose row vanished by another route.
 *
 * Designed for testability: every external dependency (db handle, statement
 * map, project list, removal helper) is injectable through `PurgeDeps`. The
 * exported convenience entrypoints close over the production `db`/`stmts` /
 * `getProjects()` defaults so callers in `heartbeat.ts` stay one-liners.
 */

import { existsSync } from 'fs';
import path from 'path';
import { db as _db, stmts as _stmts } from './db.js';
import {
  removeWorkspaceAsync as defaultRemoveWorkspace,
  cleanupStaleWorkspaces as defaultCleanupStaleWorkspaces,
} from './worktree.js';
import { getProjects as defaultGetProjects } from './project-model.js';
import { pruneOrphanSessionEvents } from './session-events-store.js';
import { cleanupSpawnCredsForSession } from './spawn-creds-mint.js';
import {
  removeBrowserScreenshotsForSession,
  sweepBrowserScreenshotStore,
} from './browser-screenshot-store.js';
import config from './config.js';
import type { Project, Stmts } from './types.js';
import {
  createFirecrackerHostIo,
  resolveFirecrackerExecConfig,
} from './session-env/firecracker/firecracker-privileged-exec.js';
import {
  firecrackerHostPaths,
  forgetPersistedFirecrackerDisks,
} from './session-env/firecracker/register-firecracker-backend.js';
import { sessionVmId } from './session-env/firecracker/firecracker-vm-args.js';
import type Database from 'better-sqlite3';

/** Row shape returned by `stmts.getExpiredArchivedSessions`. */
interface ExpiredSessionRow {
  id: string;
  worktree_path: string | null;
}

export interface PurgeDeps {
  db: Database.Database;
  stmts: Stmts;
  getProjects: () => Project[];
  /**
   * Async + EACCES-resilient (see `removeWorkspaceAsync`). Tests may inject a
   * synchronous stub returning a bare `boolean` — `await` accepts both.
   */
  removeWorkspace: (workspacePath: string) => boolean | Promise<boolean>;
  cleanupStaleWorkspaces: typeof defaultCleanupStaleWorkspaces;
  /**
   * Delete persisted Firecracker workspace disks. Must succeed before the
   * session row is hard-deleted — otherwise a transient helper failure leaves
   * disks on disk with no row left to retry. Injectable for tests.
   */
  forgetPersistedFirecrackerDisks?: (sessionId: string) => Promise<void>;
}

export interface PurgeResult {
  /** How many session rows were hard-deleted (FK cascades not counted). */
  rowsDeleted: number;
  /** How many session worktree clones were removed from disk. */
  workspacesRemoved: number;
}

/**
 * Forget Firecracker disks for a hard-purged session. No-op when no VM
 * artifact exists (host/sysbox). Fail closed when an artifact exists but the
 * local helper is missing — otherwise the row would vanish and leave disks.
 * Exported for unit tests of the gating branches.
 */
export async function forgetPersistedFirecrackerDisksForPurge(sessionId: string): Promise<void> {
  const paths = firecrackerHostPaths();
  const helper = paths.diskHelper ?? '/usr/local/lib/agent-hub/fc-prepare-disks.sh';
  const vmDir = path.join(paths.runDir, sessionVmId(sessionId));
  // Host/sysbox sessions (and installs that never provisioned Firecracker)
  // leave no VM artifact. Do not invoke sudo/helper — a missing binary would
  // otherwise fail closed and strand every archived row forever.
  if (!existsSync(vmDir)) return;
  const execCfg = resolveFirecrackerExecConfig(paths);
  // Artifact present + no way to delete it must fail closed so the session
  // row stays for retry. Skipping would orphan the workspace disk on disk.
  if (execCfg.mode === 'local' && !existsSync(helper)) {
    throw new Error(
      `[Purge] Firecracker vm dir ${vmDir} exists but helper ${helper} is missing; ` +
        `refusing to delete the session row until disks can be forgotten`,
    );
  }
  await forgetPersistedFirecrackerDisks(sessionId, {
    io: createFirecrackerHostIo(execCfg),
    paths,
  });
}

function defaultDeps(): PurgeDeps {
  return {
    db: _db!,
    stmts: _stmts!,
    getProjects: defaultGetProjects,
    removeWorkspace: defaultRemoveWorkspace,
    cleanupStaleWorkspaces: defaultCleanupStaleWorkspaces,
    forgetPersistedFirecrackerDisks: forgetPersistedFirecrackerDisksForPurge,
  };
}

/**
 * Hard-delete every session whose archive window has expired. Removes the
 * worktree clone first (best-effort; safety check inside `removeWorkspace`
 * blocks paths outside `WORKSPACES_ROOT`), then deletes the row. Returns
 * counters for logging / test assertions.
 */
export async function purgeExpiredArchivedSessions(
  deps: PurgeDeps = defaultDeps(),
): Promise<PurgeResult> {
  const { stmts, removeWorkspace } = deps;

  const rows = stmts.getExpiredArchivedSessions.all() as ExpiredSessionRow[];
  let rowsDeleted = 0;
  let workspacesRemoved = 0;

  const forgetDisks =
    deps.forgetPersistedFirecrackerDisks ?? forgetPersistedFirecrackerDisksForPurge;

  for (const row of rows) {
    // Soft archive keeps the Firecracker workspace disk; hard purge must
    // delete it *before* the session row — a helper failure must leave the
    // row so the next hourly tick can retry.
    try {
      await forgetDisks(row.id);
    } catch (fcErr: unknown) {
      const fcMsg = fcErr instanceof Error ? fcErr.message : String(fcErr);
      console.error(
        `[Purge] forgetPersistedFirecrackerDisks(${row.id}) failed; leaving row for retry:`,
        fcMsg,
      );
      continue;
    }

    if (row.worktree_path) {
      try {
        // `removeWorkspace` returns `true` only when something was actually
        // unlinked — paths missing on disk, paths outside `WORKSPACES_ROOT`,
        // and removal failures all return `false`, so the counter is an
        // honest "files unlinked" rather than the previous "attempts made".
        if (await removeWorkspace(row.worktree_path)) {
          workspacesRemoved++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Purge] removeWorkspace(${row.worktree_path}) threw:`, message);
      }
    }

    try {
      stmts.deleteSession.run(row.id);
      rowsDeleted++;
      cleanupSpawnCredsForSession(row.id, config.dataDir);
      removeBrowserScreenshotsForSession(row.id, config.dataDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Purge] deleteSession(${row.id}) failed:`, message);
    }
  }

  if (rows.length > 0) {
    console.log(
      `[Purge] Hard-deleted ${rowsDeleted}/${rows.length} expired archived session(s); ${workspacesRemoved} worktree clone(s) removed.`,
    );
  }

  return { rowsDeleted, workspacesRemoved };
}

/**
 * Walk every project's workspace dir and prune stale clones. The session
 * recoverability decision is answered by a prefix lookup against the live
 * sessions table — the lookup runs once per `session-*` directory inside
 * `cleanupStaleWorkspaces`, so a project with thousands of dirs costs at
 * most thousands of indexed prefix queries (cheap on the 8-char id slice).
 */
export async function cleanupAllProjectWorkspaces(deps: PurgeDeps = defaultDeps()): Promise<void> {
  const { stmts, getProjects, cleanupStaleWorkspaces } = deps;

  // Aggregate recoverability lookup failures across the entire tick so a
  // transient DB blip doesn't spam thousands of identical `console.warn`
  // lines (one per `session-*` entry across every project). We hold onto
  // the first error message as a representative sample and drop the rest.
  let lookupFailures = 0;
  let firstLookupFailureMessage: string | null = null;

  const isSessionRecoverable = (idPrefix: string): boolean => {
    // Reject prefixes that don't look like the 8-char hex slice we
    // generate, so a hand-created `session-foo` directory in the
    // workspace root doesn't accidentally match a real id via SQL LIKE.
    if (!/^[0-9a-f]{8}$/i.test(idPrefix)) return false;
    try {
      const row = stmts.getRecoverableSessionByIdPrefix.get(idPrefix) as { 1: number } | undefined;
      return row !== undefined;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Fail closed (preserve the dir) on lookup error — better to leak a
      // worktree than to nuke a session whose row we couldn't read. Defer
      // the actual log line to the post-loop summary below.
      lookupFailures++;
      if (firstLookupFailureMessage === null) firstLookupFailureMessage = message;
      return true;
    }
  };

  for (const project of getProjects()) {
    if (!project.cwd) continue;
    try {
      await cleanupStaleWorkspaces(project.cwd, 24 * 60 * 60 * 1000, { isSessionRecoverable });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Purge] cleanupStaleWorkspaces(${project.cwd}) threw:`, message);
    }
  }

  if (lookupFailures > 0) {
    console.warn(
      `[Purge] Recoverability lookup failed ${lookupFailures}x this tick (preserved on error). First error: ${firstLookupFailureMessage}`,
    );
  }
}

/**
 * Sweep `session_events` rows whose parent message/heartbeat/cron row
 * is gone. Runs after the archived-session purge (which cascades into
 * `messages`) so freshly-orphaned events from this tick are caught the
 * same day. See `session-events-store.ts` for the rationale and SQL.
 */
export function pruneOrphanedSessionEvents(deps: PurgeDeps = defaultDeps()): void {
  try {
    const result = pruneOrphanSessionEvents(deps.db);
    if (result.totalDeleted > 0) {
      console.log(
        `[Purge] Swept ${result.totalDeleted} orphan session_event row(s) ` +
          `(message=${result.messageOrphans}, heartbeat=${result.heartbeatOrphans}, cron=${result.cronOrphans}).`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Purge] Orphan session_events sweep threw:', message);
  }
}

/**
 * Combined daily tick — purge expired archived sessions, then sweep stale
 * clones, then sweep orphan `session_events`. Call from `scheduleAll`
 * (daily cron) and once at server startup. Wrapped in a top-level try
 * so a SQLite/FS hiccup never poisons the scheduler.
 */
export async function runWorkspacePurge(deps: PurgeDeps = defaultDeps()): Promise<PurgeResult> {
  let result: PurgeResult = { rowsDeleted: 0, workspacesRemoved: 0 };
  try {
    result = await purgeExpiredArchivedSessions(deps);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Purge] Archived-session purge threw:', message);
  }
  try {
    await cleanupAllProjectWorkspaces(deps);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Purge] Stale-clone sweep threw:', message);
  }
  // Run orphan sweep after archived-session purge so any rows freshly
  // orphaned by the cascade in this same tick are reclaimed today.
  pruneOrphanedSessionEvents(deps);
  // Backstop for browser/preview captures. The per-session removal above is
  // the normal path; this catches dirs whose session row vanished without it
  // and enforces the absolute size ceiling.
  try {
    sweepBrowserScreenshotStore({ dataDir: config.dataDir });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Purge] Browser-screenshot sweep threw:', message);
  }
  return result;
}
