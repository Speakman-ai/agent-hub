/**
 * lifecycle.ts — enable/disable Agent Hub git hosting for a project.
 *
 * State transitions for `Project.gitHost` happen ONLY through here (the
 * projects PATCH endpoint rejects direct writes): enabling has filesystem
 * side effects — bare repo creation/import and rewriting `project.cwd`'s
 * `origin` to the bare path — that a plain field write would skip.
 *
 * The origin rewrite is the trick that keeps the worktree hot paths
 * unchanged: `ensureSessionWorkspace` clones session workspaces from
 * `getRemoteUrl(projectCwd)` and `classifyCloneUrl` passes local paths
 * through verbatim, so once `origin` points at the bare repo every
 * session clone/fetch/push lands on the Hub with zero worktree.ts
 * changes. The smart-HTTP transport exists for off-host consumers.
 *
 * GitHub-mirror imports can take minutes, so `enableGitHost` runs the
 * import in the background and reports progress via the in-memory state
 * map (`getGitHostImportState`) + a `git_host_update` broadcast.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import config, { resolveAgentHubApiBaseForSpawn } from '../config.js';
import { getActualPort } from '../server-port.js';
import type { Project } from '../types.js';
import {
  createHostedRepo,
  getHostedRepoInfo,
  writeNotifyConfig,
  hostedRepoExists,
  refreshBranchProtection,
  type CreateHostedRepoOptions,
} from './repo-store.js';

const execFileP = promisify(execFile);

export type GitHostImportStatus = 'importing' | 'ready' | 'error';

export interface GitHostImportState {
  status: GitHostImportStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  importedFrom?: 'github' | 'cwd' | 'empty';
}

const importStates = new Map<string, GitHostImportState>();

export function getGitHostImportState(projectId: string): GitHostImportState | null {
  return importStates.get(projectId) ?? null;
}

/**
 * The post-receive hook always runs on the Hub host (inside the spawned
 * `git receive-pack`), so loopback is always the right notify target —
 * `publicUrl` would add a pointless round-trip through nginx.
 */
export function gitHostNotifyUrl(): string {
  return `http://127.0.0.1:${getActualPort()}/git/internal/hooks/post-receive`;
}

/** External clone URL surfaced to users / spawned CLIs. */
export function gitHostCloneUrl(projectId: string): string {
  return `${resolveAgentHubApiBaseForSpawn(config)}/git/${projectId}.git`;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, timeout: 30_000 });
  return stdout;
}

/** Point `project.cwd`'s origin at the hosted bare repo (add or set-url). */
async function rewriteCwdOrigin(projectCwd: string, target: string): Promise<void> {
  if (!projectCwd || !existsSync(path.join(projectCwd, '.git'))) return;
  try {
    await git(['remote', 'set-url', 'origin', target], projectCwd);
  } catch {
    await git(['remote', 'add', 'origin', target], projectCwd);
  }
}

export interface EnableGitHostDeps {
  saveProjects: () => void;
  broadcast: (data: Record<string, unknown>) => void;
  /** Per-user GitHub credential fallback for private-repo mirror imports. */
  requestingUserId?: string | null;
  importFrom?: CreateHostedRepoOptions['importFrom'];
  /** Test seams. */
  dataDir?: string;
  notifyUrl?: string;
  resolveUserToken?: (userId: string) => Promise<string | null>;
}

/**
 * Kick off enabling. Returns immediately with the import state; the
 * import itself (potentially a slow `clone --mirror`) continues in the
 * background. On success the project record is mutated + persisted and a
 * `git_host_update` broadcast fires; on failure the state map carries the
 * error and `gitHost` is left unchanged.
 */
