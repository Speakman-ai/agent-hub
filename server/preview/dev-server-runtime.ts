/**
 * DevServerRuntime — managed dev-server process lifecycle.
 *
 * Runs the project as one long-lived process started from
 * `prEnv.devServer.startCommand` inside the session's `SessionEnv`,
 * replacing the retired app-wrapping model. The Hub owns
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
 *     `runtime = 'dev-server'` so startup cleanup can distinguish live
 *     rows from rows left by older runtimes;
 *   - one `worktree_preview_processes` row per portMap entry, all
 *     carrying the REAL pid of the single spawned process (pid-less
 *     rows from older runtimes). `port` stores the host port
 *     the preview proxy dials; `internal_port` / `is_primary` are the
 *     dev-server companion columns.
 *
 * Isolation: all process + port work goes through the `SessionEnv`
 * abstraction. The default factory uses the host adapter (a private env
 * when the session has no shared boundary). Firecracker / sysbox sessions
 * must go through `resolveSharedEnv` so a leftover
 * `sessionEnvAdapter=firecracker` pin cannot boot a VM for every preview.
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
import type {
  SessionEnv,
  SessionEnvExit,
  SessionEnvPortMapping,
  SessionEnvProcess,
} from '../session-env/session-env.js';
import type { SessionEnvPortRouting } from '../session-env/container-routing.js';
import { isLoopbackHost } from '../loopback-host.js';
import { createSessionEnv } from '../session-env/select-session-env.js';
import {
  DEFAULT_PREVIEW_PORT_RANGE,
  DEV_SERVER_RUNTIME_KIND,
  ensureDevServerPreviewColumns,
  ensureHostScopedPreviewPortUniqueness,
  WORKTREE_PREVIEWS_SCHEMA,
  WORKTREE_PREVIEW_GROUPS_SCHEMA,
  type PreviewDialScope,
} from './preview-schema.js';
import { reclaimFailedPortHolder, reclaimFailedPortsInRange } from './preview-port-reclaim.js';
import { isHostPortFree, type IsPortFreeFn } from './host-port-probe.js';
import type { Clock, HealthFetchFn, PortRange } from './preview-runtime-primitives.js';
import { parseDbTime, systemClock } from './preview-runtime-primitives.js';
import { appendPreviewLogTailLine, DEFAULT_PREVIEW_LOG_TAIL_LINES } from './preview-log-tail.js';
import {
  installDevServerSystemDeps,
  describeSystemDepsExit,
  SYSTEM_DEPS_PROCESS_NAME,
} from './dev-server-system-deps.js';
import { runDevServerBuild, describeBuildExit, BUILD_PROCESS_NAME } from './dev-server-build.js';
import {
  runDevServerStopCommand,
  describeStopExit,
  DEFAULT_STOP_COMMAND_TIMEOUT_MS,
  STOP_PROCESS_NAME,
} from './dev-server-stop-command.js';
import { withBootDiagnostic } from './preview-boot-diagnostics.js';
import {
  composeProjectNameForSession,
  reapComposeStack,
  type ComposeStackReapResult,
} from './compose-stack-reaper.js';
import type { SysboxRunFn } from '../session-env/sysbox-session-env.js';
import type { PreviewPortEntry } from './preview-runtime-lookup.js';

// ─── Types & contracts ──────────────────────────────────────────────────

/** `worktree_preview_groups.runtime` value for rows this runtime owns. */
export { DEV_SERVER_RUNTIME_KIND };

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

export interface StartDevServerOpts {
  /**
   * Skip `buildCommand` and go straight to `startCommand` (still a full
   * stop+start otherwise), reusing the build's on-disk output — the "Restart
   * Server" action. Defaults to false ("Rebuild App" / a fresh start runs the
   * build).
   */
  skipBuild?: boolean;
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

/**
 * Resolve the environment the session already owns, if any.
 *
 * A containerized env *is* the session's isolation boundary, so the preview
 * must run in the same one as the terminal — otherwise "start the dev server,
 * then curl it from the terminal" fails, and the agent's tests run against a
 * different Postgres than the preview serves. Returning null means the
 * runtime creates its own env, which is correct for the host adapter where
 * there is no boundary to share in the first place.
 */
export type ResolveSharedSessionEnvFn = (sessionId: string) => Promise<SessionEnv | null>;

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
  /** Max ms a `devServer.stopCommand` may run on teardown before it is
   *  killed. Default 2 min. */
  stopCommandTimeoutMs?: number;
}

