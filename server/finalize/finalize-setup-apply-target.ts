/**
 * Resolve where Finalize setup-apply should write + commit ci.yaml.
 */
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { sessionUsesWorktree } from '../project-mode.js';
import type { Project, SessionRow, Stmts } from '../types.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

export interface SessionWithWorktree {
  id: string;
  worktree_path: string;
  worktree_branch: string;
}

/** Wire shape for wizard spawn response + kickoff prompt. */
export interface ResolvedApplyTarget {
  sessionId: string;
  branch: string;
  worktreePath: string;
}

export interface ResolveApplyTargetDeps {
  stmts: Pick<Stmts, 'getSession' | 'getSessions' | 'updateSessionWorktreePath'>;
  provisionSessionWorkspace?: (sessionId: string) => Promise<string>;
}

function sessionBelongsToProject(session: SessionRow, project: Project): boolean {
  return (project.agents ?? []).some((agent) => agent.id === session.agent_id);
}

async function resolveGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const branch = stdout.trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Bind a session to the project's primary checkout when the agent is
 * working in `project.cwd` without a persisted worktree (common for
 * resumed card sessions before the first ensureWorktree call).
 */
export async function tryPrimaryCheckoutBind(
  stmts: ResolveApplyTargetDeps['stmts'],
  session: SessionRow,
  project: Project,
): Promise<SessionWithWorktree | null> {
  const cwd = project.cwd?.trim();
  if (!cwd) return null;
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  const branch = await resolveGitBranch(cwd);
  if (!branch) return null;
  stmts.updateSessionWorktreePath.run(cwd, branch, session.id);
  return {
    id: session.id,
    worktree_path: cwd,
    worktree_branch: branch,
  };
}

function pickSessionWithPersistedWorktree(
  stmts: ResolveApplyTargetDeps['stmts'],
  project: Project,
  preferredSessionId: string | undefined,
): SessionWithWorktree | null {
  if (preferredSessionId) {
    const row = stmts.getSession.get(preferredSessionId) as SessionRow | undefined;
    if (row && row.worktree_path && row.worktree_branch) {
      return {
        id: row.id,
        worktree_path: row.worktree_path,
        worktree_branch: row.worktree_branch,
      };
    }
  }
  let best: { row: SessionRow; updated: string } | null = null;
  for (const agent of project.agents ?? []) {
    const rows = stmts.getSessions.all(agent.id) as SessionRow[];
    for (const row of rows) {
      if (!row.worktree_path || !row.worktree_branch) continue;
      const updated = row.updated_at ?? '';
      if (!best || updated > best.updated) {
        best = { row, updated };
      }
      break;
    }
  }
  if (!best) return null;
  return {
    id: best.row.id,
    worktree_path: best.row.worktree_path as string,
    worktree_branch: best.row.worktree_branch as string,
  };
}

/**
 * When `preferredSessionId` is set, honour that session even when it has
 * no persisted worktree yet — binding `project.cwd` + current branch.
 */
export async function resolveApplyTarget(
  deps: ResolveApplyTargetDeps,
  project: Project,
  preferredSessionId: string | undefined,
): Promise<SessionWithWorktree | null> {
  if (preferredSessionId) {
    const row = deps.stmts.getSession.get(preferredSessionId) as SessionRow | undefined;
    if (row && sessionBelongsToProject(row, project)) {
      if (row.worktree_path && row.worktree_branch) {
        return {
          id: row.id,
          worktree_path: row.worktree_path,
          worktree_branch: row.worktree_branch,
        };
      }
      const primary = await tryPrimaryCheckoutBind(deps.stmts, row, project);
      if (primary) return primary;
      if (sessionUsesWorktree(row) && deps.provisionSessionWorkspace) {
        try {
          await deps.provisionSessionWorkspace(row.id);
          const refreshed = deps.stmts.getSession.get(row.id) as SessionRow | undefined;
          if (refreshed?.worktree_path && refreshed.worktree_branch) {
            return {
              id: refreshed.id,
              worktree_path: refreshed.worktree_path,
              worktree_branch: refreshed.worktree_branch,
            };
          }
        } catch (err) {
          console.warn(
            `[finalize-setup] provisionSessionWorkspace failed for session=${row.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }
  return pickSessionWithPersistedWorktree(deps.stmts, project, preferredSessionId);
}

/** Sync picker for wizard spawn-time hints (persisted worktrees only). */
export function pickSessionWithWorktreeForHint(
  stmts: ResolveApplyTargetDeps['stmts'],
  project: Project,
): SessionWithWorktree | null {
  return pickSessionWithPersistedWorktree(stmts, project, undefined);
}
