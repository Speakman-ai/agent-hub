/**
 * Hub-owned reaping of the docker-compose stacks previews leave on the daemon.
 *
 * A dev server whose start/build command is `docker compose up` creates
 * containers, networks, and named volumes that are children of the Docker
 * daemon, not of the tracked process. Stopping the process (or the session
 * env it ran in) leaves all of them behind. Until now the only teardown was
 * the project's optional `devServer.stopCommand`, which (a) most projects do
 * not set and (b) is skipped when the session env is already gone. The
 * observed result on a shared host: dead sessions' `frontend` containers kept
 * squatting the host port the Hub had already returned to its pool ("Bind for
 * 0.0.0.0:4100 failed: port is already allocated"), and their postgres
 * volumes — a full DB copy each — filled the root disk.
 *
 * The Hub therefore owns the compose project name. It injects
 * `COMPOSE_PROJECT_NAME=session-<id8>` into every dev-server spawn (build,
 * start, stopCommand) unless the project config sets its own, and reaps by
 * the `com.docker.compose.project` label that compose stamps on everything it
 * creates:
 *
 *   - **group stop / rollback** → containers + networks (frees the port;
 *     keeps the named volumes so a restart reuses e.g. a restored database).
 *   - **session archive / delete** → containers + networks + volumes.
 *   - **boot + periodic sweep** → every `session-<id8>` stack whose session is
 *     archived or no longer exists, volumes included.
 *
 * Only Hub-shaped names (`session-<8 hex>`) are ever reaped. A project that
 * sets its own `COMPOSE_PROJECT_NAME` (typically a static name shared by every
 * session) opts out — reaping a shared name from one session would tear down
 * another session's stack — and must clean up via `stopCommand`.
 *
 * Every docker call is best-effort and injectable; nothing here throws.
 */

import type { Database } from 'better-sqlite3';
import type { SysboxRunFn } from '../session-env/sysbox-session-env.js';

/** Label compose stamps on every container / network / volume it creates. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/**
 * Hub-owned compose project names: `session-<8 hex>`. Matches the session
 * worktree directory basename (`server/worktree.ts`), which is also what
 * compose derives when no `COMPOSE_PROJECT_NAME` is set and the start
 * command runs at the worktree root — so injecting it is a no-op for the
 * common case and a fix (per-session isolation) when `devServer.cwd` is set.
 */
const HUB_COMPOSE_PROJECT_RE = /^session-([0-9a-f]{8})$/;

/** The compose project name the Hub assigns to `sessionId`'s preview stack. */
export function composeProjectNameForSession(sessionId: string): string {
  return `session-${sessionId.slice(0, 8)}`;
}

/**
 * The 8-hex session-id prefix embedded in a Hub-shaped compose project name,
 * or null when the name is not Hub-shaped (and therefore never reapable).
 */
export function hubComposeProjectSessionPrefix(projectName: string): string | null {
  const match = HUB_COMPOSE_PROJECT_RE.exec(projectName);
  return match ? match[1] : null;
}

export interface ComposeStackReapResult {
  projectName: string;
  containersRemoved: number;
  networksRemoved: number;
  volumesRemoved: number;
  errors: string[];
}

