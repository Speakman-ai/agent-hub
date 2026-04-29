import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, symlinkSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import config from './config.js';
import type { SessionRow } from './types.js';

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
 * and worktree creation in this module does not run install — so without this
 * step every worktree ends up using `.git/hooks/` (the inert stub) and the
 * repo's pre-commit checks (lint, format) never fire. That's how PRs like
 * #451 slipped through with Prettier violations.
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

function detectInstallCommand(dir: string): string | null {
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock')))
    return 'bun install --frozen-lockfile';
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm ci';
  if (existsSync(path.join(dir, 'package.json'))) return 'npm install';
  return null;
}

interface NodeModulesEntry {
  relative: string;
  absolute: string;
}

function setupDependencies(
  sourceDir: string,
  cloneDir: string,
  installCommand: string | null,
): void {
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
    return;
  }

  const installCmd = installCommand || detectInstallCommand(cloneDir);
  if (installCmd) {
    console.log(`[Workspace] No node_modules in source — running "${installCmd}" in clone`);
    exec(installCmd, { cwd: cloneDir, timeout: 120000 }, (err) => {
      if (err) {
        console.warn(`[Workspace] Install failed in clone:`, err.message);
      } else {
        console.log(`[Workspace] Install completed in ${cloneDir}`);
      }
    });
  }
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

export async function getOrCreateProcessWorktree(
  projectCwd: string,
  processKey: string,
  installCommand?: string | null,
): Promise<string> {
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
      const defaultBranch = await getDefaultBranch(projectCwd);
      await runGit(['reset', '--hard', `origin/${defaultBranch}`], { cwd: cloneDir });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Workspace] Sync failed for "${safeName}", reusing as-is:`, message);
    }
    await enableHuskyHooks(cloneDir);
    setupDependencies(projectCwd, cloneDir, installCommand ?? null);
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
    await enableHuskyHooks(cloneDir);
    setupDependencies(projectCwd, cloneDir, installCommand ?? null);
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

export async function ensureSessionWorkspace(
  session: SessionRow,
  projectCwd: string,
  agentId: string,
  persistFn: PersistFn,
  installCommand?: string | null,
  onFailure?: OnFailureFn,
): Promise<string> {
  if (session.worktree_path && existsSync(session.worktree_path)) {
    return session.worktree_path;
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
    try {
      await fetchWithRetry(['fetch', 'origin', '--quiet'], {
        cwd: cloneDir,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Workspace] Fetch failed for session "${safeName}", reusing as-is:`, message);
    }
    await enableHuskyHooks(cloneDir);
    setupDependencies(projectCwd, cloneDir, installCommand ?? null);
    persistFn(cloneDir, branchName, session.id);
    return cloneDir;
  }

  // If a prior clone attempt left a zombie directory (cloneDir exists but
  // without a .git), `git clone` will fail with "destination path already
  // exists and is not an empty directory". Remove it first so this session
  // isn't permanently trapped by a transient earlier failure.
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

    await runGit(['checkout', '-b', branchName], { cwd: cloneDir });
    await copyGitUserConfig(projectCwd, cloneDir);
    await enableHuskyHooks(cloneDir);

    setupDependencies(projectCwd, cloneDir, installCommand ?? null);
    persistFn(cloneDir, branchName, session.id);
    console.log(`[Workspace] Created session clone: ${cloneDir} (branch: ${branchName})`);
    return cloneDir;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
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
};
