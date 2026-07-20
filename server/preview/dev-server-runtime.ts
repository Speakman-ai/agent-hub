/**
 * DevServerRuntime — managed dev-server process lifecycle.
 *
 * Runs the project as one long-lived process started from
 * `prEnv.devServer.startCommand` inside the session's `SessionEnv`,
 * replacing the compose app-wrapping model. The Hub owns
 * start/stop/restart, streams stdout/stderr into an in-memory tail (and
 * the optional `notifyLog` fan-out), injects the configured env plus
 * resolved secret references at spawn, and reaps on idle TTL /
 * session-end.
 *
 * Surface mirrors the existing preview runtimes (`start` / `stop` /
 * `restart` / `getActiveBySessionId` / `stopBySessionId` / `touch` /
 * `reap`) so call-sites — chat handler, session archive/delete hooks,
 * reaper cron — don't fork per runtime.
 *
 * Persistence reuses the `worktree_preview_*` tables:
 *   - one `worktree_preview_groups` row per active dev server, marked
 *     `runtime = 'dev-server'` so the legacy PreviewRuntime's teardown
 *     paths skip it (the compose runtime already skips rows with a NULL
 *     `compose_project_name`);
 *   - one `worktree_preview_processes` row per portMap entry, all
 *     carrying the REAL pid of the single spawned process (pid-less
 *     rows are a compose-only artifact). `port` stores the host port
 *     the preview proxy dials; `internal_port` / `is_primary` are the
 *     dev-server companion columns.
 *
 * Isolation: all process + port work goes through the `SessionEnv`
 * abstraction. The default factory reads the boot-selected adapter
 * (host fallback or registered sysbox) when each session starts.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { Project } from '../types.js';
import {
  parseDevServerConfig,
  type DevServerConfig,
  type DevServerPortMapEntry,
} from '../dev-server-config.js';
import { applyPreviewDevInstallDefaults } from './preview-dev-install-env.js';
import type { SessionEnv, SessionEnvExit, SessionEnvProcess } from '../session-env/session-env.js';
import { createSessionEnv } from '../session-env/select-session-env.js';
import { getSessionEnvSelection } from '../session-env/sysbox-capability.js';
import {
  DEFAULT_PREVIEW_PORT_RANGE,
  ensureDevServerPreviewColumns,
  WORKTREE_PREVIEWS_SCHEMA,
  WORKTREE_PREVIEW_GROUPS_SCHEMA,
} from './preview-schema.js';
import { reclaimFailedPortHolder, reclaimFailedPortsInRange } from './preview-port-reclaim.js';
import { parseDbTime } from './preview-reaper.js';
import type { Clock, HealthFetchFn, PortRange } from './preview-runtime.js';
import { systemClock } from './preview-runtime.js';
import { appendPreviewLogTailLine, DEFAULT_PREVIEW_LOG_TAIL_LINES } from './preview-log-tail.js';
import type { PreviewPortEntry } from './preview-runtime-lookup.js';

// ─── Types & contracts ──────────────────────────────────────────────────

/** `worktree_preview_groups.runtime` value for rows this runtime owns. */
export const DEV_SERVER_RUNTIME_KIND = 'dev-server';

export type DevServerStatus = 'starting' | 'ready' | 'failed';

export interface DevServerRow {
  id: string;
  session_id: string;
  project_id: string;
  status: DevServerStatus;
  /** Real pid of the spawned process (null only if the spawn errored). */
  pid: number | null;
  /** Host port of the primary portMap entry — the proxy upstream. */
  port: number;
  url: string;
  started_at: string;
  last_active_at: string;
}

export interface DevServerPortRow {
  name: string;
  internalPort: number;
  hostPort: number;
  primary: boolean;
  url: string;
}

export interface StartDevServerResult {
  devServerId: string;
  url: string;
  port: number;
}

export interface DevServerReapResult {
  scanned: number;
  reaped: number;
  orphaned: number;
  notes: string[];
}

export type DevServerNotifyLogFn = (info: {
  sessionId: string;
  groupId: string;
  processName: string;
  line: string;
  stream: 'stdout' | 'stderr';
}) => void;

export type DevServerNotifyStatusFn = (info: {
  sessionId: string;
  groupId: string;
  status: 'ready' | 'failed';
  port: number;
  url: string;
  logTail: string[];
  error?: string;
  /**
   * Client-facing port entries (primary first). Present on `ready` for a
   * multi-port dev server so the preview pane can render a port selector;
   * omitted on `failed` (nothing to browse).
   */
  ports?: PreviewPortEntry[];
}) => void;

/**
 * Factory seam for the per-start SessionEnv. The runtime hands its
 * DB-backed port allocator to the env so `mapPort` resolves through the
 * shared 4100–4999 pool. Tests inject an env built on fakes; production
 * defaults to the adapter selected by the boot-time capability probe.
 */
export type CreateDevServerEnvFn = (opts: {
  sessionId: string;
  worktreePath: string;
  allocateHostPort: (internalPort: number) => number;
}) => SessionEnv;

