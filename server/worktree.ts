import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import {
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { homedir } from 'os';
import config from './config.js';
import type { SessionRow } from './types.js';
import {
  classifyCloneUrl,
  buildAuthenticatedUrl,
  redactToken,
  redactAuthHeader,
} from './clone-url-auth.js';
import { getInstallationToken, resolveInstallationId } from './github-app.js';
import { gitAuthArgsForGithubPat, resolveUserGithubToken } from './skill-credentials-github.js';
import { resolveOAuthAppCredentials } from './spawn-github-credentials.js';

/**
 * Root for all per-session / per-process git clones the workspace manager
 * creates. Exported so callers (session-purge, tests) can construct or assert
 * on paths inside this root without re-deriving it.
 */
export const WORKSPACES_ROOT: string = path.join(homedir(), '.agent-hub', 'workspaces');

/**
 * Promisified `execFile` — used everywhere in this module instead of
 * `execSync` so git network I/O does not block the Node event loop.
 *
 * The whole `getOrCreateProcessWorktree` / `ensureSessionWorkspace` graph runs
 * at the top of every heartbeat tick and every cron tick (see
 * `runHeartbeat` / `runCronJob` in heartbeat.ts). Synchronous git calls there
 * froze the loop for up to ~60s under network slowness, which manifested as
 * the node-cron `missed execution` warning bursts on PID 19954.
 */
const execFileP = promisify(execFile);
const execP = promisify(exec);

/** Written in the session clone when an awaited dependency install fails; reuse opens fail fast instead of repeating the install timeout. */
export const SESSION_DEPENDENCY_INSTALL_FAILURE_MARKER = '.agent-hub-dependency-install-failed';

/** Thrown when {@link setupDependencies} is asked to await an install that fails so callers can invoke {@link OnFailureFn} and skip returning a falsely-ready worktree path. */
export class SessionDependencyInstallError extends Error {
  override readonly name = 'SessionDependencyInstallError';
  constructor(message: string) {
    super(message);
  }
}

function dependencyInstallFailureMarkerPath(cloneDir: string): string {
  return path.join(cloneDir, SESSION_DEPENDENCY_INSTALL_FAILURE_MARKER);
}

function readDependencyInstallFailureMarker(cloneDir: string): string | null {
  const p = dependencyInstallFailureMarkerPath(cloneDir);
  if (!existsSync(p)) return null;
  try {
    const text = readFileSync(p, 'utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function writeDependencyInstallFailureMarker(cloneDir: string, reason: string): void {
  const line = reason.replace(/\r?\n/g, ' ').slice(0, 4000);
  writeFileSync(dependencyInstallFailureMarkerPath(cloneDir), `${line}\n`, 'utf8');
}

export function clearDependencyInstallFailureMarker(cloneDir: string): void {
  try {
    unlinkSync(dependencyInstallFailureMarkerPath(cloneDir));
  } catch {
    /* noop */
  }
}

/** Session clones await install so Husky / lint-staged can run before the first commit. */
const SESSION_INSTALL_TIMEOUT_MS = 600_000;

/** Fire-and-forget installs for heartbeat/cron process clones stay bounded. */
const BACKGROUND_INSTALL_TIMEOUT_MS = 120_000;

/**
 * Short-op timeout (ms) — applied to all metadata-only git commands
 * (`rev-parse`, `remote get-url`, `config`, `symbolic-ref`, `checkout`, …).
 * 5s is generous for any local git plumbing call; if we exceed it, something
 * is wedged (auth prompt, hung SSH agent, frozen filesystem) and we want to
 * fail fast rather than block agents.
 */
const SHORT_GIT_TIMEOUT_MS = 5000;

/**
 * Fetch timeout (ms) — applied to `git fetch origin --quiet` on the reuse
 * path. 30s is a balance between transient network blips (which fetch
 * tolerates) and avoiding the historical multi-minute stalls when DNS or
 * the remote was unreachable.
 */
const FETCH_TIMEOUT_MS = 30000;

/**
 * Clone timeout (ms) — applied to `git clone --depth 1`. Larger than fetch
 * because a fresh shallow clone may transfer a few MB of objects on first
 * use, especially for repos with a large `.git/objects` set.
 */
const CLONE_TIMEOUT_MS = 60000;

/**
 * Maximum number of `git clone` attempts before giving up. The first attempt
 * counts, so a value of 3 means "1 try + up to 2 retries".
 */
const MAX_CLONE_ATTEMPTS = 3;

/**
 * Base delay (ms) for the exponential backoff between clone retries.
 * Schedule with factor 3: attempt 1 fail -> wait ~500ms; attempt 2 fail ->
 * wait ~1500ms (plus jitter). Caps the worst-case retry window at ~6s on
 * top of the per-attempt CLONE_TIMEOUT_MS budget.
 */
const CLONE_RETRY_BASE_MS = 500;

/**
 * Stderr/message patterns that indicate a *transient* git clone failure
 * (network blip, GitHub returning HTTP 5xx, peer hangup, connection reset,
 * connect timeout). Retrying these usually succeeds within 1-2 attempts.
 *
 * Sample lines we want to match:
 *   error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500
 *   fatal: expected 'packfile'
 *   remote: Internal Server Error
 *   fatal: the remote end hung up unexpectedly
 *   fatal: early EOF
 */
const TRANSIENT_CLONE_PATTERNS: ReadonlyArray<RegExp> = [
  /RPC failed/i,
  /HTTP\s+5\d\d/i,
  /Internal Server Error/i,
  /expected ['"]?packfile['"]?/i,
  /early EOF/i,
  /fetch-pack: unexpected disconnect/i,
  /index-pack failed/i,
  /the remote end hung up unexpectedly/i,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bENETUNREACH\b/,
  /\bEAI_AGAIN\b/,
  /Connection reset by peer/i,
  /Connection timed out/i,
  /Could not resolve host/i,
];

/**
 * Patterns that indicate a *non-transient* failure where retrying is
 * pointless (and possibly harmful, e.g. burning auth attempts). Checked
 * before TRANSIENT_CLONE_PATTERNS so an HTTP 401 carrying "RPC failed"
 * still fails fast.
 */
const NON_TRANSIENT_CLONE_PATTERNS: ReadonlyArray<RegExp> = [
  /HTTP\s+40\d/i, // 401, 403, 404, 405, ...
  /Authentication failed/i,
  /could not read Username/i,
  /Repository not found/i,
  /access denied/i,
  /Permission denied \(publickey\)/i,
  /destination path .* already exists and is not an empty directory/i,
  /not a valid repository/i,
  /does not appear to be a git repository/i,
];

/**
 * Heuristic: did this clone failure look like a transient remote-side issue
 * (HTTP 5xx, RPC reset, peer hangup) that's worth retrying?
 *
 * The check inspects the full error string — `runGit` rejects with the
 * `child_process` ExecFileException whose `message` already includes the
 * captured stderr — so we don't need to wire `stderr` through separately.
 */
function isTransientCloneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Some Node ExecFileException objects also carry .stderr / .stdout — fold
  // those in too, in case the runtime ever stops appending them to .message.
  const e = err as { stderr?: unknown; stdout?: unknown } | null;
  const haystack = [message, String(e?.stderr ?? ''), String(e?.stdout ?? '')].join('\n');
  if (NON_TRANSIENT_CLONE_PATTERNS.some((p) => p.test(haystack))) return false;
  return TRANSIENT_CLONE_PATTERNS.some((p) => p.test(haystack));
}

type GitRunner = (args: string[], opts?: RunGitOptions) => Promise<string>;

interface RetryOptions {
  /** Override the runner (test seam — production path uses `runGit`). */
  runner?: GitRunner;
  /** Override the inter-attempt delay (test seam — production uses setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

interface CloneRetryOptions extends RetryOptions {
  /** Override the post-failure cleanup (test seam). */
  cleanup?: (cloneDir: string) => void;
}

/**
 * Resolve the user id whose GitHub token should be used to clone /
 * fetch the session worktree.
 *
 *   1. **`sessionOwnerId`** — when the session has a persisted owner
 *      (chat, autonomous dispatch with a real card creator, kanban
 *      assign), that user pays for their own work.
 *   2. **Repo-aware Owner probe** — when the session is system-spawned
 *      (`owner_user_id` is NULL, e.g. PR reviewer, fan-out, bug-report
 *      intake) AND we know the project's `githubRepo`, ask
 *      `resolveOwnerWithRepoAccess` for an Owner whose stored token
 *      actually has access. This is the fix for the "first user wins
 *      even when their OAuth scope can't see the repo" bug that broke
 *      the reviewer pipeline for ~2 days. The helper itself falls back
 *      to `getOrgOwnerUserId()` when no Owner probes 2xx, so the
 *      legacy attribution path stays intact for installs without the
 *      probe machinery available.
 *   3. **Legacy `getOrgOwnerUserId()` fallback** — for callers without
 *      a `githubRepo` (the rare project that does not point at a
 *      GitHub remote, plus tests that don't seed memberships).
 */
async function resolveWorktreeTokenOwnerId(
  sessionOwnerId: string | null,
  githubRepo?: string | null,
): Promise<string | null> {
  if (sessionOwnerId) return sessionOwnerId;
  try {
    if (githubRepo && githubRepo.trim()) {
      const probe = await import('./repo-aware-token.js');
      const userId = await probe.resolveOwnerWithRepoAccess(githubRepo);
      if (userId) return userId;
    }
    const mod = await import('./session-ownership.js');
    return mod.getOrgOwnerUserId();
  } catch {
    return null;
  }
}

/**
 * Generic transient-retry loop shared by clone and fetch paths.
 *
 * Retries up to `MAX_CLONE_ATTEMPTS` times when the failure stderr matches a
 * known transient pattern. Bails out immediately on non-transient errors
 * (auth, repository-not-found, etc.). Between attempts, an optional
 * `betweenAttempts` hook runs (used by clone to nuke the partial directory).
 *
 * Returns the runner's stdout from the successful attempt.
 */
async function withTransientRetry(
  args: string[],
  opts: RunGitOptions,
  retryOpts: RetryOptions & {
    label: 'clone' | 'fetch';
    betweenAttempts?: () => void;
  },
): Promise<string> {
  const runner = retryOpts.runner ?? runGit;
  const sleep =
    retryOpts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_CLONE_ATTEMPTS; attempt++) {
    try {
      return await runner(args, opts);
    } catch (err: unknown) {
      lastErr = err;
      const transient = isTransientCloneError(err);
      if (!transient || attempt === MAX_CLONE_ATTEMPTS) {
        throw err;
      }

      retryOpts.betweenAttempts?.();

      const baseDelay = CLONE_RETRY_BASE_MS * Math.pow(3, attempt - 1);
      const jitter = Math.floor(Math.random() * 250);
      const delayMs = baseDelay + jitter;
      const summary = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      console.warn(
        `[Workspace] Transient ${retryOpts.label} failure (attempt ${attempt}/${MAX_CLONE_ATTEMPTS}): ${summary}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  // Defensive — loop above always either returns or throws.
  throw lastErr;
}

/**
 * Run `git clone …` with retry-on-transient-failure.
 *
 * Retries up to `MAX_CLONE_ATTEMPTS` times when the failure stderr matches a
 * known transient pattern (HTTP 5xx from the remote, RPC reset, peer hangup,
 * connection reset/timeout). Backs off with exponential delay + jitter
 * between attempts. Bails out immediately on auth failures, "repository not
 * found", "destination path already exists", and any error not classified
 * as transient.
 *
 * Between retries, the partial clone directory is removed so the next
 * attempt isn't blocked by a half-populated tree from the previous failure.
 */
async function cloneWithRetry(
  args: string[],
  opts: RunGitOptions,
  cloneDir: string,
  retryOpts: CloneRetryOptions = {},
): Promise<void> {
  const cleanup = retryOpts.cleanup ?? cleanupPartialClone;
  await withTransientRetry(args, opts, {
    runner: retryOpts.runner,
    sleep: retryOpts.sleep,
    label: 'clone',
    // Wipe whatever the failed attempt left behind so the next clone
    // doesn't see "destination path already exists".
    betweenAttempts: () => cleanup(cloneDir),
  });
}

/**
 * Run `git fetch …` with retry-on-transient-failure.
 *
 * Same retry policy as `cloneWithRetry`, but without directory cleanup —
 * the local clone is intact, only the network fetch failed. Targets the
 * reuse path in `getOrCreateProcessWorktree` and `ensureSessionWorkspace`,
 * where a transient `fatal: expected 'packfile'` or HTTP 5xx from GitHub
 * was previously eaten with a single warn-and-continue.
 *
 * Resolves on success, rejects with the final attempt's error if every
 * retry exhausts the budget. Callers that prefer "log and continue with the
 * stale tree" semantics should wrap in try/catch (see the existing reuse
 * sites — they intentionally tolerate fetch failure).
 */
async function fetchWithRetry(
  args: string[],
  opts: RunGitOptions,
  retryOpts: RetryOptions = {},
): Promise<void> {
  await withTransientRetry(args, opts, {
    runner: retryOpts.runner,
    sleep: retryOpts.sleep,
    label: 'fetch',
  });
}

/**
 * Fully remove a partial clone directory between retry attempts. Unlike
 * `removeZombieCloneDir` (which only acts when there's no `.git` inside),
 * this one is unconditional because a `git clone` that failed partway
 * through pack-file fetch may have left a `.git` directory in place.
 */
function cleanupPartialClone(cloneDir: string): void {
  if (!existsSync(cloneDir)) return;
  try {
    rmSync(cloneDir, { recursive: true, force: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Workspace] Failed to clean partial clone ${cloneDir}:`, message);
  }
}

/**
 * Fail-fast git environment.
 *
 * - `GIT_TERMINAL_PROMPT=0` — never prompt for credentials. Without this,
 *   git silently waits on stdin for a username/password when an
 *   authenticated remote rejects credentials, which produces an event-loop
 *   stall that only ends at the configured timeout.
 * - `GIT_SSH_COMMAND` — for SSH remotes, refuse interactive prompts
 *   (`BatchMode=yes`), refuse host-key prompts (`StrictHostKeyChecking=accept-new`
 *   would still be interactive on first contact — `BatchMode=yes` already
 *   forces SSH to fail rather than prompt), and cap the TCP connect at 5s.
 *
 * Merged on top of `process.env` so PATH / HOME / GIT_* overrides from the
 * caller still apply.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=5',
  };
}

interface RunGitOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Run `git <args>` via `execFile` with the fail-fast env and a short
 * default timeout. Returns trimmed stdout. Rejects on non-zero exit /
 * timeout — callers that want to silently swallow the error wrap this in
 * try/catch (mirrors the previous `execSync` + try/catch shape).
 */
async function runGit(args: string[], opts: RunGitOptions = {}): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd: opts.cwd,
    env: gitEnv(),
    timeout: opts.timeoutMs ?? SHORT_GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.toString().trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--git-dir'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

async function getRemoteUrl(cwd: string): Promise<string | null> {
  try {
    return await runGit(['remote', 'get-url', 'origin'], { cwd });
  } catch {
    return null;
  }
}

function projectSlug(projectCwd: string): string {
  return path.basename(projectCwd).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * If the cloned repo ships a `.husky/` directory, point `core.hooksPath` at it.
 *
 * Husky's `prepare` script only wires `core.hooksPath` during `npm install`,
 * and **process** worktree creation (heartbeats / crons) still does not await
 * install (see {@link setupDependencies} with `awaitInstall: false`). Session
 * clones also use non-blocking install at clone/reuse time; call
 * {@link ensureSessionWorktreeDependenciesInstalled} immediately before
 * `git commit` / the `changes_ready` banner so eslint and Husky hooks exist
 * when publishing.
 *
 * **Assumes husky v9+** — the shipped hook scripts are self-contained and do
 * not source `.husky/_/husky.sh`. Husky v8 and earlier sourced that helper
 * from the `husky` npm package, so pre-commit would error in a worktree
 * whose `node_modules` don't have husky installed. The hub repo uses v9+.
 *
 * Idempotent: safe to call on reuse. Non-fatal — logs and continues on error.
 */
async function enableHuskyHooks(cloneDir: string): Promise<void> {
  try {
    if (!existsSync(path.join(cloneDir, '.husky'))) return;
    await runGit(['config', 'core.hooksPath', '.husky'], { cwd: cloneDir });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Workspace] Failed to enable husky hooks in ${cloneDir}:`, message);
  }
}

/**
 * Copy git user.name and user.email from a source repo (or global config)
 * into a newly-cloned directory so that `git commit` works without a global identity.
 */
async function copyGitUserConfig(sourceCwd: string, targetCwd: string): Promise<void> {
  const keys = ['user.name', 'user.email'] as const;
  for (const key of keys) {
    try {
      // Try source repo's local config first, then falls back to global
      const value = await runGit(['config', key], { cwd: sourceCwd });
      if (value) {
        await runGit(['config', key, value], { cwd: targetCwd });
      }
    } catch {
      // Key not set anywhere — skip
    }
  }
}

function ensureWorkspaceDir(projectCwd: string): string {
  const dir = path.join(WORKSPACES_ROOT, projectSlug(projectCwd));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * If `cloneDir` exists but is not a git repo (no `.git` subdir), remove it so
 * `git clone` can succeed. This recovers from zombie directories left behind
 * by interrupted clones (OOM, disk-full, SIGKILL mid-clone, etc.) — without
 * this, every subsequent clone attempt fails because `git clone` refuses a
 * non-empty target directory, permanently trapping the session/process.
 *
 * Returns true if a zombie directory was removed.
 */
function removeZombieCloneDir(cloneDir: string): boolean {
  if (!existsSync(cloneDir)) return false;
  if (existsSync(path.join(cloneDir, '.git'))) return false;
  try {
    rmSync(cloneDir, { recursive: true, force: true });
    console.warn(`[Workspace] Removed zombie clone dir (no .git inside): ${cloneDir}`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workspace] Failed to remove zombie clone dir ${cloneDir}:`, message);
    return false;
  }
}

async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd });
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    try {
      await runGit(['rev-parse', '--verify', 'main'], { cwd });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

/** Remote branch tip to sync a process/session clone to (kanban `pr_base_branch` or repo default). */
async function resolveSyncBranch(
  projectCwd: string,
  override: string | null | undefined,
): Promise<string> {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  return getDefaultBranch(projectCwd);
}

function detectInstallCommand(dir: string): string | null {
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock')))
    return 'bun install --frozen-lockfile';
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm ci --include=dev';
  if (existsSync(path.join(dir, 'package.json'))) return 'npm install --include=dev';
  return null;
}

/**
 * For session workspaces, prefer `npm run install:all` when the repo defines it
 * (monorepos like Agent Hub need server/client/mobile installs, not root-only).
 */
function resolveSessionInstallCommand(
  cloneDir: string,
  explicit: string | null | undefined,
): string | null {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  try {
    const pkgPath = path.join(cloneDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.['install:all']?.trim()) {
        return 'npm run install:all';
      }
    }
  } catch {
    /* ignore invalid package.json */
  }
  return detectInstallCommand(cloneDir);
}

