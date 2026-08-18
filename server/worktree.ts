import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import {
  existsSync,
  lstatSync,
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
import { createRequire } from 'module';
import config from './config.js';
import type { SessionRow } from './types.js';
import {
  classifyCloneUrl,
  buildAuthenticatedUrl,
  redactToken,
  redactAuthHeader,
  normalizeGitCloneAuthError,
  isGitAuthCloneFailure,
} from './clone-url-auth.js';
import { gitAuthArgsForGithubPat, resolveUserGithubToken } from './skill-credentials-github.js';
import { resolveOAuthAppCredentials } from './spawn-github-credentials.js';
import { rebaseOntoBase } from './pre-push-rebase.js';
import { isIsolatedModeActive } from './session-mode.js';
import { sanitizeSpawnPythonEnv } from './spawn-python-env.js';

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
 * `runCronJob` in heartbeat.ts). Synchronous git calls there
 * froze the loop for up to ~60s under network slowness, which manifested as
 * the node-cron `missed execution` warning bursts on PID 19954.
 */
const execFileP = promisify(execFile);
const execP = promisify(exec);

/**
 * Host-side path of {@link WORKSPACES_ROOT}, used only by the privileged-removal
 * escalation in {@link forceRemoveWorkspaceTree}.
 *
 * The Hub container bind-mounts the host's workspaces directory at
 * `WORKSPACES_ROOT`. Preview / finalize compose stacks write artifacts into that
 * mount as uid 0 (`.agent-hub-preview/data`, `.angular/cache`, `__pycache__`),
 * so the `node`-uid Hub process cannot unlink them — `rmSync(..., {force:true})`
 * surfaces `EACCES` (force only swallows `ENOENT`). The orphan dirs then never
 * get reclaimed and accumulate, so each synchronous sweep walks more trees and
 * blocks the event loop longer (observed: a ~100s stall → `node-cron` missed
 * execution bursts → nginx 504s, and a 234 GB / 130-dir workspace pile).
 *
 * To delete those root-owned leftovers we spawn a throwaway root container with
 * the SAME host directory mounted and `rm -rf` the subtree there. That needs the
 * host path, which differs from the in-container path. Defaults to the
 * production bind source; override with `AGENT_HUB_HOST_WORKSPACES_ROOT` (set it
 * equal to `WORKSPACES_ROOT` on bare-metal / dev where they coincide).
 */
const HOST_WORKSPACES_ROOT: string =
  process.env.AGENT_HUB_HOST_WORKSPACES_ROOT?.trim() || '/var/lib/agent-hub/workspaces';

/** Tiny always-available image for the privileged-removal escalation. */
const FORCE_RM_IMAGE: string = process.env.AGENT_HUB_FORCE_RM_IMAGE?.trim() || 'alpine:3';

/**
 * When `1`, the docker-root escalation is skipped (stage 1 `rm -rf` only). Set in
 * unit tests so the sweep never shells out to docker; production leaves it unset.
 */
const FORCE_RM_DOCKER_DISABLED: boolean = process.env.AGENT_HUB_DISABLE_FORCE_RM_DOCKER === '1';

/** Hard cap on any single `rm` / `docker run` removal so a wedged unlink can't hang the sweep. */
const FORCE_RM_TIMEOUT_MS = 120_000;

/** How many orphan trees the sweep removes concurrently — bounded so the disk isn't thrashed. */
const WORKSPACE_CLEANUP_CONCURRENCY = 3;

/**
 * Remove a workspace subtree off the event loop, escalating to a privileged
 * container when the `node`-uid `rm` cannot unlink container-written artifacts.
 *
 * Stage 1 — spawn `rm -rf` as a child process (async; never blocks the loop,
 * even for a multi-GB `node_modules` tree). Clears everything owned by `node`.
 *
 * Stage 2 — if anything survives (the `EACCES` root-owned leftovers described on
 * {@link HOST_WORKSPACES_ROOT}), spawn a throwaway root container with the host
 * workspaces dir mounted and `rm -rf` the subtree there. Best-effort: logs and
 * returns `false` if docker is unavailable rather than throwing.
 *
 * Returns `true` iff an existing path was removed (matching
 * {@link removeWorkspace}'s "something was actually unlinked" contract); `false`
 * for empty input, a path outside the managed root, a missing path, or a
 * removal that left the tree behind.
 */
export async function forceRemoveWorkspaceTree(fullPath: string): Promise<boolean> {
  if (!fullPath) return false;

  // Path-safety: must live strictly inside the managed root. A bare equality to
  // the root itself is also rejected — we never remove the root.
  if (!fullPath.startsWith(WORKSPACES_ROOT + path.sep)) {
    console.warn(`[Workspace] Refusing to force-remove path outside managed root: ${fullPath}`);
    return false;
  }
  if (!existsSync(fullPath)) return false;

  // Stage 1: async `rm -rf` as the node user.
  try {
    await execFileP('rm', ['-rf', '--', fullPath], { timeout: FORCE_RM_TIMEOUT_MS });
  } catch {
    // Ignore — fall through to the existence check; a partial failure (EACCES on
    // a root-owned subpath) leaves the dir present and triggers escalation.
  }
  if (!existsSync(fullPath)) return true;

  // Stage 2: privileged escalation for root-owned leftovers.
  if (!FORCE_RM_DOCKER_DISABLED) {
    const rel = path.relative(WORKSPACES_ROOT, fullPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      // Can't happen given the prefix guard above, but never hand docker a path
      // that could escape the mounted root.
      console.warn(`[Workspace] Skipping escalation — unexpected relative path: ${rel}`);
    } else {
      const containerTarget = path.posix.join('/ws', rel.split(path.sep).join('/'));
      try {
        await execFileP(
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${HOST_WORKSPACES_ROOT}:/ws`,
            FORCE_RM_IMAGE,
            'rm',
            '-rf',
            '--',
            containerTarget,
          ],
          { timeout: FORCE_RM_TIMEOUT_MS },
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Workspace] Privileged remove failed for ${fullPath}:`, message);
      }
    }
  }

  return !existsSync(fullPath);
}

/**
 * Async, EACCES-resilient sibling of {@link removeWorkspace}. Same
 * `WORKSPACES_ROOT` safety contract and `true`-only-when-unlinked return, but
 * routes through {@link forceRemoveWorkspaceTree} so it (a) never blocks the
 * event loop and (b) reclaims root-owned container artifacts the sync version
 * leaves behind. Preferred by `session-purge.ts`.
 */
export async function removeWorkspaceAsync(workspacePath: string): Promise<boolean> {
  const removed = await forceRemoveWorkspaceTree(workspacePath);
  if (removed) console.log(`[Workspace] Removed: ${workspacePath}`);
  return removed;
}

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
 *
 * `BUG: refs/files-backend.c:NNNN: initial ref transaction called with existing
 * refs` is in this list too. It is not a network blip: it fires when something
 * wrote refs into the destination while `git clone` was still running, so the
 * clone's *initial* ref transaction found refs it was about to create (see
 * `files_initial_transaction_commit`). `withKeyedLock` now serialises workspace
 * setup per session so that race should not recur, but the failure is still
 * retryable — and classifying it as transient is what makes `cloneWithRetry`
 * run `cleanupPartialClone` between attempts. Without that, git's `BUG()` path
 * aborts via SIGABRT *without* running its own junk-dir cleanup, leaving a
 * half-built `.git` that poisons the session directory permanently.
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
  /BUG: refs\/files-backend/i,
  /initial ref transaction called with existing refs/i,
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
 *      the reviewer pipeline for ~2 days. When no Owner probes 2xx the
 *      helper returns `null` — there is no org-owner fallback.
 *   3. **`null`** — no real Owner with repo access could be determined.
 *      The clone runs without injected creds and surfaces a clear
 *      "Authentication failed" rather than borrowing an arbitrary
 *      Owner's GitHub identity.
 */
/** Shared PAT/OAuth resolution for session and process (heartbeat/cron) clones. */
async function resolveProcessWorktreeAuth(githubRepo?: string | null): Promise<{
  userToken: string | null;
  authArgs: string[];
  tokenOwnerId: string | null;
}> {
  const tokenOwnerId = await resolveWorktreeTokenOwnerId(null, githubRepo ?? null);
  const userToken: string | null = await resolveUserGithubToken(tokenOwnerId, {
    oauthCredentials: resolveOAuthAppCredentials(config),
  });
  const authArgs: string[] = userToken ? gitAuthArgsForGithubPat(userToken) : [];
  return { userToken, authArgs, tokenOwnerId };
}

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
    // No org-owner fallback — no real Owner with repo access.
    return null;
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

/**
 * Heal a clone's `origin` to point at the project's Agent Hub-hosted bare
 * repo. Clones created BEFORE a project enabled git hosting still carry
 * the old GitHub origin — without this, their pushes (auto-git "Create
 * PR", session commits) keep landing on GitHub. Called on every worktree
 * ensure/reuse for hosted projects; cheap no-op when origin already
 * matches. Best-effort: a failure here surfaces on the next push instead.
 */
