/**
 * git-host.ts — lifecycle routes for Agent Hub-hosted git repos.
 *
 * `Project.gitHost` transitions ONLY happen through these endpoints (the
 * projects PATCH rejects direct writes): enabling creates/imports the
 * bare repo and rewrites the project cwd's `origin`, which a plain field
 * write would skip. The git smart-HTTP transport itself lives outside
 * `/api` (see server/git-host/smart-http.ts); these routes are mounted
 * behind `authMiddleware` + the project visibility gate like every other
 * `/api/projects/:projectId/*` router.
 */

import { Router, type Request, type Response } from 'express';
import type { RouteDeps, Project } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole } from '../roles.js';
import { disableGitHost, enableGitHost, getGitHostStatus } from '../git-host/lifecycle.js';
import {
  getRepoCommitDetail,
  isSafeBranchName,
  listRepoBranches,
  listRepoCommits,
  readRepoReadme,
} from '../git-host/repo-read.js';
import { issueGitHostMediaToken } from '../git-host-media-mount.js';
import {
  gitHostRepoPath,
  hostedRepoDefaultBranch,
  hostedRepoExists,
  refreshBranchProtection,
} from '../git-host/repo-store.js';
import { listRecentPushes } from '../git-host/recent-pushes.js';
import { mirrorPolicy, readMirrorState } from '../git-host/mirror.js';
import { reconcileMirror } from '../git-host/reconcile.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
import { z, registerPath } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = z.object({ error: z.string() });

const ImportStateSchema = z
  .object({
    status: z.enum(['importing', 'ready', 'error']),
    startedAt: z.number(),
    finishedAt: z.number().optional(),
    error: z.string().optional(),
    importedFrom: z.enum(['github', 'cwd', 'empty']).optional(),
  })
  .nullable();

