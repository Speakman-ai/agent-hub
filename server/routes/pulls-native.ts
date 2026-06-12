/**
 * pulls-native.ts — create a native pull request on an Agent Hub-hosted
 * project. The write counterpart of the read surface in pr-list.ts
 * (which branches to native data for hosted projects).
 *
 * Used by agents from the `create-ticket-and-pr` skill (via `ah-api.sh`)
 * after pushing their session branch to the Hub — the hosted-repo
 * replacement for `gh pr create`. Idempotent: an open PR for the same
 * head branch is reused and refreshed, mirroring the GitHub flow's
 * `gh pr view` pre-check.
 */

import { Router, type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Project, RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { isAgentHubHosted, bareRepoPath, hostedRepoExists } from '../native-pr/host.js';
import { hostedRepoDefaultBranch } from '../git-host/repo-store.js';
import { prCommits, prDiff, revParse } from '../native-pr/git-read.js';
import { NativePrError } from '../native-pr/errors.js';
import { z, registerPath } from '../openapi/registry.js';

const execFileP = promisify(execFile);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const BRANCH_RE = /^[^\s~^:?*[\\]+$/;

/** Cap diff text fed into the model — huge diffs get summarized headers. */
const GENERATE_DIFF_BUDGET = 30_000;

type PrTextGenerator = (
  prompt: string,
  systemPrompt: string,
  cwd: string,
  userId: string | null,
) => Promise<string>;

/**
 * Default generator: the Claude CLI in print mode with the REQUESTING
 * USER's stored account credentials (same resolution as chat sessions —
 * without it the spawn gets the credential-less host-creds HOME and the
 * CLI answers "Not logged in"). Lazy imports keep this route free of
 * heartbeat's module-load side effects. Tests inject a fake.
 */
let generatorOverride: PrTextGenerator | null = null;
export function __setPrTextGeneratorForTests(fn: PrTextGenerator | null): void {
  generatorOverride = fn;
}

async function generatePrText(
  prompt: string,
  systemPrompt: string,
  cwd: string,
  userId: string | null,
): Promise<string> {
  if (generatorOverride) return generatorOverride(prompt, systemPrompt, cwd, userId);
  const [{ runClaude }, { resolveSessionCliSpawnEnv }, { default: config }] = await Promise.all([
    import('../heartbeat.js'),
    import('../per-user-cli-spawn.js'),
    import('../config.js'),
  ]);
  // Throws EngineAuthRequiredError when the user has no Claude account
  // connected — surfaced as a friendly 400 by the route.
  const spawnEnv = resolveSessionCliSpawnEnv({
    cfg: config,
    ownerId: userId,
    credsOwnerId: userId,
    sessionId: null,
    engine: 'claude-code',
  });
  return runClaude(prompt, cwd, systemPrompt, { timeoutMs: 90_000, spawnEnv });
}

/** Parse the model's TITLE:/BODY: response with fallbacks for sloppiness. */
export function parseGeneratedPrText(raw: string): { title: string; body: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const titleMatch = text.match(/^TITLE:\s*(.+)$/m);
  const bodyMatch = text.match(/^BODY:\s*$/m);
  let title = titleMatch?.[1]?.trim() ?? '';
  let body = '';
  if (bodyMatch && bodyMatch.index !== undefined) {
    body = text.slice(bodyMatch.index + bodyMatch[0].length).trim();
  } else if (titleMatch) {
    body = text
      .slice((titleMatch.index ?? 0) + titleMatch[0].length)
      .replace(/^BODY:\s*/m, '')
      .trim();
  }
  if (!title) {
    // No TITLE: marker — treat the first non-empty line as the title.
    const lines = text.split('\n').filter((l) => l.trim());
    title = (lines[0] ?? '').replace(/^#+\s*/, '').trim();
    body = lines.slice(1).join('\n').trim();
  }
  if (!title) return null;
  if (title.length > 90) title = `${title.slice(0, 87)}…`;
  return { title, body };
}

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls',
  tags: ['Projects'],
  summary: 'Create (or reuse) a native pull request on an Agent Hub-hosted project',
  description:
    'Creates a DB-backed Hub PR for a branch already pushed to the hosted repo. Idempotent per open head branch. 400 for projects not hosted on Agent Hub — use gh pr create there.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          headBranch: z.string(),
          baseBranch: z
            .string()
            .optional()
            .openapi({ description: 'Defaults to the default branch.' }),
          title: z.string().min(1),
          body: z.string().optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    201: {
      description: 'PR created (or reused when one was already open for the branch).',
      content: jsonContent(
        z.object({
          prUrl: z.string(),
          number: z.number(),
          created: z.boolean(),
        }),
      ),
    },
    400: {
      description: 'Not Hub-hosted, invalid branch, or missing fields.',
      content: jsonContent(z.object({ error: z.string() })),
    },
    404: {
      description: 'Unknown project or head branch not pushed.',
      content: jsonContent(z.object({ error: z.string() })),
    },
  },
});

