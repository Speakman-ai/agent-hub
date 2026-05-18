/**
 * Docker-compose worktree preview runtime.
 *
 * Skeleton implementation per PR 1 of the compose pivot — see the ADR
 * page `worktree-previews-compose-pivot-adr` on the wiki. This class is
 * NOT yet wired into chat / session-end teardown / the reaper. PR 2
 * picks up the wiring; PR 3 converts the surveytracker project to
 * compose mode; PR 4 removes the legacy spawn path.
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
 *      (volumes scoped to the compose project) and removes the group
 *      row. Idempotent.
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
import type { ChildProcess, SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import {
  WORKTREE_PREVIEWS_SCHEMA,
  WORKTREE_PREVIEW_GROUPS_SCHEMA,
  MIGRATE_LEGACY_PREVIEWS_SQL,
  DEFAULT_PREVIEW_PORT_RANGE,
} from './preview-schema.js';
import type { PreviewComposeConfig, PrEnvPreviewConfig, Project } from '../types.js';

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

export interface PreviewComposeRuntimeConfig {
  /** Default host port range when a project doesn't override. */
  portRange?: PortRange;
  /** Default ms to wait for 2xx on healthPath. */
  readyTimeoutMs?: number;
  /** Cadence for the health-check loop. Default 1000. */
  healthIntervalMs?: number;
  /**
   * Hostname stem for the iframe URL. Defaults to `http://localhost:<port>`.
   * Override for nginx-fronted installs.
   */
  urlBase?: (port: number) => string;
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
}