export async function ensureOriginPointsAtHostedRepo(
  dir: string,
  hostedBarePath: string,
): Promise<void> {
  try {
    const current = await getRemoteUrl(dir);
    if (current === hostedBarePath) return;
    await runGit(['remote', current ? 'set-url' : 'add', 'origin', hostedBarePath], { cwd: dir });
    console.log(`[Workspace] origin → hosted repo for ${dir} (was ${current ?? '(none)'})`);
  } catch (err: unknown) {
    console.warn(
      `[Workspace] origin heal failed for ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
 * Tail of the in-flight chain for each workspace key. Entries are deleted as
 * soon as the last waiter drains, so this never grows with session count.
 */
const workspaceLocks = new Map<string, Promise<unknown>>();

/**
 * Serialise `fn` against every other call sharing `key`.
 *
 * Workspace setup is *not* idempotent under concurrency. `ensureSessionWorkspace`
 * and `getOrCreateProcessWorktree` both branch on "does a clone already exist
 * here?" and then either clone or fetch-and-reuse. Two overlapping calls for the
 * same session would each pick a branch against the same directory: one starts
 * `git clone`, the other sees the `.git` that clone just created, concludes the
 * clone is done, and fetches into it. The fetch writes `refs/remotes/origin/*`,
 * and the still-running clone then aborts in `initial_ref_transaction_commit`
 * with `BUG: refs/files-backend.c:NNNN: initial ref transaction called with
 * existing refs`, leaving a half-built repo behind.
 *
 * This is a mutex, not a promise-dedupe: each caller runs its own body with its
 * own arguments (they differ — `prBaseBranch`, `installCommand`, callbacks), it
 * just runs after the previous one finishes rather than alongside it. The second
 * caller then correctly observes a completed clone and takes the reuse path.
 *
 * A rejecting `fn` does not poison the chain: successors run regardless of how
 * their predecessor settled.
 */
async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = workspaceLocks.get(key) ?? Promise.resolve();
  // `then(fn, fn)` runs `fn` whether the predecessor fulfilled or rejected.
  const current = prev.then(fn, fn);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  workspaceLocks.set(key, tail);
  try {
    return await current;
  } finally {
    // Only clear when nobody queued behind us, so a later waiter still chains.
    if (workspaceLocks.get(key) === tail) workspaceLocks.delete(key);
  }
}

/**
 * Marker file written inside the git dir once `git clone` has returned
 * successfully. It lives under `.git/` so it never shows up in `git status`
 * and can never be committed.
 *
 * For any workspace this Hub created, the marker is the authoritative answer
 * to "did the clone finish?" — no filesystem heuristic can match it, because
 * only the process that saw `git clone` exit 0 writes it. The heuristics below
 * exist purely to classify directories cloned before the marker existed.
 */
const CLONE_COMPLETE_MARKER = 'agent-hub-clone-complete';

/** sha1 (40 hex) or sha256 (64 hex) object id. */
const OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Resolve `<cloneDir>/.git` to a real git directory, or null when it is
 * missing, is neither a directory nor a regular file, or is a linked-worktree
 * pointer that does not resolve.
 *
 * `git worktree add` writes `.git` as a *file* containing `gitdir: <path>`.
 * Accepting any non-directory `.git` unconditionally would let a truncated,
 * empty, or dangling pointer masquerade as a healthy worktree, so the pointer
 * is parsed and its target verified.
 */
function resolveGitDir(cloneDir: string): string | null {
  const gitPath = path.join(cloneDir, '.git');
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return gitPath;
  // Anything that is not a directory and not a regular file (socket, fifo,
  // device) is not a git dir pointer.
  if (!stat.isFile()) return null;
  let contents: string;
  try {
    contents = readFileSync(gitPath, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!match) return null;
  const target = path.isAbsolute(match[1]) ? match[1] : path.resolve(cloneDir, match[1]);
  try {
    if (!statSync(target).isDirectory()) return null;
  } catch {
    return null;
  }
  return target;
}

/**
 * Resolve the *common* git directory for `gitDir`.
 *
 * A linked worktree's gitdir (`.git/worktrees/<name>/`) holds only per-worktree
 * state — HEAD, index, logs — and a `commondir` file pointing at the shared
 * repository, which is where `objects/`, `refs/` and `packed-refs` actually
 * live. Checking those under the per-worktree gitdir would find nothing and
 * wrongly classify every healthy linked worktree as incomplete.
 *
 * Returns `gitDir` unchanged for an ordinary (non-linked) repository.
 */
function resolveCommonDir(gitDir: string): string {
  let raw: string;
  try {
    raw = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
  } catch {
    return gitDir;
  }
  if (!raw) return gitDir;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
  try {
    return statSync(resolved).isDirectory() ? resolved : gitDir;
  } catch {
    return gitDir;
  }
}

/**
 * Characters `git check-ref-format` forbids anywhere in a refname: ASCII
 * control characters and space (`\0`-`\x20`), DEL, and `~ ^ : ? * [ \`.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_REFNAME_CHARS = /[\u0000-\u0020\u007f~^:?*[\\]/;

/**
 * Is `name` a valid full refname, per the rules `git check-ref-format`
 * enforces?
 *
 * Checking only `startsWith('refs/')` accepted the bare namespace — `refs/`,
 * `refs/heads/` — so a truncated symref or a malformed `packed-refs` line
 * counted as a real branch and made an incomplete clone look healthy.
 *
 * Rules implemented: at least two slash-separated components; no empty
 * component; no component starting with `.` or ending with `.lock`; no `..`,
 * `@{`, leading/trailing slash, consecutive slashes, or trailing `.`; not the
 * single character `@`; and none of the forbidden characters above.
 *
 * Cross-checked against `git check-ref-format` in the test suite.
 */
function isValidRefName(name: string): boolean {
  if (!name || name === '@') return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.includes('//') || name.includes('..') || name.includes('@{')) return false;
  if (FORBIDDEN_REFNAME_CHARS.test(name)) return false;
  const components = name.split('/');
  if (components.length < 2) return false;
  for (const component of components) {
    if (!component) return false;
    if (component.startsWith('.') || component.endsWith('.lock')) return false;
  }
  return true;
}

/**
 * Is `name` a concrete ref beneath a namespace — `refs/<namespace>/<name>` with
 * a non-empty, valid name part?
 *
 * `isValidRefName` alone is not enough here: git considers `refs/heads` a
 * well-formed refname, but as the *target* of a symref or as a `packed-refs`
 * entry it names the namespace rather than a branch, and treating it as one
 * would make an incomplete clone look healthy.
 */
function isConcreteRefPath(name: string): boolean {
  return name.startsWith('refs/') && name.split('/').length >= 3 && isValidRefName(name);
}

/** A loose ref file holds either an object id or a `ref: <valid refname>` symref. */
function isValidRefContent(text: string): boolean {
  const line = text.trim();
  if (!line) return false;
  if (line.startsWith('ref:')) return isConcreteRefPath(line.slice(4).trim());
  return OBJECT_ID_RE.test(line);
}

/**
 * Walk loose refs under `<gitDir>/refs/<namespace>` looking for one file whose
 * contents are a well-formed ref.
 *
 * Recursive because refs nest: session branches live at
 * `refs/heads/agent-hub/<agentId>/session-<id>`, so the top level of
 * `refs/heads` is often a *directory*. Counting directory entries (as the first
 * version of this did) would accept an empty `refs/heads/agent-hub/` left by an
 * interrupted write.
 */
function hasLooseRefUnder(gitDir: string, namespace: string): boolean {
  const base = path.join(gitDir, 'refs', namespace);
  const stack = [base];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Validate the reconstructed refname, not just the file contents, so a
      // `.lock` file or a stray dotfile is never mistaken for a branch.
      const relative = path.relative(base, full).split(path.sep).join('/');
      if (!isConcreteRefPath(`refs/${namespace}/${relative}`)) continue;
      try {
        if (isValidRefContent(readFileSync(full, 'utf8'))) return true;
      } catch {
        /* unreadable ref — keep looking */
      }
    }
  }
  return false;
}

/** Is there a well-formed `<oid> refs/<namespace>/…` line in `packed-refs`? */
function hasPackedRefUnder(gitDir: string, namespace: string): boolean {
  let text: string;
  try {
    text = readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
  } catch {
    return false;
  }
  const prefix = `refs/${namespace}/`;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // `#` is the header, `^` is a peeled-tag continuation line.
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const [oid, name] = line.split(/\s+/);
    if (!name || !name.startsWith(prefix)) continue;
    // Rejects the bare namespace (`refs/heads/`) along with every other
    // malformed shape, so a truncated line is not counted as a branch.
    if (!isConcreteRefPath(name)) continue;
    if (OBJECT_ID_RE.test(oid ?? '')) return true;
  }
  return false;
}

/**
 * Does `gitDir` contain at least one *local* branch?
 *
 * Checks loose refs first, then `packed-refs` — a repo whose branches have been
 * packed has an empty (or missing) `refs/heads` directory, so the loose check
 * alone would report false for a perfectly healthy clone.
 */
function hasLocalBranch(gitDir: string): boolean {
  return hasLooseRefUnder(gitDir, 'heads') || hasPackedRefUnder(gitDir, 'heads');
}

/** Does `gitDir` contain at least one remote-tracking ref? */
function hasRemoteTrackingRef(gitDir: string): boolean {
  return hasLooseRefUnder(gitDir, 'remotes') || hasPackedRefUnder(gitDir, 'remotes');
}

/**
 * Has anything been written into the object store?
 *
 * This is what separates the two shapes that both present as "HEAD but no
 * refs". `git clone` populates objects (pack transport) or hardlinks them
 * (local clone) *before* it writes refs, so:
 *
 *  - empty object store  → nothing was ever transferred → the upstream really
 *    is empty and this clone finished (verified against real git: a clone of
 *    an empty bare repo has no index, no refs, and an empty `objects/`).
 *  - populated object store, still no refs → the clone died between fetching
 *    objects and `write_remote_refs`. Sweep it.
 *
 * `objects/info` is skipped: it holds `commit-graph` / `alternates` metadata
 * rather than objects, and its presence says nothing about transfer.
 */
function objectStoreIsEmpty(gitDir: string): boolean {
  const objectsDir = path.join(gitDir, 'objects');
  let entries;
  try {
    entries = readdirSync(objectsDir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (entry.name === 'info') continue;
    if (!entry.isDirectory()) return false;
    let inner: string[];
    try {
      inner = readdirSync(path.join(objectsDir, entry.name));
    } catch {
      continue;
    }
    // `objects/pack` holds .pack/.idx; `objects/<xx>` fanout dirs hold loose
    // objects. A non-empty entry in either means objects arrived.
    if (inner.length > 0) return false;
  }
  return true;
}

/**
 * Record that provisioning of `cloneDir` completed.
 *
 * Written once the workspace is genuinely reusable — cloned, positioned on its
 * session branch, checked out, hooks wired — **not** when `git clone` returned.
 * The marker is authoritative for {@link cloneLooksComplete}, so claiming it
 * earlier would let a workspace whose branch creation or positioning failed be
 * adopted on the next call as though it were fully provisioned, skipping
 * clone recovery.
 *
 * Dependency install sits outside the marker on purpose: it is idempotent and
 * re-run on every reuse, so its failure must not condemn an otherwise sound
 * workspace.
 */
function markCloneComplete(cloneDir: string): void {
  const gitDir = resolveGitDir(cloneDir);
  if (!gitDir) return;
  try {
    writeFileSync(path.join(gitDir, CLONE_COMPLETE_MARKER), `${new Date().toISOString()}\n`);
  } catch (err: unknown) {
    // Best-effort: without the marker we simply fall back to the structural
    // heuristics below, exactly as we do for pre-marker clones.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Workspace] Could not write clone-complete marker in ${cloneDir}:`, message);
  }
}

/**
 * Did `checkout` — the last phase of `git clone` — actually run?
 *
 * `cmd_clone` writes the branch in `update_head` and only then checks out, so a
 * clone killed in that window has a perfectly good `refs/heads/<branch>`, no
 * index, and an empty working tree. The index is the invariant that separates
 * the two: git always writes one when it checks out.
 *
 * Existence is the whole test, deliberately. It is *necessary* but never
 * *sufficient* — the only caller pairs it with a local-branch check — and a
 * corrupt or truncated index still proves checkout ran, which is the single
 * question being asked here.
 */
function checkoutLooksDone(gitDir: string): boolean {
  return existsSync(path.join(gitDir, 'index'));
}

/** Every object id named by a loose or packed ref under `refs/<namespace>`. */
function collectRefOids(gitDir: string, namespace: string): Set<string> {
  const oids = new Set<string>();
  const base = path.join(gitDir, 'refs', namespace);
  const stack = [base];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        // Symrefs (`refs/remotes/origin/HEAD`) name a ref, not an object.
        const text = readFileSync(full, 'utf8').trim();
        if (OBJECT_ID_RE.test(text)) oids.add(text);
      } catch {
        /* unreadable ref */
      }
    }
  }
  try {
    const prefix = `refs/${namespace}/`;
    for (const raw of readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [oid, name] = line.split(/\s+/);
      if (name?.startsWith(prefix) && OBJECT_ID_RE.test(oid ?? '')) oids.add(oid as string);
    }
  } catch {
    /* no packed-refs */
  }
  return oids;
}