const GitHostStatusSchema = z.object({
  enabled: z.boolean(),
  cloneUrl: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  branchCount: z.number(),
  importState: ImportStateSchema,
  mirror: z
    .object({
      enabled: z.boolean(),
      refs: z.enum(['default-branch', 'all']),
    })
    .nullable(),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/git-host',
  tags: ['Projects'],
  summary: 'Git hosting status for a project',
  description:
    'Reports whether the project uses Agent Hub-hosted git (gitHost: agenthub), the clone URL, default branch, import progress, and the GitHub mirror policy.',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: { description: 'Hosting status.', content: jsonContent(GitHostStatusSchema) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/git-host/enable',
  tags: ['Projects'],
  summary: 'Enable Agent Hub git hosting for a project',
  description:
    'Creates the hosted bare repo (importing from GitHub via repoUrl, from the project cwd, or empty), rewrites the project cwd origin to the hosted repo, and flips gitHost to agenthub. The import runs in the background — poll GET /git-host for progress. Requires Admin.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          importFrom: z.enum(['auto', 'github', 'cwd', 'empty']).optional(),
        }),
      ),
      required: false,
    },
  },
  responses: {
    202: {
      description: 'Import started (or already running).',
      content: jsonContent(GitHostStatusSchema),
    },
    400: { description: 'Invalid importFrom.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
    409: { description: 'Hosting already enabled.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/git-host/disable',
  tags: ['Projects'],
  summary: 'Disable Agent Hub git hosting for a project',
  description:
    'Flips gitHost back to github and restores the project cwd origin to repoUrl when set. The hosted bare repo is retained on disk. Requires Admin.',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: { description: 'Hosting disabled.', content: jsonContent(GitHostStatusSchema) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
    409: { description: 'Hosting not enabled.', content: jsonContent(ErrorResponse) },
  },
});

const RepoBranchSchema = z.object({
  name: z.string(),
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
  isDefault: z.boolean(),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
});

const RepoCommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/git-host/branches',
  tags: ['Projects'],
  summary: 'List branches of an Agent Hub-hosted repo',
  description:
    'Branches of the hosted bare repo, newest-commit first, with ahead/behind counts relative to the default branch. Repository-page surface; 404 unless the project uses gitHost: agenthub.',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: {
      description: 'Branch list.',
      content: jsonContent(
        z.object({ defaultBranch: z.string().nullable(), branches: z.array(RepoBranchSchema) }),
      ),
    },
    404: { description: 'Unknown project or not Hub-hosted.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/git-host/branches/{branch}',
  tags: ['Projects'],
  summary: 'Delete a branch from the hosted repo',
  description:
    'Admin only. Refuses the default branch and branches backing an open native PR (409).',
  request: { params: z.object({ projectId: z.string(), branch: z.string() }) },
  responses: {
    200: { description: 'Deleted.', content: jsonContent(z.object({ ok: z.boolean() })) },
    400: { description: 'Invalid branch name.', content: jsonContent(ErrorResponse) },
    404: {
      description: 'Unknown project, not Hub-hosted, or unknown branch.',
      content: jsonContent(ErrorResponse),
    },
    409: {
      description: 'Default branch or backs an open PR.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/git-host/default-branch',
  tags: ['Projects'],
  summary: "Set the hosted repo's default branch (HEAD symref)",
  description:
    'Admin only. Moves HEAD to the given existing branch and re-syncs branch protection (the pre-receive push block follows the default branch).',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(z.object({ branch: z.string() })), required: true },
  },
  responses: {
    200: { description: 'Updated git-host status.' },
    400: { description: 'Invalid branch name.', content: jsonContent(ErrorResponse) },
    404: {
      description: 'Unknown project, not Hub-hosted, or unknown branch.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/git-host/recent-pushes',
  tags: ['Projects'],
  summary: 'Recently pushed branches without an open pull request',
  description:
    'Feeds the "Compare & pull request"-style banner on the Pulls page. In-memory, ~2h window; excludes the default branch, Agent Hub-managed session branches, zero-diff branches, and branches already covered by an open native PR.',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: {
      description: 'Recent pushes, newest first.',
      content: jsonContent(
        z.object({
          pushes: z.array(z.object({ branch: z.string(), pushedAt: z.number() })),
        }),
      ),
    },
    404: {
      description: 'Unknown project or not Hub-hosted.',
      content: jsonContent(ErrorResponse),
    },
  },
});

const MirrorStateSchema = z.object({
  status: z.enum(['synced', 'ahead', 'behind', 'diverged', 'unknown']).optional(),
  diverged: z.boolean().optional(),
  hubSha: z.string().optional(),
  githubSha: z.string().optional(),
  aheadBy: z.number().optional(),
  behindBy: z.number().optional(),
  lastSyncAt: z.string().optional(),
  lastError: z.string().optional(),
  lastErrorAt: z.string().optional(),
  lastPollAt: z.string().optional(),
  lastReconcileAt: z.string().optional(),
  lastReconcileAction: z.string().optional(),
});

const MirrorStatusSchema = z.object({
  enabled: z.boolean(),
  refs: z.enum(['default-branch', 'all']),
  state: MirrorStateSchema,
});

const ReconcileResultSchema = z.object({
  status: z.enum(['synced', 'ahead', 'behind', 'diverged', 'unknown']),
  action: z.enum(['none', 'pulled', 'pushed', 'merged', 'diverged', 'skipped', 'error']),
  hubSha: z.string().optional(),
  githubSha: z.string().optional(),
  aheadBy: z.number().optional(),
  behindBy: z.number().optional(),
  error: z.string().optional(),
  state: MirrorStateSchema,
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/git-host/mirror',
  tags: ['Projects'],
  summary: 'GitHub mirror sync status for a Hub-hosted repo',
  description:
    'Reports the last-known relationship between the Hub default branch and GitHub (synced / ahead / behind / diverged), ahead/behind counts, last sync + last error, and the last reconcile action. `diverged: true` means the branches forked and could not be auto-reconciled — surface it. 404 unless gitHost: agenthub.',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: { description: 'Mirror status.', content: jsonContent(MirrorStatusSchema) },
    404: { description: 'Unknown project or not Hub-hosted.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/git-host/mirror/reconcile',
  tags: ['Projects'],
  summary: 'Reconcile the Hub default branch with GitHub on demand',
  description:
    'Admin only. Fetches GitHub\'s default branch and brings the two into sync: fast-forwards the Hub when GitHub is ahead (e.g. a release-bot version bump), pushes when the Hub is ahead, or attempts a clean auto-merge when they diverged. If they cannot be merged automatically, returns status "diverged" and records it. Never force-pushes or rewrites history.',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: {
      description: 'Reconcile outcome + refreshed state.',
      content: jsonContent(ReconcileResultSchema),
    },
    404: { description: 'Unknown project or not Hub-hosted.', content: jsonContent(ErrorResponse) },
  },
});

const RepoReadmeSchema = z
  .object({
    branch: z.string(),
    path: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    mediaToken: z.string(),
  })
  .nullable();

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/git-host/readme',
  tags: ['Projects'],
  summary: 'Root README of an Agent Hub-hosted repo branch',
  description:
    'Returns the root-level README (path + raw markdown content) of the given branch, defaulting to the default branch. `readme` is null when the repo has no root README. Repository-page surface; 404 unless gitHost: agenthub. Content is capped at 512 KiB.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      branch: z.string().optional().openapi({ description: 'Defaults to the default branch.' }),
    }),
  },
  responses: {
    200: {
      description: 'README content, or { readme: null } when absent.',
      content: jsonContent(z.object({ readme: RepoReadmeSchema })),
    },
    400: { description: 'Invalid branch name.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project or not Hub-hosted.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/git-host/commits',
  tags: ['Projects'],
  summary: 'Commit log of an Agent Hub-hosted repo branch',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      branch: z.string().optional().openapi({ description: 'Defaults to the default branch.' }),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Commit log, newest first.',
      content: jsonContent(z.object({ branch: z.string(), commits: z.array(RepoCommitSchema) })),
    },
    400: { description: 'Invalid branch name.', content: jsonContent(ErrorResponse) },
    404: {
      description: 'Unknown project, not Hub-hosted, or unknown branch.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/git-host/commits/{sha}',
  tags: ['Projects'],
  summary: 'Single-commit detail (stat + patch) from an Agent Hub-hosted repo',
  request: { params: z.object({ projectId: z.string(), sha: z.string() }) },
  responses: {
    200: {
      description: 'Commit metadata, diffstat, and unified patch (capped at 1 MiB).',
      content: jsonContent(
        z.object({
          sha: z.string(),
          subject: z.string(),
          body: z.string(),
          author: z.string(),
          date: z.string(),
          parents: z.array(z.string()),
          stat: z.string(),
          patch: z.string(),
          patchTruncated: z.boolean(),
        }),
      ),
    },
    404: { description: 'Unknown project/commit.', content: jsonContent(ErrorResponse) },
  },
});