/**
 * True when a JS workspace still needs `npm install` for Husky pre-commit (eslint)
 * or when there is no node_modules at all.
 */
function needsDependencyInstall(cloneDir: string): boolean {
  if (!existsSync(path.join(cloneDir, 'package.json'))) return false;
  if (!existsSync(path.join(cloneDir, 'node_modules'))) return true;
  if (!existsSync(path.join(cloneDir, '.husky'))) return false;
  const eslintBin = path.join(cloneDir, 'node_modules', '.bin', 'eslint');
  return !existsSync(eslintBin);
}

const installChildEnv: NodeJS.ProcessEnv = {
  ...process.env,
  // Provisioning and some hosts run the server with NODE_ENV=production, which
  // would otherwise make npm omit devDependencies despite --include=dev in some paths.
  NODE_ENV: 'development',
  // PEP 668: Debian/Ubuntu mark the system Python as "externally managed", so any
  // project install command that runs `pip install ...` outside a venv fails with
  // `error: externally-managed-environment`. Session clones are ephemeral / scoped,
  // which is the case pip's PEP 668 doc carves out as safe to opt out of. The env
  // var is inert for venv-based install commands, so it costs nothing when users
  // create a venv themselves. Operators who want PEP 668 enforcement back can set
  // `PIP_REQUIRE_VIRTUALENV=1` in their host environment — pip honours that over
  // PIP_BREAK_SYSTEM_PACKAGES.
  PIP_BREAK_SYSTEM_PACKAGES: '1',
};

