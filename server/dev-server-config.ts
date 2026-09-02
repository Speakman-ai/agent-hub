import { z } from 'zod';
import { RESERVED_KEY_RE } from './preview/reserved-env-keys.js';

/**
 * Dev-server config contract (`Project.prEnv.devServer`).
 *
 * The dev-server model runs the project as a managed long-lived process
 * started from `startCommand` inside the session env, instead of wrapping
 * the app in a per-session docker compose project. The Hub owns
 * start/stop/restart, streams logs, injects env + resolved secrets at
 * spawn, and maps `portMap[]` internal ports out through the
 * authenticated preview proxy.
 *
 * Secrets are **key references only**: `secretKeys[]` names entries in
 * the existing project-secrets store (`preview/preview-secrets-store.ts`).
 * Plaintext values never live in this block — the server resolves them
 * into the process env at spawn and never returns them to a client.
 */

export const DEV_SERVER_DEFAULT_START_COMMAND = 'npm run dev';

/** POSIX env var name: leading [A-Za-z_], rest [A-Za-z0-9_]. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Caps mirror the PR-env `env` validator in routes/projects.ts — generous
// for the expected use (a handful of flags + service URLs) but bounded so
// user error surfaces at save time, not at spawn time.
const MAX_ENV_VARS = 64;
const MAX_ENV_KEY_LEN = 128;
const MAX_ENV_VALUE_LEN = 4096;
const MAX_SECRET_KEYS = 64;
const MAX_PORT_MAP_ENTRIES = 16;
const MAX_START_COMMAND_LEN = 2000;
const MAX_LABEL_LEN = 64;
const MAX_HEALTH_PATH_LEN = 256;
const MAX_CWD_LEN = 512;
const MAX_APT_PACKAGES = 64;
const MAX_APT_PACKAGE_LEN = 128;

/**
 * Debian/Ubuntu package name, optionally pinned to a `=version`.
 *
 * Deliberately conservative: the names are interpolated into an
 * `apt-get install` command that the dev-server runtime runs **inside the
 * sysbox session container**, so the charset must exclude every shell
 * metacharacter. A real package name is `[a-z0-9]` then
 * `[a-z0-9+.-]*` (see Debian Policy §5.6.1); the optional `=<version>`
 * tail allows the usual version charset. No spaces, `;`, `|`, `&`, `$`,
 * backticks, or quotes can pass — so a package list can never smuggle a
 * second command into the install step.
 */
const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/;

// PORT is reserved: the runtime derives it from the primary portMap entry
// and injects `PORT=<internalPort>` itself, same contract as the PR-env
// runner. Letting config override it would silently break the proxy
// upstream mapping.
const RESERVED_PLAIN_KEYS = new Set(['PORT']);

/** Readiness budget bounds: 5 s – 60 min. */
const READY_TIMEOUT_MIN_MS = 5_000;
const READY_TIMEOUT_MAX_MS = 3_600_000;

/** Idle-reap bounds: 60 s – 24 h. */
const IDLE_TTL_MIN_SECONDS = 60;
const IDLE_TTL_MAX_SECONDS = 86_400;

const MAX_CAPTURE_ROUTES = 10;
const MAX_CAPTURE_ROUTE_LEN = 512;

function isReservedKey(key: string): boolean {
  return RESERVED_KEY_RE.test(key) || RESERVED_PLAIN_KEYS.has(key);
}

const envKeySchema = z
  .string()
  .max(MAX_ENV_KEY_LEN, `env keys must be at most ${MAX_ENV_KEY_LEN} chars`)
  .regex(ENV_NAME_RE, 'env keys must match [A-Za-z_][A-Za-z0-9_]* (POSIX env var name)');

const portMapEntrySchema = z.strictObject({
  /** Port the dev server listens on inside the session env. */
  internalPort: z.number().int().min(1).max(65535),
  /** Short human label shown in the UI (e.g. "web", "api"). */
  label: z.string().trim().min(1).max(MAX_LABEL_LEN),
  /**
   * The primary port keeps the `/preview/proxy/` mount; extra ports get
   * `/preview/proxy/p/<internalPort>/`. At most one entry may set this;
   * when none does, `parseDevServerConfig` promotes the first entry.
   */
  primary: z.boolean().optional(),
});

