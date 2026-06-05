/**
 * Resolve where Finalize setup-apply should write + commit ci.yaml.
 */
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
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

export interface CreateCommitTargetDeps {
  stmts: Pick<Stmts, 'getSession' | 'createSession' | 'softDeleteSession'>;
  provisionSessionWorkspace?: (sessionId: string) => Promise<string>;
}

export interface CommitTargetSessionSpec {
  agentId: string;
  name: string;
  engine: string;
  model: string;
}

/**
 * Provision a worktree for an already-created session and resolve it into
 * a {@link SessionWithWorktree}. Returns null when provisioning is
 * unavailable or fails (e.g. `project.cwd` is not a git repo and the
 * project has no `repoUrl` to clone) — `ensureSessionWorkspace` swallows
 * those failures and leaves `worktree_path` unset rather than throwing.
 */
export async function provisionCommitTargetWorktree(
  deps: {
    stmts: Pick<Stmts, 'getSession'>;
    provisionSessionWorkspace?: (sessionId: string) => Promise<string>;
  },
  sessionId: string,
): Promise<SessionWithWorktree | null> {
  if (!deps.provisionSessionWorkspace) return null;
  try {
    await deps.provisionSessionWorkspace(sessionId);
  } catch (err) {
    console.warn(
      `[finalize-setup] provisionSessionWorkspace failed for commit-target session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  const refreshed = deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (refreshed?.worktree_path && refreshed.worktree_branch) {
    return {
      id: refreshed.id,
      worktree_path: refreshed.worktree_path,
      worktree_branch: refreshed.worktree_branch,
    };
  }
  return null;
}

/**
 * Last-resort fallback for setup-apply: when no existing session owns a
 * worktree (the common case when the wizard is launched from Settings
 * rather than from a card-linked session), create a dedicated
 * `[Finalize Config]` session, clone the project into a fresh feature
 * branch, and return it as the commit target. Without this the apply
 * endpoint 400s with `no_worktree` and the generated ci.yaml can never
 * be committed.
 *
 * Returns null when provisioning is unavailable or fails; on failure the
 * orphan session row is soft-deleted so it does not clutter the sidebar.
 */
export async function createAndProvisionCommitTarget(
  deps: CreateCommitTargetDeps,
  spec: CommitTargetSessionSpec,
  onCreate?: (sessionId: string) => void,
): Promise<SessionWithWorktree | null> {
  if (!deps.provisionSessionWorkspace) return null;
  const sessionId = uuidv4();
  // use_worktree=1: this session OWNS the config branch/worktree the
  // ci.yaml commit lands on. ask_mode=0.
  deps.stmts.createSession.run(
    sessionId,
    spec.agentId,
    spec.name,
    spec.engine,
    spec.model,
    1,
    0,
    1,
  );
  onCreate?.(sessionId);
  const target = await provisionCommitTargetWorktree(
    { stmts: deps.stmts, provisionSessionWorkspace: deps.provisionSessionWorkspace },
    sessionId,
  );
  if (!target) {
    deps.stmts.softDeleteSession.run(sessionId);
    return null;
  }
  return target;
}