interface NodeModulesEntry {
  relative: string;
  absolute: string;
}

interface SetupDependenciesOptions {
  /** When true, block until install finishes (deferred session publish path). */
  awaitInstall: boolean;
  /** When true, use {@link resolveSessionInstallCommand} (install:all for monorepos). */
  preferInstallAllScript: boolean;
}

/**
 * Vitest sets AGENT_HUB_TEST_MODE=1 (server/vitest.config.ts). Session clones
 * created during tests must not block on `npm install`: shallow fixtures rarely
 * ship lockfiles, and awaiting monorepo `install:all` against the checkout blows
 * hook timeouts.
 *
 * Production also uses non-blocking install here so session startup is not
 * stalled by a cold `install:all`. {@link ensureSessionWorktreeDependenciesInstalled}
 * awaits install immediately before `changes_ready` / `git commit` so Husky
 * pre-commit hooks still run when the user publishes.
 */
function sessionWorkspaceDependencyInstallOpts(): Pick<
  SetupDependenciesOptions,
  'awaitInstall' | 'preferInstallAllScript'
> {
  if (process.env.AGENT_HUB_TEST_MODE === '1') {
    return { awaitInstall: false, preferInstallAllScript: false };
  }
  return { awaitInstall: false, preferInstallAllScript: true };
}

/**
 * Block until the session worktree has node_modules (and eslint when `.husky`
 * exists) so Husky / project pre-commit can run. Skipped entirely under
 * `AGENT_HUB_TEST_MODE=1` (see {@link sessionWorkspaceDependencyInstallOpts}).
 */
export async function ensureSessionWorktreeDependenciesInstalled(
  projectCwd: string,
  sessionCloneDir: string,
  installCommand: string | null | undefined,
): Promise<void> {
  if (process.env.AGENT_HUB_TEST_MODE === '1') {
    return;
  }
  await setupDependencies(projectCwd, sessionCloneDir, installCommand ?? null, {
    awaitInstall: true,
    preferInstallAllScript: true,
  });
}

function resolveInstallCommand(
  cloneDir: string,
  installCommand: string | null,
  preferInstallAllScript: boolean,
): string | null {
  if (preferInstallAllScript) {
    return resolveSessionInstallCommand(cloneDir, installCommand);
  }
  return installCommand || detectInstallCommand(cloneDir);
}

/**
 * Link node_modules from the project cwd when present, otherwise run the package manager.
 * Session clones pass `awaitInstall: false` at setup time; see
 * {@link ensureSessionWorktreeDependenciesInstalled} for the awaited path before commit.
 */
