/**
 * Clone-based workspace isolation for Agent Hub.
 *
 * Instead of creating git worktrees inside the user's project directory,
 * we clone into ~/.agent-hub/workspaces/<project-slug>/<purpose>/
 * giving complete isolation with zero footprint in user projects.
 */

import { execSync, exec } from 'child_process';
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, symlinkSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

const WORKSPACES_ROOT = path.join(homedir(), '.agent-hub', 'workspaces');

/**
 * Check if a directory is inside a git repo.
 */
export function isGitRepo(dir) {
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the remote origin URL for a git repo, or null.
 */
function getRemoteUrl(cwd) {
  try {
    return execSync('git remote get-url origin', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Derive a short, filesystem-safe project slug from a path.
 * e.g., /Users/ryan/Desktop/agent-hub → agent-hub
 */
function projectSlug(projectCwd) {
  return path.basename(projectCwd).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Ensure the workspaces root and project subdirectory exist.
 */
function ensureWorkspaceDir(projectCwd) {
  const dir = path.join(WORKSPACES_ROOT, projectSlug(projectCwd));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the default branch name (main or master).
 */
function getDefaultBranch(cwd) {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd, stdio: 'pipe' })
      .toString().trim();
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

/**
 * Detect the package manager for a project by checking lock files.
 * Returns the install command or null if no Node.js project detected.
 */
function detectInstallCommand(dir) {
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun install --frozen-lockfile';
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm ci';
  if (existsSync(path.join(dir, 'package.json'))) return 'npm install';
  return null;
}

/**
 * Symlink node_modules from the source project into the clone.
 *
 * Scans the source project (up to depth 2) for node_modules directories
 * and creates symlinks in the clone pointing back to them. This is instant,
 * uses zero extra disk space, and works for monorepo structures.
 *
 * Falls back to running the install command if symlinks can't be created
 * (e.g., source has no node_modules installed).
 *
 * @param {string} sourceDir  The original project directory (with node_modules)
 * @param {string} cloneDir   The cloned workspace directory
 * @param {string|null} installCommand  Optional project-level install command (from project.commands.install)
 */
function setupDependencies(sourceDir, cloneDir, installCommand) {
  // Collect node_modules paths from the source (depth 0 and 1 subdirectories)
  const nodeModulesDirs = [];

  // Check root level
  const rootNM = path.join(sourceDir, 'node_modules');
  if (existsSync(rootNM)) {
    nodeModulesDirs.push({ relative: 'node_modules', absolute: rootNM });
  }

  // Check immediate subdirectories (monorepo: client/, server/, mobile/, etc.)
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
    // Symlink each node_modules from source into clone
    let linked = 0;
    for (const { relative, absolute } of nodeModulesDirs) {
      const target = path.join(cloneDir, relative);
      if (existsSync(target)) continue; // Already exists (real or symlink)

      // Ensure parent directory exists in the clone
      const parentDir = path.dirname(target);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      try {
        symlinkSync(absolute, target, 'junction');
        linked++;
      } catch (err) {
        console.warn(`[Workspace] Failed to symlink ${relative}:`, err.message);
      }
    }
    if (linked > 0) {
      console.log(`[Workspace] Symlinked ${linked} node_modules from source project`);
    }
    return;
  }

  // No node_modules in source — try running install in the clone (async, non-blocking)
  // Prefer the project-level install command, fall back to auto-detection
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

/**
 * Fallback: copy the project directory for non-git projects.
 */
function copyFallback(projectCwd, destDir) {
  try {
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    cpSync(projectCwd, destDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return !['node_modules', '.git', '.worktrees', 'dist', 'build'].includes(base);
      },
    });
    console.log(`[Workspace] Created copy fallback: ${destDir}`);
    return destDir;
  } catch (err) {
    console.error(`[Workspace] Copy fallback failed:`, err.message);
    return projectCwd;
  }
}

/**
 * Create or reuse an isolated workspace clone for a background process.
 *
 * Keys are stable identifiers like "heartbeat-{agentId}", "cron-{cronId}",
 * "room-{roomId}-{agentId}".  Repeated calls with the same key reuse the
 * existing clone, syncing it with a fetch+reset.
 *
 * Falls back to projectCwd when the directory isn't a git repo or creation fails.
 *
 * @param {string} projectCwd  The project's main working directory
 * @param {string} processKey  Stable key identifying the background process
 * @returns {string} Workspace directory path (or projectCwd as fallback)
 */
export function getOrCreateProcessWorktree(projectCwd, processKey, installCommand) {
  if (!isGitRepo(projectCwd)) {
    return projectCwd;
  }

  const wsDir = ensureWorkspaceDir(projectCwd);
  const safeName = processKey.replace(/[^a-zA-Z0-9_-]/g, '-');
  const cloneDir = path.join(wsDir, safeName);

  // Already exists — sync and reuse
  if (existsSync(cloneDir) && existsSync(path.join(cloneDir, '.git'))) {
    try {
      execSync('git fetch origin --quiet', { cwd: cloneDir, stdio: 'pipe', timeout: 30000 });
      const defaultBranch = getDefaultBranch(projectCwd);
      execSync(`git reset --hard origin/${defaultBranch}`, { cwd: cloneDir, stdio: 'pipe' });
    } catch (err) {
      console.warn(`[Workspace] Sync failed for "${safeName}", reusing as-is:`, err.message);
    }
    // Ensure dependencies are still linked (symlinks may have been cleaned up)
    setupDependencies(projectCwd, cloneDir, installCommand);
    return cloneDir;
  }

  // Create a fresh shallow clone
  try {
    const remoteUrl = getRemoteUrl(projectCwd);
    if (remoteUrl) {
      execSync(
        `git clone --depth 1 --quiet "${remoteUrl}" "${cloneDir}"`,
        { cwd: projectCwd, stdio: 'pipe', timeout: 60000 }
      );
    } else {
      execSync(
        `git clone --depth 1 --quiet "${projectCwd}" "${cloneDir}"`,
        { stdio: 'pipe', timeout: 60000 }
      );
    }
    setupDependencies(projectCwd, cloneDir, installCommand);
    console.log(`[Workspace] Created clone: ${cloneDir}`);
    return cloneDir;
  } catch (err) {
    console.error(`[Workspace] Failed to create clone "${safeName}":`, err.message);
    return copyFallback(projectCwd, cloneDir);
  }
}

/**
 * Create or reuse an isolated workspace clone for a chat session.
 *
 * @param {object} session       Session row from DB
 * @param {string} projectCwd    Project's main working directory
 * @param {string} agentId       Agent identifier (for the branch name)
 * @param {function} persistFn   (workspacePath, branchName, sessionId) => void
 * @param {string|null} installCommand  Optional project-level install command
 * @returns {string} Workspace directory path (or projectCwd as fallback)
 */
export function ensureSessionWorkspace(session, projectCwd, agentId, persistFn, installCommand) {
  // Already created and still on disk — reuse
  if (session.worktree_path && existsSync(session.worktree_path)) {
    return session.worktree_path;
  }

  if (!isGitRepo(projectCwd)) {
    console.warn(`Workspace requested but ${projectCwd} is not a git repo — falling back`);
    return projectCwd;
  }

  const wsDir = ensureWorkspaceDir(projectCwd);
  const shortId = session.id.slice(0, 8);
  const safeName = `session-${shortId}`;
  const cloneDir = path.join(wsDir, safeName);
  const branchName = `agent-hub/${agentId}/${safeName}`;

  if (existsSync(cloneDir) && existsSync(path.join(cloneDir, '.git'))) {
    // Clone exists from a previous attempt — reuse
    setupDependencies(projectCwd, cloneDir, installCommand);
    persistFn(cloneDir, branchName, session.id);
    return cloneDir;
  }

  try {
    const remoteUrl = getRemoteUrl(projectCwd);
    if (remoteUrl) {
      execSync(
        `git clone --depth 1 --quiet "${remoteUrl}" "${cloneDir}"`,
        { cwd: projectCwd, stdio: 'pipe', timeout: 60000 }
      );
    } else {
      execSync(
        `git clone --depth 1 --quiet "${projectCwd}" "${cloneDir}"`,
        { stdio: 'pipe', timeout: 60000 }
      );
    }

    // Create the feature branch
    execSync(`git checkout -b "${branchName}"`, { cwd: cloneDir, stdio: 'pipe' });

    setupDependencies(projectCwd, cloneDir, installCommand);
    persistFn(cloneDir, branchName, session.id);
    console.log(`[Workspace] Created session clone: ${cloneDir} (branch: ${branchName})`);
    return cloneDir;
  } catch (err) {
    console.error(`[Workspace] Failed to create session clone:`, err.message);
    return projectCwd;
  }
}

/**
 * Remove a workspace directory (e.g., on session delete).
 * Simple rm -rf — no git worktree bookkeeping needed.
 *
 * @param {string} workspacePath  The workspace directory to remove
 */
export function removeWorkspace(workspacePath) {
  if (!workspacePath || !existsSync(workspacePath)) return;

  // Safety: only remove paths under our managed root
  if (!workspacePath.startsWith(WORKSPACES_ROOT)) {
    console.warn(`[Workspace] Refusing to remove path outside managed root: ${workspacePath}`);
    return;
  }

  try {
    rmSync(workspacePath, { recursive: true, force: true });
    console.log(`[Workspace] Removed: ${workspacePath}`);
  } catch (err) {
    console.error(`[Workspace] Failed to remove ${workspacePath}:`, err.message);
  }
}

/**
 * Remove stale background clones that haven't been modified recently.
 * Only targets non-session clones (session clones are managed via session delete).
 *
 * @param {string} projectCwd  Project's main working directory
 * @param {number} maxAgeMs    Max age in ms before cleanup (default 24h)
 */
export function cleanupStaleWorkspaces(projectCwd, maxAgeMs = 24 * 60 * 60 * 1000) {
  const wsDir = path.join(WORKSPACES_ROOT, projectSlug(projectCwd));
  if (!existsSync(wsDir)) return;

  try {
    const entries = readdirSync(wsDir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith('session-')) continue; // Managed by session delete
      const fullPath = path.join(wsDir, entry);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          rmSync(fullPath, { recursive: true, force: true });
          console.log(`[Workspace] Cleaned up stale clone: ${entry}`);
        }
      } catch (err) {
        console.warn(`[Workspace] Cleanup failed for ${entry}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Workspace] Cleanup scan failed:', err.message);
  }
}