export interface DevServerRuntimeConfig {
  /** Host-port pool for primary ports. Default 4100–4999. */
  portRange?: PortRange;
  /** Max ms to wait for the health probe before flipping to failed. */
  readyTimeoutMs?: number;
  /** Cadence of the health-probe loop. Default 1000. */
  healthIntervalMs?: number;
  /** Max lines retained in the in-memory log tail. Default 4000. */
  logTailLines?: number;
  /** Client-facing URL stem. Default `http://localhost:<port>`. */
  urlBase?: (port: number, sessionId: string) => string;
  /**
   * Client-facing proxy URL for a single port entry — the resolved URL
   * persisted on each process row and surfaced by `getPorts`. Lets the
   * primary keep the back-compat proxy mount while extra ports resolve to
   * their `/p/<internalPort>` sub-mount. Default: `urlBase(hostPort,
   * sessionId)` for every entry (back-compat; prod injects a
   * publicUrl-aware resolver).
   */
  portClientUrl?: (args: {
    sessionId: string;
    hostPort: number;
    internalPort: number;
    primary: boolean;
  }) => string;
  /** Host the Hub itself dials for health probes. Default loopback. */
  healthUrlBase?: (port: number) => string;
  /** SIGTERM → SIGKILL grace on teardown. Default 5000. */
  disposeGraceMs?: number;
  /** Fallback idle TTL for `reap` when the project sets none. Default 4 h. */
  defaultIdleTtlSeconds?: number;
  /** Bound on waiting for a wedged prior start of the same session. */
  sessionLockTimeoutMs?: number;
}

export interface DevServerRuntimeDeps {
  db: Database;
  /** {ok,status} health probe; throws are treated as "not up yet". */
  fetch: HealthFetchFn;
  createEnv?: CreateDevServerEnvFn;
  clock?: Clock;
  config?: DevServerRuntimeConfig;
  /**
   * Project-secrets loader (`loadProjectEnvForSpawn`). Returns every
   * decrypted project secret; the runtime injects only the keys named in
   * `devServer.secretKeys`. Optional so unit tests and secret-less
   * installs skip the store entirely.
   */
  loadProjectEnv?: (
    projectId: string,
    context: { sessionId?: string | null },
  ) => Record<string, string>;
  /** Project resolver for `reap`'s TTL lookup + orphan detection. */
  getProject?: (projectId: string) => Project | null;
  /** Signal a pid (negative = process group). Used only for rows that
   *  survived a Hub restart, where no live SessionEnv exists. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  notifyLog?: DevServerNotifyLogFn;
  notifyStatus?: DevServerNotifyStatusFn;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

// ─── Defaults ───────────────────────────────────────────────────────────

/** Dev servers boot fast (no image build) — 2 min is generous. */
export const DEFAULT_DEV_SERVER_READY_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_INTERVAL_MS = 1_000;
/** Shared with the compose runtime so late joiners see the same depth. */
const DEFAULT_LOG_TAIL_LINES = DEFAULT_PREVIEW_LOG_TAIL_LINES;
const DEFAULT_DISPOSE_GRACE_MS = 5_000;
const DEFAULT_IDLE_TTL_SECONDS = 14_400;
const DEFAULT_SESSION_LOCK_TIMEOUT_MS = 120_000;

/**
 * Port entry assumed when the project's `portMap` is empty: most dev
 * servers honor `PORT`, so the internal number only matters as the pool
 * key; the label feeds the process-row name.
 */
export const DEFAULT_DEV_SERVER_PORT_ENTRY: DevServerPortMapEntry = {
  internalPort: 3000,
  label: 'app',
  primary: true,
};

// ─── Pure helpers (exported for tests) ──────────────────────────────────

/**
 * Resolve the effective portMap: the configured entries, or the single
 * default entry when none are configured. Guarantees exactly one entry
 * is marked primary (parseDevServerConfig promotes the first on parse,
 * but hand-built configs in tests may skip that).
 */
export function resolveDevServerPortEntries(cfg: DevServerConfig): DevServerPortMapEntry[] {
  const entries = cfg.portMap.length > 0 ? cfg.portMap : [DEFAULT_DEV_SERVER_PORT_ENTRY];
  if (entries.some((e) => e.primary === true)) return entries;
  return entries.map((e, i) => (i === 0 ? { ...e, primary: true } : e));
}

/**
 * Process-row names for the port entries. Labels are the human key; a
 * duplicate label gets its internal port appended so the
 * `UNIQUE(group_id, name)` constraint holds.
 */
export function uniquePortEntryNames(entries: DevServerPortMapEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
  return entries.map((e) =>
    (counts.get(e.label) ?? 0) > 1 ? `${e.label}:${e.internalPort}` : e.label,
  );
}

export interface BuildDevServerSpawnEnvResult {
  env: Record<string, string>;
  /** secretKeys with no matching entry in the project-secrets store. */
  missingSecretKeys: string[];
}

/**
 * Merge the spawn env: configured non-secret vars, then the referenced
 * secrets, then the server-owned `PORT` (always wins — the config
 * validator already rejects user-supplied PORT). `envPort` is the port
 * the process must bind inside its env (host adapter: the allocated
 * host port; sysbox: the internal port).
 */
export function buildDevServerSpawnEnv(opts: {
  config: DevServerConfig;
  projectSecrets: Record<string, string>;
  envPort: number;
}): BuildDevServerSpawnEnvResult {
  const env: Record<string, string> = { ...opts.config.env };
  const missingSecretKeys: string[] = [];
  for (const key of opts.config.secretKeys) {
    const value = opts.projectSecrets[key];
    if (value === undefined) {
      missingSecretKeys.push(key);
      continue;
    }
    env[key] = value;
  }
  // The overlay wins over the host session-env baseEnv (process.env), so
  // defaulting NODE_ENV here keeps the Hub's NODE_ENV=production out of the
  // dev server's `npm ci` (which would otherwise omit devDependencies).
  applyPreviewDevInstallDefaults(env, (key) => key in opts.config.env);
  env.PORT = String(opts.envPort);
  return { env, missingSecretKeys };
}

// ─── Internal state ─────────────────────────────────────────────────────

interface ActiveDevServer {
  groupId: string;
  sessionId: string;
  env: SessionEnv;
  proc: SessionEnvProcess | null;
  tail: string[];
  primaryHostPort: number;
  primaryUrl: string;
  /** Set before dispose so the exit handler doesn't mark a stop as a crash. */
  stopping: boolean;
}

interface ReservedEntry {
  rowId: string;
  name: string;
  internalPort: number;
  hostPort: number;
  primary: boolean;
}

// ─── Runtime ────────────────────────────────────────────────────────────

export class DevServerRuntime {
  private readonly db: Database;
  private readonly fetch: HealthFetchFn;
  private readonly createEnv: CreateDevServerEnvFn;
  private readonly clock: Clock;
  private readonly portRange: PortRange;
  private readonly readyTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly logTailLines: number;
  private readonly urlBase: (port: number, sessionId: string) => string;
  private readonly portClientUrl: (args: {
    sessionId: string;
    hostPort: number;
    internalPort: number;
    primary: boolean;
  }) => string;
  private readonly healthUrlBase: (port: number) => string;
  private readonly disposeGraceMs: number;
  private readonly defaultIdleTtlSeconds: number;
  private readonly sessionLockTimeoutMs: number;
  private readonly loadProjectEnv: DevServerRuntimeDeps['loadProjectEnv'];
  private readonly getProject: DevServerRuntimeDeps['getProject'];
  private readonly killFn: (pid: number, signal: NodeJS.Signals) => void;
  private readonly notifyLog: DevServerNotifyLogFn | null;
  private readonly notifyStatus: DevServerNotifyStatusFn | null;
  private readonly logger: NonNullable<DevServerRuntimeDeps['logger']>;