async function setupDependencies(
  sourceDir: string,
  cloneDir: string,
  installCommand: string | null,
  options: SetupDependenciesOptions,
): Promise<void> {
  const nodeModulesDirs: NodeModulesEntry[] = [];

  const rootNM = path.join(sourceDir, 'node_modules');
  if (existsSync(rootNM)) {
    nodeModulesDirs.push({ relative: 'node_modules', absolute: rootNM });
  }

  try {
    const entries = readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (['node_modules', '.git', 'dist', 'build', '.worktrees'].includes(entry.name)) continue;
      const subNM = path.join(sourceDir, entry.name, 'node_modules');
      if (existsSync(subNM)) {
        nodeModulesDirs.push({
          relative: path.join(entry.name, 'node_modules'),
          absolute: subNM,
        });
      }
    }
  } catch {
    // Ignore — subdirectory scan is best-effort
  }

  if (nodeModulesDirs.length > 0) {
    let linked = 0;
    for (const { relative, absolute } of nodeModulesDirs) {
      const target = path.join(cloneDir, relative);
      if (existsSync(target)) continue;

      const parentDir = path.dirname(target);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      try {
        symlinkSync(absolute, target, 'junction');
        linked++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Workspace] Failed to symlink ${relative}:`, message);
      }
    }
    if (linked > 0) {
      console.log(`[Workspace] Symlinked ${linked} node_modules from source project`);
    }
    if (linked > 0 && !needsDependencyInstall(cloneDir)) {
      clearDependencyInstallFailureMarker(cloneDir);
      return;
    }
    if (linked > 0 && needsDependencyInstall(cloneDir)) {
      console.warn(
        `[Workspace] Symlinked node_modules from source are incomplete for this clone (${cloneDir}) — running install`,
      );
    }
  }

  const installCmd = resolveInstallCommand(
    cloneDir,
    installCommand,
    options.preferInstallAllScript,
  );
  if (!installCmd) {
    return;
  }

  const timeoutMs = options.awaitInstall
    ? SESSION_INSTALL_TIMEOUT_MS
    : BACKGROUND_INSTALL_TIMEOUT_MS;

  if (options.awaitInstall) {
    if (!needsDependencyInstall(cloneDir)) {
      clearDependencyInstallFailureMarker(cloneDir);
      return;
    }
    const prior = readDependencyInstallFailureMarker(cloneDir);
    if (prior) {
      throw new SessionDependencyInstallError(
        `[Workspace] Session dependency install previously failed (${cloneDir}): ${prior}`,
      );
    }
    try {
      console.log(`[Workspace] Running "${installCmd}" in ${cloneDir} (awaiting completion)`);
      await execP(installCmd, {
        cwd: cloneDir,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: installChildEnv,
      });
      console.log(`[Workspace] Install completed in ${cloneDir}`);
      clearDependencyInstallFailureMarker(cloneDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Workspace] Install failed in clone ${cloneDir}:`, message);
      writeDependencyInstallFailureMarker(cloneDir, message);
      throw new SessionDependencyInstallError(
        `[Workspace] Dependency install failed in ${cloneDir}: ${message}`,
      );
    }
    return;
  }

  console.log(
    `[Workspace] No node_modules in source — running "${installCmd}" in clone (background)`,
  );
  exec(installCmd, { cwd: cloneDir, timeout: timeoutMs, env: installChildEnv }, (err) => {
    if (err) {
      console.warn(`[Workspace] Install failed in clone:`, err.message);
    } else {
      console.log(`[Workspace] Install completed in ${cloneDir}`);
    }
  });
}

