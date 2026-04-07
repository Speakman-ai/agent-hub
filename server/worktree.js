/**
 * Shared git worktree utilities for Agent Hub.
 *
 * Background processes (heartbeats, crons, conference rooms, delegation) use
 * `getOrCreateProcessWorktree()` to get an isolated working directory so they
 * don't mutate the main repo's checked-out branch — which would interfere with
 * editors like Cursor that are watching project.cwd.
 *
 * Interactive chat sessions continue to use `ensureSessionWorktree()` (moved
 * here from index.js) for per-session isolation.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import path from 'path';

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
 * Ensure the .worktrees directory exists and is gitignored.
 */
function ensureWorktreesRoot(projectCwd) {
  const worktreesRoot = path.join(projectCwd, '.worktrees');
  if (!existsSync(worktreesRoot)) {
    mkdirSync(worktreesRoot, { recursive: true });
    const gitignorePath = path.join(projectCwd, '.gitignore');
    try {
      const existing = existsSync(gitignorePath)
        ? readFileSync(gitignorePath, 'utf8')
        : '';
      if (!existing.includes('.worktrees')) {
        const newline = existing.endsWith('\n') ? '' : '\n';
        writeFileSync(gitignorePath, existing + newline + '.worktrees/\n');
      }
    } catch (err) {
      console.warn('Could not update .gitignore for .worktrees:', err.message);
    }
  }
  return worktreesRoot;
}

/**
 * Create or reuse a worktree for a background process.
 *
 * Keys are stable identifiers like "heartbeat-{agentId}", "cron-{cronId}",
 * "room-{roomId}-{agentId}".  Repeated calls with the same key reuse the
 * existing worktree, avoiding proliferation.
 *
 * Falls back to projectCwd when the directory isn't a git repo or creation
 * fails — identical to existing behavior.
 *
 * @param {string} projectCwd  The project's main working directory
 * @param {string} processKey  Stable key identifying the background process
 * @returns {string} Worktree directory path (or projectCwd as fallback)
 */
export function getOrCreateProcessWorktree(projectCwd, processKey) {
  if (!isGitRepo(projectCwd)) {
    return projectCwd;
  }

  ensureWorktreesRoot(projectCwd);

  const safeName = processKey.replace(/[^a-zA-Z0-9_-]/g, '-');
  const worktreeDir = path.join(projectCwd, '.worktrees', safeName);
  const branchName = `agent-hub/bg/${safeName}`;

  // Already exists on disk — reuse
  if (existsSync(worktreeDir)) {
    return worktreeDir;
  }

  try {
    execSync(
      `git worktree add -b "${branchName}" "${worktreeDir}" HEAD`,
      { cwd: projectCwd, stdio: 'pipe' }
    );
  } catch {
    // Branch may already exist (e.g., server restart) — try without -b
    if (!existsSync(worktreeDir)) {
      try {
        execSync(
          `git worktree add "${worktreeDir}" "${branchName}"`,
          { cwd: projectCwd, stdio: 'pipe' }
        );
      } catch (err) {
        console.error(`[Worktree] Failed to create bg worktree "${processKey}":`, err.message);
        return projectCwd;
      }
    }
  }

  console.log(`[Worktree] Created bg worktree: ${worktreeDir} (branch: ${branchName})`);
  return worktreeDir;
}

/**
 * Ensure a session-specific worktree exists.
 *
 * Moved from index.js — identical logic but accepts a `persistFn` callback
 * so the caller can write the worktree path to the DB without this module
 * needing to know about `stmts`.
 *
 * @param {object} session       Session row from DB
 * @param {string} projectCwd    Project's main working directory
 * @param {string} agentId       Agent identifier (for the branch name)
 * @param {function} persistFn   (worktreePath, branchName, sessionId) => void
 * @returns {string} Worktree directory path (or projectCwd as fallback)
 */
export function ensureSessionWorktree(session, projectCwd, agentId, persistFn) {
  if (session.worktree_path && existsSync(session.worktree_path)) {
    return session.worktree_path;
  }

  if (!isGitRepo(projectCwd)) {
    console.warn(`Worktree requested but ${projectCwd} is not a git repo — falling back`);
    return projectCwd;
  }

  ensureWorktreesRoot(projectCwd);

  const shortId = session.id.slice(0, 8);
  const safeName = `session-${shortId}`;
  const worktreeDir = path.join(projectCwd, '.worktrees', safeName);
  const branchName = `agent-hub/${agentId}/${safeName}`;

  try {
    execSync(
      `git worktree add -b "${branchName}" "${worktreeDir}" HEAD`,
      { cwd: projectCwd, stdio: 'pipe' }
    );
  } catch {
    if (!existsSync(worktreeDir)) {
      try {
        execSync(
          `git worktree add "${worktreeDir}" "${branchName}"`,
          { cwd: projectCwd, stdio: 'pipe' }
        );
      } catch (err) {
        console.error('Failed to create worktree:', err.message);
        return projectCwd;
      }
    }
  }

  persistFn(worktreeDir, branchName, session.id);
  console.log(`Created worktree for session ${shortId}: ${worktreeDir} (branch: ${branchName})`);
  return worktreeDir;
}

/**
 * Remove stale background worktrees that haven't been modified recently.
 * Only targets bg worktrees (not session-* ones, which are managed by session
 * delete in index.js).
 *
 * @param {string} projectCwd  Project's main working directory
 * @param {number} maxAgeMs    Max age in ms before cleanup (default 24h)
 */
export function cleanupStaleWorktrees(projectCwd, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!isGitRepo(projectCwd)) return;
  const worktreesRoot = path.join(projectCwd, '.worktrees');
  if (!existsSync(worktreesRoot)) return;

  try {
    const entries = readdirSync(worktreesRoot);
    const now = Date.now();
    for (const entry of entries) {
      // Skip session worktrees — those are managed via session delete
      if (entry.startsWith('session-')) continue;
      const fullPath = path.join(worktreesRoot, entry);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          execSync(`git worktree remove "${fullPath}" --force`, {
            cwd: projectCwd,
            stdio: 'pipe',
          });
          console.log(`[Worktree] Cleaned up stale bg worktree: ${entry}`);
        }
      } catch (err) {
        console.warn(`[Worktree] Cleanup failed for ${entry}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Worktree] Cleanup scan failed:', err.message);
  }
}