/**
 * Is there a local branch whose tip is not also a remote-tracking tip?
 *
 * `git clone` writes `refs/heads/<branch>` pointing exactly at the fetched
 * remote tip, so a clone that died before checkout has a branch that merely
 * duplicates the remote. Only a branch that has *moved* represents commits a
 * re-clone could not reproduce.
 *
 * Tip equality rather than reachability is the right test for this question: it
 * is exactly what distinguishes "clone created this" from "someone committed
 * here", and it errs toward treating a branch as real work when in doubt.
 */
function hasUnpushedLocalBranch(commonDir: string): boolean {
  const localTips = collectRefOids(commonDir, 'heads');
  if (localTips.size === 0) return false;
  const remoteTips = collectRefOids(commonDir, 'remotes');
  for (const tip of localTips) {
    if (!remoteTips.has(tip)) return true;
  }
  return false;
}

/**
 * Does the working tree contain any regular file outside `.git`?
 *
 * A clone that never checked out leaves nothing behind, so any file here was
 * put there by a person or a build and must not be deleted. Returns on the
 * first hit, so the common case costs one `readdir`.
 */
function workingTreeHasFiles(cloneDir: string): boolean {
  const stack = [cloneDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (dir === cloneDir && entry.name === '.git') continue;
      if (entry.isFile()) return true;
      // Symlinks are not followed: agent-hub itself creates `node_modules`
      // symlinks during dependency setup, and those are not user work.
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return false;
}

/** Is HEAD detached — a raw object id rather than `ref: refs/…`? */
function headIsDetached(gitDir: string): boolean {
  try {
    return OBJECT_ID_RE.test(readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim());
  } catch {
    return false;
  }
}

/**
 * Did `update_head` run — i.e. does HEAD point at something real?
 *
 * `git clone` settles HEAD one of two ways: it creates `refs/heads/<branch>`
 * and points HEAD at it, or — for `--branch <tag>` and other non-branch
 * checkouts — it writes the object id straight into HEAD. Only checking for a
 * local branch misses the second, which is a completely healthy clone shape:
 *
 *     git clone --branch v1.0 …  →  0 local branches, remote refs, detached HEAD
 *
 * A clone that died before `update_head` has neither: HEAD is still the
 * symbolic placeholder written by `init_db`, pointing at a branch that was
 * never created.
 */
function headIsSettled(gitDir: string, commonDir: string): boolean {
  return hasLocalBranch(commonDir) || headIsDetached(gitDir);
}

/**
 * Does this repository hold local state that only a working session produces —
 * something a re-clone would destroy?
 *
 * Three signals, any of which means "not disposable":
 *  - a `.git/index`, which carries staged content;
 *  - a local branch, which carries commits;
 *  - a detached HEAD, which names a commit directly and so implies a real
 *    checkout rather than a half-built clone.
 *
 * Unlike {@link cloneLooksComplete}, this asks whether anything would be *lost*,
 * not whether `git clone` finished. That is why bare existence of the index is
 * the right test here: a corrupt or truncated index still means someone staged
 * something, and the cost of being wrong is refusing to delete rather than
 * deleting someone's work.
 */
function hasLocalState(gitDir: string, commonDir: string, cloneDir: string): boolean {
  if (headIsDetached(gitDir)) return true;
  if (existsSync(path.join(gitDir, 'index'))) return true;
  // A branch is only evidence of work if it has moved off the remote. `update_head`
  // creates `refs/heads/<branch>` pointing exactly at the fetched tip, so a clone
  // that died before checkout carries a branch that duplicates the remote and
  // holds nothing a re-clone would not reproduce.
  if (hasUnpushedLocalBranch(commonDir)) return true;
  return workingTreeHasFiles(cloneDir);
}

/**
 * Is `cloneDir` a *finished* clone, as opposed to the carcass of one that died
 * partway through?
 *
 * The presence of `.git` alone is not proof: `git clone` creates it about 5ms
 * into a clone that takes ~885ms warm and >10s cold on a large repo. Treating
 * that as "clone already done" is what let a second concurrent
 * `ensureSessionWorkspace` call fetch into a live clone and kill it, and what
 * then made the resulting half-built `.git` un-sweepable by
 * `removeZombieCloneDir`.
 *
 * Both callers treat `false` as "delete and re-clone", so a false negative
 * destroys a workspace. The ladder below is ordered accordingly:
 *
 *  1. `.git` must resolve to a real git dir holding both `HEAD` and an
 *     `objects/` directory (this also validates the `gitdir:` pointer for
 *     linked worktrees). `init_db` writes both, so anything missing them is
 *     not a usable repository.
 *  2. The structural invariants of a finished clone: HEAD settled *and*
 *     checkout done. Checked first, and on every call, so a workspace damaged
 *     after provisioning cannot hide behind a stale marker.
 *  3. Remote-tracking refs without those invariants — the partial-clone
 *     signature.
 *  4. Our own completion marker. It corroborates the ambiguous shapes below
 *     rather than overriding the checks above.
 *  5. Local state that only a working session produces — a staged index or a
 *     detached HEAD. A clone of an *empty* upstream legitimately has no branch
 *     and no commits, so once an agent stages work in one it would otherwise
 *     fall through to step 6 and be classified incomplete.
 *  6. No refs and no local state at all is ambiguous, so it is resolved on the
 *     object store: empty means nothing was ever transferred and the upstream
 *     is genuinely empty (a finished clone), while populated means the clone
 *     died between fetching objects and writing refs.
 *
 * Note the ordering of 4 and 5: the remote-tracking check runs first, so a
 * partially fetched clone can never be rescued by a stray index.
 *
 * Step 3 models `cmd_clone`'s last two phases directly rather than proxying
 * them. `update_head` settles HEAD — creating `refs/heads/<branch>`, or writing
 * a raw object id for `--branch <tag>` and other non-branch checkouts — and
 * only then does `checkout` write the index and working tree. Requiring both
 * catches an interruption in that window, which leaves HEAD settled but no
 * files, and reusing *that* hands an agent an empty repository.
 *
 * Testing for a local branch alone would be wrong in the other direction:
 * `git clone --branch v1.0` legitimately produces 0 local branches, remote
 * refs, an index and a detached HEAD. That shape must not fall through to
 * step 4 and be called poisoned.
 *
 * `.git/index` is the checkout invariant, tested by mere existence. That is the
 * right granularity: presence is *necessary* (checkout always writes one) but
 * never *sufficient* here, since step 3 demands the branch too, and a corrupt
 * index still means checkout ran. Deeper parsing would add risk without
 * changing any answer.
 */
function cloneLooksComplete(cloneDir: string): boolean {
  const gitDir = resolveGitDir(cloneDir);
  if (!gitDir) return false;
  if (!existsSync(path.join(gitDir, 'HEAD'))) return false;
  // HEAD and the index are per-worktree; objects and refs live in the common
  // dir, which differs from `gitDir` only for linked worktrees.
  const commonDir = resolveCommonDir(gitDir);
  try {
    if (!statSync(path.join(commonDir, 'objects')).isDirectory()) return false;
  } catch {
    return false;
  }
  // Structure is checked BEFORE the marker: the marker records that
  // provisioning once succeeded, which is not the same as the workspace still
  // being sound. Reuse-time operations (fetch, base-branch rebase, branch
  // positioning) mutate the clone and can fail, and a marker consulted first
  // would mask that forever.
  if (headIsSettled(gitDir, commonDir) && checkoutLooksDone(gitDir)) return true;
  if (hasRemoteTrackingRef(commonDir)) return false;
  if (existsSync(path.join(gitDir, CLONE_COMPLETE_MARKER))) return true;
  if (hasLocalState(gitDir, commonDir, cloneDir)) return true;
  return objectStoreIsEmpty(commonDir);
}

/**
 * If `cloneDir` exists but does not hold a *finished* git clone, remove it so
 * `git clone` can succeed. This recovers from zombie directories left behind
 * by interrupted clones (OOM, disk-full, SIGKILL mid-clone, or a `BUG()` abort
 * that skipped git's own junk-dir cleanup) — without this, every subsequent
 * clone attempt fails because `git clone` refuses a non-empty target
 * directory, permanently trapping the session/process.
 *
 * This is a recursive delete, so it does **not** rely on
 * {@link cloneLooksComplete} alone. That predicate answers "can we reuse this
 * clone?", which is a different question from "is it safe to destroy this
 * directory?" — and conflating them is how a legitimate workspace gets removed.
 * Two independent vetoes block the sweep even when the clone itself looks
 * unfinished:
 *  - a `.git` entry that exists but does not resolve (unreadable, malformed,
 *    or a linked-worktree pointer whose host repo is gone) — there is no git
 *    dir to inspect, and the working tree beside it may hold uncommitted work;
 *  - {@link hasLocalState}: a staged index, a local branch, or a detached HEAD.
 *
 * When the veto fires the directory is left in place, so the subsequent
 * `git clone` fails with "destination path already exists" and the session
 * falls back to the project checkout with a diagnosable error. That is a much
 * better outcome than silently deleting someone's work.
 *
 * Returns true if a zombie directory was removed.
 */
function removeZombieCloneDir(cloneDir: string): boolean {
  if (!existsSync(cloneDir)) return false;
  if (cloneLooksComplete(cloneDir)) return false;

  // `lstatSync`, not `existsSync`: a dangling `.git` *symlink* still means
  // someone had a repository here, and `existsSync` follows the link and would
  // report it missing.
  let gitEntryPresent = true;
  try {
    lstatSync(path.join(cloneDir, '.git'));
  } catch {
    gitEntryPresent = false;
  }

  const gitDir = resolveGitDir(cloneDir);

  // A `.git` we cannot make sense of — unreadable, malformed, or a linked
  // worktree pointer whose host repo has been moved or deleted — is NOT
  // licence to recursively delete. The working tree next to it can still hold
  // uncommitted files, and `hasLocalState` cannot vouch for them because there
  // is no git dir to inspect. Bail out and let a human look.
  if (gitEntryPresent && !gitDir) {
    console.warn(
      `[Workspace] Refusing to sweep ${cloneDir}: a .git entry exists but does not resolve ` +
        `(unreadable, malformed, or a dangling worktree pointer). It may still hold ` +
        `uncommitted files. Inspect it by hand.`,
    );
    return false;
  }

  if (gitDir && hasLocalState(gitDir, resolveCommonDir(gitDir), cloneDir)) {
    console.warn(
      `[Workspace] Refusing to sweep ${cloneDir}: the clone looks unfinished but holds ` +
        `local state (detached HEAD, staged index, a branch ahead of its remote, or ` +
        `files in the working tree). Inspect it by hand.`,
    );
    return false;
  }

  try {
    rmSync(cloneDir, { recursive: true, force: true });
    console.warn(
      `[Workspace] Removed zombie clone dir (${gitDir ? 'half-built .git — clone never settled HEAD or checked out' : 'no .git inside'}): ${cloneDir}`,
    );
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

/**
 * Does `git ls-remote --heads origin <branch>` output advertise an *exact*
 * `refs/heads/<branch>` ref? `ls-remote <pattern>` tail-matches, so a bare
 * name like `foo` would also match `refs/heads/bar/foo`; we require the full
 * ref to avoid provisioning a resolve session on the wrong branch. Pure so the
 * exact-match guard is unit-testable without git I/O.
 */
export function lsRemoteHasExactHead(lsRemoteOutput: string, branch: string): boolean {
  const suffix = `\trefs/heads/${branch}`;
  return lsRemoteOutput.split('\n').some((line) => line.endsWith(suffix));
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

/**
 * Cumulative `--deepen` steps used to reach a feature/epic base branch's
 * merge-base with the default branch on an otherwise shallow (network-cloned)
 * worktree. Bounded on purpose: a branch cut from the default diverges by a
 * small number of commits, so the first step almost always resolves the
 * merge-base. The cap keeps a pathological history from unshallowing the whole
 * repo — the per-session disk blow-up we explicitly avoid (a blanket
 * `--unshallow` across ~hundreds of session worktrees would cost tens of GB).
 */
const MERGE_BASE_DEEPEN_STEPS = [128, 512, 2048] as const;

async function isShallowClone(cwd: string): Promise<boolean> {
  try {
    return (await runGit(['rev-parse', '--is-shallow-repository'], { cwd })) === 'true';
  } catch {
    return false;
  }
}

async function mergeBaseResolves(cwd: string, refA: string, refB: string): Promise<boolean> {
  try {
    const mb = await runGit(['merge-base', refA, refB], { cwd });
    return mb.length > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure a shallow session clone has enough history for
 * `git merge-base origin/<base> origin/<default>` to resolve.
 *
 * Why: `git clone --depth 1` (honored for network / `file://` origins) grafts
 * history at depth 1, so a feature/epic base branch and the default branch
 * share NO reachable common ancestor. Every merge-base-dependent operation —
 * the pre-push / Finalize rebase, `maybeTransplantDefaultBasedBranch`, the
 * `rev-list --count` drift math — then returns garbage (the notorious "N
 * thousand commits ahead of / unsafe base branch"). We deepen the two refs
 * involved — and ONLY those two — until their merge-base is reachable, capped
 * so a runaway history can never unshallow the entire repo.
 *
 * No-op when the repo is already complete (local-path clones ignore --depth,
 * so forge/hosted worktrees are full and share objects with the bare repo via
 * hardlinks) or when base === default (straight-line history works shallow).
 */
async function deepenBaseForMergeBase(
  cloneDir: string,
  authArgs: string[],
  baseBranch: string,
  defaultBranch: string,
): Promise<void> {
  if (!baseBranch || !defaultBranch || baseBranch === defaultBranch) return;
  if (!(await isShallowClone(cloneDir))) return;
  const baseRef = `origin/${baseBranch}`;
  const defRef = `origin/${defaultBranch}`;
  for (const step of MERGE_BASE_DEEPEN_STEPS) {
    if (await mergeBaseResolves(cloneDir, baseRef, defRef)) return;
    try {
      await fetchWithRetry(
        [
          ...authArgs,
          'fetch',
          `--deepen=${step}`,
          'origin',
          `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
          `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
        ],
        { cwd: cloneDir, timeoutMs: FETCH_TIMEOUT_MS },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Workspace] deepen (+${step}) for merge-base(${baseBranch}, ${defaultBranch}) failed: ${message}`,
      );
      break;
    }
    if (!(await isShallowClone(cloneDir))) break; // fully unshallowed → done
  }
  if (!(await mergeBaseResolves(cloneDir, baseRef, defRef))) {
    console.warn(
      `[Workspace] merge-base(${baseBranch}, ${defaultBranch}) still unresolved after bounded deepen; feature-branch rebase math may be approximate`,
    );
  }
}

/**
 * True/false when origin definitively has / lacks `refs/heads/<branch>`.
 * Throws on a probe error (network/auth) so a transient failure never causes
 * us to mis-create a branch.
 */
async function originHasBranch(
  cloneDir: string,
  authArgs: string[],
  branch: string,
): Promise<boolean> {
  const refs = await runGit([...authArgs, 'ls-remote', '--heads', 'origin', branch], {
    cwd: cloneDir,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  return lsRemoteHasExactHead(refs, branch);
}

/**
 * Create a missing feature/epic integration branch on origin, cut from the
 * current tip of the default branch, so epic-linked sessions have a base to
 * branch off and merge into. Previously a missing base hard-failed the
 * session; now the platform provisions it "close to master" exactly as the
 * epic workflow intends.
 *
 * Idempotent under races: the create pushes the resolved default sha to the
 * new ref. If a concurrent session already created the branch at the same tip,
 * the push is a no-op ("up to date"); if it created it with real work, the
 * push is rejected as non-fast-forward and we adopt the existing ref instead
 * of clobbering it.
 */
async function ensureFeatureBaseBranchOnOrigin(
  cloneDir: string,
  authArgs: string[],
  baseBranch: string,
  defaultBranch: string,
): Promise<'existed' | 'created' | 'adopted-after-race'> {
  if (await originHasBranch(cloneDir, authArgs, baseBranch)) return 'existed';
  await fetchWithRetry(
    [...authArgs, 'fetch', 'origin', `${defaultBranch}:refs/remotes/origin/${defaultBranch}`],
    { cwd: cloneDir, timeoutMs: FETCH_TIMEOUT_MS },
  );
  const tip = await runGit(['rev-parse', `origin/${defaultBranch}`], { cwd: cloneDir });
  try {
    await runGit([...authArgs, 'push', 'origin', `${tip}:refs/heads/${baseBranch}`], {
      cwd: cloneDir,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    console.log(
      `[Workspace] Created epic integration branch origin/${baseBranch} from origin/${defaultBranch}@${tip.slice(0, 7)}`,
    );
    return 'created';
  } catch (err: unknown) {
    // Lost the race (or a protected-branch hook rejected the create). If the
    // branch now exists, adopt it; otherwise re-throw so the caller surfaces
    // the failure via onFailure exactly as the old missing-base path did.
    if (await originHasBranch(cloneDir, authArgs, baseBranch)) return 'adopted-after-race';
    throw err instanceof Error ? err : new Error(String(err));
  }
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

/**
 * Locate THIS server's own compiled `node-pty` module dir so session-worktree
 * installs that can't build node-pty (host without a C toolchain) can heal it by
 * copying a guaranteed ABI-matched prebuilt (see
 * `scripts/ensure-native-modules.mjs`). Resolving through the server's own module
 * graph makes the donor correct on ANY deployment topology — Docker
 * (`/app/server/node_modules/node-pty`), PM2 / bare host
 * (`~/projects/agent-hub/server/node_modules/node-pty`), etc. — instead of relying
 * on the healer's hardcoded `/app` fallback. Returns null when this server itself
 * has no node-pty (nothing to donate; the healer then degrades the Terminal).
 *
 * `requireResolve` is injectable so the resolution is unit-testable without a real
 * node-pty on disk.
 */
export function resolveHostNodePtyDonor(
  requireResolve: (id: string) => string = createRequire(import.meta.url).resolve,
): string | null {
  try {
    // node-pty/package.json is always present when the module is installed; its
    // dir is the module root the healer copies from.
    return path.dirname(requireResolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

/**
 * Precedence for the session-install `AGENT_HUB_NODE_PTY_DONOR`:
 *   1. An operator-provided value on the Hub process env always wins.
 *   2. Otherwise default to this server's own node-pty (`hostDonor`).
 *   3. If neither exists, contribute nothing (the healer degrades the Terminal).
 * Returns the env patch to merge into the install env — `{}` in cases 1 and 3
 * (case 1 already carries the value through the `process.env` spread). Pure and
 * unit-testable.
 */
export function nodePtyDonorEnvOverride(
  env: NodeJS.ProcessEnv,
  hostDonor: string | null,
): NodeJS.ProcessEnv {
  if (env.AGENT_HUB_NODE_PTY_DONOR || !hostDonor) return {};
  return { AGENT_HUB_NODE_PTY_DONOR: hostDonor };
}

/**
 * This server's own node-pty, used as the default donor for the session-install
 * env (see {@link nodePtyDonorEnvOverride}).
 */
const hostNodePtyDonor = resolveHostNodePtyDonor();

const installChildEnv: NodeJS.ProcessEnv = {
  // Scrub leaked PYTHONHOME/PYTHONPATH/VIRTUAL_ENV and pin the system Python so
  // node-gyp can compile native addons during a cold host-worktree `npm ci`.
  // Session startup skips its own hooks on host, but this install can run before
  // any sanitized chat/HostSessionEnv spawn exists, so it must sanitize too.
  ...sanitizeSpawnPythonEnv({ ...process.env }),
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
  // node-pty is an OPTIONAL dependency the Terminal needs; it has no linux-x64
  // prebuild, so session worktrees on a toolchain-less host can't build it. The
  // `postinstall` healer copies a compatible prebuilt from a donor — point it at
  // this server's own node-pty (resolved above) unless the operator already set
  // AGENT_HUB_NODE_PTY_DONOR, which survives the process.env spread and wins.
  ...nodePtyDonorEnvOverride(process.env, hostNodePtyDonor),
};

/**
 * macOS and minimal Linux images often ship `python3` but not a `pip` shim.
 * Project install commands conventionally use `pip install …`; rewrite to
 * `python3 -m pip install …` so the same strings work in dev and in Docker
 * (where we symlink `pip → pip3`).
 */
export function normalizeInstallCommandForHost(cmd: string): string {
  return cmd.replace(/\bpip(\s+install\b)/g, 'python3 -m pip$1');
}

interface NodeModulesEntry {
  relative: string;
  absolute: string;
}

interface SetupDependenciesOptions {
  /** When true, block until install finishes (deferred session publish path). */
  awaitInstall: boolean;
  /** When true, use {@link resolveSessionInstallCommand} (install:all for monorepos). */
  preferInstallAllScript: boolean;
  /**
   * Isolated / Firecracker sessions seed the guest from a tar of this clone.
   * Host `node_modules` is useless inside the VM and races the snapshot.
   * Skip host install for those sessions only — not because the Hub's global
   * `sessionEnvAdapter` is firecracker (chat is host; VM is opt-in).
   */
  skipHostInstall?: boolean;
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

function sessionScopedDependencyInstallOpts(session: SessionRow): SetupDependenciesOptions {
  return {
    ...sessionWorkspaceDependencyInstallOpts(),
    skipHostInstall: isIsolatedModeActive(session),
  };
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
  // Isolated / Firecracker sessions seed the guest from a tar of this clone.
  // Host `node_modules` (symlink from the project checkout, or a background
  // `npm install`) is useless inside the VM and races the snapshot
  // ("file changed as we read it"). The guest provisions its own deps after boot.
  if (options.skipHostInstall) {
    console.log(
      `[Workspace] Skipping host dependency install for ${cloneDir} ` +
        `(isolated session; guest provisions its own deps)`,
    );
    return;
  }

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

  const resolved = resolveInstallCommand(cloneDir, installCommand, options.preferInstallAllScript);
  if (!resolved) {
    return;
  }
  const installCmd = normalizeInstallCommandForHost(resolved);

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

async function defaultResolveInstallationToken(_repoUrl: string): Promise<string | null> {
  // The reviewer GitHub App was removed; there is no installation token to
  // mint. Clones fall back to the per-user GitHub credential below.
  return null;
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

/**
 * Self-heal counterpart of {@link ensureProjectRepoCloned} for projects
 * hosted on Agent Hub (`gitHost: 'agenthub'`): clone `projectCwd` from the
 * Hub's bare repo (a local path — no auth, no GitHub). The resulting
 * clone's `origin` is the bare path, which is exactly the post-opt-in
 * origin contract, so session worktrees branched off this cwd push to
 * the Hub with no further rewriting.
 */
export async function ensureProjectCwdFromHostedRepo(
  projectCwd: string,
  hostedBarePath: string,
  options: { projectId?: string } = {},
): Promise<boolean> {
  if (existsSync(projectCwd) && (await isGitRepo(projectCwd))) {
    return false;
  }
  if (!existsSync(hostedBarePath)) {
    throw new Error(
      `Auto-clone failed for project ${options.projectId ?? '<unknown>'}: hosted repo missing at ${hostedBarePath}`,
    );
  }

  // Existing zombie (path exists but not a git repo) → wipe before clone.
  if (existsSync(projectCwd)) {
    rmSync(projectCwd, { recursive: true, force: true });
  }
  const parentDir = path.dirname(projectCwd);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  await cloneWithRetry(
    ['clone', '--quiet', hostedBarePath, projectCwd],
    { timeoutMs: CLONE_TIMEOUT_MS },
    projectCwd,
  );
  console.log(
    `[Workspace] Auto-cloned project ${options.projectId ?? '<unknown>'} from hosted repo ${hostedBarePath} → ${projectCwd}`,
  );
  return true;
}

export type ProjectCloneUpdateStatus = 'updated' | 'noop' | 'skipped' | 'error';

export interface ProjectCloneUpdateResult {
  status: ProjectCloneUpdateStatus;
  /** Short machine-ish reason for `skipped`/`error` (safe to log). */
  reason?: string;
  branch?: string;
  beforeSha?: string;
  afterSha?: string;
}

/**
 * Force an existing project working clone to match its remote, preserving
 * untracked files.
 *
 * WHY: {@link ensureProjectRepoCloned} only clones when the directory is
 * missing — its fast path returns immediately for a healthy repo. Nothing ever
 * updated an existing clone, so a long-lived project checkout (the `cwd` an
 * agent reads + branches worktrees from) could sit pinned for weeks while the
 * server itself moved on. This is the refresh-on-use fix: both the session
 * worktree path and the process-worktree path (heartbeat / cron / finalize)
 * call this when they use the clone, so it's current exactly when it's read.
 *
 * POLICY (chosen for this feature): `git fetch origin` then
 * `git reset --hard origin/<current-branch>`. This is a FORCE update — tracked
 * local edits/commits in the project clone are discarded so the tree always
 * matches the remote. Untracked files are left alone (no `git clean`) so
 * per-clone scratch files (e.g. a `MEMORY.md` an agent dropped) survive. A
 * detached HEAD, or a branch with no `origin/<branch>` counterpart, is skipped
 * rather than guessed at.
 *
 * `authArgs` is the pre-resolved git auth prefix (the `-c http.…extraheader=…`
 * pair from {@link gitAuthArgsForGithubPat}); the token is never written to the
 * clone's `.git/config`. Pass `[]` for public repos / no credential.
 *
 * Never throws — every failure is returned as `{ status: 'error', reason }`
 * with auth secrets redacted, so a best-effort refresh never blocks the caller.
 */
export async function updateProjectCloneToOrigin(
  projectCwd: string,
  authArgs: string[],
  opts: { projectId?: string; fetchTimeoutMs?: number } = {},
): Promise<ProjectCloneUpdateResult> {
  if (!existsSync(projectCwd) || !(await isGitRepo(projectCwd))) {
    return { status: 'skipped', reason: 'not-a-git-repo' };
  }

  let branch: string;
  try {
    branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectCwd });
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    return { status: 'error', reason: redactAuthHeader(raw) };
  }
  // A detached HEAD has no branch to track; don't fabricate a reset target.
  if (!branch || branch === 'HEAD') {
    return { status: 'skipped', reason: 'detached-head' };
  }

  try {
    const before = await runGit(['rev-parse', 'HEAD'], { cwd: projectCwd });
    await runGit([...authArgs, 'fetch', 'origin', '--prune'], {
      cwd: projectCwd,
      timeoutMs: opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
    });
    // Confirm the remote actually has this branch before resetting; a
    // local-only branch (no `origin/<branch>`) would make reset fail — skip.
    try {
      await runGit(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: projectCwd });
    } catch {
      return {
        status: 'skipped',
        reason: `no-remote-branch:origin/${branch}`,
        branch,
        beforeSha: before,
      };
    }
    const target = await runGit(['rev-parse', `origin/${branch}`], { cwd: projectCwd });
    if (target === before) {
      return { status: 'noop', branch, beforeSha: before, afterSha: before };
    }
    // FORCE: discard tracked local changes/commits; untracked files preserved
    // (no `git clean`). Resetting the *currently checked-out* branch in its own
    // clone is safe w.r.t. linked worktrees — git only blocks *checking out* a
    // branch that's checked out elsewhere, not resetting the current one.
    await runGit(['reset', '--hard', `origin/${branch}`], { cwd: projectCwd });
    const after = await runGit(['rev-parse', 'HEAD'], { cwd: projectCwd });
    return { status: 'updated', branch, beforeSha: before, afterSha: after };
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    return { status: 'error', reason: redactAuthHeader(raw), branch };
  }
}

/**
 * Get (or create) the dedicated workspace clone for a heartbeat/cron process.
 *
 * Serialised per `processKey` — see {@link withKeyedLock} for why overlapping
 * calls against one clone directory are unsafe.
 */
export function getOrCreateProcessWorktree(
  ...args: Parameters<typeof getOrCreateProcessWorktreeUnlocked>
): Promise<string> {
  return withKeyedLock(`process:${args[1]}`, () => getOrCreateProcessWorktreeUnlocked(...args));
}

/**
 * Callers must go through {@link getOrCreateProcessWorktree} so the per-key
 * lock is held — this body is not safe to run concurrently against itself.
 */
async function getOrCreateProcessWorktreeUnlocked(
  projectCwd: string,
  processKey: string,
  installCommand?: string | null,
  /** Optional `origin/<branch>` tip to reset/sync to (e.g. kanban `pr_base_branch`). */
  syncBaseBranch?: string | null,
  /** Optional auto-clone source for self-healing project workspaces (Project.repoUrl). */
  repoUrl?: string | null,
  /** Project id for error attribution; opaque to the worktree code. */
  projectId?: string,
  /**
   * `Project.githubRepo` (e.g. `Speakman-ai/agent-hub`). Drives the same
   * repo-aware Owner token resolution used by session clones so heartbeat
   * and cron process worktrees authenticate private GitHub HTTPS remotes.
   */
  githubRepo?: string | null,
  /**
   * Bare repo path for Agent Hub-hosted projects (`gitHost: 'agenthub'`).
   * When set, self-heal clones from this local path instead of GitHub —
   * the Hub repo is canonical and `repoUrl` is only the mirror target.
   */
  hostedBarePath?: string | null,
): Promise<string> {
  const { userToken, authArgs, tokenOwnerId } = await resolveProcessWorktreeAuth(githubRepo);

  // Self-heal: if the project has a `repoUrl` and the cwd is missing or
  // not a git repo, auto-clone before falling through to the legacy
  // existsSync fallback. Public-repo / no-token cases are tolerated.
  if (hostedBarePath || repoUrl) {
    try {
      if (hostedBarePath) {
        await ensureProjectCwdFromHostedRepo(projectCwd, hostedBarePath, { projectId });
        // Heal a pre-hosting cwd whose origin still points at GitHub —
        // process worktrees inherit this remote when cloned.
        await ensureOriginPointsAtHostedRepo(projectCwd, hostedBarePath);
      } else {
        await ensureProjectRepoCloned(projectCwd, repoUrl, {
          projectId,
          requestingUserId: tokenOwnerId,
        });
      }
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = redactAuthHeader(redactToken(raw, userToken));
      if (!userToken && isGitAuthCloneFailure(message)) {
        console.info(
          `[Workspace] Skipping project auto-clone for ${projectId ?? '<unknown>'}: no GitHub credential (connect Settings → GitHub or set GH_TOKEN)`,
        );
      } else {
        console.error(`[Workspace] ${message}`);
      }
      // Fall through — the existing isGitRepo check below will return
      // projectCwd as-is (legacy non-git fallback) so the session can
      // still spawn against an empty workspace if that's all we have.
    }

    // Refresh-on-use: force the project clone current with its remote before a
    // heartbeat / cron / finalize process-worktree branches off it, so these
    // background readers never see a stale checkout (the gap that left the
    // project clone pinned while the server moved on). Reuses the owner creds
    // resolved above; best-effort — never blocks the process worktree.
    const refreshed = await updateProjectCloneToOrigin(projectCwd, authArgs, { projectId });
    if (refreshed.status === 'updated') {
      console.log(
        `[Workspace] Process-worktree refresh: ${projectId ?? projectCwd} ${refreshed.branch} ` +
          `${refreshed.beforeSha?.slice(0, 8)} → ${refreshed.afterSha?.slice(0, 8)}`,
      );
    } else if (refreshed.status === 'error') {
      console.warn(
        `[Workspace] Process-worktree refresh failed for ${projectId ?? projectCwd}: ${refreshed.reason}`,
      );
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

  if (cloneLooksComplete(cloneDir)) {
    if (hostedBarePath) {
      // Process worktrees created before hosting was enabled still point
      // at GitHub — repoint so heartbeat/cron pushes land on the Hub.
      await ensureOriginPointsAtHostedRepo(cloneDir, hostedBarePath);
    }
    try {
      await fetchWithRetry([...authArgs, 'fetch', 'origin', '--quiet'], {
        cwd: cloneDir,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      const syncBranch = await resolveSyncBranch(projectCwd, syncBaseBranch);
      await fetchWithRetry(
        [
          ...authArgs,
          'fetch',
          'origin',
          `${syncBranch}:refs/remotes/origin/${syncBranch}`,
          '--depth',
          '1',
        ],
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
      let canonRemoteUrl = remoteUrl;
      try {
        const u = new URL(remoteUrl);
        if (u.password || (u.username && u.username !== 'git')) {
          u.username = '';
          u.password = '';
          canonRemoteUrl = u.toString();
        }
      } catch {
        /* SCP / non-hierarchical URLs — leave as-is */
      }
      const parsedRemote = classifyCloneUrl(canonRemoteUrl);
      const cloneSourceUrl =
        parsedRemote.kind === 'github-https' && parsedRemote.owner && parsedRemote.repo
          ? `https://github.com/${parsedRemote.owner}/${parsedRemote.repo}.git`
          : canonRemoteUrl;
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
    await copyGitUserConfig(projectCwd, cloneDir);
    const syncBranch = await resolveSyncBranch(projectCwd, syncBaseBranch);
    try {
      await fetchWithRetry(
        [
          ...authArgs,
          'fetch',
          'origin',
          `${syncBranch}:refs/remotes/origin/${syncBranch}`,
          '--depth',
          '1',
        ],
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
    // Git-level provisioning is done: cloned, user config copied, synced to the
    // base tip, hooks wired. Dependency install is deliberately outside the
    // marker — it is idempotent and re-run on every reuse, so a failure there
    // must not condemn the workspace.
    markCloneComplete(cloneDir);
    await setupDependencies(projectCwd, cloneDir, installCommand ?? null, {
      awaitInstall: false,
      preferInstallAllScript: false,
    });
    console.log(`[Workspace] Created clone: ${cloneDir}${userToken ? ' (user token)' : ''}`);
    return cloneDir;
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const normalized = normalizeGitCloneAuthError(raw, authArgs.length > 0);
    const message = redactAuthHeader(redactToken(normalized, userToken));
    if (!userToken && isGitAuthCloneFailure(message)) {
      console.info(
        `[Workspace] Skipping process clone "${safeName}": no GitHub credential (${message.split('\n')[0]})`,
      );
    } else {
      console.error(`[Workspace] Failed to create clone "${safeName}":`, message);
    }
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

  // Clean tree → try auto-rebase. Route through the SHARED `rebaseOntoBase`
  // helper (the same one the pre-push Finalize path uses) rather than a
  // hand-rolled `git rebase origin/<base>`. This is critical for
  // **targeted feature branches** (cards whose `pr_base_branch` is a
  // feature/umbrella branch rather than the repo default): when the session
  // HEAD carries commits that live on `origin/<default>` but NOT on the
  // feature base, a naive `git rebase origin/<featureBase>` replays those
  // default-branch commits onto the feature base — dragging unrelated work
  // into the diff and, when they touch the same files the feature base
  // changed, producing spurious conflicts that abort the rebase and force
  // the agent to "resolve conflicts" every single turn. `rebaseOntoBase`
  // detects that shape and *transplants* only the true session commits onto
  // `origin/<base>` (see `maybeTransplantDefaultBasedBranch`), so the two
  // rebase code paths can never disagree on the exact git semantics.
  //
  // `rebaseOntoBase` guarantees the worktree is never left in a
  // "rebase in progress" limbo: on conflict it always issues
  // `git rebase --abort` internally before returning.
  const outcome = await rebaseOntoBase({
    cwd: cloneDir,
    baseBranch,
    env: gitEnv(),
  });

  if (outcome.kind === 'rebased' || outcome.kind === 'noop') {
    console.log(
      `[Workspace] Auto-rebased session ${sessionId.slice(0, 8)} onto origin/${baseBranch} (${commitsAdvanced} commits, outcome=${outcome.kind})`,
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
  }

  // `conflict` — the helper already aborted the rebase; surface so the caller
  // can post a "rebase first" notice. `skipped` (transient fetch/drift-check
  // failure or an unsafe base ref) is NOT a conflict: leave the tree as-is and
  // let the agent decide, exactly as a manual rebase would.
  const isConflict = outcome.kind === 'conflict';
  console.warn(
    `[Workspace] Auto-rebase for session ${sessionId.slice(0, 8)} on origin/${baseBranch} did not complete (outcome=${outcome.kind}${
      isConflict ? '' : `: ${outcome.reason}`
    })`,
  );
  return {
    sessionId,
    baseBranch,
    mergeBaseSha,
    newTipSha,
    commitsAdvanced,
    cleanWorkingTree: true,
    rebased: false,
    conflict: isConflict,
  };
}

interface RefreshSessionCloneRemotesOpts {
  cloneDir: string;
  projectCwd: string;
  sessionId: string;
  safeName: string;
  authArgs: string[];
  userToken: string | null;
  prBaseBranch?: string | null;
  onBaseBranchAdvanced?: OnBaseBranchAdvancedFn;
}

/**
 * Refresh remote-tracking refs for an existing session clone. Updates
 * `origin/<default>` and, when configured, `origin/<pr_base_branch>` without
 * resetting the checked-out feature branch (in-progress work must survive).
 * Logs when the sync branch tip moves so operators can audit freshness.
 */
async function refreshSessionCloneRemotes(opts: RefreshSessionCloneRemotesOpts): Promise<void> {
  const {
    cloneDir,
    projectCwd,
    sessionId,
    safeName,
    authArgs,
    userToken,
    prBaseBranch,
    onBaseBranchAdvanced,
  } = opts;

  const syncBranch = await resolveSyncBranch(projectCwd, prBaseBranch);
  let priorTip: string | null = null;
  try {
    priorTip = await runGit(['rev-parse', `origin/${syncBranch}`], { cwd: cloneDir });
  } catch {
    /* first fetch — no remote-tracking ref yet */
  }

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

  let baseRefRefreshed = false;
  try {
    await fetchWithRetry(
      [...authArgs, 'fetch', 'origin', `${syncBranch}:refs/remotes/origin/${syncBranch}`],
      { cwd: cloneDir, timeoutMs: FETCH_TIMEOUT_MS },
    );
    baseRefRefreshed = true;
    const newTip = await runGit(['rev-parse', `origin/${syncBranch}`], { cwd: cloneDir });
    if (priorTip && priorTip !== newTip) {
      console.log(
        `[Workspace] Refreshed origin/${syncBranch} for session ${safeName}: ${priorTip.slice(0, 7)} → ${newTip.slice(0, 7)}`,
      );
    } else if (!priorTip) {
      console.log(
        `[Workspace] Fetched origin/${syncBranch} for session ${safeName} at ${newTip.slice(0, 7)}`,
      );
    }
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactAuthHeader(redactToken(raw, userToken));
    console.warn(
      `[Workspace] Could not refresh origin/${syncBranch} for session "${safeName}":`,
      message,
    );
  }

  const trimmedBase = prBaseBranch?.trim();
  if (fetchSucceeded && baseRefRefreshed && trimmedBase) {
    // Ensure the reused (possibly shallow, network-cloned) worktree can still
    // compute `merge-base(origin/<base>, origin/<default>)` before the drift
    // auto-rebase runs — otherwise the feature-branch rebase math is garbage.
    // Cheap no-op once the clone is deep or when base === default.
    try {
      const defaultBranch = await getDefaultBranch(projectCwd);
      await deepenBaseForMergeBase(cloneDir, authArgs, trimmedBase, defaultBranch);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Workspace] deepen-on-reuse for origin/${trimmedBase} (session "${safeName}") failed:`,
        message,
      );
    }
  }

  if (fetchSucceeded && baseRefRefreshed && trimmedBase && onBaseBranchAdvanced) {
    try {
      const drift = await detectAndHandleBaseBranchDrift(cloneDir, sessionId, trimmedBase);
      if (drift) {
        try {
          onBaseBranchAdvanced(drift);
        } catch (cbErr: unknown) {
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

/** Outcome of {@link positionCloneOnExistingBranch}. */
type PositionCloneResult =
  | { kind: 'positioned'; tip: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/**
 * Probe origin for `<branch>` and, when the ref is present, fetch it and check
 * the fresh clone out onto it (`checkout -B <branch> origin/<branch>`). Shared
 * by the resolve-PR path and the user Branch-picker path in
 * {@link ensureSessionWorkspace}.
 *
 * Fetch depth is chosen so the positioned branch keeps a reachable merge-base
 * with its base branch — the Finalize / pre-push rebase depends on it:
 *   - **Full clone** (Agent Hub-hosted / local origin, `--depth` ignored): fetch
 *     at FULL depth. A `--depth 1` fetch here would RE-SHALLOW an otherwise
 *     complete repo at the head ref, so `merge-base(head, base)` vanishes and
 *     the Finalize rebase aborts (`rebase_aborted`) — the resolve-PR bug this
 *     guards against.
 *   - **Shallow clone** (GitHub origin, `git clone --depth 1`): fetch the tip
 *     shallowly (fast), then deepen head+default via {@link deepenBaseForMergeBase}
 *     until their merge-base is reachable. `defaultBranch` must be supplied for
 *     this to run; without it the shallow tip is left as-is.
 *
 * Returns a discriminated result instead of throwing so callers can apply their
 * own missing-ref policy: a resolve-PR session falls back to a fresh session
 * branch when the head ref is gone (fork PR / deleted branch), whereas a
 * user-chosen branch treats a missing ref as an error (never silently open a
 * new branch / duplicate PR). Any git output in `error` is redacted.
 */
async function positionCloneOnExistingBranch(opts: {
  cloneDir: string;
  branch: string;
  authArgs: string[];
  userToken: string | null | undefined;
  /**
   * Repo default branch. On a shallow clone the positioned branch is deepened
   * against it so `merge-base(branch, default)` resolves for the Finalize
   * rebase. Omit only when the caller cannot cheaply resolve it — the shallow
   * tip is then left un-deepened (pre-fix behavior).
   */
  defaultBranch?: string | null;
}): Promise<PositionCloneResult> {
  const { cloneDir, branch, authArgs, userToken, defaultBranch } = opts;
  let headRefExists: boolean;
  try {
    const refs = await runGit([...authArgs, 'ls-remote', '--heads', 'origin', branch], {
      cwd: cloneDir,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    headRefExists = lsRemoteHasExactHead(refs, branch);
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const normalized = normalizeGitCloneAuthError(raw, authArgs.length > 0);
    return { kind: 'error', message: redactAuthHeader(redactToken(normalized, userToken)) };
  }
  if (!headRefExists) return { kind: 'missing' };
  try {
    // Only shallow-fetch when the repo is already shallow. On a full clone a
    // `--depth 1` fetch would graft the head at depth 1 and strand it with no
    // shared history against the base branch.
    const shallow = await isShallowClone(cloneDir);
    const refspec = `${branch}:refs/remotes/origin/${branch}`;
    await fetchWithRetry(
      shallow
        ? [...authArgs, 'fetch', 'origin', refspec, '--depth', '1']
        : [...authArgs, 'fetch', 'origin', refspec],
      { cwd: cloneDir, timeoutMs: FETCH_TIMEOUT_MS },
    );
    await runGit(['checkout', '-B', branch, `origin/${branch}`], { cwd: cloneDir });
    // Restore just enough history that the positioned branch shares a merge-base
    // with the default branch, so the Finalize rebase onto the base succeeds.
    // No-op on full clones (already resolved) or when branch === default.
    if (shallow && defaultBranch) {
      await deepenBaseForMergeBase(cloneDir, authArgs, branch, defaultBranch);
    }
    const tip = await runGit(['rev-parse', `origin/${branch}`], { cwd: cloneDir });
    return { kind: 'positioned', tip };
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const normalized = normalizeGitCloneAuthError(raw, authArgs.length > 0);
    return { kind: 'error', message: redactAuthHeader(redactToken(normalized, userToken)) };
  }
}

export type SessionWorkspaceBranchSwitchResult =
  | { kind: 'switched'; worktreePath: string; branch: string }
  | { kind: 'default'; message: string }
  | { kind: 'missing'; message: string }
  | { kind: 'error'; message: string };

/**
 * Move a clean, already-provisioned session worktree onto an existing remote
 * branch. Callers must guard against active turns and dirty worktrees before
 * invoking this helper; the Git operation itself remains centralized here so
 * hosted-repo remotes and per-user credentials follow the normal workspace
 * path.
 */
export async function switchSessionWorkspaceBranch(
  session: SessionRow,
  branch: string,
  githubRepo?: string | null,
  hostedBarePath?: string | null,
): Promise<SessionWorkspaceBranchSwitchResult> {
  const worktreePath = session.worktree_path;
  if (!worktreePath) {
    return { kind: 'error', message: 'Session worktree is not provisioned' };
  }

  if (hostedBarePath) {
    await ensureOriginPointsAtHostedRepo(worktreePath, hostedBarePath);
  }

  const defaultBranch = await getDefaultBranch(worktreePath);
  if (branch === defaultBranch) {
    return {
      kind: 'default',
      message: `Cannot switch a session worktree onto the repository default branch '${defaultBranch}'`,
    };
  }

  const tokenOwnerId = await resolveWorktreeTokenOwnerId(
    session.owner_user_id ?? null,
    githubRepo ?? null,
  );
  const userToken = await resolveUserGithubToken(tokenOwnerId, {
    oauthCredentials: resolveOAuthAppCredentials(config),
  });
  const authArgs = userToken ? gitAuthArgsForGithubPat(userToken) : [];
  const positioned = await positionCloneOnExistingBranch({
    cloneDir: worktreePath,
    branch,
    authArgs,
    userToken,
    defaultBranch,
  });

  if (positioned.kind === 'positioned') {
    return { kind: 'switched', worktreePath, branch };
  }
  if (positioned.kind === 'missing') {
    return { kind: 'missing', message: `Branch '${branch}' no longer exists on origin` };
  }
  return positioned;
}

/**
 * Get (or create) the dedicated worktree clone for a chat session.
 *
 * Serialised per session id — see {@link withKeyedLock}. Every spawn path
 * (chat, autonomous, reviewer, webhook, resume) funnels through here, and more
 * than one of them can fire for a single session at once; without the lock the
 * second call would fetch into the clone the first is still creating.
 */
export function ensureSessionWorkspace(
  ...args: Parameters<typeof ensureSessionWorkspaceUnlocked>
): Promise<string> {
  return withKeyedLock(`session:${args[0].id}`, () => ensureSessionWorkspaceUnlocked(...args));
}

/**
 * Provision or reuse the per-session git clone under `~/.agent-hub/workspaces/`.
 *
 * All chat/autonomous/reviewer/webhook spawn paths converge on `ensureWorktree`
 * in `index.ts`, which calls this function. Remote refs are refreshed on every
 * call when the clone already exists (persisted `worktree_path`, on-disk reuse,
 * or resume). Fresh clones sync to `origin/<default>` or `origin/<pr_base_branch>`
 * before cutting `agent-hub/<agentId>/session-<id>`.
 *
 * Callers must go through {@link ensureSessionWorkspace} so the per-session
 * lock is held — this body is not safe to run concurrently against itself.
 */
async function ensureSessionWorkspaceUnlocked(
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
  /**
   * Bare repo path for Agent Hub-hosted projects (`gitHost: 'agenthub'`).
   * When set, self-heal clones from this local path instead of GitHub —
   * the Hub repo is canonical and `repoUrl` is only the mirror target.
   */
  hostedBarePath?: string | null,
): Promise<string> {
  if (Number(session.use_worktree) !== 1) {
    return projectCwd;
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
  if (hostedBarePath || repoUrl) {
    try {
      if (hostedBarePath) {
        await ensureProjectCwdFromHostedRepo(projectCwd, hostedBarePath, { projectId });
        // The cwd may predate hosting enablement (origin still GitHub) —
        // fresh session clones inherit this remote, so heal it first.
        await ensureOriginPointsAtHostedRepo(projectCwd, hostedBarePath);
      } else {
        await ensureProjectRepoCloned(projectCwd, repoUrl, {
          projectId,
          requestingUserId: sessionOwnerId,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Workspace] ${message}`);
      onFailure?.(session.id, message);
      return projectCwd;
    }

    // Session-start refresh: force the project clone current with its remote
    // before we branch this session's worktree off it, so a new session always
    // starts on the latest `main` instead of whatever the long-lived checkout
    // was last left at. Reuses `authArgs` resolved above (the repo-access owner
    // for system-spawned sessions). Best-effort — a fetch/reset failure must
    // not block the session, so we log and continue on the existing checkout.
    const refreshed = await updateProjectCloneToOrigin(projectCwd, authArgs, { projectId });
    if (refreshed.status === 'updated') {
      console.log(
        `[Workspace] Session-start refresh: project ${projectId ?? projectCwd} ${refreshed.branch} ` +
          `${refreshed.beforeSha?.slice(0, 8)} → ${refreshed.afterSha?.slice(0, 8)}`,
      );
    } else if (refreshed.status === 'error') {
      console.warn(
        `[Workspace] Session-start refresh failed for ${projectId ?? projectCwd}: ${refreshed.reason}`,
      );
    }
  }

  if (!(await isGitRepo(projectCwd))) {
    const message = `${projectCwd} is not a git repo`;
    console.warn(`[Workspace] Workspace requested but ${message} — falling back`);
    onFailure?.(session.id, message);
    return projectCwd;
  }

  const shortId = session.id.slice(0, 8);
  const safeName = `session-${shortId}`;
  // Resolve-PR sessions are pinned to the PR's head branch — provision the
  // worktree directly on it (see {@link SessionRow.resolve_pr_head_branch}) so
  // commits append to the existing PR and the session-end push updates it
  // instead of opening a new one. NULL for every other session.
  const resolvePrHeadBranch = session.resolve_pr_head_branch?.trim() || null;
  // General "work on an existing branch" choice from the session Branch picker.
  // Positions the worktree directly on the chosen branch (like resolve-PR) so
  // commits land there and Finalize pushes/updates its PR. NULL for the default
  // fresh-branch behavior. Ignored when resolve_pr_head_branch is set.
  const worktreeCheckoutBranch = session.worktree_checkout_branch?.trim() || null;

  // Persisted worktree_path (resume, kanban dispatch, webhook autofix, etc.).
  // Must refresh remotes on every ensure — previously this path returned early
  // without fetching, so origin/main stayed stale after merges landed.
  if (session.worktree_path && existsSync(session.worktree_path)) {
    if (hostedBarePath) {
      // Worktrees created before the project enabled Agent Hub hosting
      // still push to GitHub — repoint them at the hosted bare repo.
      await ensureOriginPointsAtHostedRepo(session.worktree_path, hostedBarePath);
    }
    await refreshSessionCloneRemotes({
      cloneDir: session.worktree_path,
      projectCwd,
      sessionId: session.id,
      safeName,
      authArgs,
      userToken,
      prBaseBranch,
      onBaseBranchAdvanced,
    });
    try {
      await setupDependencies(projectCwd, session.worktree_path, installCommand ?? null, {
        ...sessionScopedDependencyInstallOpts(session),
      });
    } catch (err: unknown) {
      if (!(err instanceof SessionDependencyInstallError)) throw err;
      onFailure?.(session.id, err.message);
      return projectCwd;
    }
    return session.worktree_path;
  }

  const wsDir = ensureWorkspaceDir(projectCwd);
  const cloneDir = path.join(wsDir, safeName);
  const branchName = `agent-hub/${agentId}/${safeName}`;

  if (cloneLooksComplete(cloneDir)) {
    await refreshSessionCloneRemotes({
      cloneDir,
      projectCwd,
      sessionId: session.id,
      safeName,
      authArgs,
      userToken,
      prBaseBranch,
      onBaseBranchAdvanced,
    });

    await enableHuskyHooks(cloneDir);
    try {
      await setupDependencies(projectCwd, cloneDir, installCommand ?? null, {
        ...sessionScopedDependencyInstallOpts(session),
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
    if (hostedBarePath) {
      // Agent Hub-hosted (forge) projects: clone from the LOCAL bare repo.
      // Local-path clones ignore `--depth` (git hardlinks the full object
      // store), so the worktree gets COMPLETE history — correct merge-base
      // math for feature/epic bases — AND shares objects with the bare repo
      // for ~zero marginal disk. That is the object-sharing we want for
      // locally-hosted origins, and it sidesteps the shallow-clone "unsafe
      // base branch" failure entirely. Non-hosted (GitHub-origin) projects
      // fall through to the remote-URL path below (shallow clone + deepen).
      await cloneWithRetry(
        ['clone', '--quiet', hostedBarePath, cloneDir],
        { cwd: projectCwd, timeoutMs: CLONE_TIMEOUT_MS },
        cloneDir,
      );
      await ensureOriginPointsAtHostedRepo(cloneDir, hostedBarePath);
    } else {
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
    }
    // The branch the session worktree ends up on. A resolve-PR session or a
    // user-chosen `worktree_checkout_branch` positions the worktree directly on
    // that existing branch (see below); everything else cuts the default
    // `agent-hub/<agent>/session-<id>` branch off the base.
    let effectiveBranch = branchName;
    let positionedOnExistingBranch = false;

    // Resolve-PR pins to the PR's head branch; a general session may carry a
    // user-chosen branch from the Branch picker. Resolve takes precedence.
    // `requireExactBranch` selects the missing-ref policy: a missing resolve
    // head is the fork-PR / deleted-branch case that safely falls back to a
    // fresh session branch, whereas a user-chosen branch that has vanished is
    // an explicit error (never silently open a new branch / duplicate PR).
    const requestedExistingBranch = resolvePrHeadBranch ?? worktreeCheckoutBranch;
    const requireExactBranch = !resolvePrHeadBranch && !!worktreeCheckoutBranch;

    if (requestedExistingBranch) {
      // Never position onto the repo default branch — Finalize would then push
      // to it (e.g. main). Fall through to the fresh session branch instead.
      // This guard makes "push to main" impossible regardless of what branch
      // was stored. Positioning onto a non-default feature/integration branch
      // is allowed (that's the point).
      const repoDefaultBranch = await getDefaultBranch(projectCwd);
      if (requestedExistingBranch === repoDefaultBranch) {
        console.warn(
          `[Workspace] Requested branch '${requestedExistingBranch}' is the repo default branch; using fresh session branch ${branchName} (${cloneDir})`,
        );
      } else {
        // Position the worktree on the existing branch so commits land there and
        // `git push` updates its PR (push-and-create-pr.ts finds it via
        // `gh pr list --head`). CRITICAL: a probe/fetch/checkout *error* must NOT
        // silently fall back — that would strand commits on a fresh branch and
        // let finalize open a DUPLICATE PR. Only a genuinely *missing* ref may
        // fall back, and only for resolve-PR sessions.
        const positioned = await positionCloneOnExistingBranch({
          cloneDir,
          branch: requestedExistingBranch,
          authArgs,
          userToken,
          defaultBranch: repoDefaultBranch,
        });
        if (positioned.kind === 'positioned') {
          effectiveBranch = requestedExistingBranch;
          positionedOnExistingBranch = true;
          console.log(
            `[Workspace] Session positioned on existing branch origin/${requestedExistingBranch} at ${positioned.tip.slice(0, 7)} (${cloneDir})`,
          );
        } else if (positioned.kind === 'missing') {
          if (requireExactBranch) {
            const message = `Chosen branch '${requestedExistingBranch}' no longer exists on origin`;
            console.error(`[Workspace] ${message} (${cloneDir}); not falling back to a new branch`);
            onFailure?.(session.id, message);
            return projectCwd;
          }
          // Reachable origin without the ref: fork PR (head lives on the fork) or
          // a deleted head branch. Fall back to the default session branch; the
          // resolve prompt's `gh pr checkout` lands fork-PR commits on the PR.
          console.warn(
            `[Workspace] PR head branch '${requestedExistingBranch}' not found on origin (fork PR / deleted branch) for ${cloneDir}; falling back to ${branchName}`,
          );
        } else {
          // The ref exists but probe/fetch/checkout failed (transient/auth/
          // refspec). Infra error, NOT a fork/deleted fallback — surface it so
          // finalize never opens a duplicate PR off the default session branch.
          console.error(
            `[Workspace] Failed to position session on existing branch '${requestedExistingBranch}' (${cloneDir}); not falling back to a new branch:`,
            positioned.message,
          );
          onFailure?.(session.id, positioned.message);
          return projectCwd;
        }
      }
    }

    if (!positionedOnExistingBranch) {
      const defaultBranch = await getDefaultBranch(projectCwd);
      const syncBranch = await resolveSyncBranch(projectCwd, prBaseBranch);
      const baseIsFeatureBranch = !!syncBranch && syncBranch !== defaultBranch;
      try {
        await fetchWithRetry([...authArgs, 'fetch', 'origin', '--quiet'], {
          cwd: cloneDir,
          timeoutMs: FETCH_TIMEOUT_MS,
        });
        // Epic/feature integration branch that doesn't exist yet → create it
        // from the default branch so the session has a base to branch off and
        // merge into. Previously a missing base hard-failed provisioning.
        if (baseIsFeatureBranch) {
          await ensureFeatureBaseBranchOnOrigin(cloneDir, authArgs, syncBranch, defaultBranch);
        }
        await fetchWithRetry(
          [
            ...authArgs,
            'fetch',
            'origin',
            `${syncBranch}:refs/remotes/origin/${syncBranch}`,
            '--depth',
            '1',
          ],
          {
            cwd: cloneDir,
            timeoutMs: FETCH_TIMEOUT_MS,
          },
        );
        await runGit(['reset', '--hard', `origin/${syncBranch}`], { cwd: cloneDir });
        // Deepen so `merge-base(origin/<base>, origin/<default>)` is reachable
        // for the Finalize / pre-push rebase + transplant math. No-op on
        // full/local (forge) clones or when base === default.
        if (baseIsFeatureBranch) {
          await deepenBaseForMergeBase(cloneDir, authArgs, syncBranch, defaultBranch);
        }
        const tip = await runGit(['rev-parse', `origin/${syncBranch}`], { cwd: cloneDir });
        console.log(
          `[Workspace] Fresh session clone synced to origin/${syncBranch} at ${tip.slice(0, 7)} before branching (${branchName})`,
        );
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        const normalized = normalizeGitCloneAuthError(raw, authArgs.length > 0);
        const message = redactAuthHeader(redactToken(normalized, userToken));
        console.error(
          `[Workspace] Failed to position session clone on origin/${syncBranch}:`,
          message,
        );
        onFailure?.(session.id, message);
        return projectCwd;
      }

      await runGit(['checkout', '-b', branchName], { cwd: cloneDir });
    }

    await copyGitUserConfig(projectCwd, cloneDir);
    await enableHuskyHooks(cloneDir);

    // Only now is the workspace genuinely reusable: cloned, positioned on
    // `effectiveBranch`, checked out, and hooks wired. Writing the marker at
    // clone time would have claimed completeness before branch creation and
    // positioning ran, so a failure in between left a workspace that the next
    // call adopted as authoritative — without the session branch it is
    // supposed to be on, and with clone-recovery skipped.
    //
    // Dependency install is deliberately left outside the marker. It is
    // idempotent and re-run on every reuse, and its failure returns
    // `projectCwd` without throwing; condemning the workspace for it would
    // strand the session, since the sweep is (correctly) vetoed once a session
    // branch exists.
    markCloneComplete(cloneDir);

    try {
      await setupDependencies(projectCwd, cloneDir, installCommand ?? null, {
        ...sessionScopedDependencyInstallOpts(session),
      });
    } catch (err: unknown) {
      if (!(err instanceof SessionDependencyInstallError)) throw err;
      onFailure?.(session.id, err.message);
      return projectCwd;
    }
    persistFn(cloneDir, effectiveBranch, session.id);
    console.log(
      `[Workspace] Created session clone: ${cloneDir} (branch: ${effectiveBranch})${userToken ? ' (user token)' : ''}`,
    );
    return cloneDir;
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const normalized = normalizeGitCloneAuthError(raw, authArgs.length > 0);
    // Triple-pass redaction: strip the user token and any installation token
    // that was embedded in the project repo's remote.origin.url so neither
    // secret reaches the WebSocket log or the onFailure callback. The final
    // `redactAuthHeader` pass also catches the base64-encoded
    // `x-access-token:<TOKEN>` form that surfaces in `-c http.<host>
    // .extraheader=Authorization: basic …` argv echoes — that shape contains
    // none of the raw token's characters, so value-based redaction can't
    // reach it on its own.
    const once = redactToken(normalized, userToken);
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
export async function cleanupStaleWorkspaces(
  projectCwd: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  opts: CleanupStaleOpts = {},
): Promise<void> {
  const wsDir = path.join(WORKSPACES_ROOT, projectSlug(projectCwd));
  if (!existsSync(wsDir)) return;

  const isSessionRecoverable = opts.isSessionRecoverable;
  const now = opts.now ?? Date.now();

  // Phase 1 — decide what to remove. This is the only synchronous work, and it
  // is cheap: one `readdir`, then a `statSync` + indexed DB prefix lookup per
  // entry. The heavy `rm` I/O is deferred to phase 2 so it never blocks the
  // event loop (the prior synchronous `rmSync` walk over a multi-GB orphan pile
  // froze the loop for ~100s → node-cron missed-execution bursts → 504s).
  const toRemove: { path: string; label: string }[] = [];
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
          toRemove.push({ path: fullPath, label: `orphan session clone: ${entry}` });
          continue;
        }

        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          toRemove.push({ path: fullPath, label: `stale clone: ${entry}` });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Workspace] Cleanup scan failed for ${entry}:`, message);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Workspace] Cleanup scan failed:', message);
    return;
  }

  // Phase 2 — remove off the event loop, a few at a time. `forceRemoveWorkspaceTree`
  // spawns `rm` (and escalates to a privileged container for root-owned
  // leftovers), so the disk churn happens in child processes while the loop
  // stays responsive.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < toRemove.length) {
      const item = toRemove[cursor++];
      const removed = await forceRemoveWorkspaceTree(item.path);
      if (removed) {
        console.log(`[Workspace] Cleaned up ${item.label}`);
      } else {
        console.warn(
          `[Workspace] Cleanup failed for ${path.basename(item.path)}: not fully removed`,
        );
      }
    }
  };
  const pool = Math.min(WORKSPACE_CLEANUP_CONCURRENCY, toRemove.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
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
  lsRemoteHasExactHead,
  SHORT_GIT_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  CLONE_TIMEOUT_MS,
  MAX_CLONE_ATTEMPTS,
  CLONE_RETRY_BASE_MS,
  cloneWithRetry,
  fetchWithRetry,
  isTransientCloneError,
  cleanupPartialClone,
  checkoutLooksDone,
  headIsDetached,
  headIsSettled,
  cloneLooksComplete,
  hasLocalBranch,
  collectRefOids,
  hasLocalState,
  hasUnpushedLocalBranch,
  workingTreeHasFiles,
  hasRemoteTrackingRef,
  isConcreteRefPath,
  isValidRefContent,
  isValidRefName,
  objectStoreIsEmpty,
  resolveCommonDir,
  markCloneComplete,
  resolveGitDir,
  removeZombieCloneDir,
  withKeyedLock,
  CLONE_COMPLETE_MARKER,
  defaultResolveInstallationToken,
  detectAndHandleBaseBranchDrift,
  deepenBaseForMergeBase,
  positionCloneOnExistingBranch,
  isShallowClone,
  mergeBaseResolves,
  originHasBranch,
  ensureFeatureBaseBranchOnOrigin,
  normalizeInstallCommandForHost,
  detectInstallCommand,
  resolveSessionInstallCommand,
  needsDependencyInstall,
  sessionWorkspaceDependencyInstallOpts,
  setupDependencies,
  installChildEnv,
};