function copyFallback(projectCwd: string, destDir: string): string {
  try {
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    cpSync(projectCwd, destDir, {
      recursive: true,
      filter: (src: string) => {
        const base = path.basename(src);
        return !['node_modules', '.git', '.worktrees', 'dist', 'build'].includes(base);
      },
    });
    console.log(`[Workspace] Created copy fallback: ${destDir}`);
    return destDir;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workspace] Copy fallback failed:`, message);
    return projectCwd;
  }
}

/**
 * Token resolver injected for tests — production calls
 * {@link defaultResolveInstallationToken} which talks to GitHub.
 *
 * Returns the bare installation token string (no `x-access-token:` prefix)
 * or `null` when no GitHub App installation is configured / matched. The
 * caller is responsible for redacting this value before logging or
 * broadcasting; see `redactToken` in `clone-url-auth.ts`.
 */
export type InstallationTokenResolver = (repoUrl: string) => Promise<string | null>;

async function defaultResolveInstallationToken(repoUrl: string): Promise<string | null> {
  const parsed = classifyCloneUrl(repoUrl);
  if (parsed.kind !== 'github-https' || !parsed.owner) return null;
  const appCfg = config.githubApp;
  if (!appCfg || !appCfg.appId || !appCfg.privateKey) return null;
  const installationId = resolveInstallationId(appCfg, parsed.owner);
  if (!installationId) return null;
  return await getInstallationToken(appCfg.appId, appCfg.privateKey, installationId);
}

/**
 * Ensure `projectCwd` exists and is a git repo by auto-cloning from
 * `repoUrl` when missing or non-git. No-op when the path already holds a
 * git repo, or when `repoUrl` is unset.
 *
 * On clone success, the parent of `projectCwd` is created with `mkdir -p`
 * and the repo is fetched at full depth so subsequent worktree creation
 * has the history it needs. Failures are surfaced as a clean error
 * carrying the unauthenticated `repoUrl` and project id — the auth-injected
 * URL and token are redacted from the message before throwing so they
 * never reach the WebSocket log or stderr.
 *
 * @returns `true` when a clone happened; `false` when nothing was done
 * (path already a git repo, or repoUrl unset). The boolean is mostly for
 * tests; production callers can ignore it.
 */
export async function ensureProjectRepoCloned(
  projectCwd: string,
  repoUrl: string | null | undefined,
  options: {
    projectId?: string;
    resolveToken?: InstallationTokenResolver;
    /**
     * When set, and the GitHub App installation token resolver returns
     * `null`, the user's per-user GitHub credential (OAuth user-to-server
     * token preferred, skill-credentials PAT as fallback) is used so
     * private repos still clone for self-hosters without the GitHub App
     * installed. Auth is injected via a per-invocation `-c
     * http.<host>.extraheader=…` arg (the GH Actions pattern), so the
     * token never lands in the resulting repo's on-disk `.git/config`.
     * Installation token wins when both exist — preserves bot attribution.
     */
    requestingUserId?: string | null;
    /**
     * Test seam — defaults to `resolveUserGithubToken` with the current
     * server config's OAuth credentials. Returns a Promise so the OAuth
     * refresh path can run. Override in tests to short-circuit token
     * resolution without touching the orgs DB or the OAuth refresh
     * endpoint.
     */
    resolveUserToken?: (userId: string) => Promise<string | null>;
  } = {},
): Promise<boolean> {
  if (!repoUrl) return false;

  // Fast-path — already a healthy git repo, nothing to do.
  if (existsSync(projectCwd) && (await isGitRepo(projectCwd))) {
    return false;
  }

  const parsed = classifyCloneUrl(repoUrl);
  if (parsed.kind !== 'github-https') {
    // PATCH validator already rejects SSH / non-github URLs, so this is
    // belt-and-braces: surface a clean error if a project somehow holds a
    // bad URL (e.g. legacy row, manual JSON edit) instead of letting `git
    // clone` blow up with a cryptic message.
    throw new Error(
      `Auto-clone failed for project ${options.projectId ?? '<unknown>'}: repoUrl ${repoUrl} is not a supported GitHub HTTPS URL.`,
    );
  }

  const resolveToken = options.resolveToken ?? defaultResolveInstallationToken;
  let token: string | null = null;
  try {
    token = await resolveToken(repoUrl);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Token mint failures are non-fatal here — fall through with the
    // unauthenticated URL so public repos still clone. If the repo is
    // private, git itself will surface a clear auth failure below and we
    // re-throw with the un-tokenized URL.
    console.warn(
      `[Workspace] Failed to mint installation token for ${repoUrl}: ${message} — falling back to unauthenticated clone`,
    );
  }

  // Per-user token fallback. Only consulted when the App installation
  // token is unavailable: the bot identity is preferred when present so
  // PR attribution / API rate buckets stay with the App. The user's
  // credential — OAuth user-to-server token first, skill-credentials PAT
  // second (see `resolveUserGithubToken`) — is injected via `-c
  // http.…extraheader=…` and never embedded into the clone URL, so it
  // cannot land in the on-disk `.git/config` of the resulting repo.
  let userToken: string | null = null;
  if (!token && options.requestingUserId) {
    const resolveToken =
      options.resolveUserToken ??
      ((uid: string) =>
        resolveUserGithubToken(uid, { oauthCredentials: resolveOAuthAppCredentials(config) }));
    userToken = await resolveToken(options.requestingUserId);
  }

  const cloneUrl = token ? buildAuthenticatedUrl(parsed, token) : repoUrl;
  const authArgs = userToken ? gitAuthArgsForGithubPat(userToken) : [];

  // Existing zombie (path exists but not a git repo) → wipe before clone.
  if (existsSync(projectCwd)) {
    try {
      rmSync(projectCwd, { recursive: true, force: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Auto-clone failed for project ${options.projectId ?? '<unknown>'} (${repoUrl}): could not remove non-git directory at ${projectCwd}: ${message}`,
      );
    }
  }

  const parentDir = path.dirname(projectCwd);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  try {
    await cloneWithRetry(
      [...authArgs, 'clone', '--quiet', cloneUrl, projectCwd],
      { timeoutMs: CLONE_TIMEOUT_MS },
      projectCwd,
    );
  } catch (err: unknown) {
    // Strip both auth secrets from the error message before re-throwing
    // so the caller / log pipeline never sees the installation token or
    // the user token. `redactToken` is a no-op when its second argument
    // is falsy, so the chain is safe even when only one of the two is set.
    const raw = err instanceof Error ? err.message : String(err);
    const safeOnce = redactToken(raw, token);
    const safeTwice = redactToken(safeOnce, userToken);
    // Shape-based redaction catches base64-encoded `x-access-token:<TOKEN>`
    // values inside `-c http.<host>.extraheader=Authorization: basic …`
    // argv echoes, which the value-based passes above cannot reach.
    const safe = redactAuthHeader(safeTwice);
    throw new Error(
      `Auto-clone failed for project ${options.projectId ?? '<unknown>'} (${repoUrl}): ${safe}`,
    );
  }

  console.log(
    `[Workspace] Auto-cloned project ${options.projectId ?? '<unknown>'} from ${repoUrl} → ${projectCwd}${userToken && !token ? ' (user token)' : ''}`,
  );
  return true;
}

export async function getOrCreateProcessWorktree(
  projectCwd: string,
  processKey: string,
  installCommand?: string | null,
  /** Optional `origin/<branch>` tip to reset/sync to (e.g. kanban `pr_base_branch`). */
  syncBaseBranch?: string | null,
  /** Optional auto-clone source for self-healing project workspaces (Project.repoUrl). */
  repoUrl?: string | null,
  /** Project id for error attribution; opaque to the worktree code. */
  projectId?: string,
): Promise<string> {
  // Self-heal: if the project has a `repoUrl` and the cwd is missing or
  // not a git repo, auto-clone before falling through to the legacy
  // existsSync fallback. Public-repo / no-token cases are tolerated.
  if (repoUrl) {
    try {
      // No requestingUserId here: getOrCreateProcessWorktree has no session
      // owner identity (it's called for heartbeats / cron jobs, not for a
      // specific user session). The user-PAT fallback path in
      // ensureProjectRepoCloned is therefore intentionally absent — if the
      // GitHub App installation token isn't available this path uses only
      // unauthenticated access (public repos) or fails gracefully.
      await ensureProjectRepoCloned(projectCwd, repoUrl, { projectId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Workspace] ${message}`);
      // Fall through — the existing isGitRepo check below will return
      // projectCwd as-is (legacy non-git fallback) so the session can
      // still spawn against an empty workspace if that's all we have.
    }
  }

  if (!existsSync(projectCwd)) {
    const fallback = config.defaultCwd || homedir();
    console.warn(
      `[Workspace] cwd does not exist: "${projectCwd}" — falling back to "${fallback}" for ${processKey}`,
    );
    projectCwd = fallback;
  }

  if (!(await isGitRepo(projectCwd))) {
    return projectCwd;
  }

  const wsDir = ensureWorkspaceDir(projectCwd);
  const safeName = processKey.replace(/[^a-zA-Z0-9_-]/g, '-');
  const cloneDir = path.join(wsDir, safeName);

  if (existsSync(cloneDir) && existsSync(path.join(cloneDir, '.git'))) {
    try {
      await fetchWithRetry(['fetch', 'origin', '--quiet'], {
        cwd: cloneDir,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      const syncBranch = await resolveSyncBranch(projectCwd, syncBaseBranch);
      await fetchWithRetry(
        ['fetch', 'origin', `${syncBranch}:refs/remotes/origin/${syncBranch}`, '--depth', '1'],
        {
          cwd: cloneDir,
          timeoutMs: FETCH_TIMEOUT_MS,
        },
      );
      await runGit(['reset', '--hard', `origin/${syncBranch}`], { cwd: cloneDir });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Workspace] Sync failed for "${safeName}", reusing as-is:`, message);
    }
    await enableHuskyHooks(cloneDir);
    await setupDependencies(projectCwd, cloneDir, installCommand ?? null, {
      awaitInstall: false,
      preferInstallAllScript: false,
    });
    return cloneDir;
  }

  // If a prior clone left a zombie directory (exists but no .git), remove it
  // before attempting to clone — otherwise `git clone` will fail with
  // "destination path already exists and is not an empty directory" forever.
  removeZombieCloneDir(cloneDir);

  try {
    const remoteUrl = await getRemoteUrl(projectCwd);
    if (remoteUrl) {
      await cloneWithRetry(
        ['clone', '--depth', '1', '--quiet', remoteUrl, cloneDir],
        { cwd: projectCwd, timeoutMs: CLONE_TIMEOUT_MS },
        cloneDir,
      );
    } else {
      await cloneWithRetry(
        ['clone', '--depth', '1', '--quiet', projectCwd, cloneDir],
        { timeoutMs: CLONE_TIMEOUT_MS },
        cloneDir,
      );
    }
    await copyGitUserConfig(projectCwd, cloneDir);
    const syncBranch = await resolveSyncBranch(projectCwd, syncBaseBranch);
    try {
      await fetchWithRetry(
        ['fetch', 'origin', `${syncBranch}:refs/remotes/origin/${syncBranch}`, '--depth', '1'],
        {
          cwd: cloneDir,
          timeoutMs: FETCH_TIMEOUT_MS,
        },
      );
      await runGit(['reset', '--hard', `origin/${syncBranch}`], { cwd: cloneDir });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Workspace] Could not sync new process clone to origin/${syncBranch}, using clone default:`,
        message,
      );
    }
    await enableHuskyHooks(cloneDir);
    await setupDependencies(projectCwd, cloneDir, installCommand ?? null, {
      awaitInstall: false,
      preferInstallAllScript: false,
    });
    console.log(`[Workspace] Created clone: ${cloneDir}`);
    return cloneDir;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workspace] Failed to create clone "${safeName}":`, message);
    return copyFallback(projectCwd, cloneDir);
  }
}

type PersistFn = (workspacePath: string, branchName: string, sessionId: string) => void;
type OnFailureFn = (sessionId: string, errorMessage: string) => void;

/**
 * Structured info reported when a reused session worktree's `pr_base_branch`
 * has advanced on origin since the worktree was first positioned. Emitted via
 * the optional `onBaseBranchAdvanced` callback to `ensureSessionWorkspace` so
 * callers can post a card comment and inject a "rebase first" notice into the
 * agent's next-turn system prompt.
 *
 * `rebased: true` means we auto-rebased a clean working tree on top of the
 * new origin tip and the agent can continue against the up-to-date base.
 * `rebased: false` means the working tree was either dirty (uncommitted
 * changes — we did not touch it) or the rebase produced conflicts and was
 * aborted; in both cases the agent must rebase manually before continuing.
 */
export interface BaseBranchAdvancedInfo {
  /** Session whose worktree drifted. */
  sessionId: string;
  /** Branch name (the `pr_base_branch` we were tracking). */
  baseBranch: string;
  /** Merge-base of session HEAD with origin/<baseBranch> before any action. */
  mergeBaseSha: string;
  /** Tip of origin/<baseBranch> at detection time. */
  newTipSha: string;
  /** Number of commits the base advanced (output of `git rev-list --count`). */
  commitsAdvanced: number;
  /** Was the working tree clean when drift was detected? */
  cleanWorkingTree: boolean;
  /** Did we successfully auto-rebase onto the new tip? */
  rebased: boolean;
  /** Did an auto-rebase attempt fail with conflicts (and was aborted)? */
  conflict: boolean;
}

export type OnBaseBranchAdvancedFn = (info: BaseBranchAdvancedInfo) => void;

/**
 * Detect whether the session's `pr_base_branch` on origin has advanced past
 * the worktree's current merge-base. When it has, attempt a two-tier auto-fix:
 *
 *   1. Clean working tree → run `git rebase origin/<base>` auto-pilot. If it
 *      succeeds the agent continues silently on the new tip. If it conflicts,
 *      `git rebase --abort` restores the prior tree and the caller is told to
 *      surface the conflict (card comment + system-prompt note).
 *   2. Dirty working tree (uncommitted changes) → do NOT rebase. We have no
 *      safe way to stash agent-in-progress edits. Caller is told to surface
 *      the drift so the agent can decide.
 *
 * Returns `null` when there's no drift (the common case) so the hot reuse
 * path stays cheap. Returns a populated {@link BaseBranchAdvancedInfo} when
 * either branch of the two-tier response above fires.
 *
 * All git invocations route through `runGit` so they share the fail-fast env
 * (`GIT_TERMINAL_PROMPT=0`) and short timeout — a wedged remote will not
 * stall the reuse path.
 */
async function detectAndHandleBaseBranchDrift(
  cloneDir: string,
  sessionId: string,
  baseBranch: string,
): Promise<BaseBranchAdvancedInfo | null> {
  let mergeBaseSha: string;
  let newTipSha: string;
  try {
    [mergeBaseSha, newTipSha] = await Promise.all([
      runGit(['merge-base', 'HEAD', `origin/${baseBranch}`], { cwd: cloneDir }),
      runGit(['rev-parse', `origin/${baseBranch}`], { cwd: cloneDir }),
    ]);
  } catch (err: unknown) {
    // origin/<base> may not exist (deleted, renamed, never fetched). Bail
    // quietly — the reuse path tolerated this before drift detection, and we
    // shouldn't make a missing ref harder than it already is.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Workspace] Drift check skipped for session ${sessionId.slice(0, 8)} (origin/${baseBranch}): ${message}`,
    );
    return null;
  }

  if (mergeBaseSha === newTipSha) {
    return null; // no drift — the common case
  }

  let commitsAdvanced = 0;
  try {
    const count = await runGit(['rev-list', '--count', `${mergeBaseSha}..${newTipSha}`], {
      cwd: cloneDir,
    });
    commitsAdvanced = Number.parseInt(count, 10) || 0;
  } catch {
    /* best-effort — count is informational only */
  }

  // Cleanliness check — `git status --porcelain` prints one line per modified
  // / staged / untracked entry. Empty stdout means a clean tree (including
  // no untracked files, which we treat as dirty too because a rebase that
  // would touch them is dangerous).
  let cleanWorkingTree = false;
  try {
    const porcelain = await runGit(['status', '--porcelain'], { cwd: cloneDir });
    cleanWorkingTree = porcelain.length === 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Workspace] git status failed for session ${sessionId.slice(0, 8)}, assuming dirty: ${message}`,
    );
    cleanWorkingTree = false;
  }

  if (!cleanWorkingTree) {
    console.log(
      `[Workspace] Base branch advanced for session ${sessionId.slice(0, 8)} (origin/${baseBranch} ${commitsAdvanced} ahead) — working tree dirty, skipping auto-rebase`,
    );
    return {
      sessionId,
      baseBranch,
      mergeBaseSha,
      newTipSha,
      commitsAdvanced,
      cleanWorkingTree: false,
      rebased: false,
      conflict: false,
    };
  }

  // Clean tree → try auto-rebase. A successful rebase leaves the working
  // tree at the new tip and there's nothing for the agent to do. A failed
  // rebase ALWAYS gets `git rebase --abort` so the worktree returns to its
  // prior state — never leave the tree in a half-rebased "rebase in progress"
  // limbo where the agent's next git command will produce confusing errors.
  try {
    await runGit(['rebase', `origin/${baseBranch}`], {
      cwd: cloneDir,
      // Rebase can take several seconds on a large stack; give it the
      // fetch budget rather than the 5s short-op budget.
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    console.log(
      `[Workspace] Auto-rebased session ${sessionId.slice(0, 8)} onto origin/${baseBranch} (${commitsAdvanced} commits)`,
    );
    return {
      sessionId,
      baseBranch,
      mergeBaseSha,
      newTipSha,
      commitsAdvanced,
      cleanWorkingTree: true,
      rebased: true,
      conflict: false,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Workspace] Auto-rebase failed for session ${sessionId.slice(0, 8)} on origin/${baseBranch}: ${message} — aborting`,
    );
    try {
      await runGit(['rebase', '--abort'], { cwd: cloneDir });
    } catch (abortErr: unknown) {
      const abortMsg = abortErr instanceof Error ? abortErr.message : String(abortErr);
      // `git rebase --abort` exits non-zero when there's no rebase in
      // progress (e.g. the rebase failed before touching anything). Not
      // fatal — log and move on.
      console.warn(
        `[Workspace] git rebase --abort for session ${sessionId.slice(0, 8)} reported: ${abortMsg}`,
      );
    }
    return {
      sessionId,
      baseBranch,
      mergeBaseSha,
      newTipSha,
      commitsAdvanced,
      cleanWorkingTree: true,
      rebased: false,
      conflict: true,
    };
  }
}