export interface PreviewComposeRuntimeDeps {
  db: Database;
  spawn: SpawnFn;
  fetch: HealthFetchFn;
  clock?: Clock;
  config?: PreviewComposeRuntimeConfig;
  logger?: {
    log: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_READY_TIMEOUT_MS = 300_000; // 5 min — cold-build budget.
const DEFAULT_HEALTH_INTERVAL_MS = 1_000;
const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';
const DEFAULT_HEALTH_PATH = '/';
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
 *   docker compose -p <proj> -f <file> [--env-file <env>] up -d --build
 *
 * `--build` is included unconditionally — for a worktree preview we
 * always want the entry-service container to reflect the agent's edits,
 * not a stale image from a prior run.
 *
 * NOTE: this builder produces the **arguments to the `docker` binary**.
 * The caller spawns `docker` with these args; the first element is
 * always `'compose'`.
 */
export function buildComposeUpArgs(opts: {
  composeProjectName: string;
  composeFile: string;
  envFile?: string;
}): string[] {
  const args: string[] = ['compose', '-p', opts.composeProjectName, '-f', opts.composeFile];
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
 */
export function buildComposeDownArgs(opts: {
  composeProjectName: string;
  composeFile: string;
}): string[] {
  return [
    'compose',
    '-p',
    opts.composeProjectName,
    '-f',
    opts.composeFile,
    'down',
    '-v',
    '--remove-orphans',
  ];
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
} {
  return {
    file: raw.file ?? defaults.composeFile,
    entryService: raw.entryService,
    entryPort: raw.entryPort,
    envFile: raw.envFile,
    healthPath: normaliseHealthPath(raw.healthPath ?? defaults.healthPath),
    hostPortRange: raw.hostPortRange ?? defaults.portRange,
    readyTimeoutMs: raw.readyTimeoutMs ?? defaults.readyTimeoutMs,
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
  private readonly urlBase: (port: number) => string;
  private readonly defaultComposeFile: string;
  private readonly defaultHealthPath: string;
  private readonly logger: NonNullable<PreviewComposeRuntimeDeps['logger']>;

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
    this.urlBase = deps.config?.urlBase ?? ((p) => `http://localhost:${p}`);
    this.defaultComposeFile = deps.config?.defaultComposeFile ?? DEFAULT_COMPOSE_FILE;
    this.defaultHealthPath = deps.config?.defaultHealthPath ?? DEFAULT_HEALTH_PATH;
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
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
    this.addComposeRuntimeColumnsIfMissing();
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

    const projectName = composeProjectName(sessionId);
    const groupId = randomUUID();

    // Allocate a host port + insert the group row + the single `entry`
    // process row inside one DB transaction so a half-inserted group
    // never lingers if a UNIQUE collision fires on the process row.
    const { port, entryRowId } = this.reserveGroup({
      groupId,
      sessionId,
      projectId: project.id,
      worktreePath,
      composeFile: cfg.file,
      hostPortRange: cfg.hostPortRange,
      composeProjectName: projectName,
    });

    const url = this.urlBase(port);

    // Spawn `docker compose up -d --build`. The CLI returns immediately
    // once the containers are dispatched; the health check below is
    // what actually decides "ready". The spawn is best-effort — if
    // it errors synchronously we mark the group failed and return so
    // the caller still gets a previewId to surface logs against.
    const upArgs = buildComposeUpArgs({
      composeProjectName: projectName,
      composeFile: cfg.file,
      envFile: cfg.envFile,
    });

    // Compose's HOST_PORT override for the entry service is conveyed
    // via env var rather than a CLI flag — the compose file is
    // expected to reference `${AGENTHUB_HOST_PORT}` on the entry
    // service's `ports:` mapping. The exact env-var contract is
    // documented in the ADR; PR 3 (surveytracker conversion) is the
    // first project to wire it.
    const composeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTHUB_HOST_PORT: String(port),
      AGENTHUB_ENTRY_PORT: String(cfg.entryPort),
      AGENTHUB_SESSION_ID: sessionId,
      AGENTHUB_PROJECT_ID: project.id,
    };

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
      // Detach stdio — compose's progress output is large + uninteresting
      // here. PR 2 wires a streaming consumer that fans these lines
      // through the WS broadcaster (mirrors PreviewRuntime's notifyLog).
      child.stdout?.resume();
      child.stderr?.resume();
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
      url,
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
   */
  async stopPreview(groupId: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT g.id, g.session_id, g.project_id, g.compose_project_name,
                g.compose_file, g.worktree_path,
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
          compose_file: string | null;
          worktree_path: string | null;
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
    const composeFile = row.compose_file?.trim() || this.defaultComposeFile;
    const downArgs = buildComposeDownArgs({
      composeProjectName: row.compose_project_name,
      composeFile,
    });
    const composeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTHUB_SESSION_ID: row.session_id,
      AGENTHUB_PROJECT_ID: row.project_id,
    };
    if (row.port != null) {
      composeEnv.AGENTHUB_HOST_PORT = String(row.port);
    }
    try {
      const child = this.spawn('docker', downArgs, {
        cwd: row.worktree_path ?? undefined,
        env: composeEnv,
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
    // FK ON DELETE CASCADE removes the entry process row + frees its port.
    this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
    this.db.prepare(`DELETE FROM worktree_previews WHERE id = ?`).run(groupId);
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
   * `compose_project_name` discriminator. SQLite's ALTER TABLE … ADD
   * COLUMN is fast and atomic; re-running it on a freshly-migrated DB
   * throws a `duplicate column name` SQLITE_ERROR which we swallow.
   */
  private addComposeRuntimeColumnsIfMissing(): void {
    this.addColumnIfMissing('compose_project_name', 'TEXT');
    this.addColumnIfMissing('compose_file', 'TEXT');
    this.addColumnIfMissing('worktree_path', 'TEXT');
  }

  private addColumnIfMissing(columnName: string, sqlType: string): void {
    try {
      this.db.exec(`ALTER TABLE worktree_preview_groups ADD COLUMN ${columnName} ${sqlType}`);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('duplicate column name')) return;
      throw err;
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
    worktreePath: string;
    composeFile: string;
    hostPortRange: PortRange;
    composeProjectName: string;
  }): { port: number; entryRowId: string } {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const port = this.allocatePort(args.hostPortRange);
      const url = this.urlBase(port);
      const entryRowId = `${args.groupId}:${ENTRY_PROCESS_NAME}`;
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO worktree_preview_groups
               (id, session_id, project_id, status, compose_project_name, compose_file, worktree_path)
             VALUES (?, ?, ?, 'starting', ?, ?, ?)`,
          )
          .run(
            args.groupId,
            args.sessionId,
            args.projectId,
            args.composeProjectName,
            args.composeFile,
            args.worktreePath,
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
          // Clean up any partial group row left behind by the
          // transaction (transactions roll back on throw so this is a
          // safety net, not a hot path).
          this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(args.groupId);
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
    const deadline = this.clock.nowMs() + opts.timeoutMs;
    while (this.clock.nowMs() < deadline) {
      // If the group has already been torn down or flipped to failed,
      // bail. Cheap query — happy path runs at most ~300 times during
      // a 5-min boot at the default 1s cadence.
      const groupStatus = this.getGroupStatus(opts.groupId);
      if (!groupStatus || groupStatus !== 'starting') return;
      try {
        const res = await this.fetch(healthUrl);
        if (res.ok) {
          this.db
            .prepare(
              `UPDATE worktree_preview_processes
                  SET status = 'ready'
                WHERE id = ? AND status = 'starting'`,
            )
            .run(opts.entryRowId);
          this.db
            .prepare(
              `UPDATE worktree_preview_groups
                  SET status = 'ready',
                      last_active_at = datetime('now')
                WHERE id = ? AND status = 'starting'`,
            )
            .run(opts.groupId);
          return;
        }
      } catch {
        // ignore — container may not have bound the entry port yet
      }
      await this.clock.sleep(this.healthIntervalMs);
    }
    await this.markGroupFailed(opts.groupId, `health check timed out after ${opts.timeoutMs}ms`);
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
    this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET status = 'failed',
                last_active_at = datetime('now')
          WHERE id = ? AND status IN ('starting','ready')`,
      )
      .run(groupId);
    this.logger.warn(`[preview-compose ${groupId}] group failed: ${reason}`);
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
   */
  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const settled = prior.catch(() => {});
    const next = settled.then(() => fn());
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

// ─── Test-only re-exports ───────────────────────────────────────────────

/**
 * Exposed for the unit test that pins the `agenthub-session-` prefix
 * + length-cap behaviour. Production callers should use
 * {@link composeProjectName} directly.
 */
export const __test_COMPOSE_PROJECT_MAX_LEN = COMPOSE_PROJECT_MAX_LEN;
export const __test_COMPOSE_PROJECT_PREFIX = COMPOSE_PROJECT_PREFIX;
export const __test_ENTRY_PROCESS_NAME = ENTRY_PROCESS_NAME;
