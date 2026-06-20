/**
 * Docker-compose worktree preview runtime.
 *
 * Per-session compose orchestration for worktree previews — see the ADR
 * page `worktree-previews-compose-pivot-adr` on the wiki. PR 1 shipped
 * the skeleton + schema, PR 2 wired the runtime into the chat handler,
 * and PR 3 converted the surveytracker project's prEnv from the legacy
 * `./quickstart` spawn to `preview.compose.entryService = 'frontend'`
 * targeting `compose.preview.yml`. PR 4 removes the legacy spawn path.
 *
 * Lifecycle:
 *
 *   1. `startPreview(sessionId, project, worktreePath)` allocates one
 *      host port from a configurable range, builds the compose argv
 *      (`docker compose -p agenthub-session-<sessionId> -f <file>
 *       [--env-file …] up -d`), spawns it, then polls
 *      `http://<urlBase>:<port><healthPath>` until 2xx or the configured
 *      `readyTimeoutMs` elapses.
 *
 *   2. `stopPreview(groupId)` spawns `docker compose -p <proj> down -v`
 *      (volumes scoped to the compose project), then best-effort
 *      `docker volume rm` for the project (so a failed `down` does not
 *      leak postgres/node_modules volumes), and removes the group row.
 *      Idempotent.
 *
 *   3. `stopBySessionId(sessionId)` tears every compose group owned by
 *      `sessionId` down — used by the session-delete hook (PR 2).
 *
 *   4. `touchPreview(groupId)` bumps `last_active_at` so the reaper's
 *      idle-TTL clock resets.
 *
 * DB persistence shares the existing `worktree_preview_groups` and
 * `worktree_preview_processes` tables — a compose-managed group has a
 * single process row (name = `entry`, pid = NULL, port = allocated host
 * port) so the legacy port allocator + reaper queries still see compose
 * ports as taken. The differentiator is the new `compose_project_name`
 * column on `worktree_preview_groups`, applied by the constructor via
 * an idempotent `ALTER TABLE … ADD COLUMN` (legacy spawn rows leave the
 * column NULL).
 *
 * Design notes:
 *
 *   - **IO is injectable.** `spawn`, `fetch`, and `clock` flow through
 *     the constructor exactly like `PreviewRuntime`. Tests pass fakes;
 *     production wires the real Node implementations.
 *
 *   - **The runtime owns no PIDs.** Once `docker compose up -d` returns,
 *     the compose CLI hands control back to the OS — we don't track
 *     child PIDs because compose-managed containers are addressed by
 *     project name, not pid. Teardown shells out to
 *     `docker compose down -v` rather than `kill(-pid, SIGTERM)`.
 *
 *   - **Per-session compose-project name** is deterministically
 *     `agenthub-session-<sessionId>`. Persisting it on the group row is
 *     a debugging affordance; the runtime can always re-derive it from
 *     `session_id` after a server restart.
 *
 *   - **Port allocation reuses the legacy pool** by default (4100–4999)
 *     so spawn and compose previews can coexist during the rollout
 *     window. Operators who want isolated ranges set
 *     `preview.compose.hostPortRange` per-project.
 */