export interface DevServerRuntimeDeps {
  db: Database;
  /** {ok,status} health probe; throws are treated as "not up yet". */
  fetch: HealthFetchFn;
  createEnv?: CreateDevServerEnvFn;
  /**
   * Session-owned env lookup. When it yields an env, the preview runs inside
   * the session's existing boundary instead of starting a second one.
   */
  resolveSharedEnv?: ResolveSharedSessionEnvFn;
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
   *  survived a Hub restart, where no live SessionEnv exists. Signal `0`
   *  is a liveness check: it throws ESRCH when the process is gone. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /**
   * Host-level port availability check, consulted before a port is
   * handed out. Defaults to a real socket bind (`isHostPortFree`);
   * tests inject a stub to stay hermetic.
   */
  isPortFree?: IsPortFreeFn;
  /**
   * One-shot `docker` invocation for Hub-owned compose stack reaping (see
   * `compose-stack-reaper.ts`). Null / omitted on docker-less hosts and in
   * tests: teardown then relies on the project's `stopCommand` alone.
   */
  runDocker?: SysboxRunFn | null;
  notifyLog?: DevServerNotifyLogFn;
  notifyStatus?: DevServerNotifyStatusFn;
  /**
   * Bump the session-owned env's activity clock when preview traffic keeps the
   * group alive. Guest daemons are invisible to `liveProcessCount`, so without
   * this the idle reaper can tear down a VM that is still serving a preview.
   */
  onSessionActivity?: (sessionId: string) => void;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

// ─── Defaults ───────────────────────────────────────────────────────────

/** Dev servers boot fast (no image build) — 2 min is generous. */
export const DEFAULT_DEV_SERVER_READY_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_INTERVAL_MS = 1_000;
/** Shared log-tail depth for late joiners. */
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
 *
 * `upstreamHost` is the address the Hub's proxy will actually connect over,
 * published as `AGENT_HUB_PREVIEW_HEALTH_HOST` so a dev server that gates on
 * the `Host` header allows it. Under container-IP routing this is the session
 * container's address, which is assigned at create time and therefore cannot be
 * baked into any config: without it a Vite dev server allowlists only the
 * static default and answers the proxy with its blocked-host 403 — *after* the
 * readiness probe passed, because the probe sends `Host: localhost`. The result
 * is a preview that reports ready and shows an error page, which reads as a bug
 * in the app. A value pinned in `devServer.env` still wins; that is an operator
 * deliberately naming the host.
 */
export function buildDevServerSpawnEnv(opts: {
  config: DevServerConfig;
  projectSecrets: Record<string, string>;
  envPort: number;
  upstreamHost?: string | null;
  /**
   * The pool-allocated, host-unique primary host port, published as
   * `AGENT_HUB_HOST_PORT`. A dev server whose `startCommand` is a
   * `docker compose up` (or any process that binds a host port itself,
   * rather than honoring the injected `PORT`) can interpolate this to
   * publish a per-session unique port — e.g. `${AGENT_HUB_HOST_PORT}:4200`
   * in the compose file — instead of a hardcoded `4100`, which two
   * sessions on the same host collide on ("port is already allocated").
   */
  hostPort?: number;
  /**
   * Hub-owned compose project name (`session-<id8>`), published as
   * `COMPOSE_PROJECT_NAME` unless the config pins its own. Scopes every
   * container / network / volume a `docker compose` start creates to this
   * session, which is what lets the Hub reap them by label after the group
   * or the session is gone. See `compose-stack-reaper.ts`.
   */
  composeProjectName?: string;
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
  const upstreamHost = opts.upstreamHost?.trim();
  if (upstreamHost && !('AGENT_HUB_PREVIEW_HEALTH_HOST' in opts.config.env)) {
    env.AGENT_HUB_PREVIEW_HEALTH_HOST = upstreamHost;
  }
  if (opts.hostPort !== undefined) {
    env.AGENT_HUB_HOST_PORT = String(opts.hostPort);
  }
  if (opts.composeProjectName && !('COMPOSE_PROJECT_NAME' in opts.config.env)) {
    env.COMPOSE_PROJECT_NAME = opts.composeProjectName;
  }
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
  /**
   * False when the env belongs to the session rather than to this preview.
   * A shared env outlives the dev server — stopping the preview must not
   * take the terminal's shell and the project's databases down with it.
   */
  ownsEnv: boolean;
  /** Set before dispose so the exit handler doesn't mark a stop as a crash. */
  stopping: boolean;
  /**
   * Hostname that actually answered the readiness probe when it is the
   * Hub's own loopback and `healthUrlBase` points at the docker-host
   * gateway. Null means "use the Hub-wide default" (published-port path).
   */
  probeHost: string | null;
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
  private readonly resolveSharedEnv: ResolveSharedSessionEnvFn | null;
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
  private readonly stopCommandTimeoutMs: number;
  private readonly loadProjectEnv: DevServerRuntimeDeps['loadProjectEnv'];
  private readonly getProject: DevServerRuntimeDeps['getProject'];
  private readonly killFn: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly isPortFree: IsPortFreeFn;
  private readonly runDocker: SysboxRunFn | null;
  private readonly notifyLog: DevServerNotifyLogFn | null;
  private readonly notifyStatus: DevServerNotifyStatusFn | null;

  /** Keep collision detection fast even when a gateway route blackholes. */
  private static readonly CANDIDATE_PREFLIGHT_TIMEOUT_MS = 250;
  private readonly onSessionActivity: ((sessionId: string) => void) | null;
  private readonly logger: NonNullable<DevServerRuntimeDeps['logger']>;

  private readonly active = new Map<string, ActiveDevServer>();
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  constructor(deps: DevServerRuntimeDeps) {
    this.db = deps.db;
    this.fetch = deps.fetch;
    this.createEnv =
      deps.createEnv ??
      ((opts) =>
        createSessionEnv('host', {
          sessionId: opts.sessionId,
          worktreePath: opts.worktreePath,
          hostDeps: { allocateHostPort: opts.allocateHostPort },
        }));
    this.resolveSharedEnv = deps.resolveSharedEnv ?? null;
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
    this.stopCommandTimeoutMs =
      deps.config?.stopCommandTimeoutMs ?? DEFAULT_STOP_COMMAND_TIMEOUT_MS;
    this.loadProjectEnv = deps.loadProjectEnv;
    this.getProject = deps.getProject;
    this.killFn = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.isPortFree = deps.isPortFree ?? isHostPortFree;
    this.runDocker = deps.runDocker ?? null;
    this.notifyLog = deps.notifyLog ?? null;
    this.notifyStatus = deps.notifyStatus ?? null;
    this.onSessionActivity = deps.onSessionActivity ?? null;
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
    ensureHostScopedPreviewPortUniqueness(this.db);
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
    opts: StartDevServerOpts = {},
  ): Promise<StartDevServerResult> {
    return this.withSessionLock(sessionId, () =>
      this._start(sessionId, project, worktreePath, opts),
    );
  }

  /** Stop-and-start convenience — same replace semantics as `start`. */
  async restart(
    sessionId: string,
    project: Project,
    worktreePath: string,
    opts: StartDevServerOpts = {},
  ): Promise<StartDevServerResult> {
    return this.start(sessionId, project, worktreePath, opts);
  }

  /**
   * "Restart Server": replace the running dev server, reusing the existing
   * build output. This is a full stop+start (`skipBuild: true`) — it stops the
   * current group, re-reserves ports, remounts the worktree, re-resolves
   * secrets, and re-runs apt — it does NOT recycle only the process. What it
   * skips is `buildCommand`, and that is safe because the build's *output*
   * (node_modules, compiled artifacts) lives on the worktree, which persists on
   * disk across the replace. So it avoids the expensive recompile, not the rest
   * of startup.
   */
  async restartServer(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartDevServerResult> {
    return this.start(sessionId, project, worktreePath, { skipBuild: true });
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
      .prepare(
        `SELECT id, runtime, session_id AS sessionId, project_id AS projectId
           FROM worktree_preview_groups WHERE id = ?`,
      )
      .get(devServerId) as
      | { id: string; runtime: string | null; sessionId: string; projectId: string }
      | undefined;
    if (!row) return;
    if (row.runtime !== DEV_SERVER_RUNTIME_KIND) {
      this.logger.warn(
        `[dev-server] stop(${devServerId}) called for a non-dev-server group; ignoring`,
      );
      return;
    }
    const entry = this.active.get(devServerId);
    // Mark stopping before anything can make the tracked process exit, so a
    // stopCommand that ends the `docker compose up` (or the process's own
    // teardown) is not misread as a crash by the exit handler.
    if (entry) entry.stopping = true;

    // Run the project's teardown command (e.g. `docker compose down`) while the
    // env is still live. The tracked process may not own the resources the
    // start created — compose containers are children of the Docker daemon, so
    // signalling the compose CLI below leaves them running and holding their
    // published host port. This is the step that reclaims them.
    await this.runStopHook(devServerId, row.sessionId, row.projectId, entry?.env ?? null);
    // Hub-owned backstop for daemon-owned resources, independent of whether a
    // stopCommand exists or the env is still live: remove this session's
    // compose containers + networks by label so the host port they published
    // is actually free when the pool hands it to the next session. Named
    // volumes stay so a restart can reuse them; archive/delete purges those.
    await this.reapSessionComposeStack(row.sessionId, devServerId, { removeVolumes: false });

    if (entry) {
      await this.releaseEnv(entry, devServerId);
      this.active.delete(devServerId);
    } else {
      // Restart-orphan: the row survived a Hub restart, so there is no
      // live SessionEnv to dispose. Signal the recorded pid directly,
      // escalating to SIGKILL, because the row (and its port) is about
      // to be deleted — a survivor here becomes the orphan that hijacks
      // the next session allocated this port.
      const pidRow = this.db
        .prepare(
          `SELECT pid FROM worktree_preview_processes
            WHERE group_id = ? AND pid IS NOT NULL LIMIT 1`,
        )
        .get(devServerId) as { pid: number } | undefined;
      if (pidRow?.pid) {
        await this.terminateOrphanPid(pidRow.pid, devServerId);
      }
    }
    // FK ON DELETE CASCADE removes the process rows + frees the ports.
    this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(devServerId);
  }

  /**
   * Session archive / delete teardown: remove every compose container,
   * network, AND named volume the session's previews created under the
   * Hub-owned project name. The session will never restart its preview, so
   * the volumes (a restored database per session on some projects) are pure
   * leak from here on. Best-effort; resolves null when reaping is disabled
   * (no `runDocker`).
   */
  async purgeSessionComposeStack(sessionId: string): Promise<ComposeStackReapResult | null> {
    return this.reapSessionComposeStack(sessionId, null, { removeVolumes: true });
  }

  private async reapSessionComposeStack(
    sessionId: string,
    groupId: string | null,
    opts: { removeVolumes: boolean },
  ): Promise<ComposeStackReapResult | null> {
    if (!this.runDocker) return null;
    const tag = groupId ? `[dev-server ${groupId}]` : `[dev-server session ${sessionId}]`;
    try {
      return await reapComposeStack({
        run: this.runDocker,
        projectName: composeProjectNameForSession(sessionId),
        removeVolumes: opts.removeVolumes,
        log: (m) => this.logger.log(`${tag} ${m}`),
        warn: (m) => this.logger.warn(`${tag} ${m}`),
      });
    } catch (err) {
      this.logger.warn(`${tag} compose stack reap threw: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Run `devServer.stopCommand` for a group being torn down, best-effort.
   *
   * Resolves the project config for the command + cwd, an env to run it in
   * (the live one when the group is still tracked, else the session's own env
   * after a Hub restart), and the same non-secret env + resolved secrets the
   * start got. A missing config/command/env, a non-zero exit, a spawn
   * failure, or a timeout are all logged and swallowed — teardown never blocks
   * on cleanup.
   */
  private async runStopHook(
    groupId: string,
    sessionId: string,
    projectId: string | null,
    liveEnv: SessionEnv | null,
  ): Promise<void> {
    if (!projectId || !this.getProject) return;
    const project = this.getProject(projectId);
    const rawDevServer = project?.prEnv?.devServer;
    if (!rawDevServer) return;
    const parsed = parseDevServerConfig(rawDevServer);
    if (!parsed.ok) return;
    const cfg = parsed.value;
    const stopCommand = cfg.stopCommand;
    if (!stopCommand) return;

    const env =
      liveEnv && !liveEnv.disposed
        ? liveEnv
        : this.resolveSharedEnv
          ? await this.resolveSharedEnv(sessionId).catch(() => null)
          : null;
    if (!env || env.disposed) {
      this.logger.warn(
        `[dev-server ${groupId}] stopCommand skipped: no live env to run it in ` +
          `(session ${sessionId} may have ended). Daemon-owned resources it would ` +
          `clean up (e.g. compose containers) may persist.`,
      );
      return;
    }

    let projectSecrets: Record<string, string> = {};
    if (this.loadProjectEnv && cfg.secretKeys.length > 0) {
      try {
        projectSecrets = this.loadProjectEnv(projectId, { sessionId });
      } catch (err) {
        this.logger.warn(
          `[dev-server ${groupId}] stopCommand loadProjectEnv failed: ${(err as Error).message}`,
        );
      }
    }
    const spawnEnv: Record<string, string> = { ...cfg.env };
    for (const key of cfg.secretKeys) {
      const value = projectSecrets[key];
      if (value !== undefined) spawnEnv[key] = value;
    }
    // Guarantee the session id is present so a stack namespaced by it (e.g.
    // COMPOSE_PROJECT_NAME=session-$AGENT_HUB_SESSION_ID) tears down the same
    // project the start command created.
    spawnEnv.AGENT_HUB_SESSION_ID = sessionId;
    // Same project name the start got, so a `docker compose down` stopCommand
    // targets the stack this session created rather than the cwd default.
    if (!('COMPOSE_PROJECT_NAME' in cfg.env)) {
      spawnEnv.COMPOSE_PROJECT_NAME = composeProjectNameForSession(sessionId);
    }

    try {
      const result = await runDevServerStopCommand({
        env,
        stopCommand,
        cwd: cfg.cwd,
        spawnEnv,
        timeoutMs: this.stopCommandTimeoutMs,
        onLine: (line, stream) => {
          if (!this.notifyLog) return;
          try {
            this.notifyLog({ sessionId, groupId, processName: STOP_PROCESS_NAME, line, stream });
          } catch (err) {
            this.logger.warn(`[dev-server ${groupId}] notifyLog threw: ${(err as Error).message}`);
          }
        },
      });
      const summary = describeStopExit(result);
      if (result.timedOut || result.exit.error || result.exit.signal || result.exit.code) {
        this.logger.warn(`[dev-server ${groupId}] ${summary}`);
      } else {
        this.logger.log(`[dev-server ${groupId}] ${summary}`);
      }
    } catch (err) {
      this.logger.warn(`[dev-server ${groupId}] stopCommand threw: ${(err as Error).message}`);
    }
  }

  /**
   * SIGTERM → grace → SIGKILL a pid that has no live `SessionEnv`.
   *
   * Signals the process group first (the spawn is a group leader, so
   * this reaches `npm` → `vite` grandchildren) and falls back to the
   * bare pid. Returns once the process is gone or the grace window has
   * elapsed and SIGKILL has been sent.
   */
  /**
   * SIGKILL a pid whose port reservation is being reclaimed. Routed
   * through the injected `kill` so tests never signal a real process.
   */
  private readonly killReclaimedPid = (pid: number): void => {
    for (const target of [-pid, pid]) {
      try {
        this.killFn(target, 'SIGKILL');
        return;
      } catch {
        // ESRCH: already gone, or not a group leader — try the bare pid.
      }
    }
  };

  private async terminateOrphanPid(pid: number, devServerId: string): Promise<void> {
    const signal = (sig: NodeJS.Signals | 0): boolean => {
      for (const target of [-pid, pid]) {
        try {
          this.killFn(target, sig);
          return true;
        } catch {
          // ESRCH on the group form is expected when the child was not a
          // group leader; retry the bare pid before giving up.
        }
      }
      return false;
    };

    if (!signal('SIGTERM')) return; // Already gone.

    const deadline = this.clock.nowMs() + this.disposeGraceMs;
    const pollMs = Math.max(1, Math.min(100, Math.floor(this.disposeGraceMs / 5)));
    while (this.clock.nowMs() < deadline) {
      await this.clock.sleep(pollMs);
      if (!signal(0)) return; // Exited within the grace window.
    }

    if (signal('SIGKILL')) {
      this.logger.warn(
        `[dev-server] pid ${pid} for ${devServerId} ignored SIGTERM; sent SIGKILL before releasing its port`,
      );
    }
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
   * pane, same contract as `listActive`.
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
   * Base URL the **Hub process itself** can use to reach a dev server port,
   * rather than the client-facing proxy URL, which the server-side drive
   * browser cannot resolve.
   *
   * Mirrors the health-check target exactly, including the session's own dial
   * host: pass `sessionId` whenever it is known, or a container-routed session
   * resolves to the Hub-wide default and the drive browser screenshots
   * whatever else happens to answer there.
   */
  serverReachableUrlForPort(port: number, sessionId?: string): string {
    if (sessionId) {
      const host = this.getSessionUpstreamHost(sessionId);
      // Use a discovered host verbatim — wrapping 127.0.0.1 in probeUrlBase
      // would translate it back to the docker-host gateway.
      if (host) return `http://${host}:${port}`;
    }
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
   * older runtimes.
   */
  getSessionUpstreamPort(sessionId: string, internalPort?: number): number | null {
    const row = this.getActiveBySessionId(sessionId);
    if (!row || row.status !== 'ready') return null;
    if (internalPort === undefined) return row.port > 0 ? row.port : null;
    const match = this.getPorts(row.id).find((p) => p.internalPort === internalPort);
    return match && match.hostPort > 0 ? match.hostPort : null;
  }

  /**
   * Host the preview proxy should dial for `sessionId`, or null to use the
   * Hub-wide default.
   *
   * Loopback is only correct when the env publishes its ports onto the host.
   * A container env under container-IP routing publishes nothing and answers
   * on its own bridge address, so dialing loopback would reach either
   * nothing or — worse — an unrelated process that happens to hold the port.
   */
  getSessionUpstreamHost(sessionId: string): string | null {
    const row = this.getActiveBySessionId(sessionId);
    if (!row) return null;
    const record = this.active.get(row.id);
    // A host-adapter process that answered on the Hub's own loopback must
    // pin that host so the proxy does not follow AGENT_HUB_PREVIEW_HEALTH_HOST
    // out to the docker gateway, where the port was never published.
    if (record?.probeHost) return record.probeHost;
    const env = record?.env;
    if (!env || env.disposed) return null;
    // Every mapping in one env shares a dial host, so the first is enough.
    const host = env.listPortMappings()[0]?.host;
    if (!host) return null;
    // A loopback mapping with no discovered probe host means "reach me on
    // the host". Returning null hands that to the Hub-wide default (the
    // docker-host gateway when the Hub itself is containerized).
    return isLoopbackHost(host) ? null : host;
  }

  /**
   * The dial host worth telling the dev server about, or null.
   *
   * Same rule as {@link getSessionUpstreamHost}, applied to a mapping in hand
   * during startup rather than to a row that is not `ready` yet — the allowlist
   * has to be in the spawn env before the process starts, which is strictly
   * before the proxy can ask where to dial.
   */
  private upstreamHostForDialHost(dialHost: string | null): string | null {
    if (!dialHost || isLoopbackHost(dialHost)) return null;
    return dialHost;
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
    const sessionId =
      this.active.get(devServerId)?.sessionId ??
      (
        this.db
          .prepare(`SELECT session_id AS sessionId FROM worktree_preview_groups WHERE id = ?`)
          .get(devServerId) as { sessionId: string } | undefined
      )?.sessionId;
    if (sessionId) this.onSessionActivity?.(sessionId);
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
      const ttlRaw = project?.prEnv?.devServer?.idleTTL;
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
    opts: StartDevServerOpts = {},
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
    // Everything from here to the first health probe can take minutes (container
    // create, apt packages, install, first compile) while emitting nothing at
    // all. Mark the entry so a start that stalls can be told apart from one that
    // was declined upstream or never arrived.
    this.logger.log(
      `[dev-server] starting ${project.id} for session ${sessionId}: ${JSON.stringify(cfg.startCommand)} (ports ${entries.map((e) => e.internalPort).join(', ')})`,
    );

    const reclaimed = reclaimFailedPortsInRange(
      this.db,
      this.portRange.min,
      this.portRange.max,
      this.killReclaimedPid,
    );
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

    // The env has to be resolved before any port is reserved: whether a
    // reservation should draw from the host pool at all depends on how the
    // env is reached (see `reserveRows`).
    const reservedByInternal = new Map<number, number>();
    let env: SessionEnv;
    let ownsEnv = false;
    try {
      // Prefer the session's own environment so the preview, the terminal,
      // and anything the agent runs share one boundary.
      const shared = this.resolveSharedEnv ? await this.resolveSharedEnv(sessionId) : null;
      if (shared) {
        env = shared;
      } else {
        ownsEnv = true;
        env = this.createEnv({
          sessionId,
          worktreePath,
          // Only ever called under published-ports routing, and only from
          // `mapPortsOut` below — by which point `reserveRows` has filled the
          // map. Container-IP routing publishes nothing and never calls this.
          allocateHostPort: (internalPort) => {
            const hostPort = reservedByInternal.get(internalPort);
            if (hostPort === undefined) {
              throw new Error(`No reserved host port for internal port ${internalPort}`);
            }
            return hostPort;
          },
        });
      }
    } catch (err) {
      // Adapter construction can fail (for example, a selected sysbox
      // backend becoming unavailable after the boot probe). Do not
      // strand the group row on that failure path.
      this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
      throw err;
    }

    let reserved: ReservedEntry[];
    try {
      reserved = await this.reserveRows(groupId, sessionId, entries, names, env.portRouting);
      for (const r of reserved) reservedByInternal.set(r.internalPort, r.hostPort);
    } catch (err) {
      // An env this call created has no other owner yet, so it must not
      // outlive the failed start.
      if (ownsEnv) {
        await env.dispose({ graceMs: this.disposeGraceMs }).catch((disposeErr) => {
          this.logger.warn(
            `[dev-server] env dispose after failed reservation threw: ${(disposeErr as Error).message}`,
          );
        });
      }
      this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
      throw err;
    }
    const primaryEntry = reserved.find((r) => r.primary)!;

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
      ownsEnv,
      stopping: false,
      probeHost: null,
    };
    this.active.set(groupId, record);

    let primaryEnvPort: number;
    let primaryDialHost: string | null = null;
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
      primaryDialHost = mappings[0].host;
      // The env decides where a port actually answers, so it — not the
      // reservation — is the authority. They diverge whenever the env was not
      // created by this call: a session-owned env comes from the manager without
      // the pooled allocator, so a published-ports adapter falls back to
      // identity mapping while the reserved row still holds a pool number. The
      // row feeds the health probe, the proxy, and the client URL, so leaving it
      // stale means dialing a port nothing listens on — every preview times out
      // or 502s, with the app itself perfectly healthy.
      this.adoptEnvPortMappings(reserved, orderedInternalPorts, mappings, sessionId);
      record.primaryHostPort = primaryEntry.hostPort;
      record.primaryUrl = this.portClientUrl({
        sessionId,
        hostPort: primaryEntry.hostPort,
        internalPort: primaryEntry.internalPort,
        primary: true,
      });
    } catch (err) {
      await this.rollbackStart(groupId, record, project.id);
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
      hostPort: primaryEntry.hostPort,
      composeProjectName: composeProjectNameForSession(sessionId),
      // Only when it is the env's own address. A loopback mapping means the
      // Hub reaches the process over the gateway translation it already has
      // configured, so overriding it here would name the wrong side.
      upstreamHost: this.upstreamHostForDialHost(primaryDialHost),
    });
    if (missingSecretKeys.length > 0) {
      this.logger.warn(
        `[dev-server ${groupId}] secretKeys not found in project secrets: ${missingSecretKeys.join(', ')}`,
      );
    }

    // Install OS-level packages (apt) before the app starts. Runs only on the
    // sysbox backend (isolated rootless container); the host backend skips
    // with a warning rather than mutating the shared host. Runs AFTER secret
    // resolution so an install that needs registry/proxy credentials or
    // `APT_*` from `prEnv.devServer` gets the same env the dev server does. A
    // failed install fails the start — the app declared it needs these libs.
    if (cfg.aptPackages.length > 0) {
      try {
        const depsResult = await installDevServerSystemDeps({
          env,
          aptPackages: cfg.aptPackages,
          spawnEnv,
          logger: this.logger,
          onLine: (line, stream) => {
            appendPreviewLogTailLine(record.tail, line, this.logTailLines);
            if (this.notifyLog) {
              try {
                this.notifyLog({
                  sessionId,
                  groupId,
                  processName: SYSTEM_DEPS_PROCESS_NAME,
                  line,
                  stream,
                });
              } catch (err) {
                this.logger.warn(
                  `[dev-server ${groupId}] notifyLog threw: ${(err as Error).message}`,
                );
              }
            }
          },
        });
        if (depsResult.ran && depsResult.exit && depsResult.exit.code !== 0) {
          throw new Error(
            `system dependency install failed: ${describeSystemDepsExit(depsResult.exit)}`,
          );
        }
      } catch (err) {
        await this.rollbackStart(groupId, record, project.id);
        throw err;
      }
    }

    const processName = primaryEntry.name;

    // Build step. Runs to completion BEFORE startCommand (after apt install, so
    // a build can rely on native libs). Skipped on a "Restart Server" restart
    // (opts.skipBuild): the build's on-disk output (node_modules, compiled
    // artifacts) survives on the worktree across the stop+start, so re-running
    // the command would only repeat work. A non-zero build exit fails the
    // start: the project declared the build a hard prerequisite of the server.
    if (cfg.buildCommand && !opts.skipBuild) {
      try {
        const buildResult = await runDevServerBuild({
          env,
          buildCommand: cfg.buildCommand,
          cwd: cfg.cwd,
          spawnEnv,
          onLine: (line, stream) => {
            appendPreviewLogTailLine(record.tail, line, this.logTailLines);
            if (this.notifyLog) {
              try {
                this.notifyLog({
                  sessionId,
                  groupId,
                  processName: BUILD_PROCESS_NAME,
                  line,
                  stream,
                });
              } catch (err) {
                this.logger.warn(
                  `[dev-server ${groupId}] notifyLog threw: ${(err as Error).message}`,
                );
              }
            }
          },
        });
        if (buildResult.exit.code !== 0 || buildResult.exit.error || buildResult.exit.signal) {
          throw new Error(
            withBootDiagnostic(`build failed: ${describeBuildExit(buildResult.exit)}`, record.tail),
          );
        }
      } catch (err) {
        await this.rollbackStart(groupId, record, project.id);
        throw err;
      }
    }

    const healthPath = cfg.healthPath ?? '/';
    const companionPorts = reserved
      .filter((r) => !r.primary)
      .map((r) => ({ label: r.name, hostPort: r.hostPort }));
    // The host allocator can only inspect the Hub's own network namespace.
    // Before the process starts, snapshot fallback URLs that already answer
    // through the docker-host gateway. The new preview cannot own those
    // sockets, so health checks must never select them as its upstream.
    const preexistingProbeUrls = await this.findPreexistingFallbackProbeUrls(primaryDialHost, [
      { port: primaryEntry.hostPort, path: healthPath },
      ...companionPorts.map((entry) => ({ port: entry.hostPort, path: '/' })),
    ]);

    let proc: SessionEnvProcess;
    try {
      proc = env.spawn(cfg.startCommand, {
        cwd: cfg.cwd,
        env: spawnEnv,
        name: `dev-server:${sessionId}`,
      });
    } catch (err) {
      await this.rollbackStart(groupId, record, project.id);
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

    const readyTimeoutMs = cfg.readyTimeoutMs ?? this.readyTimeoutMs;
    // Every declared portMap entry is a browsable surface the user can open in
    // the pane, so readiness must gate on ALL of them binding — not just the
    // primary. A multi-service stack (e.g. web + api) that flips to ready the
    // moment the primary answers leaves the user staring at a connection error
    // when they open the companion port that has not started listening yet.
    void this.runHealthCheck(
      groupId,
      primaryDialHost,
      primaryEntry.hostPort,
      healthPath,
      readyTimeoutMs,
      companionPorts,
      preexistingProbeUrls,
    ).catch((err) => {
      this.logger.error(`[dev-server ${groupId}] health check crashed: ${(err as Error).message}`);
    });

    return { devServerId: groupId, url: record.primaryUrl, port: primaryEntry.hostPort };
  }

  /**
   * Release the env behind a stopping dev server.
   *
   * An env this runtime created is disposed outright. A session-owned env is
   * only relieved of *this* dev server's process — the session, its terminal,
   * and its backing services keep running.
   */
  private async releaseEnv(record: ActiveDevServer, label: string): Promise<void> {
    try {
      if (record.ownsEnv) {
        await record.env.dispose({ graceMs: this.disposeGraceMs });
      } else {
        record.proc?.kill('SIGTERM');
      }
    } catch (err) {
      this.logger.warn(`[dev-server] env release failed for ${label}: ${(err as Error).message}`);
    }
  }

  /** Undo a partially-started group: release the env, drop the rows. */
  private async rollbackStart(
    groupId: string,
    record: ActiveDevServer,
    projectId: string,
  ): Promise<void> {
    record.stopping = true;
    // Same teardown as a normal stop: a start that got far enough to launch
    // daemon-owned resources (e.g. a `buildCommand` that runs `docker compose
    // up -d` before a later step fails) must `down` them here, or they leak
    // and squat the port exactly as an un-reaped stack would. Runs while the
    // env is still live, before it is released.
    await this.runStopHook(groupId, record.sessionId, projectId, record.env);
    await this.reapSessionComposeStack(record.sessionId, groupId, { removeVolumes: false });
    await this.releaseEnv(record, groupId);
    this.active.delete(groupId);
    this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
  }

  /**
   * Reserve one row per port entry, in the port space the env is reached in.
   *
   * Under **published-ports** routing the Hub dials a host port, so the
   * primary draws from the shared pool (its number is injected as `PORT`) and
   * extras take their configured port by identity. Both compete host-wide.
   *
   * Under **container-IP** routing nothing is published: the process binds its
   * configured internal port inside the env's own network namespace and the
   * Hub dials the env directly. A pooled host port would be worse than
   * wasteful — it would be the wrong number to dial, which is precisely the
   * bug this split fixes. Ports are namespaced per session, so there is no
   * pool to draw from, no host-wide collision to lose, and no reason to probe
   * the host for a squatter.
   */
  private async reserveRows(
    groupId: string,
    sessionId: string,
    entries: DevServerPortMapEntry[],
    names: string[],
    routing: SessionEnvPortRouting,
  ): Promise<ReservedEntry[]> {
    const reserved: ReservedEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const primary = entry.primary === true;
      if (routing === 'container-ip') {
        reserved.push(
          this.reserveEnvScopedRow(groupId, sessionId, names[i], entry.internalPort, primary),
        );
      } else if (primary) {
        reserved.push(
          await this.reservePooledRow(groupId, sessionId, names[i], entry.internalPort),
        );
      } else {
        reserved.push(
          await this.reserveIdentityRow(groupId, sessionId, names[i], entry.internalPort),
        );
      }
    }
    return reserved;
  }

  /**
   * Rewrites reservations that the env did not honor, in place and in the row.
   *
   * A reservation is a request; `mapPortsOut` is the answer. An adapter is free
   * to return something else — the identity fallback when it has no allocator is
   * the case that happens in production — and everything downstream reads the
   * row, so the row has to carry the answer.
   *
   * A rewrite can collide with another group's host-port reservation, in which
   * case the UPDATE throws on the partial unique index. That is the correct
   * outcome: two live previews cannot share one host port, and the caller
   * rolls the start back rather than publishing a URL that serves the other
   * session's app.
   */
  private adoptEnvPortMappings(
    reserved: ReservedEntry[],
    orderedInternalPorts: number[],
    mappings: SessionEnvPortMapping[],
    sessionId: string,
  ): void {
    for (let i = 0; i < orderedInternalPorts.length; i++) {
      // `hostPort` is the port the Hub dials, which is the only one the row
      // means. Not `envPort` — a publishing adapter translates, so the process
      // binds its internal port while the Hub reaches it on another, and taking
      // that one would break the case this is meant to protect.
      const dialPort = mappings[i]?.hostPort;
      if (dialPort === undefined) continue;
      const entry = reserved.find((r) => r.internalPort === orderedInternalPorts[i]);
      if (!entry || entry.hostPort === dialPort) continue;

      const url = this.portClientUrl({
        sessionId,
        hostPort: dialPort,
        internalPort: entry.internalPort,
        primary: entry.primary,
      });
      this.db
        .prepare(`UPDATE worktree_preview_processes SET port = ?, url = ? WHERE id = ?`)
        .run(dialPort, url, entry.rowId);
      this.logger.warn(
        `[dev-server] ${entry.name}: env dials internal ${entry.internalPort} on ${dialPort}, ` +
          `not the reserved ${entry.hostPort}; following the env`,
      );
      entry.hostPort = dialPort;
    }
  }

  /**
   * Reservation for a port living inside the session env. The dialed port is
   * the internal port, and `UNIQUE(group_id, name)` is the only uniqueness
   * that applies — a conflict there means this group already reserved the
   * name, which is a programming error rather than a port race.
   */
  private reserveEnvScopedRow(
    groupId: string,
    sessionId: string,
    name: string,
    internalPort: number,
    primary: boolean,
  ): ReservedEntry {
    const inserted = this.tryInsertProcessRow(
      groupId,
      sessionId,
      name,
      internalPort,
      internalPort,
      primary,
      'env',
    );
    if (!inserted) {
      throw new Error(`Dev-server port entry "${name}" is already reserved for this preview group`);
    }
    return inserted;
  }

  /**
   * Pool-allocated reservation for the primary port. Bounded retry on
   * host-port uniqueness — the loser of a concurrent-start race
   * reclaims failed holders and picks the next free port.
   */
  private async reservePooledRow(
    groupId: string,
    sessionId: string,
    name: string,
    internalPort: number,
  ): Promise<ReservedEntry> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const hostPort = await this.allocatePort();
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
      reclaimFailedPortHolder(this.db, hostPort, this.killReclaimedPid);
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
  private async reserveIdentityRow(
    groupId: string,
    sessionId: string,
    name: string,
    internalPort: number,
  ): Promise<ReservedEntry> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = this.tryInsertProcessRow(
        groupId,
        sessionId,
        name,
        internalPort,
        internalPort,
        false,
      );
      if (inserted) {
        // An extra port can't be steered via PORT, so the process will
        // bind this exact number. If something already holds it the
        // proxy would tunnel to that stranger instead — fail the start
        // rather than serve someone else's app on this session's URL.
        if (!(await this.isPortFree(internalPort))) {
          this.db
            .prepare(`DELETE FROM worktree_preview_processes WHERE id = ?`)
            .run(inserted.rowId);
          throw new Error(
            `Dev-server port ${internalPort} ("${name}") is already in use by a process the Hub does not manage. ` +
              'Stop whatever is listening on it, or change the portMap entry.',
          );
        }
        return inserted;
      }
      reclaimFailedPortHolder(this.db, internalPort, this.killReclaimedPid);
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
    dialScope: PreviewDialScope = 'host',
  ): ReservedEntry | null {
    const rowId = randomUUID();
    const url = this.portClientUrl({ sessionId, hostPort, internalPort, primary });
    try {
      this.db
        .prepare(
          `INSERT INTO worktree_preview_processes
             (id, group_id, name, pid, port, url, log_path, status, internal_port,
              is_primary, dial_scope)
           VALUES (?, ?, ?, NULL, ?, ?, NULL, 'starting', ?, ?, ?)`,
        )
        .run(rowId, groupId, name, hostPort, url, internalPort, primary ? 1 : 0, dialScope);
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
      throw err;
    }
    return { rowId, name, internalPort, hostPort, primary };
  }

  /**
   * Next port that is free **both** in the pool table and on the host.
   *
   * The DB check alone is not enough: teardown paths exist that delete a
   * process row without confirming the process died, so a port can read
   * as free while an orphaned dev server still holds the socket. Handing
   * that port out makes the proxy serve the orphan's app under this
   * session's URL. Probing the socket demotes that from a silent
   * wrong-app preview to "the allocator skipped a busy port".
   */
  private async allocatePort(): Promise<number> {
    const taken = new Set(
      (
        this.db
          .prepare(
            // dial_scope: an env-scoped row's port is inside a container's
            // network namespace, so it holds nothing on the host and must not
            // subtract from the pool — otherwise a session serving 4200
            // silently removes host port 4200 from every other session.
            `SELECT port FROM worktree_preview_processes
              WHERE port BETWEEN ? AND ?
                AND status IN ('pending','starting','ready')
                AND dial_scope = 'host'`,
          )
          .all(this.portRange.min, this.portRange.max) as Array<{ port: number }>
      ).map((r) => r.port),
    );
    const squatted: number[] = [];
    for (let p = this.portRange.min; p <= this.portRange.max; p++) {
      if (taken.has(p)) continue;
      if (!(await this.isPortFree(p))) {
        squatted.push(p);
        continue;
      }
      if (squatted.length > 0) {
        this.logger.warn(
          `[dev-server] skipped ${squatted.length} untracked in-use port(s) before allocating ${p}: ${squatted.join(', ')}. ` +
            'These are held by processes the Hub no longer tracks (orphaned dev servers); ' +
            'stop them to return the ports to the pool.',
        );
      }
      return p;
    }
    throw new Error(
      `Dev-server port pool exhausted: all ports in [${this.portRange.min}, ${this.portRange.max}] are in use ` +
        `(${taken.size} tracked by the Hub, ${squatted.length} held by untracked processes)`,
    );
  }

  /**
   * Base URL for probing a dev server, given the host its env reports.
   *
   * `healthUrlBase` translates loopback for a Hub inside Docker
   * (`AGENT_HUB_PREVIEW_HEALTH_HOST`). That translation is right for a
   * published port and wrong for an env that answers on its own address:
   * probing the docker-host gateway for a port nothing published reaches
   * either nothing or an unrelated process holding that number, and the
   * preview times out looking like a dev server that never booted.
   *
   * Host-adapter processes spawned inside the Hub container bind in this
   * netns, so {@link probeUrlCandidates} tries loopback *before* the
   * gateway rather than replacing loopback with it.
   */
  private probeUrlBase(dialHost: string | null, port: number): string {
    if (dialHost && !isLoopbackHost(dialHost)) return `http://${dialHost}:${port}`;
    return this.healthUrlBase(port);
  }

  /**
   * Probe URLs for a mapped port. Container-IP envs have one candidate.
   * Loopback mappings try the Hub's own loopback first (co-resident
   * `tsx` / `npm run dev`) and then `healthUrlBase` (a port published
   * onto the docker host, e.g. `docker compose up` as the start command).
   */
  private probeUrlCandidates(dialHost: string | null, port: number): string[] {
    if (dialHost && !isLoopbackHost(dialHost)) return [`http://${dialHost}:${port}`];
    const loopback = `http://127.0.0.1:${port}`;
    const translated = this.healthUrlBase(port);
    if (translated === loopback) return [loopback];
    return [loopback, translated];
  }

  /**
   * Find fallback candidates that answered before this preview process
   * existed. Such a response belongs to a different network namespace or
   * stale service and must not be accepted as readiness for this session.
   */
  private async findPreexistingFallbackProbeUrls(
    dialHost: string | null,
    probes: Array<{ port: number; path: string }>,
  ): Promise<Set<string>> {
    const fallbackUrls = probes.flatMap(({ port, path }) =>
      this.probeUrlCandidates(dialHost, port)
        .slice(1)
        .map((base) => `${base}${path}`),
    );
    const occupied = new Set<string>();
    await Promise.all(
      fallbackUrls.map(async (url) => {
        try {
          await this.fetch(url, DevServerRuntime.CANDIDATE_PREFLIGHT_TIMEOUT_MS);
          occupied.add(url);
        } catch {
          // Nothing answered before spawn, so this remains a valid fallback.
        }
      }),
    );
    return occupied;
  }

  /** Pin the proxy to Hub loopback when that is what the probe actually hit. */
  private rememberLoopbackProbeHost(groupId: string, healthUrl: string): void {
    let hostname: string;
    let gatewayHost: string;
    try {
      hostname = new URL(healthUrl).hostname;
      gatewayHost = new URL(this.healthUrlBase(0)).hostname;
    } catch {
      return;
    }
    if (!isLoopbackHost(hostname) || isLoopbackHost(gatewayHost)) return;
    const record = this.active.get(groupId);
    if (record) record.probeHost = hostname;
  }

  private async runHealthCheck(
    groupId: string,
    dialHost: string | null,
    hostPort: number,
    healthPath: string,
    readyTimeoutMs: number,
    companionPorts: Array<{ label: string; hostPort: number }> = [],
    preexistingProbeUrls: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const candidateUrls = this.probeUrlCandidates(dialHost, hostPort)
      .map((base) => `${base}${healthPath}`)
      .filter((url) => !preexistingProbeUrls.has(url));
    let healthUrl: string | null = null;
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
    // True once the primary answers 2xx. Kept apart from readiness so the
    // failure reason can tell "primary never went 2xx" from "primary is fine
    // but a companion port never came up".
    let primaryReady = false;
    // Companion host ports that have accepted a connection. A bound port stays
    // bound, so probing it again is wasted work — track and skip.
    const boundCompanions = new Set<number>();
    for (;;) {
      if (this.clock.nowMs() >= deadline) break;
      const status = this.getStatus(groupId);
      // Stopped (row gone) or already terminal — nothing left to probe.
      if (status !== 'starting') return;
      try {
        const urls: string[] = healthUrl ? [healthUrl] : candidateUrls;
        let res: { ok: boolean; status: number } | null = null;
        for (const url of urls) {
          try {
            res = await this.fetch(url);
            const isPreferredCandidate = url === candidateUrls[0];
            // A response from the preferred candidate proves the intended
            // socket exists, even if the app still returns 4xx/5xx. A fallback
            // remains provisional until it is healthy so loopback gets another
            // chance on the next poll instead of being bypassed forever.
            if (isPreferredCandidate || res.ok) {
              healthUrl = url;
              this.rememberLoopbackProbeHost(groupId, url);
            }
            break;
          } catch {
            // This candidate is not bound yet; try the next (loopback vs gateway).
          }
        }
        if (res === null) {
          // No candidate accepted a connection — still building/booting.
          await this.clock.sleep(this.healthIntervalMs);
          continue;
        }
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
          primaryReady = true;
          // Hold in `starting` until every companion port is listening too, so
          // the pane never renders a ready preview whose other service refuses
          // the connection at the socket level.
          const companionHost = healthUrl ? new URL(healthUrl).hostname : dialHost;
          if (
            await this.allCompanionsBound(
              companionHost,
              companionPorts,
              boundCompanions,
              preexistingProbeUrls,
            )
          ) {
            this.markReady(groupId);
            return;
          }
        }
      } catch {
        // Not bound yet — still building/booting; poll again.
      }
      await this.clock.sleep(this.healthIntervalMs);
    }
    if (this.getStatus(groupId) !== 'starting') return;
    // Distinct failures, each naming what it actually got: never bound (full
    // budget spent booting), bound-in-budget (full rebased window granted, no
    // 2xx), bound-over-budget (rebase refused, no post-bind window), and
    // primary-ready-but-a-companion-never-listened.
    const unboundCompanions = companionPorts.filter((c) => !boundCompanions.has(c.hostPort));
    const reason =
      boundAtMs === null
        ? `health check timed out after ${readyTimeoutMs}ms (port never bound)`
        : !primaryReady
          ? rebased
            ? `health check timed out ${readyTimeoutMs}ms after the port bound (no 2xx from ${healthPath})`
            : `port bound at +${boundAtMs - startedAt}ms, after the ${readyTimeoutMs}ms boot budget expired (no 2xx from ${healthPath})`
          : `primary port is ready but companion port(s) never started listening: ${unboundCompanions
              .map((c) => `${c.label} (:${c.hostPort})`)
              .join(', ')}`;
    await this.markFailed(groupId, reason);
  }