registerPath({
  method: 'patch',
  path: '/api/projects/{projectId}/pulls/{number}',
  tags: ['Projects'],
  summary: 'Edit the title/body of an open native pull request',
  description:
    'Agent Hub-hosted projects only. Closed/merged PRs are immutable (409). At least one of title/body must be supplied.',
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          title: z.string().min(1).optional(),
          body: z.string().optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated PR summary (same shape as the list rows).',
      content: jsonContent(z.object({ pr: z.record(z.string(), z.unknown()) })),
    },
    400: {
      description: 'Invalid input or not Hub-hosted.',
      content: jsonContent(z.object({ error: z.string() })),
    },
    404: {
      description: 'Unknown project or PR.',
      content: jsonContent(z.object({ error: z.string() })),
    },
    409: { description: 'PR is not open.', content: jsonContent(z.object({ error: z.string() })) },
  },
});

const PrActionOkSchema = z.object({ pr: z.record(z.string(), z.unknown()) });
const PrErrorSchema = z.object({ error: z.string() });

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/reopen',
  tags: ['Projects'],
  summary: 'Reopen a closed native pull request',
  description: 'Closed → open. Merged PRs are immutable (409). Agent Hub-hosted projects only.',
  request: { params: z.object({ projectId: z.string(), number: z.string() }) },
  responses: {
    200: { description: 'Reopened PR summary.', content: jsonContent(PrActionOkSchema) },
    400: { description: 'Not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is merged or already open.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/request-review',
  tags: ['Projects'],
  summary: 'Flag (or unflag) a native pull request for human review',
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(z.object({ requested: z.boolean().optional() })),
      required: false,
    },
  },
  responses: {
    200: { description: 'Updated PR summary.', content: jsonContent(PrActionOkSchema) },
    400: { description: 'Not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is not open.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/reviews',
  tags: ['Projects'],
  summary: 'Submit a human review on a native pull request',
  description:
    'state: approved | changes_requested | commented. A verdict (approve/request changes) clears any outstanding review-request flag. Reviews render in the PR detail and feed the Autofix context.',
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          state: z.enum(['approved', 'changes_requested', 'commented']),
          body: z.string().optional(),
          reviewer: z
            .string()
            .optional()
            .openapi({ description: 'Reviewer-name override (agent reviews).' }),
        }),
      ),
      required: true,
    },
  },
  responses: {
    201: {
      description: 'The recorded review (GitHub review-object shape).',
      content: jsonContent(z.object({ review: z.record(z.string(), z.unknown()) })),
    },
    400: { description: 'Invalid state or not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is not open.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/comments',
  tags: ['Projects'],
  summary: 'Add an inline (per-line) diff comment to a native pull request',
  description:
    "Anchored to a file + line in the PR diff. side 'new' = post-image line number (additions/context), 'old' = pre-image (deletions). Rendered inside the Files-changed diff and included in the Autofix context.",
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          filePath: z.string().min(1),
          line: z.coerce.number().int().min(1),
          side: z.enum(['old', 'new']).optional(),
          body: z.string().min(1),
        }),
      ),
      required: true,
    },
  },
  responses: {
    201: {
      description: 'The recorded comment.',
      content: jsonContent(z.object({ comment: z.record(z.string(), z.unknown()) })),
    },
    400: { description: 'Invalid input or not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is not open.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/pulls/{number}/comments/{commentId}',
  tags: ['Projects'],
  summary: 'Delete an inline diff comment from a native pull request',
  request: {
    params: z.object({ projectId: z.string(), number: z.string(), commentId: z.string() }),
  },
  responses: {
    200: { description: 'Deleted.', content: jsonContent(z.object({ ok: z.boolean() })) },
    400: { description: 'Not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR/comment.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/generate-description',
  tags: ['Projects'],
  summary: 'Generate a PR title and description from a branch diff (AI)',
  description:
    'Runs the configured model over the branch diff + commit subjects and returns a suggested title and body. Used by the optional "Generate" button on the PR creation form — fields stay editable.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          headBranch: z.string(),
          baseBranch: z.string().optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Suggested PR text.',
      content: jsonContent(z.object({ title: z.string(), body: z.string() })),
    },
    400: { description: 'Invalid branch or not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project or branch.', content: jsonContent(PrErrorSchema) },
    502: { description: 'Model invocation failed.', content: jsonContent(PrErrorSchema) },
  },
});