export interface ReapComposeStackOpts {
  run: SysboxRunFn;
  projectName: string;
  /**
   * Also remove the stack's named volumes. False on a plain group stop so a
   * restart can reuse them (a restored database is expensive); true on
   * session archive / delete and in the orphan sweep.
   */
  removeVolumes: boolean;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

function parseLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function labelFilter(projectName: string): string {
  return `label=${COMPOSE_PROJECT_LABEL}=${projectName}`;
}

/**
 * Remove everything the daemon holds for one Hub-owned compose project.
 * Order matters: containers first (a network / volume in use cannot be
 * removed), then networks, then volumes.
 */
export async function reapComposeStack(
  opts: ReapComposeStackOpts,
): Promise<ComposeStackReapResult> {
  const result: ComposeStackReapResult = {
    projectName: opts.projectName,
    containersRemoved: 0,
    networksRemoved: 0,
    volumesRemoved: 0,
    errors: [],
  };
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;

  // Safety rail: a non-Hub name (e.g. `backend`) may be shared by every
  // session of a project, so reaping it from one would take down another's.
  if (hubComposeProjectSessionPrefix(opts.projectName) === null) {
    result.errors.push(
      `refusing to reap compose project "${opts.projectName}": not a Hub-owned session-<id> name`,
    );
    warn(`[compose-reaper] ${result.errors[0]}`);
    return result;
  }

  const filter = labelFilter(opts.projectName);

  const containers = await opts.run(['docker', 'ps', '-aq', '--filter', filter]);
  if (!containers.ok) {
    result.errors.push(`list containers failed: ${containers.stderr.trim()}`);
  } else {
    for (const id of parseLines(containers.stdout)) {
      // `-v` drops the container's anonymous volumes only; named volumes are
      // handled below, gated on `removeVolumes`.
      const rm = await opts.run(['docker', 'rm', '-f', '-v', id]);
      if (rm.ok) result.containersRemoved += 1;
      else result.errors.push(`rm container ${id} failed: ${rm.stderr.trim()}`);
    }
  }

  const networks = await opts.run(['docker', 'network', 'ls', '-q', '--filter', filter]);
  if (!networks.ok) {
    result.errors.push(`list networks failed: ${networks.stderr.trim()}`);
  } else {
    for (const id of parseLines(networks.stdout)) {
      const rm = await opts.run(['docker', 'network', 'rm', id]);
      if (rm.ok) result.networksRemoved += 1;
      else result.errors.push(`rm network ${id} failed: ${rm.stderr.trim()}`);
    }
  }

  if (opts.removeVolumes) {
    const volumes = await opts.run(['docker', 'volume', 'ls', '-q', '--filter', filter]);
    if (!volumes.ok) {
      result.errors.push(`list volumes failed: ${volumes.stderr.trim()}`);
    } else {
      for (const name of parseLines(volumes.stdout)) {
        // No `-f`: an in-use volume must reject — that means a container we
        // did not list (or could not remove) still owns it.
        const rm = await opts.run(['docker', 'volume', 'rm', name]);
        if (rm.ok) result.volumesRemoved += 1;
        else result.errors.push(`rm volume ${name} failed: ${rm.stderr.trim()}`);
      }
    }
  }

  if (result.containersRemoved || result.networksRemoved || result.volumesRemoved) {
    log(
      `[compose-reaper] ${opts.projectName}: removed ${result.containersRemoved} container(s), ` +
        `${result.networksRemoved} network(s), ${result.volumesRemoved} volume(s)`,
    );
  }
  for (const err of result.errors) warn(`[compose-reaper] ${opts.projectName}: ${err}`);
  return result;
}

export interface SweepOrphanedComposeStacksOpts {
  run: SysboxRunFn;
  /**
   * True when a session whose id starts with `prefix` is still live (not
   * archived / soft-deleted). A live session's stack is never touched, even
   * when its preview group is stopped — it may restart and reuse the volumes.
   */
  isSessionLive: (prefix: string) => boolean;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface SweepOrphanedComposeStacksResult {
  reaped: ComposeStackReapResult[];
  /** Hub-shaped projects left alone because their session is still live. */
  skippedLive: number;
  errors: string[];
}

const LABEL_FORMAT = `{{.Label "${COMPOSE_PROJECT_LABEL}"}}`;

/**
 * Find every Hub-shaped compose project the daemon still holds anything
 * for — containers, networks, or volumes, since a partially torn-down stack
 * can leave any one of them alone — and reap the ones whose session is gone.
 */
export async function sweepOrphanedComposeStacks(
  opts: SweepOrphanedComposeStacksOpts,
): Promise<SweepOrphanedComposeStacksResult> {
  const result: SweepOrphanedComposeStacksResult = { reaped: [], skippedLive: 0, errors: [] };
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  const anyLabel = `label=${COMPOSE_PROJECT_LABEL}`;

  const lists: Array<{ kind: string; argv: string[] }> = [
    {
      kind: 'containers',
      argv: ['docker', 'ps', '-a', '--filter', anyLabel, '--format', LABEL_FORMAT],
    },
    {
      kind: 'networks',
      argv: ['docker', 'network', 'ls', '--filter', anyLabel, '--format', LABEL_FORMAT],
    },
    {
      kind: 'volumes',
      argv: ['docker', 'volume', 'ls', '--filter', anyLabel, '--format', LABEL_FORMAT],
    },
  ];
  const projects = new Set<string>();
  for (const { kind, argv } of lists) {
    const out = await opts.run(argv);
    if (!out.ok) {
      result.errors.push(`list ${kind} failed: ${out.stderr.trim()}`);
      continue;
    }
    for (const name of parseLines(out.stdout)) {
      if (hubComposeProjectSessionPrefix(name) !== null) projects.add(name);
    }
  }

  for (const projectName of [...projects].sort()) {
    const prefix = hubComposeProjectSessionPrefix(projectName);
    if (prefix === null) continue;
    if (opts.isSessionLive(prefix)) {
      result.skippedLive += 1;
      continue;
    }
    const reaped = await reapComposeStack({
      run: opts.run,
      projectName,
      removeVolumes: true,
      log,
      warn,
    });
    result.reaped.push(reaped);
  }

  if (result.reaped.length > 0) {
    log(
      `[compose-reaper] sweep: reaped ${result.reaped.length} orphaned stack(s) ` +
        `(${result.reaped.map((r) => r.projectName).join(', ')}); ${result.skippedLive} live skipped`,
    );
  }
  for (const err of result.errors) warn(`[compose-reaper] sweep: ${err}`);
  return result;
}

/**
 * `isSessionLive` backed by the `sessions` table: live means a row with that
 * id prefix exists and is not soft-deleted (archive == `deleted_at` set). A
 * prefix with no row at all (hard-purged session) is not live. Conservative on
 * prefix collisions: any live match keeps the stack.
 */
export function makeSessionLivenessCheck(db: Database): (prefix: string) => boolean {
  const stmt = db.prepare(`SELECT 1 FROM sessions WHERE id LIKE ? AND deleted_at IS NULL LIMIT 1`);
  return (prefix) => {
    // Only hex prefixes reach here (HUB_COMPOSE_PROJECT_RE), so `%` / `_`
    // wildcards cannot be injected into the LIKE pattern.
    return stmt.get(`${prefix}%`) !== undefined;
  };
}
