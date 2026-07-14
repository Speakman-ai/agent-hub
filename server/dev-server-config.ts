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

// PORT is reserved: the runtime derives it from the primary portMap entry
// and injects `PORT=<internalPort>` itself, same contract as the PR-env
// runner. Letting config override it would silently break the proxy
// upstream mapping.
const RESERVED_PLAIN_KEYS = new Set(['PORT']);

/** Bounds match `PreviewComposeConfig.readyTimeoutMs` (5 s – 60 min). */
const READY_TIMEOUT_MIN_MS = 5_000;
const READY_TIMEOUT_MAX_MS = 3_600_000;

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
    /** Shell command run via `sh -c` from `cwd` (or the worktree root). */
    startCommand: z
      .string()
      .trim()
      .min(1, 'startCommand must be a non-empty string')
      .max(MAX_START_COMMAND_LEN)
      .default(DEV_SERVER_DEFAULT_START_COMMAND),
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
     * Working-directory override relative to the worktree root (monorepo
     * subdir). Absolute paths and `..` segments are rejected.
     */
    cwd: z.string().trim().min(1).max(MAX_CWD_LEN).optional(),
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