  private readonly active = new Map<string, ActiveDevServer>();
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  constructor(deps: DevServerRuntimeDeps) {
    this.db = deps.db;
    this.fetch = deps.fetch;
    this.createEnv =
      deps.createEnv ??
      ((opts) =>
        createSessionEnv(getSessionEnvSelection().adapter, {
          sessionId: opts.sessionId,
          worktreePath: opts.worktreePath,
          hostDeps: { allocateHostPort: opts.allocateHostPort },
        }));
    this.clock = deps.clock ?? systemClock;
    this.portRange = deps.config?.portRange ?? DEFAULT_PREVIEW_PORT_RANGE;
    this.readyTimeoutMs = deps.config?.readyTimeoutMs ?? DEFAULT_DEV_SERVER_READY_TIMEOUT_MS;
    this.healthIntervalMs = deps.config?.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.logTailLines = deps.config?.logTailLines ?? DEFAULT_LOG_TAIL_LINES;
    this.urlBase = deps.config?.urlBase ?? ((p) => `http://localhost:${p}`);
    this.portClientUrl =
      deps.config?.portClientUrl ?? ((a) => this.urlBase(a.hostPort, a.sessionId));
    this.healthUrlBase = deps.config?.healthUrlBase ?? ((p) => `http://127.0.0.1:${p}`);
    this.disposeGraceMs = deps.config?.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
    this.defaultIdleTtlSeconds = deps.config?.defaultIdleTtlSeconds ?? DEFAULT_IDLE_TTL_SECONDS;
    this.sessionLockTimeoutMs =
      deps.config?.sessionLockTimeoutMs ?? DEFAULT_SESSION_LOCK_TIMEOUT_MS;
    this.loadProjectEnv = deps.loadProjectEnv;
    this.getProject = deps.getProject;
    this.killFn = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.notifyLog = deps.notifyLog ?? null;
    this.notifyStatus = deps.notifyStatus ?? null;
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
    if (this.portRange.min > this.portRange.max) {
      throw new Error(
        `Invalid dev-server port range: ${this.portRange.min}..${this.portRange.max}`,
      );
    }
    // Same-order schema application as the sibling runtimes so a
    // hand-built test DB gets identical migration semantics.
    this.db.exec(WORKTREE_PREVIEWS_SCHEMA);
    this.db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
    ensureDevServerPreviewColumns(this.db);
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Boot the dev server for `sessionId`. An existing group for the
   * session (any status) is stopped and replaced. Resolves once the
   * rows are inserted and the process is spawned; readiness flips in
   * the background health loop — poll `getById` / listen on
   * `notifyStatus` for the terminal transition.
   */
  async start(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartDevServerResult> {
    return this.withSessionLock(sessionId, () => this._start(sessionId, project, worktreePath));
  }

  /** Stop-and-start convenience — same replace semantics as `start`. */
  async restart(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartDevServerResult> {
    return this.start(sessionId, project, worktreePath);
  }

  /** Active dev server for `sessionId`, matching the managed-runtime surface. */
  getActive(sessionId: string): DevServerRow | null {
    return this.getActiveBySessionId(sessionId);
  }

  /**
   * Live isolation environment for a session managed by this process.
   *
   * The terminal PTY must enter the same Sysbox container as the dev server;
   * creating a second `SessionEnv` for the same session would collide on the
   * container name and split the shell from the app's backing services. This
   * deliberately exposes only the env (not the runtime's private process
   * record) for that shared-session consumer. Rows recovered after a Hub
   * restart have no in-memory env and therefore return null.
   */
  getSessionEnvBySessionId(sessionId: string): SessionEnv | null {
    const row = this.getActiveBySessionId(sessionId);
    if (!row) return null;
    const env = this.active.get(row.id)?.env;
    return env && !env.disposed ? env : null;
  }

  /**
   * Tear down one dev-server group: SIGTERM the process group, SIGKILL
   * survivors after the grace window, release ports, delete the rows.
   * Idempotent; a no-op for rows owned by another runtime.
   */
  async stop(devServerId: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT id, runtime FROM worktree_preview_groups WHERE id = ?`)
      .get(devServerId) as { id: string; runtime: string | null } | undefined;
    if (!row) return;
    if (row.runtime !== DEV_SERVER_RUNTIME_KIND) {
      this.logger.warn(
        `[dev-server] stop(${devServerId}) called for a non-dev-server group; ignoring`,
      );
      return;
    }
    const entry = this.active.get(devServerId);
    if (entry) {
      entry.stopping = true;
      try {
        await entry.env.dispose({ graceMs: this.disposeGraceMs });
      } catch (err) {
        this.logger.warn(
          `[dev-server] env dispose failed for ${devServerId}: ${(err as Error).message}`,
        );
      }
      this.active.delete(devServerId);
    } else {
      // Restart-orphan: the row survived a Hub restart, so there is no
      // live SessionEnv. Best-effort SIGTERM to the recorded pid's
      // process group so the tree doesn't outlive the row.
      const pidRow = this.db
        .prepare(
          `SELECT pid FROM worktree_preview_processes
            WHERE group_id = ? AND pid IS NOT NULL LIMIT 1`,
        )
        .get(devServerId) as { pid: number } | undefined;
      if (pidRow?.pid) {
        try {
          this.killFn(-pidRow.pid, 'SIGTERM');
        } catch {
          try {
            this.killFn(pidRow.pid, 'SIGTERM');
          } catch {
            // Already gone.
          }
        }
      }
    }
    // FK ON DELETE CASCADE removes the process rows + frees the ports.
    this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(devServerId);
  }

  /** Stop every dev-server group owned by `sessionId`. Returns the count. */
  async stopBySessionId(sessionId: string): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id FROM worktree_preview_groups
          WHERE session_id = ? AND runtime = ?
            AND status IN ('starting','ready','failed')`,
      )
      .all(sessionId, DEV_SERVER_RUNTIME_KIND) as Array<{ id: string }>;
    for (const r of rows) {
      await this.stop(r.id);
    }
    return rows.length;
  }

  /** Active (non-stopped) dev-server group for `sessionId`, or null. */
  getActiveBySessionId(sessionId: string): DevServerRow | null {
    return (this.selectRow(`g.session_id = ?`, sessionId) as DevServerRow | null) ?? null;
  }

  /** Single group by id, or null. */
  getById(devServerId: string): DevServerRow | null {
    return (this.selectRow(`g.id = ?`, devServerId) as DevServerRow | null) ?? null;
  }

  /**
   * Every dev-server group in `starting` / `ready` / `failed`, ordered by
   * `started_at` ASC — the WS connect snapshot walks this so a late
   * joiner (reconnect after tab sleep / WS drop) can rebuild its preview
   * pane, same contract as the compose runtime's `listActive`.
   */
  listActive(): DevServerRow[] {
    // INNER JOIN on the primary process row: a group with no primary yet
    // has no port/url a snapshot could render, so it is invisible here
    // rather than emitted as `port: 0` / `url: ''`. In practice the gap
    // is unobservable — `_start` inserts the group and its process rows
    // in one synchronous block — so this only guards hand-edited or
    // partially-failed rows.
    const rows = this.db
      .prepare(
        `SELECT g.id, g.session_id, g.project_id, g.status, g.started_at, g.last_active_at,
                p.pid, p.port, p.url
           FROM worktree_preview_groups g
           JOIN worktree_preview_processes p
                  ON p.group_id = g.id AND p.is_primary = 1
          WHERE g.runtime = ? AND g.status IN ('starting','ready','failed')
          ORDER BY g.started_at ASC`,
      )
      .all(DEV_SERVER_RUNTIME_KIND) as Array<Omit<DevServerRow, 'pid'> & { pid: number | null }>;
    return rows.map((row) => ({ ...row, pid: row.pid ?? null }));
  }

  /**
   * Base URL the **Hub process itself** can use to reach the dev server's
   * host port. Mirrors the health-check target (honors
   * `AGENT_HUB_PREVIEW_HEALTH_HOST` when the Hub runs inside Docker)
   * rather than the client-facing proxy URL, which the server-side drive
   * browser cannot resolve.
   */
  serverReachableUrlForPort(port: number): string {
    return this.healthUrlBase(port);
  }

  /** Alias matching the preview-react runtime surface. */
  touchPreview(devServerId: string): void {
    this.touch(devServerId);
  }

  /**
   * Upstream host port the preview proxy should dial for `sessionId`.
   * Omit `internalPort` for the primary port (the back-compat
   * `/preview/proxy` mount); pass one to resolve an extra portMap entry
   * (the `/preview/proxy/p/<internalPort>` sub-mount). Resolves only once
   * the group is `ready`, mirroring `getSessionPreviewPort`'s gate for the
   * compose/legacy runtimes.
   */
  getSessionUpstreamPort(sessionId: string, internalPort?: number): number | null {
    const row = this.getActiveBySessionId(sessionId);
    if (!row || row.status !== 'ready') return null;
    if (internalPort === undefined) return row.port > 0 ? row.port : null;
    const match = this.getPorts(row.id).find((p) => p.internalPort === internalPort);
    return match && match.hostPort > 0 ? match.hostPort : null;
  }

  /** All port mappings for a group — primary first. */
  getPorts(devServerId: string): DevServerPortRow[] {
    const rows = this.db
      .prepare(
        `SELECT name, port, url, internal_port, is_primary
           FROM worktree_preview_processes
          WHERE group_id = ?
          ORDER BY is_primary DESC, internal_port ASC`,
      )
      .all(devServerId) as Array<{
      name: string;
      port: number;
      url: string;
      internal_port: number | null;
      is_primary: number;
    }>;
    return rows.map((r) => ({
      name: r.name,
      internalPort: r.internal_port ?? r.port,
      hostPort: r.port,
      primary: r.is_primary === 1,
      url: r.url,
    }));
  }

  /**
   * Client-facing port entries for a group (primary first). Feeds the
   * preview pane's multi-port selector — the pane only renders it when the
   * list has more than one entry, so a single-port dev server is unaffected.
   * `url` is the stored browser-facing proxy URL for each port.
   */
  getClientPorts(groupId: string): PreviewPortEntry[] {
    return this.getPorts(groupId).map((p) => ({
      internalPort: p.internalPort,
      label: p.name,
      primary: p.primary,
      url: p.url,
    }));
  }

  /** In-memory boot/runtime log tail. Empty after a Hub restart. */
  getLogTail(devServerId: string): string[] {
    return [...(this.active.get(devServerId)?.tail ?? [])];
  }

  /** Bump `last_active_at` so the idle reaper's clock resets. */
  touch(devServerId: string): void {
    this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET last_active_at = datetime('now')
          WHERE id = ? AND runtime = ? AND status IN ('starting','ready')`,
      )
      .run(devServerId, DEV_SERVER_RUNTIME_KIND);
  }

  /**
   * One idle-reaper pass over this runtime's rows. Never throws;
   * operational failures land in `notes`. `nowMs` is injected so the
   * cron and tests share one code path.
   */
  async reap(nowMs: number): Promise<DevServerReapResult> {
    const result: DevServerReapResult = { scanned: 0, reaped: 0, orphaned: 0, notes: [] };
    const rows = this.db
      .prepare(
        `SELECT id, project_id, last_active_at FROM worktree_preview_groups
          WHERE runtime = ? AND status IN ('starting','ready','failed')`,
      )
      .all(DEV_SERVER_RUNTIME_KIND) as Array<{
      id: string;
      project_id: string;
      last_active_at: string;
    }>;
    result.scanned = rows.length;
    for (const row of rows) {
      const project = this.getProject ? this.getProject(row.project_id) : null;
      if (this.getProject && !project) {
        try {
          await this.stop(row.id);
          result.orphaned++;
          result.notes.push(`reaped orphan ${row.id} (project ${row.project_id} missing)`);
        } catch (err) {
          const note = `failed to reap orphan ${row.id}: ${(err as Error).message}`;
          result.notes.push(note);
          this.logger.warn(`[dev-server] ${note}`);
        }
        continue;
      }
      const ttlRaw = project?.prEnv?.preview?.idleTTL;
      const ttlSec =
        typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) && ttlRaw > 0
          ? Math.floor(ttlRaw)
          : this.defaultIdleTtlSeconds;
      const lastActiveMs = parseDbTime(row.last_active_at);
      if (lastActiveMs == null) continue;
      const idleMs = nowMs - lastActiveMs;
      if (idleMs < ttlSec * 1000) continue;
      try {
        await this.stop(row.id);
        result.reaped++;
        result.notes.push(`reaped ${row.id} (idle ${Math.round(idleMs / 1000)}s ≥ ttl ${ttlSec}s)`);
      } catch (err) {
        const note = `failed to reap ${row.id}: ${(err as Error).message}`;
        result.notes.push(note);
        this.logger.warn(`[dev-server] ${note}`);
      }
    }
    if (result.reaped > 0 || result.orphaned > 0) {
      this.logger.log(
        `[dev-server-reaper] tick: scanned=${result.scanned} reaped=${result.reaped} orphaned=${result.orphaned}`,
      );
    }
    return result;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async _start(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartDevServerResult> {
    const existing = this.getActive(sessionId);
    if (existing) {
      await this.stop(existing.id);
    }

    const parsed = parseDevServerConfig(project.prEnv?.devServer ?? {});
    if (!parsed.ok) {
      throw new Error(`Invalid dev-server config: ${parsed.error}`);
    }
    const cfg = parsed.value;
    const entries = resolveDevServerPortEntries(cfg);
    const names = uniquePortEntryNames(entries);

    const reclaimed = reclaimFailedPortsInRange(this.db, this.portRange.min, this.portRange.max);
    if (reclaimed > 0) {
      this.logger.log(`[dev-server] reclaimed ${reclaimed} failed preview port(s)`);
    }

    const groupId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO worktree_preview_groups (id, session_id, project_id, status, runtime)
         VALUES (?, ?, ?, 'starting', ?)`,
      )
      .run(groupId, sessionId, project.id, DEV_SERVER_RUNTIME_KIND);

    // Reserve every port row up-front (pool allocation for the primary,
    // identity for extras). On any failure the group row is rolled back
    // so the next start gets a clean slate.
    const reserved: ReservedEntry[] = [];
    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const primary = entry.primary === true;
        reserved.push(
          primary
            ? this.reservePooledRow(groupId, sessionId, names[i], entry.internalPort)
            : this.reserveIdentityRow(groupId, sessionId, names[i], entry.internalPort),
        );
      }
    } catch (err) {
      this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
      throw err;
    }
    const primaryEntry = reserved.find((r) => r.primary)!;
    const reservedByInternal = new Map(reserved.map((r) => [r.internalPort, r.hostPort]));

