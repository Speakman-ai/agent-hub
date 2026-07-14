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
  normalizeGitCloneAuthError,
  isGitAuthCloneFailure,
} from './clone-url-auth.js';
import { gitAuthArgsForGithubPat, resolveUserGithubToken } from './skill-credentials-github.js';
import { resolveOAuthAppCredentials } from './spawn-github-credentials.js';
import { rebaseOntoBase } from './pre-push-rebase.js';

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

  if (existsSync(cloneDir) && existsSync(path.join(cloneDir, '.git'))) {
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

/**
 * Provision or reuse the per-session git clone under `~/.agent-hub/workspaces/`.
 *
 * All chat/autonomous/reviewer/webhook spawn paths converge on `ensureWorktree`
 * in `index.ts`, which calls this function. Remote refs are refreshed on every
 * call when the clone already exists (persisted `worktree_path`, on-disk reuse,
 * or resume). Fresh clones sync to `origin/<default>` or `origin/<pr_base_branch>`
 * before cutting `agent-hub/<agentId>/session-<id>`.
 */
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
        ...sessionWorkspaceDependencyInstallOpts(),
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

  if (existsSync(cloneDir) && existsSync(path.join(cloneDir, '.git'))) {
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

    // The branch the session worktree ends up on. Resolve-PR sessions try to
    // position on the PR head branch first (see below); everything else cuts
    // the default `agent-hub/<agent>/session-<id>` branch off the base.
    let effectiveBranch = branchName;
    let positionedOnPrHead = false;

    if (resolvePrHeadBranch) {
      // Position the worktree on the PR's head branch so the agent commits onto
      // the branch GitHub's PR is tracking — `git push` then updates the
      // existing PR (push-and-create-pr.ts finds it via `gh pr list --head`).
      //
      // CRITICAL: only a *genuinely missing* head ref may fall back to the
      // default session branch (the fork-PR / deleted-branch case the prompt's
      // `gh pr checkout` still covers). A transient/auth/refspec failure must
      // NOT silently fall back — doing so would strand commits on
      // `agent-hub/<agent>/session-*` and let finalize open a DUPLICATE PR,
      // the exact failure this change prevents. So we first probe the remote
      // with `ls-remote`: a reachable origin that lacks the ref is the safe
      // fallback; any probe/fetch/checkout *error* routes through `onFailure`.
      let headRefExists: boolean | null = null;
      try {
        const refs = await runGit(
          [...authArgs, 'ls-remote', '--heads', 'origin', resolvePrHeadBranch],
          { cwd: cloneDir, timeoutMs: FETCH_TIMEOUT_MS },
        );
        headRefExists = lsRemoteHasExactHead(refs, resolvePrHeadBranch);
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        const normalized = normalizeGitCloneAuthError(raw, authArgs.length > 0);
        const message = redactAuthHeader(redactToken(normalized, userToken));
        console.error(
          `[Workspace] Failed to probe PR head branch '${resolvePrHeadBranch}' on origin (${cloneDir}); not falling back to a new branch:`,
          message,
        );
        onFailure?.(session.id, message);
        return projectCwd;
      }

      if (headRefExists) {
        try {
          await fetchWithRetry(
            [
              ...authArgs,
              'fetch',
              'origin',
              `${resolvePrHeadBranch}:refs/remotes/origin/${resolvePrHeadBranch}`,
              '--depth',
              '1',
            ],
            { cwd: cloneDir, timeoutMs: FETCH_TIMEOUT_MS },
          );
          await runGit(['checkout', '-B', resolvePrHeadBranch, `origin/${resolvePrHeadBranch}`], {
            cwd: cloneDir,
          });
          const tip = await runGit(['rev-parse', `origin/${resolvePrHeadBranch}`], {
            cwd: cloneDir,
          });
          effectiveBranch = resolvePrHeadBranch;
          positionedOnPrHead = true;
          console.log(
            `[Workspace] Resolve session positioned on PR head branch origin/${resolvePrHeadBranch} at ${tip.slice(0, 7)} (${cloneDir})`,
          );
        } catch (err: unknown) {
          // The ref exists but fetch/checkout failed (transient/auth/refspec).
          // This is an infra error, NOT a fork/deleted fallback — surface it so
          // finalize never opens a duplicate PR off the default session branch.
          const raw = err instanceof Error ? err.message : String(err);
          const normalized = normalizeGitCloneAuthError(raw, authArgs.length > 0);
          const message = redactAuthHeader(redactToken(normalized, userToken));
          console.error(
            `[Workspace] Failed to position resolve session on existing PR head branch '${resolvePrHeadBranch}' (${cloneDir}); not falling back to a new branch:`,
            message,
          );
          onFailure?.(session.id, message);
          return projectCwd;
        }
      } else {
        // Reachable origin without the ref: fork PR (head lives on the fork) or
        // a deleted head branch. Fall back to the default session branch; the
        // resolve prompt's `gh pr checkout` step lands fork-PR commits on the PR.
        console.warn(
          `[Workspace] PR head branch '${resolvePrHeadBranch}' not found on origin (fork PR / deleted branch) for ${cloneDir}; falling back to ${branchName}`,
        );
      }
    }

    if (!positionedOnPrHead) {
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

    try {
      await setupDependencies(projectCwd, cloneDir, installCommand ?? null, {
        ...sessionWorkspaceDependencyInstallOpts(),
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
  defaultResolveInstallationToken,
  detectAndHandleBaseBranchDrift,
  deepenBaseForMergeBase,
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