export function enableGitHost(project: Project, deps: EnableGitHostDeps): GitHostImportState {
  const existing = importStates.get(project.id);
  if (existing?.status === 'importing') return existing;

  const state: GitHostImportState = { status: 'importing', startedAt: Date.now() };
  importStates.set(project.id, state);

  void (async () => {
    try {
      const result = await createHostedRepo(project, {
        importFrom: deps.importFrom,
        requestingUserId: deps.requestingUserId,
        resolveUserToken: deps.resolveUserToken,
        notifyUrl: deps.notifyUrl ?? gitHostNotifyUrl(),
        dataDir: deps.dataDir,
      });

      await rewriteCwdOrigin(project.cwd, result.repoPath);

      project.gitHost = 'agenthub';
      // Default mirror policy: keep GitHub Actions/deploys alive by
      // pushing the default branch downstream after merges — but only
      // when there's a GitHub repo to mirror to.
      if (project.repoUrl && !project.gitMirror) {
        project.gitMirror = { enabled: true, refs: 'default-branch' };
      }
      deps.saveProjects();

      state.status = 'ready';
      state.finishedAt = Date.now();
      state.importedFrom = result.importedFrom;
      deps.broadcast({
        type: 'git_host_update',
        projectId: project.id,
        status: 'enabled',
        importedFrom: result.importedFrom,
      });
    } catch (err: unknown) {
      state.status = 'error';
      state.finishedAt = Date.now();
      state.error = err instanceof Error ? err.message : String(err);
      console.error(`[git-host] enable failed for ${project.id}: ${state.error}`);
      deps.broadcast({
        type: 'git_host_update',
        projectId: project.id,
        status: 'error',
        error: state.error,
      });
    }
  })();

  return state;
}

export interface DisableGitHostDeps {
  saveProjects: () => void;
  broadcast: (data: Record<string, unknown>) => void;
  dataDir?: string;
}

/**
 * Disable hosting: flip the project back to GitHub and restore the cwd
 * origin to `repoUrl` when set. The bare repo is retained on disk —
 * re-enabling is instant and nothing is lost.
 */
export async function disableGitHost(project: Project, deps: DisableGitHostDeps): Promise<void> {
  project.gitHost = 'github';
  importStates.delete(project.id);
  if (project.repoUrl) {
    try {
      await rewriteCwdOrigin(project.cwd, project.repoUrl);
    } catch (err: unknown) {
      // Restoring origin is best-effort: the project record is the source
      // of truth and a follow-up clone self-heals from repoUrl.
      console.warn(
        `[git-host] disable: could not restore origin for ${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  deps.saveProjects();
  deps.broadcast({ type: 'git_host_update', projectId: project.id, status: 'disabled' });
}

export interface GitHostStatus {
  enabled: boolean;
  cloneUrl: string | null;
  defaultBranch: string | null;
  branchCount: number;
  importState: GitHostImportState | null;
  mirror: {
    enabled: boolean;
    refs: 'default-branch' | 'all';
  } | null;
}

export async function getGitHostStatus(project: Project, dataDir?: string): Promise<GitHostStatus> {
  const enabled = project.gitHost === 'agenthub';
  const info =
    enabled && hostedRepoExists(project.id, dataDir ?? config.dataDir)
      ? await getHostedRepoInfo(project.id, dataDir ?? config.dataDir)
      : null;
  return {
    enabled,
    cloneUrl: enabled ? gitHostCloneUrl(project.id) : null,
    defaultBranch: info?.defaultBranch ?? null,
    branchCount: info?.branchCount ?? 0,
    importState: getGitHostImportState(project.id),
    mirror: enabled
      ? {
          enabled: project.gitMirror?.enabled !== false && Boolean(project.repoUrl),
          refs: project.gitMirror?.refs === 'all' ? 'all' : 'default-branch',
        }
      : null,
  };
}

/**
 * Boot-time refresh: the Hub's port can change between runs, and the
 * notify hook/config must always point at the current process. Called
 * once from index.ts after the port is bound.
 */
export function refreshGitHostNotifyConfigs(projects: Project[], dataDir?: string): void {
  for (const project of projects) {
    if (project.gitHost !== 'agenthub') continue;
    try {
      if (hostedRepoExists(project.id, dataDir ?? config.dataDir)) {
        writeNotifyConfig(project.id, gitHostNotifyUrl(), dataDir ?? config.dataDir);
        // Keep the pre-receive push block in sync with settings (the
        // hook is reinstalled above; the config file is what arms it).
        void refreshBranchProtection(project, dataDir ?? config.dataDir).catch(() => {});
      }
    } catch (err: unknown) {
      console.warn(
        `[git-host] notify refresh failed for ${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Test seam: clear in-memory import state between tests. */
export function __clearGitHostImportStates(): void {
  importStates.clear();
}