    let env: SessionEnv;
    try {
      env = this.createEnv({
        sessionId,
        worktreePath,
        allocateHostPort: (internalPort) => {
          const hostPort = reservedByInternal.get(internalPort);
          if (hostPort === undefined) {
            throw new Error(`No reserved host port for internal port ${internalPort}`);
          }
          return hostPort;
        },
      });
    } catch (err) {
      // Adapter construction can fail (for example, a selected sysbox
      // backend becoming unavailable after the boot probe). Do not
      // strand the pre-reserved group/port rows on that failure path.
      this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
      throw err;
    }

    const record: ActiveDevServer = {
      groupId,
      sessionId,
      env,
      proc: null,
      tail: [],
      primaryHostPort: primaryEntry.hostPort,
      primaryUrl: this.portClientUrl({
        sessionId,
        hostPort: primaryEntry.hostPort,
        internalPort: primaryEntry.internalPort,
        primary: true,
      }),
      stopping: false,
    };
    this.active.set(groupId, record);

    let primaryEnvPort: number;
    try {
      await env.mountWorktree();
      // Establish every mapping through the env so a containerized adapter
      // publishes each port; the host adapter resolves through the pooled
      // allocator above. Primary first so `mappings[0]` is its mapping.
      const orderedInternalPorts = [
        primaryEntry.internalPort,
        ...reserved.filter((r) => !r.primary).map((r) => r.internalPort),
      ];
      const mappings = await env.mapPortsOut(orderedInternalPorts);
      primaryEnvPort = mappings[0].envPort;
    } catch (err) {
      await this.rollbackStart(groupId, record);
      throw err;
    }