export const devServerConfigSchema = z
  .strictObject({
    /**
     * Optional build step run to completion (via `sh -c` from `cwd`)
     * **before** `startCommand`, after apt packages install. Use it for
     * work that only needs to happen when the code changes — `npm ci`,
     * `docker compose build`, a bundler/compile pass — so a plain server
     * restart can reuse the build output instead of repeating it. When
     * unset, the runtime skips straight to `startCommand`.
     *
     * A non-zero exit fails the start (the build declared a hard
     * prerequisite). The "Restart Server" action skips this step; "Rebuild
     * App" runs it. Gets the same env + resolved secrets as `startCommand`.
     */
    buildCommand: z
      .string()
      .trim()
      .min(1, 'buildCommand must be a non-empty string')
      .max(MAX_START_COMMAND_LEN)
      .optional(),
    /** Shell command run via `sh -c` from `cwd` (or the worktree root). */
    startCommand: z
      .string()
      .trim()
      .min(1, 'startCommand must be a non-empty string')
      .max(MAX_START_COMMAND_LEN)
      .default(DEV_SERVER_DEFAULT_START_COMMAND),
    /**
     * Optional teardown command run via `sh -c` from `cwd` whenever the Hub
     * tears the dev server down — manual stop, idle reap, restart, and a
     * failed start's rollback all route through it.
     *
     * It exists for one specific leak: when `startCommand` is
     * `docker compose up`, the Hub only tracks the compose **CLI** process,
     * but the containers it starts are children of the Docker daemon, not of
     * that CLI. Signalling the CLI (SIGTERM/SIGKILL on stop or restart, or a
     * pid that is already gone after a Hub restart) leaves the containers
     * running, and they keep holding whatever host port the compose file
     * published — so the next session's `docker compose up` dies with
     * "Bind for 0.0.0.0:<port> failed: port is already allocated". A
     * `stopCommand` of `docker compose down --remove-orphans` reliably removes
     * the daemon-owned containers on every teardown path. Runs best-effort
     * (a non-zero exit or timeout is logged, never blocks the teardown) with
     * the same env + resolved secrets `startCommand` gets.
     */
    stopCommand: z
      .string()
      .trim()
      .min(1, 'stopCommand must be a non-empty string')
      .max(MAX_START_COMMAND_LEN)
      .optional(),
    /** Non-secret env injected at spawn. Secrets go in `secretKeys`. */
    env: z.record(envKeySchema, z.string().max(MAX_ENV_VALUE_LEN)).default({}),
    /**
     * Names of project-secrets-store entries resolved into the process
     * env at spawn. Key references only — never plaintext values.
     */
    secretKeys: z
      .array(z.string().max(MAX_ENV_KEY_LEN).regex(ENV_NAME_RE))
      .max(MAX_SECRET_KEYS)
      .default([]),
    /** Internal ports exposed through the authenticated preview proxy. */
    portMap: z.array(portMapEntrySchema).max(MAX_PORT_MAP_ENTRIES).default([]),
    /** Readiness probe path on the primary port. Must start with `/`. */
    healthPath: z
      .string()
      .trim()
      .max(MAX_HEALTH_PATH_LEN)
      .regex(/^\//, 'healthPath must start with `/`')
      .optional(),
    /** Max ms to wait for `healthPath` 2xx before flipping to failed. */
    readyTimeoutMs: z.number().int().min(READY_TIMEOUT_MIN_MS).max(READY_TIMEOUT_MAX_MS).optional(),
    /**
     * Routes the session preview opens by default. The first entry wins;
     * when unset the preview falls back to `healthPath`, then `/`.
     */
    captureRoutes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(MAX_CAPTURE_ROUTE_LEN)
          .regex(/^\//, 'routes must start with `/`'),
      )
      .max(MAX_CAPTURE_ROUTES)
      .optional(),
    /**
     * Seconds of inactivity before the reap pass tears the dev server
     * down. Bounds are 60 s – 24 h; when unset the runtime's own default
     * applies.
     */
    idleTTL: z.number().int().min(IDLE_TTL_MIN_SECONDS).max(IDLE_TTL_MAX_SECONDS).optional(),
    /**
     * Working-directory override relative to the worktree root (monorepo
     * subdir). Absolute paths and `..` segments are rejected.
     */
    cwd: z.string().trim().min(1).max(MAX_CWD_LEN).optional(),
    /**
     * OS-level packages (apt) the app needs at runtime but pip/npm cannot
     * provide — e.g. `imagemagick`/`libmagickwand-dev` for Python Wand,
     * `gdal-bin`, `libpq-dev`. The runtime installs these via `apt-get`
     * **before** `startCommand`, and **only** when the session runs on the
     * sysbox backend (an isolated, rootless per-session container). On the
     * host backend the install is skipped with a loud warning — apt would
     * need root and would mutate the shared host, which is never safe.
     */
    aptPackages: z
      .array(z.string().trim().min(1).max(MAX_APT_PACKAGE_LEN))
      .max(MAX_APT_PACKAGES)
      .default([]),
    /**
     * Show the "Enable preview" control on every native pull request by
     * default. The control itself is always available on Hub-hosted PRs when
     * a dev server is configured; this only sets whether the PR page surfaces
     * (and, on the web, auto-hydrates) preview state without the user opening
     * the section first. Off by default — a preview boots a real process, so
     * opting the whole project into per-PR previews is a deliberate choice.
     * Optional (absent === off) so existing config literals need no change.
     */
    previewOnPullRequests: z.boolean().optional(),
  })
  .superRefine((cfg, ctx) => {
    const envKeys = Object.keys(cfg.env);
    if (envKeys.length > MAX_ENV_VARS) {
      ctx.addIssue({
        code: 'custom',
        path: ['env'],
        message: `env supports at most ${MAX_ENV_VARS} entries (got ${envKeys.length})`,
      });
    }
    for (const key of envKeys) {
      if (isReservedKey(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['env', key],
          message: `env key "${key}" is reserved (injected by the server at spawn)`,
        });
      }
    }

    const seenSecrets = new Set<string>();
    cfg.secretKeys.forEach((key, i) => {
      if (isReservedKey(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['secretKeys', i],
          message: `secret key "${key}" is reserved (injected by the server at spawn)`,
        });
      }
      if (seenSecrets.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['secretKeys', i],
          message: `secret key "${key}" is listed more than once`,
        });
      }
      seenSecrets.add(key);
      if (key in cfg.env) {
        ctx.addIssue({
          code: 'custom',
          path: ['secretKeys', i],
          message: `"${key}" appears in both env and secretKeys — a key resolves from exactly one place`,
        });
      }
    });

    const seenPorts = new Set<number>();
    let primaryCount = 0;
    cfg.portMap.forEach((entry, i) => {
      if (seenPorts.has(entry.internalPort)) {
        ctx.addIssue({
          code: 'custom',
          path: ['portMap', i, 'internalPort'],
          message: `internalPort ${entry.internalPort} is listed more than once`,
        });
      }
      seenPorts.add(entry.internalPort);
      if (entry.primary === true) primaryCount += 1;
    });
    if (primaryCount > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['portMap'],
        message: 'portMap allows at most one primary entry',
      });
    }

    const seenPackages = new Set<string>();
    cfg.aptPackages.forEach((pkg, i) => {
      if (!APT_PACKAGE_RE.test(pkg)) {
        ctx.addIssue({
          code: 'custom',
          path: ['aptPackages', i],
          message: `"${pkg}" is not a valid apt package name (allowed: a-z, 0-9, "+.-", optional "=version")`,
        });
      }
      if (seenPackages.has(pkg)) {
        ctx.addIssue({
          code: 'custom',
          path: ['aptPackages', i],
          message: `apt package "${pkg}" is listed more than once`,
        });
      }
      seenPackages.add(pkg);
    });

    if (cfg.cwd !== undefined) {
      if (cfg.cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cfg.cwd)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cwd'],
          message: 'cwd must be relative to the worktree root',
        });
      } else if (
        cfg.cwd
          .replace(/\\/g, '/')
          .split('/')
          .some((seg) => seg === '..')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['cwd'],
          message: 'cwd must not escape the worktree root (no `..` segments)',
        });
      }
    }
  });