  /**
   * Probe every not-yet-bound companion port and record the ones that answer.
   * A resolved fetch — any HTTP status, including 4xx/5xx — means the socket is
   * bound; only a connection error means the service has not started listening.
   * Returns true once all companions are bound (trivially true with none).
   */
  private async allCompanionsBound(
    dialHost: string | null,
    companionPorts: Array<{ label: string; hostPort: number }>,
    bound: Set<number>,
    preexistingProbeUrls: ReadonlySet<string> = new Set(),
  ): Promise<boolean> {
    const pending = companionPorts.filter((c) => !bound.has(c.hostPort));
    if (pending.length === 0) return true;
    await Promise.all(
      pending.map(async (c) => {
        const url = dialHost
          ? `http://${dialHost}:${c.hostPort}/`
          : `${this.probeUrlBase(null, c.hostPort)}/`;
        if (preexistingProbeUrls.has(url)) return;
        try {
          await this.fetch(url);
          bound.add(c.hostPort);
        } catch {
          // Not listening yet — leave it pending for the next tick.
        }
      }),
    );
    return companionPorts.every((c) => bound.has(c.hostPort));
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
    // Surface a host-level infra cause (e.g. Docker address-pool exhaustion at
    // compose-up) buried in the boot log, so the reason names the self-serve
    // fix instead of a bare exit/timeout. No-op when nothing matches.
    if (record) reason = withBootDiagnostic(reason, record.tail);
    // Tear down the whole env, not only the top-level process handle. A
    // health timeout can leave grandchildren alive; SessionEnv.dispose
    // owns the process-group SIGTERM → SIGKILL grace and port release.
    if (record && !record.env.disposed) {
      await this.releaseEnv(record, groupId);
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