export async function ensureSessionWorkspace(
  session: SessionRow,
  projectCwd: string,
  agentId: string,
  persistFn: PersistFn,
  installCommand?: string | null,
  onFailure?: OnFailureFn,
  /** When set (e.g. kanban `pr_base_branch`), the session branch is created from `origin/<branch>` instead of the repo default after shallow clone. */
  prBaseBranch?: string | null,
  /** Optional auto-clone source for self-healing project workspaces (Project.repoUrl). */
  repoUrl?: string | null,
  /** Project id for error attribution; opaque to the worktree code. */
  projectId?: string,
  /**
   * Fires on the **reuse** path when origin/<prBaseBranch> has advanced past
   * the session worktree's merge-base. Either a clean auto-rebase happened
   * (`rebased: true`) or the caller is responsible for surfacing the drift
   * (card comment + system-prompt note). Never fires for fresh-clone or
   * no-drift cases. See {@link BaseBranchAdvancedInfo}.
   */
  onBaseBranchAdvanced?: OnBaseBranchAdvancedFn,
  /**
   * `Project.githubRepo` (e.g. `Speakman-ai/agent-hub`). When set, drives
   * the repo-aware Owner-token resolution used for system-spawned
   * sessions (reviewer, autonomous probes) whose `owner_user_id` is NULL
   * — so we pick an Owner whose stored OAuth/PAT actually has access to
   * the repo, not just "the user with the earliest `created_at`". See
   * `resolveOwnerWithRepoAccess` in `repo-aware-token.ts`.
   */
  githubRepo?: string | null,
): Promise<string> {
  if (Number(session.use_worktree) !== 1) {
    return projectCwd;
  }
  if (session.worktree_path && existsSync(session.worktree_path)) {
    try {
      await setupDependencies(projectCwd, session.worktree_path, installCommand ?? null, {
        ...sessionWorkspaceDependencyInstallOpts(),
      });
    } catch (err: unknown) {
      if (!(err instanceof SessionDependencyInstallError)) throw err;
      onFailure?.(session.id, err.message);
      return projectCwd;
    }
    return session.worktree_path;
  }

  // Per-session GitHub token resolution. Pulled once at the top (before
  // any branch) so every git network call below — the reuse-path fetches
  // (origin/--quiet, origin/<base>), the auto-clone of the project, and
  // the fresh shallow clone of the session worktree — all use the same
  // credential. Deferring to after remote classification is not possible
  // because the reuse-path fetches run before we ever read the remote URL.
  //
  // Resolution order (see `resolveUserGithubToken`):
  //   1. OAuth user-to-server token (canonical, refreshable)
  //   2. Skill-credentials PAT (override / fallback)
  //   3. null — session owner missing or unauthenticated owner; downstream
  //      git calls fall back to unauthenticated access (public repos only)
  const sessionOwnerId = session.owner_user_id ?? null;
  const tokenOwnerId = await resolveWorktreeTokenOwnerId(sessionOwnerId, githubRepo ?? null);
  const userToken: string | null = await resolveUserGithubToken(tokenOwnerId, {
    oauthCredentials: resolveOAuthAppCredentials(config),
  });
  const authArgs: string[] = userToken ? gitAuthArgsForGithubPat(userToken) : [];

  // Self-heal: when a `repoUrl` is set and `projectCwd` is missing or not a
  // git repo, auto-clone the project before continuing. Errors here are
  // surfaced via `onFailure` (the same channel used by other worktree
  // failures) so downstream behaviour — falling back to the project cwd
  // — is unchanged when auto-clone fails. The session owner's PAT is
  // threaded through as a fallback so private-repo first-time clones
  // succeed for self-hosters without the GitHub App installed.
  if (repoUrl) {
    try {
      await ensureProjectRepoCloned(projectCwd, repoUrl, {
        projectId,
        requestingUserId: sessionOwnerId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Workspace] ${message}`);
      onFailure?.(session.id, message);
      return projectCwd;
    }
  }

  if (!(await isGitRepo(projectCwd))) {
    const message = `${projectCwd} is not a git repo`;
    console.warn(`[Workspace] Workspace requested but ${message} — falling back`);
    onFailure?.(session.id, message);
    return projectCwd;
  }

  const wsDir = ensureWorkspaceDir(projectCwd);
  const shortId = session.id.slice(0, 8);
  const safeName = `session-${shortId}`;
  const cloneDir = path.join(wsDir, safeName);
  const branchName = `agent-hub/${agentId}/${safeName}`;

  if (existsSync(cloneDir) && existsSync(path.join(cloneDir, '.git'))) {
    // Refresh remote-tracking refs so origin/<default> reflects current main.
    // Do NOT reset the checked-out feature branch — it may carry in-progress
    // work. Agents that want to see merged PRs can `git log origin/<default>`
    // or rebase explicitly.
    let fetchSucceeded = false;
    try {
      await fetchWithRetry([...authArgs, 'fetch', 'origin', '--quiet'], {
        cwd: cloneDir,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      fetchSucceeded = true;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = redactAuthHeader(redactToken(raw, userToken));
      console.warn(`[Workspace] Fetch failed for session "${safeName}", reusing as-is:`, message);
    }

    // Umbrella-branch drift detection. Only meaningful when:
    //   (a) we have a `pr_base_branch` to compare against (epic / stacked PR),
    //   (b) the fetch above actually landed (otherwise origin/<base> is stale
    //       and any comparison would be against the old tip — false negative).
    // For long-running cards under an epic, siblings merging into the umbrella
    // between feedback rounds means the iterating card's branch is N commits
    // behind base on resume → guaranteed conflict on next push. Two-tier fix:
    // clean tree gets auto-rebased; dirty tree gets a notice via the callback.
    //
    // The generic `fetch origin --quiet` above only updates branches in the
    // clone's `remote.origin.fetch` refspec. `git clone --depth 1` implies
    // `--single-branch`, so the clone's fetch refspec lists ONLY the default
    // branch. We must therefore explicitly refresh `origin/<base>` before
    // comparing — otherwise a stale remote-tracking ref produces a false
    // "no drift" result and the rebase opportunity is missed.
    const trimmedBase = prBaseBranch?.trim();
    if (fetchSucceeded && trimmedBase && onBaseBranchAdvanced) {
      let baseRefRefreshed = true;
      try {
        await fetchWithRetry(
          [...authArgs, 'fetch', 'origin', `${trimmedBase}:refs/remotes/origin/${trimmedBase}`],
          { cwd: cloneDir, timeoutMs: FETCH_TIMEOUT_MS },
        );
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        const message = redactAuthHeader(redactToken(raw, userToken));
        console.warn(
          `[Workspace] Could not refresh origin/${trimmedBase} for drift check on session "${safeName}":`,
          message,
        );
        baseRefRefreshed = false;
      }

      if (baseRefRefreshed) {
        try {
          const drift = await detectAndHandleBaseBranchDrift(cloneDir, session.id, trimmedBase);
          if (drift) {
            try {
              onBaseBranchAdvanced(drift);
            } catch (cbErr: unknown) {
              // A callback failure must not poison the reuse path — the
              // worktree is still healthy, we just couldn't surface the notice.
              const message = cbErr instanceof Error ? cbErr.message : String(cbErr);
              console.warn(
                `[Workspace] onBaseBranchAdvanced callback threw for session "${safeName}":`,
                message,
              );
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[Workspace] Drift detection failed for session "${safeName}", continuing:`,
            message,
          );
        }
      }
    }

    await enableHuskyHooks(cloneDir);
    try {
      await setupDependencies(projectCwd, cloneDir, installCommand ?? null, {
        ...sessionWorkspaceDependencyInstallOpts(),
      });
    } catch (err: unknown) {
      if (!(err instanceof SessionDependencyInstallError)) throw err;
      onFailure?.(session.id, err.message);
      return projectCwd;
    }
    persistFn(cloneDir, branchName, session.id);
    return cloneDir;
  }

  // If a prior clone attempt left a zombie directory (cloneDir exists but
  // without a .git), `git clone` will fail with "destination path already
  // exists and is not an empty directory". Remove it first so this session
  // isn't permanently trapped by a transient earlier failure.
  removeZombieCloneDir(cloneDir);

  // Track any token embedded in the project remote URL (e.g. a legacy
  // `x-access-token:…@github.com` install clone) for double-pass error
  // redaction in the catch below. Declared outside the try so the catch
  // can reference it even when the error fires before we reach the strip.
  let embeddedToken: string | null = null;

  try {
    const remoteUrl = await getRemoteUrl(projectCwd);
    if (remoteUrl) {
      // Strip any userinfo from the URL before calling `classifyCloneUrl`.
      // The `classifyCloneUrl` regex matches only the bare github.com host;
      // a URL of the form `https://x-access-token:<TOKEN>@github.com/…`
      // does NOT match and falls to `kind: 'other'`, which would pass the
      // token-bearing URL verbatim to `git clone` and persist it in the
      // session clone's `.git/config`. Stripping via `new URL()` is safe
      // for any valid HTTP(S) URL and is a no-op for the already-clean case.
      let canonRemoteUrl = remoteUrl;
      try {
        const u = new URL(remoteUrl);
        if (u.password) {
          embeddedToken = u.password;
          u.username = '';
          u.password = '';
          canonRemoteUrl = u.toString();
        } else if (u.username && u.username !== 'git') {
          // Rare: token encoded as username-only (no password segment).
          embeddedToken = u.username;
          u.username = '';
          canonRemoteUrl = u.toString();
        }
      } catch {
        // Not a valid hierarchical URL (e.g. `git@github.com:…` SCP form).
        // Leave canonRemoteUrl as-is; classifyCloneUrl handles SCP correctly.
      }
      // Canonicalize the source URL so a token previously embedded in the
      // project repo's `remote.origin.url` (legacy installs that cloned
      // with `https://x-access-token:…@github.com/…`) does NOT end up in
      // the session clone's `.git/config`. For github-https we rebuild
      // the clean `https://github.com/<owner>/<repo>.git` form and pair
      // it with `authArgs` (per-invocation header injection) so the
      // resulting clone has no token persisted anywhere on disk.
      const parsedRemote = classifyCloneUrl(canonRemoteUrl);
      const cloneSourceUrl =
        parsedRemote.kind === 'github-https' && parsedRemote.owner && parsedRemote.repo
          ? `https://github.com/${parsedRemote.owner}/${parsedRemote.repo}.git`
          : canonRemoteUrl;
      // Only forward auth args for github.com remotes — other hosts
      // (bitbucket, internal mirrors) should pass through unauthenticated.
      const cloneAuthArgs = parsedRemote.kind === 'github-https' ? authArgs : [];
      await cloneWithRetry(
        [...cloneAuthArgs, 'clone', '--depth', '1', '--quiet', cloneSourceUrl, cloneDir],
        { cwd: projectCwd, timeoutMs: CLONE_TIMEOUT_MS },
        cloneDir,
      );
    } else {
      await cloneWithRetry(
        ['clone', '--depth', '1', '--quiet', projectCwd, cloneDir],
        { timeoutMs: CLONE_TIMEOUT_MS },
        cloneDir,
      );
    }

    const base = prBaseBranch?.trim();
    if (base) {
      try {
        await fetchWithRetry(
          [...authArgs, 'fetch', 'origin', `${base}:refs/remotes/origin/${base}`, '--depth', '1'],
          {
            cwd: cloneDir,
            timeoutMs: FETCH_TIMEOUT_MS,
          },
        );
        await runGit(['reset', '--hard', `origin/${base}`], { cwd: cloneDir });
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        const message = redactAuthHeader(redactToken(raw, userToken));
        console.error(`[Workspace] Failed to position session clone on origin/${base}:`, message);
        onFailure?.(session.id, message);
        return projectCwd;
      }
    }

    await runGit(['checkout', '-b', branchName], { cwd: cloneDir });
    await copyGitUserConfig(projectCwd, cloneDir);
    await enableHuskyHooks(cloneDir);

    try {
      await setupDependencies(projectCwd, cloneDir, installCommand ?? null, {
        ...sessionWorkspaceDependencyInstallOpts(),
      });
    } catch (err: unknown) {
      if (!(err instanceof SessionDependencyInstallError)) throw err;
      onFailure?.(session.id, err.message);
      return projectCwd;
    }
    persistFn(cloneDir, branchName, session.id);
    console.log(
      `[Workspace] Created session clone: ${cloneDir} (branch: ${branchName})${userToken ? ' (user token)' : ''}`,
    );
    return cloneDir;
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    // Triple-pass redaction: strip the user token and any installation token
    // that was embedded in the project repo's remote.origin.url so neither
    // secret reaches the WebSocket log or the onFailure callback. The final
    // `redactAuthHeader` pass also catches the base64-encoded
    // `x-access-token:<TOKEN>` form that surfaces in `-c http.<host>
    // .extraheader=Authorization: basic …` argv echoes — that shape contains
    // none of the raw token's characters, so value-based redaction can't
    // reach it on its own.
    const once = redactToken(raw, userToken);
    const twice = redactToken(once, embeddedToken);
    const message = redactAuthHeader(twice);
    console.error(`[Workspace] Failed to create session clone:`, message);
    onFailure?.(session.id, message);
    return projectCwd;
  }
}