    // Resolve secrets. A store failure degrades to "no secrets" with a
    // loud warning rather than blocking boot — same posture as the
    // legacy runtime's loadProjectEnv.
    let projectSecrets: Record<string, string> = {};
    if (this.loadProjectEnv && cfg.secretKeys.length > 0) {
      try {
        projectSecrets = this.loadProjectEnv(project.id, { sessionId });
      } catch (err) {
        this.logger.warn(
          `[dev-server ${groupId}] loadProjectEnv failed: ${(err as Error).message} (continuing without secrets)`,
        );
      }
    }
    const { env: spawnEnv, missingSecretKeys } = buildDevServerSpawnEnv({
      config: cfg,
      projectSecrets,
      envPort: primaryEnvPort,
    });
    if (missingSecretKeys.length > 0) {
      this.logger.warn(
        `[dev-server ${groupId}] secretKeys not found in project secrets: ${missingSecretKeys.join(', ')}`,
      );
    }

    const processName = primaryEntry.name;
    let proc: SessionEnvProcess;
    try {
      proc = env.spawn(cfg.startCommand, {
        cwd: cfg.cwd,
        env: spawnEnv,
        name: `dev-server:${sessionId}`,
      });
    } catch (err) {
      await this.rollbackStart(groupId, record);
      throw err;
    }
    record.proc = proc;
    this.db
      .prepare(`UPDATE worktree_preview_processes SET pid = ? WHERE group_id = ?`)
      .run(proc.pid, groupId);