export default function createPullsNativeRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.post('/api/projects/:projectId/pulls', async (req: Request, res: Response) => {
    const project = deps.findProject(req.params.projectId as string) as Project | null;
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isAgentHubHosted(project) || !hostedRepoExists(project.id)) {
      return res.status(400).json({
        error:
          'Project is not hosted on Agent Hub — create the pull request on GitHub (gh pr create).',
      });
    }
    if (!deps.nativePr) {
      return res.status(503).json({ error: 'Native PR service not available' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const headBranch = typeof body.headBranch === 'string' ? body.headBranch.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const prBody = typeof body.body === 'string' ? body.body : '';
    const baseRaw = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
    if (!headBranch || !BRANCH_RE.test(headBranch)) {
      return res.status(400).json({ error: 'headBranch is required (a branch pushed to the Hub)' });
    }
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (baseRaw && !BRANCH_RE.test(baseRaw)) {
      return res.status(400).json({ error: 'invalid baseBranch' });
    }

    const repoPath = bareRepoPath(project.id);
    let headSha = '';
    try {
      const { stdout } = await execFileP(
        'git',
        ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${headBranch}^{commit}`],
        { timeout: 15_000 },
      );
      headSha = stdout.trim();
    } catch {
      return res.status(404).json({
        error: `Branch "${headBranch}" not found on the hosted repo — push it first (git push -u origin ${headBranch}).`,
      });
    }

    const baseBranch = baseRaw || (await hostedRepoDefaultBranch(project.id)) || 'main';
    const areq = req as AuthenticatedRequest;
    try {
      const { row, prUrl, created } = deps.nativePr.createOrGetOpenPr({
        project,
        headBranch,
        baseBranch,
        headSha,
        title,
        body: prBody,
        author: areq.authUser ?? areq.authUserId ?? 'agent',
      });
      return res.status(201).json({ prUrl, number: row.number, created });
    } catch (err: unknown) {
      const status = err instanceof NativePrError ? err.status : 500;
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(status).json({ error: msg });
    }
  });

  router.patch('/api/projects/:projectId/pulls/:number', (req: Request, res: Response) => {
    const project = deps.findProject(req.params.projectId as string) as Project | null;
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isAgentHubHosted(project)) {
      return res.status(400).json({ error: 'Project is not hosted on Agent Hub' });
    }
    const number = Number.parseInt(String(req.params.number), 10);
    if (!Number.isFinite(number) || number <= 0) {
      return res.status(400).json({ error: 'Invalid PR number' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : undefined;
    const prBody = typeof body.body === 'string' ? body.body : undefined;
    if (title === undefined && prBody === undefined) {
      return res.status(400).json({ error: 'Provide title and/or body' });
    }
    if (title !== undefined && !title) {
      return res.status(400).json({ error: 'title cannot be empty' });
    }

    const row = deps.stmts.getPullRequestByNumber.get(project.id, number) as
      | { id: string; title: string; body: string; status: string }
      | undefined;
    if (!row) return res.status(404).json({ error: `PR #${number} not found` });
    if (row.status !== 'open') {
      return res.status(409).json({ error: `PR #${number} is ${row.status} — edits are locked` });
    }

    deps.stmts.updatePullRequestText.run(
      title ?? row.title,
      prBody ?? row.body,
      Date.now(),
      row.id,
    );
    deps.broadcast({
      type: 'native_pr_update',
      projectId: project.id,
      prNumber: number,
      action: 'edited',
    });
    const updated = deps.stmts.getPullRequestByNumber.get(project.id, number);
    return res.json({ pr: updated });
  });

  /** Shared guard for the action sub-routes below. */
  const resolveActionContext = (
    req: Request,
    res: Response,
  ): { project: Project; number: number } | null => {
    const project = deps.findProject(req.params.projectId as string) as Project | null;
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    if (!isAgentHubHosted(project) || !deps.nativePr) {
      res.status(400).json({ error: 'Project is not hosted on Agent Hub' });
      return null;
    }
    const number = Number.parseInt(String(req.params.number), 10);
    if (!Number.isFinite(number) || number <= 0) {
      res.status(400).json({ error: 'Invalid PR number' });
      return null;
    }
    return { project, number };
  };

  const sendNativeError = (res: Response, err: unknown): void => {
    const status = err instanceof NativePrError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  };

  router.post('/api/projects/:projectId/pulls/:number/reopen', (req: Request, res: Response) => {
    const ctx = resolveActionContext(req, res);
    if (!ctx) return;
    try {
      const { row } = deps.nativePr!.reopen({ project: ctx.project, number: ctx.number });
      res.json({ pr: row });
    } catch (err: unknown) {
      sendNativeError(res, err);
    }
  });

  router.post(
    '/api/projects/:projectId/pulls/:number/request-review',
    (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      const requestedRaw = (req.body as Record<string, unknown> | undefined)?.requested;
      const requested = requestedRaw === undefined ? true : requestedRaw === true;
      const areq = req as AuthenticatedRequest;
      try {
        const { row } = deps.nativePr!.setReviewRequested({
          project: ctx.project,
          number: ctx.number,
          requested,
          actor: areq.authUser ?? areq.authUserId ?? 'user',
        });
        res.json({ pr: row });
      } catch (err: unknown) {
        sendNativeError(res, err);
      }
    },
  );

  router.post('/api/projects/:projectId/pulls/:number/reviews', (req: Request, res: Response) => {
    const ctx = resolveActionContext(req, res);
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const state = body.state;
    if (state !== 'approved' && state !== 'changes_requested' && state !== 'commented') {
      return res
        .status(400)
        .json({ error: 'state must be "approved", "changes_requested", or "commented"' });
    }
    const reviewBody = typeof body.body === 'string' ? body.body : '';
    if (state === 'commented' && !reviewBody.trim()) {
      return res.status(400).json({ error: 'a comment review needs a body' });
    }
    const areq = req as AuthenticatedRequest;
    // Optional reviewer-name override for agent reviews (the auto-review
    // dispatch tells the Reviewer agent to sign with its own name so
    // per-reviewer verdict precedence works). Authenticated callers on a
    // trusted instance only — attribution, not authorization.
    const reviewerOverride =
      typeof body.reviewer === 'string' && body.reviewer.trim()
        ? body.reviewer.trim().slice(0, 80)
        : null;
    try {
      const { review } = deps.nativePr!.submitReview({
        project: ctx.project,
        number: ctx.number,
        state,
        body: reviewBody,
        reviewer: reviewerOverride ?? areq.authUser ?? areq.authUserId ?? 'user',
      });
      res.status(201).json({ review });
    } catch (err: unknown) {
      sendNativeError(res, err);
    }
  });

  router.post('/api/projects/:projectId/pulls/:number/comments', (req: Request, res: Response) => {
    const ctx = resolveActionContext(req, res);
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
    const line = Number.parseInt(String(body.line), 10);
    const side = body.side === 'old' ? 'old' : 'new';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!filePath) return res.status(400).json({ error: 'filePath is required' });
    if (!Number.isFinite(line) || line <= 0) {
      return res.status(400).json({ error: 'line must be a positive integer' });
    }
    if (!text) return res.status(400).json({ error: 'body is required' });
    const areq = req as AuthenticatedRequest;
    try {
      const { comment } = deps.nativePr!.addInlineComment({
        project: ctx.project,
        number: ctx.number,
        filePath,
        line,
        side,
        body: text,
        author: areq.authUser ?? areq.authUserId ?? 'user',
      });
      res.status(201).json({ comment });
    } catch (err: unknown) {
      sendNativeError(res, err);
    }
  });

  router.post(
    '/api/projects/:projectId/pulls/generate-description',
    async (req: Request, res: Response) => {
      const project = deps.findProject(req.params.projectId as string) as Project | null;
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!isAgentHubHosted(project) || !hostedRepoExists(project.id)) {
        return res.status(400).json({ error: 'Project is not hosted on Agent Hub' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const headBranch = typeof body.headBranch === 'string' ? body.headBranch.trim() : '';
      const baseRaw = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
      if (!headBranch || !BRANCH_RE.test(headBranch)) {
        return res.status(400).json({ error: 'headBranch is required' });
      }
      if (baseRaw && !BRANCH_RE.test(baseRaw)) {
        return res.status(400).json({ error: 'invalid baseBranch' });
      }

      const repoPath = bareRepoPath(project.id);
      const baseBranch = baseRaw || (await hostedRepoDefaultBranch(project.id)) || 'main';
      const headSha = await revParse(repoPath, `refs/heads/${headBranch}`);
      const baseSha = await revParse(repoPath, `refs/heads/${baseBranch}`);
      if (!headSha || !baseSha) {
        return res.status(404).json({ error: 'Branch not found on the hosted repo' });
      }

      let diff = '';
      let commits: Array<{ subject: string }> = [];
      try {
        [diff, commits] = await Promise.all([
          prDiff(repoPath, baseSha, headSha),
          prCommits(repoPath, baseSha, headSha),
        ]);
      } catch (err: unknown) {
        return res
          .status(502)
          .json({ error: `Failed to read diff: ${err instanceof Error ? err.message : err}` });
      }
      if (diff.length > GENERATE_DIFF_BUDGET) {
        diff = `${diff.slice(0, GENERATE_DIFF_BUDGET)}\n…(diff truncated at ${GENERATE_DIFF_BUDGET} chars)`;
      }

      const systemPrompt =
        'You write pull request titles and descriptions. Respond in EXACTLY this format with no preamble:\n' +
        'TITLE: <imperative summary, under 70 characters>\n' +
        'BODY:\n' +
        '## Summary\n<2-4 bullet points of what changed and why>\n\n' +
        '## Test plan\n<1-3 bullets on how this was or should be verified>';
      const prompt =
        `Branch: ${headBranch} → ${baseBranch}\n\n` +
        `Commits:\n${commits.map((c) => `- ${c.subject}`).join('\n') || '(none)'}\n\n` +
        `Diff:\n${diff || '(empty diff)'}`;

      const actingUserId = (req as AuthenticatedRequest).authUserId ?? null;
      try {
        const raw = await generatePrText(prompt, systemPrompt, repoPath, actingUserId);
        const parsed = parseGeneratedPrText(raw);
        if (!parsed) {
          return res.status(502).json({ error: 'Model returned no usable title' });
        }
        // The CLI reports auth problems as normal text output — don't let
        // "Not logged in · Please run /login" become a PR title.
        if (/not logged in|please run \/login/i.test(parsed.title)) {
          return res.status(400).json({
            error:
              'Your Claude account is not connected — add it under Settings → Account, then try again.',
          });
        }
        return res.json(parsed);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === 'EngineAuthRequiredError') {
          return res.status(400).json({
            error:
              'Your Claude account is not connected — add it under Settings → Account, then try again.',
          });
        }
        return res.status(502).json({ error: `Generation failed: ${msg.split('\n')[0]}` });
      }
    },
  );

  router.delete(
    '/api/projects/:projectId/pulls/:number/comments/:commentId',
    (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      try {
        deps.nativePr!.deleteInlineComment({
          project: ctx.project,
          number: ctx.number,
          commentId: String(req.params.commentId),
        });
        // 200 + body (not 204): the client fetch helper parses JSON on
        // every success, and an empty 204 body would throw.
        res.json({ ok: true });
      } catch (err: unknown) {
        sendNativeError(res, err);
      }
    },
  );

  return router;
}