/**
 * Remove a workspace directory and report whether anything was actually
 * unlinked. Returns `true` only when `rmSync` ran against an existing path
 * inside `WORKSPACES_ROOT` and didn't throw. Returns `false` for the three
 * no-op paths (empty input, missing directory, path outside the managed
 * root) and for `rmSync` failures, so callers like `session-purge.ts` can
 * count honest removals instead of attempts.
 */
export function removeWorkspace(workspacePath: string): boolean {
  if (!workspacePath || !existsSync(workspacePath)) return false;

  if (!workspacePath.startsWith(WORKSPACES_ROOT)) {
    console.warn(`[Workspace] Refusing to remove path outside managed root: ${workspacePath}`);
    return false;
  }

  try {
    rmSync(workspacePath, { recursive: true, force: true });
    console.log(`[Workspace] Removed: ${workspacePath}`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workspace] Failed to remove ${workspacePath}:`, message);
    return false;
  }
}

export interface CleanupStaleOpts {
  /**
   * Given an 8-char session-id prefix (the suffix of a `session-<prefix>`
   * directory name), return true if a live or within-recovery-window session
   * row exists. When true, the directory is preserved. When false (orphan or
   * past the 24-hour archive window), the directory is removed unconditionally.
   *
   * Optional — when omitted, every `session-*` directory is preserved (legacy
   * behaviour preserved for callers that don't have a DB handle to query).
   */
  isSessionRecoverable?: (idPrefix: string) => boolean;
  /** Override for unit testing — defaults to `Date.now()`. */
  now?: number;
}

/**
 * Reclaim worktree clones inside `~/.agent-hub/workspaces/<projectSlug>/`.
 *
 * Two paths:
 * - **Non-session clones** (`cron-*`, `heartbeat-*`, ad-hoc process clones):
 *   removed when their mtime is older than `maxAgeMs` (default 24h). They
 *   regenerate cheaply on the next tick.
 * - **Session clones** (`session-<prefix>`): preserved only when
 *   `opts.isSessionRecoverable(prefix)` returns true (i.e. a live or within
 *   the 24-hour archive window row exists). Anything else — orphans on disk
 *   without a matching DB row, or rows already hard-deleted by the purge —
 *   is removed without consulting mtime, since the recovery window is the
 *   contract, not the file's last-touched time.
 *
 * Safety: every removed path is constructed inside `WORKSPACES_ROOT` via
 * `path.join`, so the implicit prefix check makes it impossible to escape.
 * The explicit `WORKSPACES_ROOT` guard remains in `removeWorkspace` for
 * direct callers.
 */
export function cleanupStaleWorkspaces(
  projectCwd: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  opts: CleanupStaleOpts = {},
): void {
  const wsDir = path.join(WORKSPACES_ROOT, projectSlug(projectCwd));
  if (!existsSync(wsDir)) return;

  const isSessionRecoverable = opts.isSessionRecoverable;
  const now = opts.now ?? Date.now();

  try {
    const entries = readdirSync(wsDir);
    for (const entry of entries) {
      const fullPath = path.join(wsDir, entry);

      // Belt-and-braces: the join above already keeps us under WORKSPACES_ROOT,
      // but a hostile entry (e.g. ".." surfaced by a broken filesystem) would
      // be rejected here too. Cheap check — keep it.
      if (!fullPath.startsWith(WORKSPACES_ROOT)) {
        console.warn(`[Workspace] Skipping path outside managed root: ${fullPath}`);
        continue;
      }

      try {
        if (entry.startsWith('session-')) {
          // Strip the `session-` prefix to get the id-prefix the DB row was
          // sliced from (`session.id.slice(0, 8)` at create time).
          //
          // Default-preserve when the caller didn't pass a recoverability
          // probe — the JSDoc on `CleanupStaleOpts.isSessionRecoverable`
          // documents this as the legacy behaviour, and "fail closed on
          // missing context" matches the rest of the purge module (e.g.
          // `session-purge.ts` returns true on a DB-lookup error). A future
          // caller without a DB handle would otherwise silently wipe live
          // session worktrees on first run.
          const idPrefix = entry.slice('session-'.length);
          if (!isSessionRecoverable || isSessionRecoverable(idPrefix)) {
            continue;
          }
          rmSync(fullPath, { recursive: true, force: true });
          console.log(`[Workspace] Cleaned up orphan session clone: ${entry}`);
          continue;
        }

        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          rmSync(fullPath, { recursive: true, force: true });
          console.log(`[Workspace] Cleaned up stale clone: ${entry}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Workspace] Cleanup failed for ${entry}:`, message);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Workspace] Cleanup scan failed:', message);
  }
}

/**
 * Test-only export: lets unit tests assert on the fail-fast git env without
 * spawning git. Not part of the public worktree contract — do not consume
 * from production code paths.
 *
 * @internal
 */
export const __test = {
  gitEnv,
  SHORT_GIT_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  CLONE_TIMEOUT_MS,
  MAX_CLONE_ATTEMPTS,
  CLONE_RETRY_BASE_MS,
  cloneWithRetry,
  fetchWithRetry,
  isTransientCloneError,
  cleanupPartialClone,
  defaultResolveInstallationToken,
  detectAndHandleBaseBranchDrift,
  detectInstallCommand,
  resolveSessionInstallCommand,
  needsDependencyInstall,
  sessionWorkspaceDependencyInstallOpts,
  setupDependencies,
  installChildEnv,
};