    const append = (chunk: string, stream: 'stdout' | 'stderr') => {
      const lines = chunk.split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        appendPreviewLogTailLine(record.tail, line, this.logTailLines);
        if (this.notifyLog) {
          try {
            this.notifyLog({ sessionId, groupId, processName, line, stream });
          } catch (err) {
            this.logger.warn(`[dev-server ${groupId}] notifyLog threw: ${(err as Error).message}`);
          }
        }
      }
    };
    proc.onStdout((chunk) => append(chunk, 'stdout'));
    proc.onStderr((chunk) => append(chunk, 'stderr'));
    proc.onExit((exit) => {
      if (record.stopping) return;
      void this.markFailed(groupId, describeExit(exit)).catch((err) => {
        this.logger.error(
          `[dev-server ${groupId}] markFailed after exit threw: ${(err as Error).message}`,
        );
      });
    });

    const healthPath = cfg.healthPath ?? '/';
    const readyTimeoutMs = cfg.readyTimeoutMs ?? this.readyTimeoutMs;
    void this.runHealthCheck(groupId, primaryEntry.hostPort, healthPath, readyTimeoutMs).catch(
      (err) => {
        this.logger.error(
          `[dev-server ${groupId}] health check crashed: ${(err as Error).message}`,
        );
      },
    );