import type { Database } from 'better-sqlite3';
import { spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { reclaimFailedPortHolder, reclaimFailedPortsInRange } from './preview-port-reclaim.js';
import {
  WORKTREE_PREVIEWS_SCHEMA,
  WORKTREE_PREVIEW_GROUPS_SCHEMA,
  MIGRATE_LEGACY_PREVIEWS_SQL,
  DEFAULT_PREVIEW_PORT_RANGE,
} from './preview-schema.js';
import type { PreviewComposeConfig, PrEnvPreviewConfig, Project } from '../types.js';
import { mergeProjectSecretsSpawnEnv } from '../project-secrets-spawn.js';
import {
  requireVisibleComposeProjectDirectory,
  resolveComposeProjectDirectory,
  translateContainerPathToHost,
} from './host-path-translation.js';
import {
  removeComposeProjectVolumes as removeComposeProjectVolumesDefault,
  type RemoveComposeProjectVolumesDeps,
} from './preview-compose-volumes.js';
import { filterComposeLogLinesForUi, probePreviewHealth } from './preview-health-fetch.js';
import {
  DEFAULT_PREVIEW_LOG_TAIL_LINES,
  appendPreviewLogTailLine,
  trimPreviewLogTail,
} from './preview-log-tail.js';
import { waitForWorktreeComposeReady } from './worktree-compose-ready.js';
import { previewProxyMountPath } from './preview-public-url.js';

export type RemoveComposeProjectVolumesFn = (deps: RemoveComposeProjectVolumesDeps) => void;

// ─── Types & contracts ──────────────────────────────────────────────────

export interface PortRange {
  readonly min: number;
  readonly max: number;
}

export type ComposeStatus = 'starting' | 'ready' | 'failed';

export interface ComposePreviewRow {
  id: string;
  session_id: string;
  project_id: string;
  port: number;
  url: string;
  compose_project_name: string;
  status: ComposeStatus;
  started_at: string;
  last_active_at: string;
}

export interface StartComposePreviewResult {
  previewId: string;
  url: string;
  port: number;
  composeProjectName: string;
}

/** Minimal `child_process.spawn`-shaped surface, same contract as PreviewRuntime. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface Clock {
  nowMs(): number;
  nowIso(): string;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** A 2xx-or-network-error fetch surface, same contract as PreviewRuntime. */
export type HealthFetchFn = (url: string) => Promise<{ ok: boolean; status: number }>;

/**
 * Writes the per-group compose override YAML to disk and returns the
 * absolute path docker should be pointed at, or `null` when no override
 * should be passed (tests / opt-out installs).
 *
 * Production wires the disk-backed implementation in
 * `preview-runtime-setup.ts`, which writes to
 * `<dataDir>/preview-compose/<groupId>.yml` with 0600 perms. The runtime
 * never reads the file itself; docker is the only consumer.
 */
export type WriteOverrideFileFn = (opts: {
  groupId: string;
  entryService: string;
  hostPort: number;
  entryPort: number;
  /**
   * When set, the override mounts the host worktree on this absolute
   * in-container path so the entry service's file watcher sees agent
   * edits live. The bind source is `.` (resolved by compose against
   * `--project-directory`, which is the host-translated worktree
   * path), so the writer doesn't need the host path itself.
   */
  entryWorkdir?: string;
  /** Subdirectory of the worktree to mount (default `.`). For monorepos. */
  entrySourceDir?: string;
  /**
   * Relative paths under `entryWorkdir` to declare as compose
   * anonymous volumes, "punching holes" in the parent bind so the
   * image's pre-installed contents (node_modules etc.) survive.
   * Ignored when `entryWorkdir` is unset.
   */
  shadowDirs?: string[];
  /**
   * Public-URL path prefix the proxy serves this session under
   * (always ends in `/`, e.g. `/api/sessions/<sid>/preview/proxy/`).
   * Injected into the entry service environment as
   * `AGENT_HUB_PREVIEW_BASE_PATH` so apps can map it to whatever
   * base-URL knob their framework uses (Angular's `--serve-path`,
   * Vite's `base`, Next's `basePath`, CRA's `PUBLIC_URL`). Apps that
   * ignore the var are unaffected — behaviour is unchanged for
   * existing previews.
   */
  previewBasePath?: string;
}) => string | null;

/**
 * Removes a previously-written override file. Best-effort — a missing
 * file (because no override was ever written, because cleanup already
 * ran, or because the operator nuked the dataDir) must not throw.
 * Mirrors {@link WriteOverrideFileFn} as the cleanup half of the same
 * disk seam so test doubles can pair the two without pulling in `fs`.
 */
export type DeleteOverrideFileFn = (overrideFilePath: string) => void;

export interface PreviewComposeRuntimeConfig {
  /** Default host port range when a project doesn't override. */
  portRange?: PortRange;
  /** Default ms to wait for 2xx on healthPath. */
  readyTimeoutMs?: number;
  /** Cadence for the health-check loop. Default 1000. */
  healthIntervalMs?: number;
  /**
   * Cadence for the "still starting" progress heartbeat emitted into the
   * boot-log tail while the health check is waiting on a slow first boot.
   *
   * Compose's `up` blocks on a dependent service's `depends_on:
   * condition: service_healthy`, printing `Container … Waiting` exactly
   * once and then nothing until the dependency goes healthy. For a stack
   * with a heavy first boot (image build, S3 dump restore, migrations) that
   * silent gap can run for minutes, so the preview *looks* hung. The
   * heartbeat appends a periodic, elapsed/remaining-stamped line through the
   * same `notifyLog` + tail path as real boot output, so the client sees the
   * wait is progressing rather than frozen.
   *
   * Default: 15_000 ms. Set to 0 to disable (no heartbeat lines).
   */
  startingHeartbeatMs?: number;
  /**
   * Upper bound on how long a new `startPreview` call will wait on the
   * per-session lock before assuming the prior call wedged and proceeding.
   *
   * `withSessionLock` previously chained promises through an in-memory
   * `Map<sessionId, Promise>` with no TTL. If a prior `_startPreview` ever
   * returned a promise that never settled — an undelivered `child.on('error')`,
   * a `docker compose down` hung inside `stopPreview(existing.id)`, an
   * unhandled rejection swallowed by the global hook — every subsequent
   * `startPreview` for the same sessionId queued behind a dead promise and
   * blocked **forever**, only clearing on server restart.
   *
   * The build-test endpoint reuses a single hardcoded sessionId
   * (`__preview_build_test__<projectId>`) so the wedge was particularly
   * easy to hit in Settings → Preview environment → Build and run:
   * one stuck build permanently bricked the button.
   *
   * Bound the wait so a wedged prior call can't deadlock new calls. When
   * the budget elapses we log a warning, drop the dead entry, and let the
   * new caller proceed. The default (120s) is comfortably larger than any
   * legitimate single `_startPreview` — the longest sub-call is
   * `stopPreview` (30s daemon timeout) plus the synchronous DB / fs work,
   * well under 120s.
   *
   * Tests inject the runtime's `Clock`, which `withSessionLock` uses for
   * the timeout via `clock.sleep`. Production wires the system clock.
   *
   * Default: 120_000 ms (2 min).
   */
  sessionLockTimeoutMs?: number;
  /**
   * Hostname stem for the iframe URL. Defaults to `http://localhost:<port>`.
   * Override for nginx-fronted installs.
   */
  urlBase?: (port: number, sessionId: string) => string;
  /**
   * Host used only for readiness polling. Defaults to {@link urlBase}.
   * When the server runs in Docker but preview stacks are started on the
   * host daemon (bind-mounted `/var/run/docker.sock`), published ports
   * listen on the host — not on the server container's loopback. Set
   * `AGENT_HUB_PREVIEW_HEALTH_HOST=host.docker.internal` (plus
   * `extra_hosts: host-gateway` in compose) so health checks reach the
   * host-published port while the iframe URL stays `localhost` for the
   * browser.
   */
  healthUrlBase?: (port: number) => string;
  /**
   * Default compose-file path when `prEnv.preview.compose.file` is unset.
   * Resolved relative to the worktree root.
   */
  defaultComposeFile?: string;
  /**
   * Default healthPath when `prEnv.preview.compose.healthPath` is unset.
   * Default `/`.
   */
  defaultHealthPath?: string;
  /** Max lines retained in the in-memory boot log tail. Default 120. */
  logTailLines?: number;
}

export type ComposePreviewNotifyLogFn = (info: {
  sessionId: string;
  groupId: string;
  processName: string;
  line: string;
  stream: 'stdout' | 'stderr';
}) => void;

/**
 * Optional callback fired when the background health-check transitions a
 * compose group's status to a terminal state — `ready` once the entry
 * service answers a 2xx, or `failed` on timeout / explicit failure.
 *
 * Why this exists: the chat handler in `handlePreviewBlock` ALSO polls
 * `getById(groupId).status` and broadcasts a `preview` / `preview_failed`
 * event when it sees the flip. That polling loop is bounded by
 * `readyTimeoutMs` and only runs for the lifetime of the chat turn that
 * spawned the preview. Once it exits, no further broadcasts happen for
 * that preview — so if the container becomes ready AFTER the chat
 * handler returns (slow boot, server-side polling lag, or the loop's
 * budget was tighter than the runtime's), or if a WS client reconnects
 * after the chat-handler broadcast already fired, the client never
 * learns that the container is healthy.
 *
 * Wiring `notifyStatus` to the WS broadcast in `server/index.ts` gives
 * us a second, runtime-driven path that fires exactly once per terminal
 * transition, independent of any chat handler.
 *
 * The `logTail` reflects whatever lines are in the runtime's tail at the
 * moment the transition fires — recipients should treat it as
 * informational, not as a complete log.
 */
export type ComposePreviewNotifyStatusFn = (info: {
  sessionId: string;
  groupId: string;
  status: 'ready' | 'failed';
  port: number;
  url: string;
  logTail: string[];
  /** Failure reason when `status === 'failed'`. Unset on `ready`. */
  error?: string;
}) => void;

export interface PreviewComposeRuntimeDeps {
  db: Database;
  spawn: SpawnFn;
  fetch: HealthFetchFn;
  clock?: Clock;
  config?: PreviewComposeRuntimeConfig;
  /** Optional WS fan-out for live boot logs (mirrors PreviewRuntime.notifyLog). */
  notifyLog?: ComposePreviewNotifyLogFn;
  /**
   * Optional WS fan-out for terminal status transitions. See
   * {@link ComposePreviewNotifyStatusFn} for the contract.
   */
  notifyStatus?: ComposePreviewNotifyStatusFn;
  logger?: {
    log: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
  /**
   * Per-group override-file writer. Called once during `startPreview`
   * after a host port has been allocated. The path it returns is passed
   * to compose as a second `-f` flag on every up/down spawn for the
   * group. Defaults to a no-op writer that returns `null` (tests +
   * opt-out installs run without the override file).
   */
  writeOverrideFile?: WriteOverrideFileFn;
  /**
   * Cleanup hook for the override file. Called best-effort after
   * `docker compose down` returns. Defaults to a no-op so the disk
   * stays untouched in tests; production wires an `fs.rm`-based impl in
   * `preview-runtime-setup.ts`.
   */
  deleteOverrideFile?: DeleteOverrideFileFn;
  /**
   * Fallback volume cleanup after `docker compose down`. Production
   * uses {@link removeComposeProjectVolumesDefault}; tests may stub.
   */
  removeComposeProjectVolumes?: RemoveComposeProjectVolumesFn;
  /**
   * Predicate used by the strict {@link requireVisibleComposeProjectDirectory}
   * preflight to check whether the resolved host path is readable inside
   * this process. Defaults to {@link existsSync}. Tests stub this so they
   * don't need to provision real host paths on disk.
   */
  pathExists?: (path: string) => boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Default health-poll budget for compose previews (cold build + DB restore). */
export const DEFAULT_PREVIEW_COMPOSE_READY_TIMEOUT_MS = 600_000; // 10 min
const DEFAULT_READY_TIMEOUT_MS = DEFAULT_PREVIEW_COMPOSE_READY_TIMEOUT_MS;
const DEFAULT_HEALTH_INTERVAL_MS = 1_000;
/** Default cadence for the "still starting" boot-log heartbeat. */
const DEFAULT_STARTING_HEARTBEAT_MS = 15_000;
/**
 * Hard cap on how long `withSessionLock` will wait on a prior call. Two
 * minutes is wider than any legitimate single `_startPreview` (which is
 * dominated by `stopPreview`'s 30s docker-down timeout + synchronous DB
 * / fs work), and narrow enough that a wedged prior call self-clears in
 * a few minutes rather than only on server restart.
 */
const DEFAULT_SESSION_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';
const DEFAULT_HEALTH_PATH = '/';
const DEFAULT_LOG_TAIL_LINES = DEFAULT_PREVIEW_LOG_TAIL_LINES;
const ENTRY_PROCESS_NAME = 'entry';
const COMPOSE_PROJECT_PREFIX = 'agenthub-session-';

/**
 * Maximum length of a docker compose project name. Compose itself
 * enforces a 63-char practical cap (it's used as a label prefix in
 * docker object names); session ids are uuid-shaped (32 hex + 4 dashes
 * = 36) so the prefix + uuid lands at exactly
 * `agenthub-session-` (17) + 36 = 53 chars — well under the cap.
 * Anything longer than 63 is rejected up front so an operator who
 * passes a custom sessionId doesn't hit a cryptic docker error later.
 */
const COMPOSE_PROJECT_MAX_LEN = 63;

// ─── Pure helpers (exported for unit tests) ─────────────────────────────

/**
 * Derive the compose project name for `sessionId`. Deterministic so the
 * teardown path can always reconstruct it without consulting the DB.
 *
 * Throws when the resulting name would exceed compose's effective
 * length cap (63 chars). Session ids are 36-char uuids in practice,
 * which is comfortably within the limit; the guard exists for the
 * "operator passes a custom sessionId" case.
 */
export function composeProjectName(sessionId: string): string {
  const name = `${COMPOSE_PROJECT_PREFIX}${sessionId}`;
  if (name.length > COMPOSE_PROJECT_MAX_LEN) {
    throw new Error(
      `compose project name exceeds ${COMPOSE_PROJECT_MAX_LEN} chars: ${name.length} (sessionId=${sessionId.slice(0, 12)}…)`,
    );
  }
  return name;
}

/**
 * Build the argv passed to `docker compose <args>` for an `up -d` call.
 * Pure function so tests can pin the exact CLI invocation without
 * mocking `child_process`.
 *
 * Order of flags follows compose's own documented precedence:
 *
 *   docker compose -p <proj> -f <file> [-f <override>] [--env-file <env>] up -d --build
 *
 * `--build` is included unconditionally — for a worktree preview we
 * always want the entry-service container to reflect the agent's edits,
 * not a stale image from a prior run.
 *
 * When `overrideFile` is supplied, it is appended as a second `-f` after
 * the primary compose file. Compose merges multiple `-f` files left to
 * right (later wins for scalar fields; list-valued fields like `ports:`
 * APPEND by default — the disk-backed override file uses the `!override`
 * tag to force a replace for the entry service's `ports:` mapping so
 * concurrent sessions don't collide on the base file's static host port).
 *
 * NOTE: this builder produces the **arguments to the `docker` binary**.
 * The caller spawns `docker` with these args; the first element is
 * always `'compose'`.
 */
export function buildComposeUpArgs(opts: {
  composeProjectName: string;
  composeFile: string;
  overrideFile?: string | null;
  envFile?: string;
  /**
   * When set, emits `--project-directory <projectDirectory>` so compose-go
   * resolves relative bind-mount sources against that path before sending
   * absolute paths to the docker daemon. Required when the docker daemon
   * runs on the host but the compose CLI runs inside a container — see
   * {@link translateContainerPathToHost}.
   */
  projectDirectory?: string | null;
}): string[] {
  const args: string[] = ['compose', '-p', opts.composeProjectName];
  if (opts.projectDirectory) {
    args.push('--project-directory', opts.projectDirectory);
  }
  args.push('-f', opts.composeFile);
  if (opts.overrideFile) {
    args.push('-f', opts.overrideFile);
  }
  if (opts.envFile) {
    args.push('--env-file', opts.envFile);
  }
  args.push('up', '-d', '--build');
  return args;
}

/**
 * Build the argv for `docker compose down -v` — the teardown path. The
 * `-v` flag drops compose-project-scoped named volumes so the next
 * `up` starts from a clean state (matches what users get on
 * `docker compose down -v` locally).
 *
 * Mirrors `buildComposeUpArgs` for the `overrideFile` flag so the
 * teardown spawn reproduces the up call's `-f` chain exactly. Without
 * this, a service body that references `${HOST_PORT}` via the override
 * file would emit "variable is not set" warnings on `down` and may
 * refuse to act on the referencing service.
 */
export function buildComposeDownArgs(opts: {
  composeProjectName: string;
  composeFile: string;
  overrideFile?: string | null;
  /** See {@link buildComposeUpArgs}. */
  projectDirectory?: string | null;
}): string[] {
  const args: string[] = ['compose', '-p', opts.composeProjectName];
  if (opts.projectDirectory) {
    args.push('--project-directory', opts.projectDirectory);
  }
  args.push('-f', opts.composeFile);
  if (opts.overrideFile) {
    args.push('-f', opts.overrideFile);
  }
  args.push('down', '-v', '--remove-orphans');
  return args;
}

/** `docker compose restart <service>` — same `-f` / `--project-directory` chain as `up`. */
export function buildComposeRestartArgs(
  opts: {
    composeProjectName: string;
    composeFile: string;
    overrideFile?: string | null;
    projectDirectory?: string | null;
  },
  service: string,
): string[] {
  const args: string[] = ['compose', '-p', opts.composeProjectName];
  if (opts.projectDirectory) {
    args.push('--project-directory', opts.projectDirectory);
  }
  args.push('-f', opts.composeFile);
  if (opts.overrideFile) {
    args.push('-f', opts.overrideFile);
  }
  args.push('restart', service);
  return args;
}

/**
 * Build the YAML body for the disk-backed compose override file. Maps
 * the runtime-allocated `hostPort` to the service's internal
 * `entryPort` so the project's own `docker-compose.yml` can declare the
 * entry service without any Agent-Hub-specific port plumbing.
 *
 * Uses the compose-spec `!override` tag on `ports:` so the runtime's
 * mapping REPLACES whatever the base compose file declared (instead of
 * appending). Without `!override`, compose's default merge strategy
 * for list-valued fields like `ports:` is to concatenate — so a project
 * that ships `ports: ["4200:4200"]` in its base compose file would end
 * up binding both `4200:4200` AND `<allocated>:4200`, and a second
 * concurrent session would EADDRINUSE on the static port. The
 * `!override` tag is supported in compose v2.20+ and is required for
 * the per-session port-allocator contract to hold.
 *
 * Pure helper — exported so tests can pin the exact YAML emitted to disk
 * without standing up the full runtime.
 *
 * ⚠️ Bind-mount trap (PR #1074 reviewer [9/10]):
 *
 *   The override file path is persisted as a container-side path
 *   (`<dataDir>/preview-compose/<groupId>.yml`) and passed to compose
 *   as a second `-f` flag. That works today because the override only
 *   carries `ports: !override` — compose reads the file locally and no
 *   bind-mount resolution touches its path. If a future override stanza
 *   ever declares `volumes:` or any other bind-mounted source, compose
 *   will resolve those paths against the override file's directory and
 *   ship container-side absolute paths to the daemon — which will see
 *   empty dirs on the host. If you add bind mounts here, you MUST
 *   either (a) translate the override file path to its host equivalent
 *   via {@link translateContainerPathToHost} before writing it, or
 *   (b) emit absolute host paths in the override YAML rather than
 *   relative sources. The runtime's per-spawn `--project-directory`
 *   flag only rebases the PRIMARY `-f` file's working dir; it does NOT
 *   rebase additional `-f` overrides.
 */
export function buildComposeOverrideYaml(opts: {
  entryService: string;
  hostPort: number;
  entryPort: number;
  /** See {@link WriteOverrideFileFn} — when set, emits the bind-mount volumes block. */
  entryWorkdir?: string;
  /** Subdirectory of the worktree to mount (default `.`). For monorepos. */
  entrySourceDir?: string;
  /** See {@link WriteOverrideFileFn} — relative paths under `entryWorkdir`. */
  shadowDirs?: string[];
  /** See {@link WriteOverrideFileFn} — public path prefix the proxy serves this session under. */
  previewBasePath?: string;
}): string {
  const lines: string[] = [
    '# Auto-generated by Agent Hub PreviewComposeRuntime.',
    '# Maps the runtime-allocated host port to the entry service.',
    "# `!override` replaces the base compose file's `ports:` list",
    '# entirely so multiple concurrent sessions never collide on a',
    '# statically-declared host port.',
    '# Do not edit by hand — regenerated per `startPreview`.',
    'services:',
    `  ${opts.entryService}:`,
    `    ports: !override`,
    `      - "${opts.hostPort}:${opts.entryPort}"`,
  ];

  if (opts.entryWorkdir) {
    // Bind source `.` resolves relative to --project-directory at
    // compose-up time, which the runtime sets to the host-translated
    // worktree path. Anonymous volumes under entryWorkdir "punch
    // holes" so the image's pre-installed contents (node_modules,
    // .next, dist, …) survive the parent bind. `!override` so the
    // base compose file's `volumes:` list is replaced wholesale —
    // this matches the ports semantics and avoids surprising merges
    // when the base file already declares its own bind.
    // Prefix with ./ so compose treats it as a bind-mount path, not a
    // named volume. Without ./, `frontend:/app` means "named volume
    // called frontend" → "undefined volume" error.
    const raw = (opts.entrySourceDir ?? '.').replace(/^\/+/, '').replace(/\/+$/, '') || '.';
    const sourceDir = raw === '.' ? '.' : `./${raw}`;
    lines.push(`    volumes: !override`);
    lines.push(`      - "${sourceDir}:${opts.entryWorkdir}"`);
    for (const shadow of opts.shadowDirs ?? []) {
      const clean = shadow.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!clean) continue;
      lines.push(`      - "${opts.entryWorkdir.replace(/\/+$/, '')}/${clean}"`);
    }
  }

  if (opts.previewBasePath) {
    // Apps map AGENT_HUB_PREVIEW_BASE_PATH to whatever base-URL knob
    // their framework exposes — Angular `--serve-path`, Vite `base`,
    // Next `basePath`, CRA `PUBLIC_URL`. Without the right base,
    // dev-server-emitted asset URLs (JS modules, HMR WebSocket,
    // manifest) resolve at the Hub root instead of the path-prefixed
    // proxy mount, producing white-screen iframes. Always injected so
    // apps that opt in don't need a per-session restart to pick it
    // up; apps that ignore it are unaffected.
    lines.push(`    environment:`);
    lines.push(`      AGENT_HUB_PREVIEW_BASE_PATH: "${opts.previewBasePath}"`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Resolve the effective {@link PreviewComposeConfig} for a project — fills
 * in defaults from the runtime config so the rest of the runtime can
 * treat every field as defined.
 */
export function resolveComposeConfig(
  raw: PreviewComposeConfig,
  defaults: {
    composeFile: string;
    healthPath: string;
    portRange: PortRange;
    readyTimeoutMs: number;
  },
): {
  file: string;
  entryService: string;
  entryPort: number;
  envFile: string | undefined;
  healthPath: string;
  hostPortRange: PortRange;
  readyTimeoutMs: number;
  entryWorkdir: string | undefined;
  entrySourceDir: string | undefined;
  shadowDirs: string[] | undefined;
} {
  return {
    file: raw.file ?? defaults.composeFile,
    entryService: raw.entryService,
    entryPort: raw.entryPort,
    envFile: raw.envFile,
    healthPath: normaliseHealthPath(raw.healthPath ?? defaults.healthPath),
    hostPortRange: raw.hostPortRange ?? defaults.portRange,
    readyTimeoutMs: raw.readyTimeoutMs ?? defaults.readyTimeoutMs,
    entryWorkdir: raw.entryWorkdir,
    entrySourceDir: raw.entrySourceDir,
    shadowDirs: raw.shadowDirs,
  };
}

function normaliseHealthPath(raw: string): string {
  const v = raw.trim() || '/';
  return v.startsWith('/') ? v : `/${v}`;
}

// ─── Implementation ─────────────────────────────────────────────────────

export class PreviewComposeRuntime {
  private readonly db: Database;
  private readonly spawn: SpawnFn;
  private readonly fetch: HealthFetchFn;
  private readonly clock: Clock;
  private readonly portRange: PortRange;
  private readonly readyTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly startingHeartbeatMs: number;
  private readonly sessionLockTimeoutMs: number;
  private readonly urlBase: (port: number, sessionId: string) => string;
  private readonly healthUrlBase: (port: number) => string;
  private readonly defaultComposeFile: string;
  private readonly defaultHealthPath: string;
  private readonly logger: NonNullable<PreviewComposeRuntimeDeps['logger']>;
  private readonly writeOverrideFile: WriteOverrideFileFn;
  private readonly deleteOverrideFile: DeleteOverrideFileFn;
  private readonly removeComposeProjectVolumes: RemoveComposeProjectVolumesFn;
  private readonly pathExists: (path: string) => boolean;
  private readonly notifyLog?: ComposePreviewNotifyLogFn;
  private readonly notifyStatus?: ComposePreviewNotifyStatusFn;
  private readonly logTailLines: number;

  /** In-memory boot log tail keyed by group id (compose up + daemon logs). */
  private readonly logTails = new Map<string, string[]>();
  private readonly sessionIdByGroup = new Map<string, string>();

  /**
   * The single live log producer per group. During the build phase this
   * is the `docker compose up -d --build` child (its stdio); once that
   * exits 0 it is replaced by a long-lived `docker compose logs --follow`
   * child streaming container runtime stdout. Exactly one producer feeds
   * `logTails` at a time, so the in-memory tail is the single source of
   * truth for both the per-line `preview_log` fan-out and the snapshot
   * reads (`getLogTail` / `snapshotLogTail`). That coherence is what
   * stops the boot log from "looping" — previously the health loop's
   * `docker compose logs --tail` poll replaced the buffer out-of-band,
   * diverging from the live stream the client was appending.
   */
  private readonly liveLogChildren = new Map<string, ChildProcess>();

  /**
   * Groups currently being torn down by `stopPreview`. Guards against a
   * late `up`-child `exit(0)` re-spawning a `logs --follow` follower for a
   * stack we are in the middle of `docker compose down`-ing.
   */
  private readonly stoppingGroups = new Set<string>();

  /**
   * Wall-clock ms at which the `docker compose up -d --build` child exited
   * cleanly (code 0) for a group — i.e. the image build finished and the
   * containers were created/started. The health-check loop reads this to
   * **rebase** its readiness deadline: a slow first-time image build (e.g.
   * surveytracker's `pyproj sync` pulling geodetic grids for minutes) must
   * not eat into the app-readiness budget. Without this rebase the single
   * `readyTimeoutMs` window covers build + start + health, so a long build
   * trips "health check timed out" before the app ever gets a chance.
   * Populated by the up-child `exit` handler; cleared on teardown / failure.
   */
  private readonly buildCompletedAtMs = new Map<string, number>();

  /** Per-session serialization lock — same shape as PreviewRuntime. */
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  constructor(deps: PreviewComposeRuntimeDeps) {
    this.db = deps.db;
    this.spawn = deps.spawn;
    this.fetch = deps.fetch;
    this.clock = deps.clock ?? systemClock;
    this.portRange = deps.config?.portRange ?? DEFAULT_PREVIEW_PORT_RANGE;
    this.readyTimeoutMs = deps.config?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.healthIntervalMs = deps.config?.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.startingHeartbeatMs = deps.config?.startingHeartbeatMs ?? DEFAULT_STARTING_HEARTBEAT_MS;
    this.sessionLockTimeoutMs =
      deps.config?.sessionLockTimeoutMs ?? DEFAULT_SESSION_LOCK_TIMEOUT_MS;
    this.urlBase = deps.config?.urlBase ?? ((p, _sid) => `http://localhost:${p}`);
    this.healthUrlBase = deps.config?.healthUrlBase ?? ((p) => this.urlBase(p, ''));
    this.defaultComposeFile = deps.config?.defaultComposeFile ?? DEFAULT_COMPOSE_FILE;
    this.defaultHealthPath = deps.config?.defaultHealthPath ?? DEFAULT_HEALTH_PATH;
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
    this.writeOverrideFile = deps.writeOverrideFile ?? (() => null);
    this.deleteOverrideFile = deps.deleteOverrideFile ?? (() => undefined);
    this.removeComposeProjectVolumes =
      deps.removeComposeProjectVolumes ?? removeComposeProjectVolumesDefault;
    this.pathExists = deps.pathExists ?? existsSync;
    this.notifyLog = deps.notifyLog;
    this.notifyStatus = deps.notifyStatus;
    this.logTailLines = deps.config?.logTailLines ?? DEFAULT_LOG_TAIL_LINES;
    if (this.portRange.min > this.portRange.max) {
      throw new Error(
        `Invalid compose preview port range: ${this.portRange.min}..${this.portRange.max}`,
      );
    }
    // Apply schema in the same order db.ts uses so a caller that hands
    // us a hand-built DB (tests) gets the same migration semantics as
    // the production wiring.
    this.db.exec(WORKTREE_PREVIEWS_SCHEMA);
    this.db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
    this.db.exec(MIGRATE_LEGACY_PREVIEWS_SQL);
    this.addComposeProjectNameColumnIfMissing();
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Boot a compose preview for `sessionId`. If a group already exists
   * for the session it is torn down first (replace-on-restart). Returns
   * the legacy `previewId` (group row id), the `url` for the iframe, the
   * allocated host `port`, and the derived compose project name.
   *
   * Throws when:
   *   - `project.prEnv.preview.compose` is unset (caller should fall
   *     back to the spawn runtime).
   *   - The port pool is exhausted.
   *   - The compose project name would exceed the docker length cap.
   *
   * Health-check failure does NOT throw — the group is flipped to
   * `failed` in the background and `getById(previewId)` reports it. The
   * caller still gets the `url` so the UI can render the failure state
   * with a "view logs" link.
   */
  async startPreview(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartComposePreviewResult> {
    return this.withSessionLock(sessionId, () =>
      this._startPreview(sessionId, project, worktreePath),
    );
  }

  private async _startPreview(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartComposePreviewResult> {
    const previewCfg: PrEnvPreviewConfig = project.prEnv?.preview ?? { enabled: false };
    if (!previewCfg.compose) {
      throw new Error(
        `PreviewComposeRuntime called for project ${project.id} without prEnv.preview.compose set`,
      );
    }
    const cfg = resolveComposeConfig(previewCfg.compose, {
      composeFile: this.defaultComposeFile,
      healthPath: this.defaultHealthPath,
      portRange: this.portRange,
      readyTimeoutMs: this.readyTimeoutMs,
    });

    // Tear down any prior compose group for this session before booting
    // a new one — same replace-on-restart contract as PreviewRuntime.
    const existing = this.getActiveBySessionId(sessionId);
    if (existing) {
      await this.stopPreview(existing.id);
    }

    const reclaimed = reclaimFailedPortsInRange(
      this.db,
      cfg.hostPortRange.min,
      cfg.hostPortRange.max,
    );
    if (reclaimed > 0) {
      this.logger.log(
        `[preview-compose] reclaimed ${reclaimed} failed preview port(s) in [${cfg.hostPortRange.min}, ${cfg.hostPortRange.max}]`,
      );
    }

    const projectName = composeProjectName(sessionId);
    const groupId = randomUUID();
    this.sessionIdByGroup.set(groupId, sessionId);
    this.logTails.set(groupId, []);

    // Allocate a host port + insert the group row + the single `entry`
    // process row inside one DB transaction so a half-inserted group
    // never lingers if a UNIQUE collision fires on the process row.
    //
    // We persist worktreePath + composeFile + entryPort on the group row
    // so stopPreview can reproduce the up spawn's environment exactly:
    // same cwd (relative `-f` resolves consistently), same compose file
    // (a project that overrides `compose.file` still tears down cleanly),
    // and the same env-var contract (so compose's `down`-time variable
    // interpolation doesn't emit "variable is not set" warnings against
    // services that reference `${AGENTHUB_HOST_PORT}` etc. outside `ports:`).
    const { port, entryRowId } = this.reserveGroup({
      groupId,
      sessionId,
      projectId: project.id,
      hostPortRange: cfg.hostPortRange,
      composeProjectName: projectName,
      worktreePath,
      composeFile: cfg.file,
      entryPort: cfg.entryPort,
    });

    const url = this.urlBase(port, sessionId);
    this.appendComposeLog(
      groupId,
      `[preview-compose] Starting docker compose project ${projectName} on host port ${port}…`,
      'stdout',
    );

    // Write the disk-backed override file (if a writer was injected).
    // The file path is persisted on the group row so the matching
    // `stopPreview` spawns can reproduce the up call's `-f` chain
    // verbatim. A `null` return from the writer (default tests, opt-out
    // installs) skips both the persist + the `-f` flag.
    let overrideFilePath: string | null = null;
    try {
      overrideFilePath = this.writeOverrideFile({
        groupId,
        entryService: cfg.entryService,
        hostPort: port,
        entryPort: cfg.entryPort,
        entryWorkdir: cfg.entryWorkdir,
        entrySourceDir: cfg.entrySourceDir,
        shadowDirs: cfg.shadowDirs,
        previewBasePath: `${previewProxyMountPath(sessionId)}/`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[preview-compose ${groupId}] writeOverrideFile failed: ${reason} (continuing without override)`,
      );
      overrideFilePath = null;
    }
    if (overrideFilePath) {
      this.db
        .prepare(`UPDATE worktree_preview_groups SET override_file_path = ? WHERE id = ?`)
        .run(overrideFilePath, groupId);
    }

    // When the server runs in a container with /var/run/docker.sock
    // bind-mounted in, the docker daemon resolves bind-mount paths on
    // the HOST filesystem — not the container's. Without a
    // `--project-directory` override compose-go resolves relative paths
    // (e.g. `./frontend:/app`) against the container path of the
    // compose file, ships those container-rooted absolute paths to the
    // daemon, and the daemon mounts empty directories. Translate the
    // container `worktreePath` to its host equivalent and pass it
    // through as `--project-directory` so the daemon sees real source.
    const hostProjectDirectoryUp = translateContainerPathToHost(worktreePath);
    let composeProjectDirectory: string;
    try {
      composeProjectDirectory = requireVisibleComposeProjectDirectory(
        worktreePath,
        hostProjectDirectoryUp,
        { pathExists: this.pathExists },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Surface in the preview log tail too — the build-test UI shows this
      // verbatim, so operators get the identity-mount hint directly in the
      // failure message instead of a 600s opaque timeout.
      this.appendComposeLog(groupId, `[preview-compose] ${reason}`, 'stderr');
      await this.markGroupFailed(groupId, reason);
      throw new Error(reason);
    }
    if (
      hostProjectDirectoryUp.hostPath &&
      composeProjectDirectory !== hostProjectDirectoryUp.hostPath
    ) {
      this.logger.log(
        `[preview-compose ${groupId}] using container worktree for --project-directory ` +
          `(${worktreePath}); translated host path is not visible inside this process`,
      );
    } else if (
      hostProjectDirectoryUp.hostPath === null &&
      (process.env.AGENT_HUB_HOST_PROJECTS_DIR || process.env.AGENT_HUB_HOST_WORKSPACES_DIR)
    ) {
      this.logger.warn(
        `[preview-compose ${groupId}] could not translate worktreePath to host path ` +
          `(${hostProjectDirectoryUp.skippedReason ?? 'unknown'}); ` +
          `using ${composeProjectDirectory} for compose`,
      );
    }
    try {
      await waitForWorktreeComposeReady({
        worktreeDir: worktreePath,
        composeFile: cfg.file,
        composeFileDir: worktreePath,
        sleep: (ms) => this.clock.sleep(ms),
        onWaiting: (missing) => {
          this.appendComposeLog(
            groupId,
            `[preview-compose] Waiting for worktree paths in ${worktreePath} ` +
              `(compose file ${cfg.file}): ${missing.join(', ')}…`,
            'stdout',
          );
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.markGroupFailed(groupId, reason);
      throw new Error(reason);
    }
    // Card c79c4bc0 — persist the resolved host path so stopPreview can
    // reproduce the up call's `--project-directory` even if the host env
    // mapping changes between start and stop (server restart with the
    // data dir remounted to a different host path, etc.). Without this,
    // a remount between start and stop would emit an incorrect
    // `--project-directory` on the down spawn, compose-go can't address
    // the named volumes that were created under the old mapping, the
    // `-v` flag fails to drop them, and the allocated port stays
    // claimed until manual cleanup.
    this.db
      .prepare(`UPDATE worktree_preview_groups SET host_project_directory = ? WHERE id = ?`)
      .run(composeProjectDirectory, groupId);

    // Spawn `docker compose up -d --build`. The CLI returns immediately
    // once the containers are dispatched; the health check below is
    // what actually decides "ready". The spawn is best-effort — if
    // it errors synchronously we mark the group failed and return so
    // the caller still gets a previewId to surface logs against.
    const upArgs = buildComposeUpArgs({
      composeProjectName: projectName,
      composeFile: cfg.file,
      overrideFile: overrideFilePath,
      envFile: cfg.envFile,
      projectDirectory: composeProjectDirectory,
    });

    // Compose's HOST_PORT override for the entry service is conveyed
    // via env var rather than a CLI flag — the compose file is
    // expected to reference `${AGENTHUB_HOST_PORT}` on the entry
    // service's `ports:` mapping. The exact env-var contract is
    // documented in the ADR. Surveytracker (PR 3) was the first
    // project to wire it; the contract is stable for new projects.
    const composeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTHUB_HOST_PORT: String(port),
      AGENTHUB_ENTRY_PORT: String(cfg.entryPort),
      // Survey Tracker (and similar stacks) bind ng serve with FRONTEND_PORT /
      // PORT, not AGENTHUB_HOST_PORT. Both MUST be the entry (container-internal)
      // port, NOT the host port: the override publishes `hostPort:entryPort`
      // (e.g. 4100:4200), so the in-container dev server has to listen on
      // `entryPort` (4200) for docker to forward host:4100 traffic to it. The
      // host port is a host-namespace concept the container never binds. Setting
      // `PORT` to the host port made any app that honours the conventional `PORT`
      // var (Angular `ng serve --port $PORT`, Express, Vite, Next, CRA) listen on
      // the wrong socket inside the container, leaving the published port dead and
      // the health poll on host:<hostPort> failing until the 600s timeout.
      FRONTEND_PORT: String(cfg.entryPort),
      PORT: String(cfg.entryPort),
      AGENTHUB_SESSION_ID: sessionId,
      AGENTHUB_PROJECT_ID: project.id,
    };
    // Wizard-persisted preview secrets must reach `${VAR}` substitutions in
    // compose files. Without this, only repo `.env` / host process.env apply.
    mergeProjectSecretsSpawnEnv(composeEnv, {
      projectId: project.id,
      sessionId,
      overwriteExisting: true,
    });

    // Explicit "we got this far" log line so an operator chasing a
    // hang can distinguish "spawn was never attempted" (entry missing
    // here) from "spawn ran but the daemon stalled" (entry present,
    // no `ready`/`failed` flip, no `docker compose up errored`
    // follow-up). Without this, the previous gap between
    // "override file written" and the `child.on('error')` handler
    // — which only fires when `spawn` itself throws asynchronously —
    // left the failure mode ambiguous.
    this.logger.log(
      `[preview-compose ${groupId}] spawning \`docker compose up\` for project ` +
        `${projectName} (cwd=${worktreePath}, host_port=${port}, override_file=` +
        `${overrideFilePath ?? 'none'})`,
    );
    try {
      const child = this.spawn('docker', upArgs, {
        cwd: worktreePath,
        env: composeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // We don't need the child's PID — compose addresses containers
      // by project name. But we DO want to surface any synchronous
      // spawn error (e.g. `docker` not on PATH) before kicking off
      // the health-check loop.
      child.on('error', (err) => {
        this.logger.warn(
          `[preview-compose ${groupId}] \`docker compose up\` error: ${err.message}`,
        );
        void this.markGroupFailed(groupId, `docker compose up errored: ${err.message}`);
      });
      // The `up -d --build` child IS the live log producer for the build
      // phase — track it so getLogTail/snapshotLogTail know a live stream
      // exists and don't fall back to an out-of-band daemon pull.
      this.liveLogChildren.set(groupId, child);
      this.wireComposeChildStdio(groupId, child);
      // `up -d --build` exits once containers are *created/started* — which
      // is BEFORE the app health check passes. We do NOT start the runtime
      // `logs --follow` here: a stack the product still treats as `starting`
      // must not be followed (it may yet time out and be marked failed), and
      // this keeps the handoff on the same readiness signal as the
      // getLogTail reattach invariant. The runtime follower is started by
      // the `ready` transition in runHealthCheck. Here we only drop the
      // build child from the live-producer map when it exits.
      child.on('exit', (code) => {
        if (this.liveLogChildren.get(groupId) === child) {
          this.liveLogChildren.delete(groupId);
        }
        // A clean exit (code 0) means the build finished and the containers
        // were created/started. Stamp the moment so runHealthCheck can rebase
        // its deadline and grant the app the FULL readiness budget after the
        // build — instead of letting a slow first-time image build burn the
        // window. A non-zero exit (build/up failed) is intentionally NOT
        // stamped: a doomed boot should time out on the original deadline,
        // never earn a fresh readiness window.
        if (code === 0) {
          this.buildCompletedAtMs.set(groupId, this.clock.nowMs());
        }
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[preview-compose ${groupId}] failed to spawn docker: ${reason}`);
      await this.markGroupFailed(groupId, `failed to spawn docker: ${reason}`);
      return {
        previewId: groupId,
        url,
        port,
        composeProjectName: projectName,
      };
    }

    // Kick off the health-check loop in the background. Callers that
    // need the final status should poll `getById(previewId)`.
    void this.runHealthCheck({
      groupId,
      entryRowId,
      url: this.healthUrlBase(port),
      healthPath: cfg.healthPath,
      timeoutMs: cfg.readyTimeoutMs,
    });

    return {
      previewId: groupId,
      url,
      port,
      composeProjectName: projectName,
    };
  }

  /**
   * Stop the compose group with `groupId`. Idempotent. Shells out to
   * `docker compose down -v --remove-orphans` against the persisted
   * project name + compose file, then deletes the group row.
   *
   * Reproduces the up call's spawn environment exactly:
   *
   *   - `cwd = worktree_path` so a relative `-f docker-compose.yml`
   *     resolves against the same directory the up call used.
   *   - `-f` carries the up call's resolved compose file path (a project
   *     that overrides `compose.file` tears down the same file it
   *     brought up — not whatever the runtime default happens to be).
   *   - env pins the same `AGENTHUB_*` contract the up call set, so
   *     compose's variable interpolation during `down` doesn't emit
   *     "variable is not set" warnings against services that reference
   *     `${AGENTHUB_HOST_PORT}` etc. outside `ports:` mappings.
   */
  async stopPreview(groupId: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT g.id, g.session_id, g.project_id, g.compose_project_name,
                g.worktree_path, g.compose_file, g.entry_port, g.override_file_path,
                g.host_project_directory,
                p.port, p.url
           FROM worktree_preview_groups g
           LEFT JOIN worktree_preview_processes p
                  ON p.group_id = g.id AND p.name = ?
          WHERE g.id = ?`,
      )
      .get(ENTRY_PROCESS_NAME, groupId) as
      | {
          id: string;
          session_id: string;
          project_id: string;
          compose_project_name: string | null;
          worktree_path: string | null;
          compose_file: string | null;
          entry_port: number | null;
          override_file_path: string | null;
          host_project_directory: string | null;
          port: number | null;
          url: string | null;
        }
      | undefined;
    if (!row) return;
    if (!row.compose_project_name) {
      // Not a compose-managed group — the legacy PreviewRuntime owns
      // teardown. We don't touch it. This guard matters during PR 2's
      // rollout window when both runtimes share the table.
      this.logger.warn(
        `[preview-compose] stopPreview(${groupId}) called for a non-compose group; ignoring`,
      );
      return;
    }
    // Mark the group as tearing down BEFORE we shell out to `docker
    // compose down` so a late `up` exit (which fires `startComposeLogFollow`)
    // can't race a follower into existence against a stack we're killing.
    // The teardown is wrapped in try/finally so the in-memory guard
    // (`stoppingGroups`) and child/tail state are ALWAYS cleared — an
    // unexpected throw (DB delete, etc.) must not leave the group marked
    // stopping forever, which would suppress future startComposeLogFollow.
    this.stoppingGroups.add(groupId);
    try {
      this.killLiveLogChild(groupId);
      // Fall back to the runtime default if a legacy compose row predates
      // the worktree_path / compose_file columns — null guards make this
      // defensible even though startPreview always persists both now.
      const composeFile = row.compose_file ?? this.defaultComposeFile;
      // Mirror the up call's `--project-directory` so compose-go resolves
      // relative bind mounts against the same base on tear-down. Without
      // this, `down` may pick a different working dir (parent of `-f`)
      // and emit "no such file" warnings against bind-mounted volumes.
      //
      // Prefer the host path persisted at startPreview time
      // (`host_project_directory`) over re-translating `worktree_path` —
      // see card c79c4bc0. The persisted value is what the up spawn
      // actually used; re-translation against current env vars would emit
      // a different path if the host mapping changed between start and
      // stop (server restart with the data dir remounted to a new host
      // path). Legacy rows with `host_project_directory IS NULL` (preview
      // groups created before this column existed) fall back to the
      // current translation — those rows can't be helped, the host path
      // was simply never recorded.
      let hostProjectDirectoryDown: string | null;
      if (row.host_project_directory) {
        hostProjectDirectoryDown = row.host_project_directory;
      } else if (row.worktree_path) {
        hostProjectDirectoryDown = resolveComposeProjectDirectory(
          row.worktree_path,
          translateContainerPathToHost(row.worktree_path),
        );
      } else {
        hostProjectDirectoryDown = null;
      }
      const downArgs = buildComposeDownArgs({
        composeProjectName: row.compose_project_name,
        composeFile,
        overrideFile: row.override_file_path,
        projectDirectory: hostProjectDirectoryDown,
      });
      const downEnv: NodeJS.ProcessEnv = {
        ...process.env,
        AGENTHUB_HOST_PORT: row.port != null ? String(row.port) : '',
        AGENTHUB_ENTRY_PORT: row.entry_port != null ? String(row.entry_port) : '',
        AGENTHUB_SESSION_ID: row.session_id,
        AGENTHUB_PROJECT_ID: row.project_id,
      };
      mergeProjectSecretsSpawnEnv(downEnv, {
        projectId: row.project_id,
        sessionId: row.session_id,
        overwriteExisting: true,
      });
      try {
        const child = this.spawn('docker', downArgs, {
          cwd: row.worktree_path ?? undefined,
          env: downEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.resume();
        child.stderr?.resume();
        await this.waitForExit(child);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[preview-compose ${groupId}] \`docker compose down\` failed: ${reason} ` +
            `(continuing with row deletion so the port is reclaimed)`,
        );
      }
      try {
        this.removeComposeProjectVolumes({
          composeProjectName: row.compose_project_name,
          logger: this.logger,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[preview-compose ${groupId}] compose volume cleanup failed: ${reason} (ignoring)`,
        );
      }
      // FK ON DELETE CASCADE removes the entry process row + frees its port.
      this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
      this.db.prepare(`DELETE FROM worktree_previews WHERE id = ?`).run(groupId);

      // Best-effort cleanup of the per-group override file. Compose
      // doesn't need it after `down` exits, and leaving it behind would
      // grow the dataDir without bound across long-lived deployments.
      if (row.override_file_path) {
        try {
          this.deleteOverrideFile(row.override_file_path);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `[preview-compose ${groupId}] deleteOverrideFile failed: ${reason} (ignoring)`,
          );
        }
      }
    } finally {
      // Always clear in-memory teardown state — even if a statement above
      // threw. Leaving `stoppingGroups` populated would permanently suppress
      // startComposeLogFollow for this group id and leak the log tail.
      this.killLiveLogChild(groupId);
      this.stoppingGroups.delete(groupId);
      this.logTails.delete(groupId);
      this.sessionIdByGroup.delete(groupId);
      this.buildCompletedAtMs.delete(groupId);
    }
  }

  /**
   * `docker compose restart backend` for the active compose preview on
   * `sessionId`. No-op when the group is not `ready`. Used after agent
   * turns so Django reloads worktree Python without tearing down the stack.
   */
  async restartBackendForSession(sessionId: string, serviceName = 'backend'): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT id, session_id, project_id, status, compose_project_name,
                worktree_path, compose_file, override_file_path, host_project_directory
           FROM worktree_preview_groups
          WHERE session_id = ?
            AND compose_project_name IS NOT NULL
            AND status = 'ready'
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .get(sessionId) as
      | {
          id: string;
          session_id: string;
          project_id: string;
          status: ComposeStatus;
          compose_project_name: string;
          worktree_path: string | null;
          compose_file: string | null;
          override_file_path: string | null;
          host_project_directory: string | null;
        }
      | undefined;
    if (!row?.compose_project_name || !row.worktree_path) return;

    const composeFile = row.compose_file ?? this.defaultComposeFile;
    const hostProjectDirectory = row.host_project_directory
      ? row.host_project_directory
      : resolveComposeProjectDirectory(
          row.worktree_path,
          translateContainerPathToHost(row.worktree_path),
        );

    const restartArgs = buildComposeRestartArgs(
      {
        composeProjectName: row.compose_project_name,
        composeFile,
        overrideFile: row.override_file_path,
        projectDirectory: hostProjectDirectory,
      },
      serviceName,
    );
    const restartEnv: NodeJS.ProcessEnv = { ...process.env };
    mergeProjectSecretsSpawnEnv(restartEnv, {
      projectId: row.project_id,
      sessionId: row.session_id,
      overwriteExisting: true,
    });

    this.logger.log(
      `[preview-compose ${row.id}] restarting compose service ${serviceName} after worktree change`,
    );
    const child = this.spawn('docker', restartArgs, {
      cwd: row.worktree_path,
      env: restartEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    await this.waitForExit(child);
  }

  /**
   * Stop every compose group owned by `sessionId`. Used by the
   * session-delete hook (PR 2). Returns the number of groups torn down.
   */
  async stopBySessionId(sessionId: string): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id FROM worktree_preview_groups
          WHERE session_id = ? AND compose_project_name IS NOT NULL
            AND status IN ('starting','ready','failed')`,
      )
      .all(sessionId) as Array<{ id: string }>;
    for (const r of rows) {
      await this.stopPreview(r.id);
    }
    return rows.length;
  }

  /** Fetch recent boot logs for a compose-managed group. */
  getLogTail(groupId: string): string[] {
    // When a live producer (the build child or a follower) is already
    // streaming, the in-memory tail is authoritative — do NOT pull a
    // daemon `--tail` snapshot, which would replace the buffer out-of-band
    // and make the client log "loop".
    //
    // Lazy reattach is gated on `ready` — i.e. a proven-running stack. We
    // must NOT reattach during `starting`: there the build/up child (or its
    // success-handoff follower) is the authoritative producer, and if
    // neither is present the build exited non-zero. Reattaching then would
    // spawn a pointless long-lived follower against a stack that never came
    // up and refresh away the build error in the tail — the health loop will
    // mark the group failed instead. A `ready` group with no live producer
    // means the in-memory child was lost (e.g. a server restart) for a stack
    // that IS up, so we seed once from the daemon and reattach a `--tail 0`
    // follower so subsequent reads stream live again.
    if (!this.liveLogChildren.has(groupId) && this.getGroupStatus(groupId) === 'ready') {
      this.refreshComposeLogsFromDaemon(groupId);
      // The refresh above already seeded the tail with daemon history, so
      // the reattached follower uses `--tail 0` to avoid re-emitting it.
      this.startComposeLogFollow(groupId, { tailLines: 0 });
    }
    return [...(this.logTails.get(groupId) ?? [])];
  }

  /**
   * Base URL the **Hub process itself** can use to reach a preview's
   * published host port. Mirrors the health-check target (so it honors
   * `AGENT_HUB_PREVIEW_HEALTH_HOST=host.docker.internal` when the Hub runs
   * inside Docker) rather than the client-facing iframe URL, which may be a
   * proxy path the server-side browser cannot resolve.
   */
  serverReachableUrlForPort(port: number): string {
    return this.healthUrlBase(port);
  }

  /** Bump `last_active_at` so the reaper's idle-TTL clock resets. */
  touchPreview(groupId: string): void {
    this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET last_active_at = datetime('now')
          WHERE id = ? AND status IN ('starting','ready')
            AND compose_project_name IS NOT NULL`,
      )
      .run(groupId);
  }

  /** Active compose-managed group for `sessionId`, or null. */
  getActiveBySessionId(sessionId: string): ComposePreviewRow | null {
    const row = this.db
      .prepare(
        `SELECT g.id, g.session_id, g.project_id, g.compose_project_name,
                g.status, g.started_at, g.last_active_at,
                p.port, p.url
           FROM worktree_preview_groups g
           LEFT JOIN worktree_preview_processes p
                  ON p.group_id = g.id AND p.name = ?
          WHERE g.session_id = ?
            AND g.compose_project_name IS NOT NULL
            AND g.status IN ('starting','ready','failed')
          ORDER BY g.started_at DESC
          LIMIT 1`,
      )
      .get(ENTRY_PROCESS_NAME, sessionId) as
      | {
          id: string;
          session_id: string;
          project_id: string;
          compose_project_name: string;
          status: ComposeStatus;
          started_at: string;
          last_active_at: string;
          port: number | null;
          url: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      project_id: row.project_id,
      port: row.port ?? 0,
      url: row.url ?? '',
      compose_project_name: row.compose_project_name,
      status: row.status,
      started_at: row.started_at,
      last_active_at: row.last_active_at,
    };
  }

  /**
   * Every compose-managed group whose status is one of `starting`, `ready`,
   * or `failed`. Ordered by `started_at` ASC so the WS connect snapshot
   * replay is deterministic when multiple sessions have active previews.
   *
   * Returned rows are flat in the same shape as {@link getById} —
   * `compose_project_name IS NOT NULL` excludes any legacy spawn rows.
   */
  listActive(): ComposePreviewRow[] {
    const rows = this.db
      .prepare(
        `SELECT g.id, g.session_id, g.project_id, g.compose_project_name,
                g.status, g.started_at, g.last_active_at,
                p.port, p.url
           FROM worktree_preview_groups g
           LEFT JOIN worktree_preview_processes p
                  ON p.group_id = g.id AND p.name = ?
          WHERE g.compose_project_name IS NOT NULL
            AND g.status IN ('starting','ready','failed')
          ORDER BY g.started_at ASC`,
      )
      .all(ENTRY_PROCESS_NAME) as Array<{
      id: string;
      session_id: string;
      project_id: string;
      compose_project_name: string;
      status: ComposeStatus;
      started_at: string;
      last_active_at: string;
      port: number | null;
      url: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project_id: row.project_id,
      port: row.port ?? 0,
      url: row.url ?? '',
      compose_project_name: row.compose_project_name,
      status: row.status,
      started_at: row.started_at,
      last_active_at: row.last_active_at,
    }));
  }

  /** Single group by id, or null. */
  getById(groupId: string): ComposePreviewRow | null {
    const row = this.db
      .prepare(
        `SELECT g.id, g.session_id, g.project_id, g.compose_project_name,
                g.status, g.started_at, g.last_active_at,
                p.port, p.url
           FROM worktree_preview_groups g
           LEFT JOIN worktree_preview_processes p
                  ON p.group_id = g.id AND p.name = ?
          WHERE g.id = ? AND g.compose_project_name IS NOT NULL`,
      )
      .get(ENTRY_PROCESS_NAME, groupId) as
      | {
          id: string;
          session_id: string;
          project_id: string;
          compose_project_name: string;
          status: ComposeStatus;
          started_at: string;
          last_active_at: string;
          port: number | null;
          url: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      project_id: row.project_id,
      port: row.port ?? 0,
      url: row.url ?? '',
      compose_project_name: row.compose_project_name,
      status: row.status,
      started_at: row.started_at,
      last_active_at: row.last_active_at,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Idempotent migration: ensure `worktree_preview_groups` carries the
   * compose-managed metadata columns.
   *
   * Columns:
   *   - `compose_project_name` — discriminator separating compose
   *     groups from legacy spawn groups (NULL for spawn rows).
   *   - `worktree_path` — the up call's `cwd`; reused by stopPreview so
   *     `-f <relative-file>` resolves against the same directory.
   *   - `compose_file` — the resolved compose-file path from the up call
   *     (default or `prEnv.preview.compose.file`); reused verbatim by
   *     stopPreview so projects that override the file don't trigger
   *     `no such file or directory` on teardown.
   *   - `entry_port` — the container's internal entry port, persisted so
   *     stopPreview can reconstruct the same `AGENTHUB_ENTRY_PORT` env
   *     that the up call set (compose interpolates env on `down` too;
   *     mismatched env emits "variable is not set" warnings and can
   *     refuse to stop services).
   *   - `override_file_path` — disk path of the per-group compose
   *     override file written by `writeOverrideFile`; reused on tear-down
   *     so the down spawn applies the same `-f` chain as the up spawn.
   *   - `host_project_directory` — the host-side path resolved by
   *     {@link translateContainerPathToHost} at startPreview time. Stored
   *     so stopPreview can emit the SAME `--project-directory` flag the
   *     up spawn used, even when the host env mapping has changed since
   *     start (server restart with a remounted data dir, etc.). Card
   *     `c79c4bc0` — closes the stale-mapping risk from PR #1074
   *     reviewer item [4/10]. NULL for legacy rows that predate this
   *     column; in that case stopPreview falls back to re-translation.
   *
   * SQLite's `ALTER TABLE … ADD COLUMN` is fast and atomic; re-running
   * on a freshly-migrated DB throws `duplicate column name` which we
   * swallow per-column so a partially-migrated DB still picks up the
   * remaining additions.
   */
  private addComposeProjectNameColumnIfMissing(): void {
    // `compose_project_name` was promoted to the base schema (see
    // `preview-schema.ts`) so PreviewRuntime can read it for the
    // cross-runtime ownership guard without needing the compose runtime
    // to be constructed first. The ALTER below stays as a no-op on fresh
    // DBs (the duplicate-column error is swallowed) and the column-
    // backfill remains the source of truth for legacy DBs that predate
    // the base-schema promotion.
    const additions = [
      `ALTER TABLE worktree_preview_groups ADD COLUMN compose_project_name TEXT`,
      `ALTER TABLE worktree_preview_groups ADD COLUMN worktree_path TEXT`,
      `ALTER TABLE worktree_preview_groups ADD COLUMN compose_file TEXT`,
      `ALTER TABLE worktree_preview_groups ADD COLUMN entry_port INTEGER`,
      `ALTER TABLE worktree_preview_groups ADD COLUMN override_file_path TEXT`,
      `ALTER TABLE worktree_preview_groups ADD COLUMN host_project_directory TEXT`,
    ];
    for (const stmt of additions) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('duplicate column name')) continue;
        throw err;
      }
    }
  }

  /**
   * Allocate a port + insert the group row + the single `entry` process
   * row. Retries up to 3 times on a UNIQUE(port) race — same allocator
   * pattern as `PreviewRuntime.reserveProcessRow`.
   *
   * Rolls back any partial state on a non-recoverable insert error so a
   * crashed reservation never leaves a zombie row.
   */
  private reserveGroup(args: {
    groupId: string;
    sessionId: string;
    projectId: string;
    hostPortRange: PortRange;
    composeProjectName: string;
    worktreePath: string;
    composeFile: string;
    entryPort: number;
  }): { port: number; entryRowId: string } {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const port = this.allocatePort(args.hostPortRange);
      const url = this.urlBase(port, args.sessionId);
      const entryRowId = `${args.groupId}:${ENTRY_PROCESS_NAME}`;
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO worktree_preview_groups
               (id, session_id, project_id, status, compose_project_name,
                worktree_path, compose_file, entry_port)
             VALUES (?, ?, ?, 'starting', ?, ?, ?, ?)`,
          )
          .run(
            args.groupId,
            args.sessionId,
            args.projectId,
            args.composeProjectName,
            args.worktreePath,
            args.composeFile,
            args.entryPort,
          );
        this.db
          .prepare(
            `INSERT INTO worktree_preview_processes
               (id, group_id, name, pid, port, url, log_path, status)
             VALUES (?, ?, ?, NULL, ?, ?, NULL, 'starting')`,
          )
          .run(entryRowId, args.groupId, ENTRY_PROCESS_NAME, port, url);
      });
      try {
        tx();
        return { port, entryRowId };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'SQLITE_CONSTRAINT_UNIQUE' && attempt < MAX_ATTEMPTS - 1) {
          this.logger.warn(
            `[preview-compose] port ${port} collision on attempt ${attempt + 1}, retrying`,
          );
          // `db.transaction(...)` rolls back on throw, so no partial group
          // row survives this catch — proceed straight to the next attempt.
          if (reclaimFailedPortHolder(this.db, port) != null) {
            this.logger.warn(`[preview-compose] freed failed holder for port ${port} before retry`);
          }
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable: compose preview port retry loop exited without returning');
  }

  /**
   * Lowest-free-port allocator across the *shared* preview pool. Scans
   * `worktree_preview_processes` for occupied ports (any non-failed
   * row, regardless of whether the group is compose or spawn) so the
   * two runtimes never hand out the same port.
   */
  private allocatePort(range: PortRange): number {
    const taken = new Set(
      (
        this.db
          .prepare(
            `SELECT port FROM worktree_preview_processes
              WHERE port BETWEEN ? AND ?
                AND status IN ('pending','starting','ready')`,
          )
          .all(range.min, range.max) as Array<{ port: number }>
      ).map((r) => r.port),
    );
    for (let p = range.min; p <= range.max; p++) {
      if (!taken.has(p)) return p;
    }
    throw new Error(
      `Compose preview port pool exhausted: all ports in [${range.min}, ${range.max}] are in use`,
    );
  }

  /**
   * Poll `url + healthPath` until 2xx or `timeoutMs` elapses. Flips the
   * group + entry-process row to `ready` on success, `failed` on
   * timeout. Synchronous fetch errors are swallowed (the container may
   * not have bound the port yet).
   */
  private async runHealthCheck(opts: {
    groupId: string;
    entryRowId: string;
    url: string;
    healthPath: string;
    timeoutMs: number;
  }): Promise<void> {
    const healthUrl = opts.url + opts.healthPath;
    const startedAt = this.clock.nowMs();
    // Two-phase budget. `originalDeadline` caps the BUILD phase (build can't
    // hang forever) and is held SEPARATELY so it can gate the rebase below.
    // When the `docker compose up -d --build` child exits cleanly — recorded
    // in `buildCompletedAtMs` — we rebase `deadline` to `buildExit + timeoutMs`
    // exactly once, so the app gets the full readiness budget independent of
    // how long the image build took. A cached/fast build (child exits almost
    // immediately) collapses this back to the original single-window
    // behaviour. The rebase is the fix for slow first boots tripping
    // "health check timed out" before the app ever starts.
    //
    // The rebase is gated on `buildExitAt <= originalDeadline`: a build that
    // OVERRAN its own budget must not earn a fresh readiness window. If the
    // loop is delayed/sleeping past `originalDeadline` and the `up` child
    // exits cleanly at `originalDeadline + epsilon`, we leave `deadline` at
    // the original so the expiry check fails the preview instead of extending.
    const originalDeadline = startedAt + opts.timeoutMs;
    let deadline = originalDeadline;
    let rebasedForBuild = false;
    // Throttle state for the "still starting" progress heartbeat. Seeded to
    // `startedAt` so the first heartbeat fires one interval in, not on the
    // very first (already-noisy) poll.
    let lastHeartbeatAt = startedAt;
    // NOTE: the loop is `for (;;)` rather than `while (now < deadline)` so the
    // build-completion rebase is applied BEFORE the expiry check on every
    // iteration — including the one that wakes from `sleep`. A `while`
    // condition evaluated first would mis-fire the boundary race the reviewer
    // flagged: a clean `up` exit stamped at, say, 95ms (within the build-phase
    // budget) while the loop sleeps would be missed if the sleep ends at
    // 100-105ms — the `while` would see `now >= original deadline` and mark
    // the preview failed before ever consulting the freshly-stamped
    // `buildCompletedAtMs`. Checking the rebase first closes that window.
    for (;;) {
      if (!rebasedForBuild) {
        const buildExitAt = this.buildCompletedAtMs.get(opts.groupId);
        if (buildExitAt !== undefined) {
          rebasedForBuild = true;
          // Only extend when the build finished within its own budget. A
          // build that overran `originalDeadline` keeps the original
          // deadline so the expiry check below fails it — it cannot launder
          // an over-budget build into a fresh readiness window.
          if (buildExitAt <= originalDeadline) {
            deadline = buildExitAt + opts.timeoutMs;
          }
        }
      }
      if (this.clock.nowMs() >= deadline) break;
      // If the group has already been torn down or flipped to failed,
      // bail. Cheap query — happy path runs at most ~300 times during
      // a 5-min boot at the default 1s cadence.
      const groupStatus = this.getGroupStatus(opts.groupId);
      if (!groupStatus || groupStatus !== 'starting') return;
      try {
        const ok = this.fetch
          ? await this.fetch(healthUrl)
              .then((r) => r.ok)
              .catch(() => false)
          : (await probePreviewHealth(healthUrl)).ok;
        if (ok) {
          this.db
            .prepare(
              `UPDATE worktree_preview_processes
                  SET status = 'ready'
                WHERE id = ? AND status = 'starting'`,
            )
            .run(opts.entryRowId);
          const update = this.db
            .prepare(
              `UPDATE worktree_preview_groups
                  SET status = 'ready',
                      last_active_at = datetime('now')
                WHERE id = ? AND status = 'starting'`,
            )
            .run(opts.groupId);
          // Only fire `notifyStatus` when this call is the one that actually
          // flipped the row — `changes === 0` means a concurrent
          // markGroupFailed (or a duplicate health check) beat us to it, and
          // we'd otherwise emit a phantom `preview` event for a row that's
          // already failed/cleaned up.
          if (update.changes > 0) {
            // The stack is now a proven-running, `ready` stack — THIS is the
            // point we start the runtime `logs --follow` stream (not the
            // build child's exit, which fires while still `starting`). The
            // in-memory tail holds only the build child's build/orchestration
            // output at this point — `up -d` is detached and never streamed
            // container application stdout — so seeding the follower with
            // `--tail N` replays container logs from startup through ready
            // additively, without duplicating anything already in the tail.
            this.startComposeLogFollow(opts.groupId, { tailLines: this.logTailLines });
            this.fireNotifyStatus(opts.groupId, 'ready');
          }
          return;
        }
      } catch {
        // ignore — container may not have bound the entry port yet
      }
      // No daemon log pull here. The build phase streams via the `up`
      // child's stdio and the runtime phase streams via the
      // `logs --follow` child started on the `ready` transition above —
      // both flow through `appendComposeLog`, so the in-memory tail stays
      // the single coherent source. Polling `docker compose logs --tail`
      // here would replace that buffer out-of-band and make the log "loop".
      //
      // We DO emit a lightweight, throttled "still starting" heartbeat into
      // the same tail. While compose is blocked on a dependent service's
      // `service_healthy` condition it prints `Container … Waiting` exactly
      // once, so a multi-minute first boot (build / dump restore / migrations)
      // otherwise looks frozen. The heartbeat is a synthetic informational
      // line — it does not pull from the daemon and keeps the single-producer
      // tail invariant intact.
      const now = this.clock.nowMs();
      if (this.startingHeartbeatMs > 0 && now - lastHeartbeatAt >= this.startingHeartbeatMs) {
        lastHeartbeatAt = now;
        this.emitStartingHeartbeat(opts.groupId, now - startedAt, deadline - now);
      }
      await this.clock.sleep(this.healthIntervalMs);
    }
    await this.markGroupFailed(opts.groupId, `health check timed out after ${opts.timeoutMs}ms`);
  }

  /**
   * Append a throttled "still starting" progress line to the boot-log tail
   * (and fan it out via `notifyLog`) so a slow first boot reads as
   * in-progress rather than hung. Synthetic — no daemon pull — so it does
   * not disturb the single-producer log tail.
   */
  private emitStartingHeartbeat(groupId: string, elapsedMs: number, remainingMs: number): void {
    const elapsed = Math.max(0, Math.round(elapsedMs / 1000));
    const remaining = Math.max(0, Math.round(remainingMs / 1000));
    const line =
      `==> [preview] still starting — waiting for the entry service to pass its ` +
      `health check (${elapsed}s elapsed, ${remaining}s before timeout). ` +
      `A first boot that builds images or restores a database can take several minutes.`;
    this.appendComposeLog(groupId, line, 'stdout', false);
  }

  private wireComposeChildStdio(
    groupId: string,
    child: ChildProcess,
    opts: { filterForUi?: boolean } = {},
  ): void {
    const onChunk =
      (stream: 'stdout' | 'stderr') =>
      (chunk: Buffer | string): void => {
        this.appendComposeLog(groupId, String(chunk), stream, opts.filterForUi ?? false);
      };
    child.stdout?.on('data', onChunk('stdout'));
    child.stderr?.on('data', onChunk('stderr'));
  }

  private appendComposeLog(
    groupId: string,
    chunk: string,
    stream: 'stdout' | 'stderr',
    filterForUi = false,
  ): void {
    let lines = chunk.split(/\r?\n/).filter((line) => line.length > 0);
    if (filterForUi) lines = filterComposeLogLinesForUi(lines);
    if (lines.length === 0) return;
    let tail = this.logTails.get(groupId);
    if (!tail) {
      tail = [];
      this.logTails.set(groupId, tail);
    }
    const sessionId = this.sessionIdByGroup.get(groupId);
    for (const line of lines) {
      appendPreviewLogTailLine(tail, line, this.logTailLines);
      if (this.notifyLog && sessionId) {
        try {
          this.notifyLog({
            sessionId,
            groupId,
            processName: ENTRY_PROCESS_NAME,
            line,
            stream,
          });
        } catch (err) {
          this.logger.warn(
            `[preview-compose ${groupId}] notifyLog threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  /**
   * Spawn a long-lived `docker compose logs --follow` that streams the
   * container runtime stdout/stderr through `appendComposeLog`, so every
   * runtime line both updates the in-memory tail AND fans out as a live
   * `preview_log` WS event. Idempotent: a no-op if a live producer (the
   * build child or an existing follower) is already attached for the
   * group. Called on the `ready` transition (runHealthCheck) and lazily
   * from `getLogTail` for a `ready` stack that lost its in-memory follower
   * (e.g. a server restart).
   *
   * `tailLines` controls how much daemon history `--tail` replays before
   * following — and MUST be 0 on any handoff where the tail is ALREADY
   * seeded with container logs, otherwise Docker re-emits them into
   * `appendComposeLog` and the client sees duplicates:
   *   - getLogTail cold reattach (a one-shot `refreshComposeLogsFromDaemon`
   *     already pulled the container log tail) → `tailLines: 0`.
   *   - `ready` transition: the tail holds only the build child's
   *     build/orchestration output (`up -d` never streams container stdout),
   *     so `tailLines: N` replays container logs from startup additively
   *     with nothing to duplicate.
   */
  private startComposeLogFollow(groupId: string, opts: { tailLines: number }): void {
    if (this.liveLogChildren.has(groupId)) return;
    if (this.stoppingGroups.has(groupId)) return;
    const row = this.db
      .prepare(
        `SELECT status, compose_project_name, worktree_path, compose_file, override_file_path
           FROM worktree_preview_groups WHERE id = ?`,
      )
      .get(groupId) as
      | {
          status: ComposeStatus;
          compose_project_name: string | null;
          worktree_path: string | null;
          compose_file: string | null;
          override_file_path: string | null;
        }
      | undefined;
    // Don't tail a stack that's gone (row deleted) or already failed —
    // only `starting`/`ready` groups have a live stack worth following.
    if (!row || row.status === 'failed') return;
    if (!row.compose_project_name || !row.worktree_path) return;
    const composeFile = row.compose_file ?? this.defaultComposeFile;
    const args = ['compose', '-p', row.compose_project_name, '-f', composeFile];
    if (row.override_file_path) args.push('-f', row.override_file_path);
    // `--tail N` replays the last N daemon lines before following; `--tail 0`
    // follows only NEW output (used whenever the tail is already seeded).
    args.push('logs', '--follow', '--no-color', '--tail', String(opts.tailLines));
    let child: ChildProcess;
    try {
      child = this.spawn('docker', args, {
        cwd: row.worktree_path,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[preview-compose ${groupId}] failed to spawn logs --follow: ${reason}`);
      return;
    }
    this.liveLogChildren.set(groupId, child);
    this.wireComposeChildStdio(groupId, child, { filterForUi: true });
    const detach = (): void => {
      if (this.liveLogChildren.get(groupId) === child) {
        this.liveLogChildren.delete(groupId);
      }
    };
    child.on('error', (err) => {
      this.logger.warn(`[preview-compose ${groupId}] logs --follow error: ${err.message}`);
      detach();
    });
    child.on('exit', detach);
  }

  /** Kill (and forget) the active live-log producer for `groupId`, if any. */
  private killLiveLogChild(groupId: string): void {
    const child = this.liveLogChildren.get(groupId);
    if (!child) return;
    this.liveLogChildren.delete(groupId);
    try {
      child.kill('SIGTERM');
    } catch {
      // best-effort — the process may already be gone
    }
  }

  /** Best-effort pull of `docker compose logs` into the in-memory tail. */
  private refreshComposeLogsFromDaemon(groupId: string): void {
    const pulled = this.pullDaemonLogTail(groupId);
    if (pulled.length === 0) return;
    this.logTails.set(groupId, trimPreviewLogTail(pulled, this.logTailLines));
  }

  private pullDaemonLogTail(groupId: string): string[] {
    const row = this.db
      .prepare(
        `SELECT compose_project_name, worktree_path, compose_file, override_file_path
           FROM worktree_preview_groups WHERE id = ?`,
      )
      .get(groupId) as
      | {
          compose_project_name: string | null;
          worktree_path: string | null;
          compose_file: string | null;
          override_file_path: string | null;
        }
      | undefined;
    if (!row?.compose_project_name || !row.worktree_path) return [];
    const composeFile = row.compose_file ?? this.defaultComposeFile;
    const args = ['compose', '-p', row.compose_project_name, '-f', composeFile];
    if (row.override_file_path) args.push('-f', row.override_file_path);
    args.push('logs', '--tail', String(this.logTailLines), '--no-color');
    try {
      const result = spawnSync('docker', args, {
        cwd: row.worktree_path,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15_000,
      });
      const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      if (!text) return [];
      return filterComposeLogLinesForUi(text.split(/\r?\n/).filter((line) => line.length > 0));
    } catch {
      return [];
    }
  }

  /**
   * Flip the group + every backing process row to `failed`. Idempotent.
   * Does NOT spawn `docker compose down` — teardown of a failed compose
   * stack happens via `stopPreview()` (called by the reaper or
   * session-end hook); leaving the row in `failed` until then preserves
   * the diagnostic state for the operator to inspect.
   */
  private async markGroupFailed(groupId: string, reason: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE worktree_preview_processes
            SET status = 'failed'
          WHERE group_id = ? AND status IN ('pending','starting','ready')`,
      )
      .run(groupId);
    const update = this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET status = 'failed',
                last_active_at = datetime('now')
          WHERE id = ? AND status IN ('starting','ready')`,
      )
      .run(groupId);
    this.logger.warn(`[preview-compose ${groupId}] group failed: ${reason}`);
    // Tear down the live log follower (if any) — a failed stack will be
    // torn down later by stopPreview, but the `logs --follow` child should
    // not linger streaming a dead stack until then.
    this.killLiveLogChild(groupId);
    this.buildCompletedAtMs.delete(groupId);
    if (update.changes > 0) {
      this.fireNotifyStatus(groupId, 'failed', reason);
    }
  }

  /**
   * Notify any wired-up listener that a group transitioned to a terminal
   * state. Best-effort: a throwing listener is logged but never crashes
   * the surrounding caller (health-check loop / failure path). Reads the
   * row back from the DB so the broadcast carries the current port/url
   * — the caller has already flipped the status by the time we're
   * called, so a fresh read also confirms the flip stuck.
   */
  private fireNotifyStatus(groupId: string, status: 'ready' | 'failed', error?: string): void {
    if (!this.notifyStatus) return;
    let row: ComposePreviewRow | null;
    try {
      row = this.getById(groupId);
    } catch (err) {
      this.logger.warn(
        `[preview-compose ${groupId}] fireNotifyStatus: getById threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (!row) return;
    try {
      this.notifyStatus({
        sessionId: row.session_id,
        groupId,
        status,
        port: row.port,
        url: row.url,
        logTail: this.snapshotLogTail(groupId),
        ...(error ? { error } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `[preview-compose ${groupId}] notifyStatus threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Snapshot the in-memory log tail without touching the docker daemon.
   * `getLogTail` does a synchronous `docker compose logs --tail` to
   * refresh — fine for an HTTP request, too expensive when we're
   * broadcasting from inside a hot health-check loop. The in-memory map
   * already contains everything we appended via wireComposeChildStdio +
   * the periodic refreshComposeLogsFromDaemon ticks in the loop above.
   */
  private snapshotLogTail(groupId: string): string[] {
    return [...(this.logTails.get(groupId) ?? [])];
  }

  private getGroupStatus(groupId: string): ComposeStatus | null {
    const row = this.db
      .prepare(`SELECT status FROM worktree_preview_groups WHERE id = ?`)
      .get(groupId) as { status: ComposeStatus } | undefined;
    return row?.status ?? null;
  }

  /**
   * Resolve once the child exits. Used by `stopPreview` to await the
   * `docker compose down` invocation. Times out at 30 s — compose's own
   * default container-stop grace is 10 s, plus image teardown overhead.
   */
  private waitForExit(child: ChildProcess, graceMs = 30_000): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Per-session serialization — same shape as PreviewRuntime so two
   * concurrent `startPreview` calls for the same session don't both
   * race past `getActiveBySessionId`.
   *
   * **Wedge protection (issue surfaced by Settings → Build and run):**
   * a prior `_startPreview` that never resolves (undelivered
   * `child.on('error')`, hung `docker compose down` inside the early
   * `stopPreview(existing.id)`, swallowed rejection) used to permanently
   * block every subsequent call for the same sessionId — the chained
   * `prior.then(() => fn())` would never tick. The build-test endpoint
   * reuses a single hardcoded sessionId per project, so one wedge bricked
   * the Build button until server restart.
   *
   * Now: bound the wait on `prior` to `sessionLockTimeoutMs`. On timeout,
   * log a warning, drop the dead entry, and run `fn()` anyway. The
   * trade-off is conscious — we give up strict serialization with a
   * presumed-dead prior in exchange for forward progress. Setting the
   * timeout safely above any legitimate `_startPreview` duration (default
   * 120s) keeps real overlapping calls serialized while breaking only
   * the deadlocks they could otherwise produce.
   */
  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(sessionId);
    if (prior) {
      // Race the prior promise against a sleep-based deadline. A symbol
      // sentinel keeps the two branches type-safe even when `prior` is
      // typed `Promise<unknown>` and the eventual value of `prior` is
      // irrelevant — we only care whether it settled in time.
      const TIMEOUT_SENTINEL: unique symbol = Symbol('preview-compose lock timeout');
      type RaceResult = 'settled' | typeof TIMEOUT_SENTINEL;
      const priorSettled: Promise<RaceResult> = prior.then(
        () => 'settled' as const,
        () => 'settled' as const,
      );
      const timeout: Promise<RaceResult> = this.clock
        .sleep(this.sessionLockTimeoutMs)
        .then(() => TIMEOUT_SENTINEL);
      const outcome = await Promise.race([priorSettled, timeout]);
      if (outcome === TIMEOUT_SENTINEL && this.sessionLocks.get(sessionId) === prior) {
        // Prior call did not settle inside the budget — assume it's
        // wedged and orphan its entry so we don't keep chaining off a
        // dead promise. Subsequent overwrites are still atomic via the
        // `set` below, so a slow-but-not-dead prior that revives later
        // will simply complete on its own without re-acquiring the slot.
        this.logger.warn(
          `[preview-compose] withSessionLock(${sessionId}) prior call did not settle ` +
            `within ${this.sessionLockTimeoutMs}ms; evicting and proceeding. ` +
            `Likely cause: a previous _startPreview never resolved (hung docker compose ` +
            `down inside stopPreview, undelivered spawn error, swallowed rejection).`,
        );
        this.sessionLocks.delete(sessionId);
      }
    }
    const next = fn();
    const nextSettled = next.catch(() => {});
    this.sessionLocks.set(sessionId, nextSettled);
    try {
      return await next;
    } finally {
      if (this.sessionLocks.get(sessionId) === nextSettled) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }
}

// Test fixtures live in `preview-compose-runtime.test-helpers.ts` so the
// production module ships zero test-only exports. The contract values
// (project-name prefix, max length, entry-process row name) are pinned
// in tests against literals so the assertion is the spec rather than a
// renamed re-export of an internal constant.