export default function createGitHostRoutes(deps: RouteDeps): Router {
  const router = Router();

  const findProjectOr404 = (req: Request, res: Response): Project | null => {
    const project = deps.findProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return project;
  };

  router.get('/api/projects/:projectId/git-host', async (req: Request, res: Response) => {
    const project = findProjectOr404(req, res);
    if (!project) return;
    const status = await getGitHostStatus(project);
    // Embed the caller's username in the clone URL so `git push` only
    // prompts for the password (an ahub_ API key) instead of appearing
    // to hang on a hidden username prompt.
    const username = (req as AuthenticatedRequest).authUser;
    if (status.cloneUrl && username) {
      status.cloneUrl = status.cloneUrl.replace('://', `://${encodeURIComponent(username)}@`);
    }
    res.json(status);
  });

  /** Repo-browsing reads require an actually-hosted project. */
  const findHostedProjectOr404 = (req: Request, res: Response): Project | null => {
    const project = findProjectOr404(req, res);
    if (!project) return null;
    if (project.gitHost !== 'agenthub' || !hostedRepoExists(project.id)) {
      res.status(404).json({ error: 'Project is not hosted on Agent Hub' });
      return null;
    }
    return project;
  };

  router.get(
    '/api/projects/:projectId/git-host/recent-pushes',
    async (req: Request, res: Response) => {
      const project = findHostedProjectOr404(req, res);
      if (!project) return;
      const defaultBranch = await hostedRepoDefaultBranch(project.id);
      res.json({ pushes: await listRecentPushes(deps.stmts, project.id, defaultBranch) });
    },
  );

  router.get('/api/projects/:projectId/git-host/mirror', (req: Request, res: Response) => {
    const project = findHostedProjectOr404(req, res);
    if (!project) return;
    const policy = mirrorPolicy(project);
    res.json({ enabled: policy.enabled, refs: policy.refs, state: readMirrorState(project.id) });
  });

  router.post(
    '/api/projects/:projectId/git-host/mirror/reconcile',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findHostedProjectOr404(req, res);
      if (!project) return;
      const result = await reconcileMirror(project, { broadcast: deps.broadcast });
      res.json({ ...result, state: readMirrorState(project.id) });
    },
  );

  router.get('/api/projects/:projectId/git-host/branches', async (req: Request, res: Response) => {
    const project = findHostedProjectOr404(req, res);
    if (!project) return;
    try {
      res.json(await listRepoBranches(project.id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list branches: ${msg.split('\n')[0]}` });
    }
  });

  router.get('/api/projects/:projectId/git-host/readme', async (req: Request, res: Response) => {
    const project = findHostedProjectOr404(req, res);
    if (!project) return;
    const branchParam = typeof req.query.branch === 'string' ? req.query.branch : '';
    if (branchParam && !isSafeBranchName(branchParam)) {
      return res.status(400).json({ error: 'Invalid branch name' });
    }
    try {
      const readme = await readRepoReadme(project.id, branchParam || undefined);
      res.json({
        readme: readme
          ? {
              ...readme,
              mediaToken: issueGitHostMediaToken(project.id, readme.branch),
            }
          : null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to read README: ${msg.split('\n')[0]}` });
    }
  });

  router.get('/api/projects/:projectId/git-host/commits', async (req: Request, res: Response) => {
    const project = findHostedProjectOr404(req, res);
    if (!project) return;
    const branchParam = typeof req.query.branch === 'string' ? req.query.branch : '';
    const branch = branchParam || (await hostedRepoDefaultBranch(project.id)) || 'main';
    if (!isSafeBranchName(branch)) {
      return res.status(400).json({ error: 'Invalid branch name' });
    }
    let limit = Number.parseInt((req.query.limit as string) || '', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    try {
      const commits = await listRepoCommits(project.id, branch, limit);
      res.json({ branch, commits });
    } catch {
      // git exits non-zero for unknown refs — report as 404, not 500.
      res.status(404).json({ error: `Branch not found: ${branch}` });
    }
  });

  router.get(
    '/api/projects/:projectId/git-host/commits/:sha',
    async (req: Request, res: Response) => {
      const project = findHostedProjectOr404(req, res);
      if (!project) return;
      try {
        const detail = await getRepoCommitDetail(project.id, String(req.params.sha));
        if (!detail) return res.status(404).json({ error: 'Commit not found' });
        res.json(detail);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to read commit: ${msg.split('\n')[0]}` });
      }
    },
  );

  router.post(
    '/api/projects/:projectId/git-host/enable',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProjectOr404(req, res);
      if (!project) return;
      if (project.gitHost === 'agenthub') {
        return res.status(409).json({ error: 'Agent Hub git hosting is already enabled.' });
      }
      const rawImportFrom = (req.body as Record<string, unknown> | undefined)?.importFrom;
      if (
        rawImportFrom !== undefined &&
        rawImportFrom !== 'auto' &&
        rawImportFrom !== 'github' &&
        rawImportFrom !== 'cwd' &&
        rawImportFrom !== 'empty'
      ) {
        return res
          .status(400)
          .json({ error: 'importFrom must be "auto", "github", "cwd", or "empty"' });
      }
      enableGitHost(project, {
        saveProjects: deps.saveProjects,
        broadcast: deps.broadcast,
        requestingUserId: (req as AuthenticatedRequest).authUserId ?? null,
        importFrom: rawImportFrom as 'auto' | 'github' | 'cwd' | 'empty' | undefined,
      });
      res.status(202).json(await getGitHostStatus(project));
    },
  );

  router.post(
    '/api/projects/:projectId/git-host/disable',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProjectOr404(req, res);
      if (!project) return;
      if (project.gitHost !== 'agenthub') {
        return res.status(409).json({ error: 'Agent Hub git hosting is not enabled.' });
      }
      await disableGitHost(project, {
        saveProjects: deps.saveProjects,
        broadcast: deps.broadcast,
      });
      res.json(await getGitHostStatus(project));
    },
  );

  router.delete(
    '/api/projects/:projectId/git-host/branches/:branch',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findHostedProjectOr404(req, res);
      if (!project) return;
      const branch = decodeURIComponent(String(req.params.branch ?? '')).trim();
      if (!branch || !isSafeBranchName(branch)) {
        return res.status(400).json({ error: 'Invalid branch name' });
      }
      const defaultBranch = await hostedRepoDefaultBranch(project.id);
      if (defaultBranch && branch === defaultBranch) {
        return res.status(409).json({ error: 'The default branch cannot be deleted.' });
      }
      const openPr = deps.stmts.getOpenPullRequestByHeadBranch.get(project.id, branch) as
        | { number: number }
        | undefined;
      if (openPr) {
        return res.status(409).json({
          error: `Branch backs open PR #${openPr.number} — close or merge it first.`,
        });
      }
      const repoPath = gitHostRepoPath(project.id);
      try {
        await execFileP('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`], {
          timeout: 15_000,
        });
      } catch {
        return res.status(404).json({ error: `Branch "${branch}" not found` });
      }
      try {
        await execFileP('git', ['-C', repoPath, 'update-ref', '-d', `refs/heads/${branch}`], {
          timeout: 15_000,
        });
      } catch (err: unknown) {
        return res.status(500).json({
          error: `Failed to delete branch: ${err instanceof Error ? err.message : err}`,
        });
      }
      deps.broadcast({ type: 'git_host_branch_deleted', projectId: project.id, branch });
      res.json({ ok: true });
    },
  );

  router.post(
    '/api/projects/:projectId/git-host/default-branch',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findHostedProjectOr404(req, res);
      if (!project) return;
      const branch =
        typeof (req.body as Record<string, unknown> | undefined)?.branch === 'string'
          ? String((req.body as Record<string, unknown>).branch).trim()
          : '';
      if (!branch || !isSafeBranchName(branch)) {
        return res.status(400).json({ error: 'A valid branch name is required' });
      }
      const repoPath = gitHostRepoPath(project.id);
      try {
        await execFileP('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`], {
          timeout: 15_000,
        });
      } catch {
        return res.status(404).json({ error: `Branch "${branch}" not found` });
      }
      try {
        await execFileP('git', ['-C', repoPath, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
          timeout: 15_000,
        });
      } catch (err: unknown) {
        return res.status(500).json({
          error: `Failed to set default branch: ${err instanceof Error ? err.message : err}`,
        });
      }
      // The pre-receive push block protects "the default branch" — re-sync
      // it so protection follows the new default.
      await refreshBranchProtection(project).catch(() => {});
      deps.broadcast({ type: 'git_host_default_branch', projectId: project.id, branch });
      res.json(await getGitHostStatus(project));
    },
  );

  return router;
}