    return { devServerId: groupId, url: record.primaryUrl, port: primaryEntry.hostPort };
  }

  /** Undo a partially-started group: dispose the env, drop the rows. */
  private async rollbackStart(groupId: string, record: ActiveDevServer): Promise<void> {
    record.stopping = true;
    try {
      await record.env.dispose({ graceMs: this.disposeGraceMs });
    } catch {
      // Best-effort — the row delete below frees the ports either way.
    }
    this.active.delete(groupId);
    this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
  }

  /**
   * Pool-allocated reservation for the primary port. Bounded retry on
   * the shared `UNIQUE(port)` — the loser of a concurrent-start race
   * reclaims failed holders and picks the next free port.
   */
  private reservePooledRow(
    groupId: string,
    sessionId: string,
    name: string,
    internalPort: number,
  ): ReservedEntry {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const hostPort = this.allocatePort();
      const inserted = this.tryInsertProcessRow(
        groupId,
        sessionId,
        name,
        internalPort,
        hostPort,
        true,
      );
      if (inserted) return inserted;
      this.logger.warn(
        `[dev-server] port ${hostPort} conflict for ${name} on attempt ${attempt + 1}, retrying`,
      );
      reclaimFailedPortHolder(this.db, hostPort);
    }
    throw new Error('unreachable: dev-server port retry loop exited without returning');
  }

  /**
   * Identity reservation for a non-primary entry: on the host adapter
   * the process binds the configured internal port directly (extra
   * ports can't be steered via PORT), so hostPort == internalPort. A
   * UNIQUE conflict after one reclaim attempt is a real cross-session
   * collision and fails the start loudly.
   */
  private reserveIdentityRow(
    groupId: string,
    sessionId: string,
    name: string,
    internalPort: number,
  ): ReservedEntry {
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = this.tryInsertProcessRow(
        groupId,
        sessionId,
        name,
        internalPort,
        internalPort,
        false,
      );
      if (inserted) return inserted;
      reclaimFailedPortHolder(this.db, internalPort);
    }
    throw new Error(
      `Dev-server port ${internalPort} ("${name}") is already in use by another preview or dev server`,
    );
  }

  private tryInsertProcessRow(
    groupId: string,
    sessionId: string,
    name: string,
    internalPort: number,
    hostPort: number,
    primary: boolean,
  ): ReservedEntry | null {
    const rowId = randomUUID();
    const url = this.portClientUrl({ sessionId, hostPort, internalPort, primary });
    try {
      this.db
        .prepare(
          `INSERT INTO worktree_preview_processes
             (id, group_id, name, pid, port, url, log_path, status, internal_port, is_primary)
           VALUES (?, ?, ?, NULL, ?, ?, NULL, 'starting', ?, ?)`,
        )
        .run(rowId, groupId, name, hostPort, url, internalPort, primary ? 1 : 0);
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
      throw err;
    }
    return { rowId, name, internalPort, hostPort, primary };
  }

  private allocatePort(): number {
    const taken = new Set(
      (
        this.db
          .prepare(
            `SELECT port FROM worktree_preview_processes
              WHERE port BETWEEN ? AND ?
                AND status IN ('pending','starting','ready')`,
          )
          .all(this.portRange.min, this.portRange.max) as Array<{ port: number }>
      ).map((r) => r.port),
    );
    for (let p = this.portRange.min; p <= this.portRange.max; p++) {
      if (!taken.has(p)) return p;
    }
    throw new Error(
      `Dev-server port pool exhausted: all ports in [${this.portRange.min}, ${this.portRange.max}] are in use`,
    );
  }

  private async runHealthCheck(
    groupId: string,
    hostPort: number,
    healthPath: string,
    readyTimeoutMs: number,
  ): Promise<void> {
    const healthUrl = `${this.healthUrlBase(hostPort)}${healthPath}`;
    const startedAt = this.clock.nowMs();
    // Two-phase budget, carried over from the compose runtime's build-exit
    // rebase. Phase one is BUILD/BOOT: the dev server is installing deps or
    // compiling and nothing listens yet, so every probe throws (connection
    // refused). Phase two is APP-READY: the port is bound and the probe gets
    // an HTTP response of any status. The first bound response rebases
    // `deadline` to `boundAt + readyTimeoutMs` exactly once, so the app gets
    // the full readiness budget to go 2xx regardless of how long the
    // compile took. A fast boot (probe answers almost immediately) collapses
    // this back to the single-window behaviour.
    //
    // The rebase is gated on `boundAt <= originalDeadline`: a boot that
    // overran its own budget must not earn a fresh readiness window — the
    // expiry check below fails it instead of extending.
    const originalDeadline = startedAt + readyTimeoutMs;
    let deadline = originalDeadline;
    let boundAtMs: number | null = null;
    let rebased = false;
    for (;;) {
      if (this.clock.nowMs() >= deadline) break;
      const status = this.getStatus(groupId);
      // Stopped (row gone) or already terminal — nothing left to probe.
      if (status !== 'starting') return;
      try {
        const res = await this.fetch(healthUrl);
        // Any response — even a 4xx/5xx — means the socket is bound: the
        // build/boot phase is over. Rebase the readiness window once.
        if (boundAtMs === null) {
          boundAtMs = this.clock.nowMs();
          if (boundAtMs <= originalDeadline) {
            rebased = true;
            deadline = boundAtMs + readyTimeoutMs;
          }
        }
        if (res.ok) {
          this.markReady(groupId);
          return;
        }
      } catch {
        // Not bound yet — still building/booting; poll again.
      }
      await this.clock.sleep(this.healthIntervalMs);
    }
    if (this.getStatus(groupId) !== 'starting') return;
    // Three distinct failures, each naming the window it actually got:
    // never bound (full budget spent booting), bound-in-budget (full
    // rebased window granted, no 2xx), and bound-over-budget (rebase
    // refused, so no post-bind window existed at all).
    const reason =
      boundAtMs === null
        ? `health check timed out after ${readyTimeoutMs}ms (port never bound)`
        : rebased
          ? `health check timed out ${readyTimeoutMs}ms after the port bound (no 2xx from ${healthPath})`
          : `port bound at +${boundAtMs - startedAt}ms, after the ${readyTimeoutMs}ms boot budget expired (no 2xx from ${healthPath})`;
    await this.markFailed(groupId, reason);
  }

  private markReady(groupId: string): void {
    this.db
      .prepare(
        `UPDATE worktree_preview_processes SET status = 'ready'
          WHERE group_id = ? AND status = 'starting'`,
      )
      .run(groupId);
    this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET status = 'ready', last_active_at = datetime('now')
          WHERE id = ? AND status = 'starting'`,
      )
      .run(groupId);
    const record = this.active.get(groupId);
    if (record && this.notifyStatus) {
      try {
        this.notifyStatus({
          sessionId: record.sessionId,
          groupId,
          status: 'ready',
          port: record.primaryHostPort,
          url: record.primaryUrl,
          logTail: [...record.tail],
          ports: this.getClientPorts(groupId),
        });
      } catch {
        // Best-effort broadcast.
      }
    }
  }

  private async markFailed(groupId: string, reason: string): Promise<void> {
    const current = this.getStatus(groupId);
    if (current === null || current === 'failed') return;
    this.db
      .prepare(
        `UPDATE worktree_preview_processes SET status = 'failed'
          WHERE group_id = ? AND status IN ('pending','starting','ready')`,
      )
      .run(groupId);
    this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET status = 'failed', last_active_at = datetime('now')
          WHERE id = ? AND status IN ('starting','ready')`,
      )
      .run(groupId);
    const record = this.active.get(groupId);
    // Tear down the whole env, not only the top-level process handle. A
    // health timeout can leave grandchildren alive; SessionEnv.dispose
    // owns the process-group SIGTERM → SIGKILL grace and port release.
    if (record && !record.env.disposed) {
      try {
        await record.env.dispose({ graceMs: this.disposeGraceMs });
      } catch (err) {
        this.logger.warn(
          `[dev-server ${groupId}] env dispose after failure threw: ${(err as Error).message}`,
        );
      }
    }
    this.logger.warn(`[dev-server ${groupId}] failed: ${reason}`);
    if (record && this.notifyStatus) {
      try {
        this.notifyStatus({
          sessionId: record.sessionId,
          groupId,
          status: 'failed',
          port: record.primaryHostPort,
          url: record.primaryUrl,
          logTail: [...record.tail],
          error: reason,
        });
      } catch {
        // Best-effort broadcast.
      }
    }
  }

  private getStatus(groupId: string): DevServerStatus | null {
    const row = this.db
      .prepare(`SELECT status FROM worktree_preview_groups WHERE id = ? AND runtime = ?`)
      .get(groupId, DEV_SERVER_RUNTIME_KIND) as { status: DevServerStatus } | undefined;
    return row?.status ?? null;
  }

  private selectRow(where: string, param: string): DevServerRow | null {
    const row = this.db
      .prepare(
        `SELECT g.id, g.session_id, g.project_id, g.status, g.started_at, g.last_active_at,
                p.pid, p.port, p.url
           FROM worktree_preview_groups g
           LEFT JOIN worktree_preview_processes p
                  ON p.group_id = g.id AND p.is_primary = 1
          WHERE ${where} AND g.runtime = '${DEV_SERVER_RUNTIME_KIND}'
            AND g.status IN ('starting','ready','failed')
          ORDER BY g.started_at DESC
          LIMIT 1`,
      )
      .get(param) as
      | (Omit<DevServerRow, 'pid' | 'port' | 'url'> & {
          pid: number | null;
          port: number | null;
          url: string | null;
        })
      | undefined;
    if (!row) return null;
    return {
      ...row,
      pid: row.pid ?? null,
      port: row.port ?? 0,
      url: row.url ?? '',
    };
  }

  /**
   * Serialize starts per session — bounded wait so a wedged prior call
   * can't deadlock new ones (same rationale as the compose runtime's
   * `sessionLockTimeoutMs`).
   */
  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(sessionId);
    if (prior) {
      const settled = prior.then(
        () => 'done' as const,
        () => 'done' as const,
      );
      const timedOut = this.clock.sleep(this.sessionLockTimeoutMs).then(() => 'timeout' as const);
      if ((await Promise.race([settled, timedOut])) === 'timeout') {
        this.logger.warn(
          `[dev-server] session lock for ${sessionId} exceeded ${this.sessionLockTimeoutMs}ms; proceeding`,
        );
      }
    }
    const run = fn();
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionLocks.set(sessionId, guard);
    void guard.then(() => {
      if (this.sessionLocks.get(sessionId) === guard) this.sessionLocks.delete(sessionId);
    });
    return run;
  }
}

function describeExit(exit: SessionEnvExit): string {
  if (exit.error) return `process failed to spawn: ${exit.error.message}`;
  if (exit.signal) return `process exited on signal ${exit.signal}`;
  return `process exited with code ${exit.code ?? 'unknown'}`;
}