export interface DevServerPortMapEntry {
  internalPort: number;
  label: string;
  primary?: boolean;
}

export type DevServerConfig = z.output<typeof devServerConfigSchema>;

/**
 * Whether a raw project config can start a managed dev server.
 *
 * Keep this deliberately narrower than `devServerConfigSchema`: prompt and
 * start-surface gates must not advertise a preview for a saved-but-empty
 * `{}` block (or a whitespace-only command).
 */
export function isDevServerConfigured(
  devServer: { startCommand?: unknown } | null | undefined,
): boolean {
  const startCommand = devServer?.startCommand;
  return typeof startCommand === 'string' && startCommand.trim().length > 0;
}

// Compile-time guard: the inferred portMap entry stays assignable to the
// documented interface (which types.ts re-exports for the Project shape).
const _portMapEntryCheck: DevServerPortMapEntry[] = [] as DevServerConfig['portMap'];
void _portMapEntryCheck;

/**
 * Parse + normalize a raw `prEnv.devServer` payload.
 *
 * On success the value has defaults applied (`startCommand` falls back to
 * {@link DEV_SERVER_DEFAULT_START_COMMAND}; `env` / `secretKeys` /
 * `portMap` default to empty) and, when `portMap` is non-empty with no
 * explicit `primary`, the first entry is promoted so the runtime always
 * has a deterministic proxy upstream.
 *
 * On failure returns the first issue as a `prEnv.devServer.<path>`
 * message — the same `{ ok, error }` contract as the sibling prEnv
 * validators in routes/projects.ts.
 */
export function parseDevServerConfig(
  raw: unknown,
): { ok: true; value: DevServerConfig } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'prEnv.devServer must be an object' };
  }
  const result = devServerConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
    return { ok: false, error: `prEnv.devServer${path}: ${issue.message}` };
  }
  const value = result.data;
  if (value.portMap.length > 0 && !value.portMap.some((p) => p.primary === true)) {
    value.portMap = value.portMap.map((p, i) => (i === 0 ? { ...p, primary: true } : p));
  }
  return { ok: true, value };
}
