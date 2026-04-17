import { execSync, exec } from 'child_process';
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, symlinkSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import config from './config.js';
import type { SessionRow } from './types.js';

const WORKSPACES_ROOT: string = path.join(homedir(), '.agent-hub', 'workspaces');

export function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getRemoteUrl(cwd: string): string | null {
  try {
    return execSync('git remote get-url origin', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

function projectSlug(projectCwd: string): string {
  return path.basename(projectCwd).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Copy git user.name and user.email from a source repo (or global config)
 * into a newly-cloned directory so that `git commit` works without a global identity.
 */
function copyGitUserConfig(sourceCwd: string, targetCwd: string): void {
  const keys = ['user.name', 'user.email'] as const;
  for (const key of keys) {
    try {
      // Try source repo's local config first, then falls back to global
      const value = execSync(`git config ${key}`, { cwd: sourceCwd, stdio: 'pipe' })
        .toString()
        .trim();
      if (value) {
        execSync(`git config ${key} ${JSON.stringify(value)}`, { cwd: targetCwd, stdio: 'pipe' });
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

function getDefaultBranch(cwd: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd, stdio: 'pipe' })
      .toString()
      .trim();
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    try {
      execSync('git rev-parse --verify main', { cwd, stdio: 'pipe' });
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

export function getOrCreateProcessWorktree(
  projectCwd: string,
  processKey: string,
  installCommand?: string | null,
): string {
  if (!existsSync(projectCwd)) {
    const fallback = config.defaultCwd || homedir();
    console.warn(
      `[Workspace] cwd does not exist: "${projectCwd}" — falling back to "${fallback}" for ${processKey}`,
    );
    projectCwd = fallback;
  }

  if (!isGitRepo(projectCwd)) {
    return projectCwd;
  }

  const wsDir = ensureWorkspaceDir(projectCwd);
  const safeName = processKey.replace(/[^a-zA-Z0-9_-]/g, '-');
  const cloneDir = path.join(wsDir, safeName);

  if (existsSync(cloneDir) && existsSync(path.join(cloneDir, '.git'))) {
    try {
      execSync('git fetch origin --quiet', { cwd: cloneDir, stdio: 'pipe', timeout: 30000 });
      const defaultBranch = getDefaultBranch(projectCwd);
      execSync(`git reset --hard origin/${defaultBranch}`, { cwd: cloneDir, stdio: 'pipe' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Workspace] Sync failed for "${safeName}", reusing as-is:`, message);
    }
    setupDependencies(projectCwd, cloneDir, installCommand ?? null);
    return cloneDir;
  }

  // If a prior clone left a zombie directory (exists but no .git), remove it
  // before attempting to clone — otherwise `git clone` will fail with
  // "destination path already exists and is not an empty directory" forever.
  removeZombieCloneDir(cloneDir);

  try {
    const remoteUrl = getRemoteUrl(projectCwd);
    if (remoteUrl) {
      execSync(`git clone --depth 1 --quiet "${remoteUrl}" "${cloneDir}"`, {
        cwd: projectCwd,
        stdio: 'pipe',
        timeout: 60000,
      });
    } else {
      execSync(`git clone --depth 1 --quiet "${projectCwd}" "${cloneDir}"`, {
        stdio: 'pipe',
        timeout: 60000,
      });
    }
    copyGitUserConfig(projectCwd, cloneDir);
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

export function ensureSessionWorkspace(
  session: SessionRow,
  projectCwd: string,
  agentId: string,
  persistFn: PersistFn,
  installCommand?: string | null,
  onFailure?: OnFailureFn,
): string {
  if (session.worktree_path && existsSync(session.worktree_path)) {
    return session.worktree_path;
  }

  if (!isGitRepo(projectCwd)) {
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
      execSync('git fetch origin --quiet', { cwd: cloneDir, stdio: 'pipe', timeout: 30000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Workspace] Fetch failed for session "${safeName}", reusing as-is:`, message);
    }
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
    const remoteUrl = getRemoteUrl(projectCwd);
    if (remoteUrl) {
      execSync(`git clone --depth 1 --quiet "${remoteUrl}" "${cloneDir}"`, {
        cwd: projectCwd,
        stdio: 'pipe',
        timeout: 60000,
      });
    } else {
      execSync(`git clone --depth 1 --quiet "${projectCwd}" "${cloneDir}"`, {
        stdio: 'pipe',
        timeout: 60000,
      });
    }

    execSync(`git checkout -b "${branchName}"`, { cwd: cloneDir, stdio: 'pipe' });
    copyGitUserConfig(projectCwd, cloneDir);

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

export function removeWorkspace(workspacePath: string): void {
  if (!workspacePath || !existsSync(workspacePath)) return;

  if (!workspacePath.startsWith(WORKSPACES_ROOT)) {
    console.warn(`[Workspace] Refusing to remove path outside managed root: ${workspacePath}`);
    return;
  }

  try {
    rmSync(workspacePath, { recursive: true, force: true });
    console.log(`[Workspace] Removed: ${workspacePath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workspace] Failed to remove ${workspacePath}:`, message);
  }
}

export function cleanupStaleWorkspaces(
  projectCwd: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): void {
  const wsDir = path.join(WORKSPACES_ROOT, projectSlug(projectCwd));
  if (!existsSync(wsDir)) return;

  try {
    const entries = readdirSync(wsDir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith('session-')) continue;
      const fullPath = path.join(wsDir, entry);
      try {
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
