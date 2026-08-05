/**
 * routes/pr-actions.ts — API endpoints for human PR actions.
 *
 * POST /api/pr/merge   — Merge a PR by URL (user OAuth)
 * POST /api/pr/close   — Close a PR by URL (user OAuth)
 * GET  /api/pr/status  — Get PR status (mergeable, CI, reviews)
 * GET  /api/pr/data    — Get full PR detail (metadata, reviews, comments, checks)
 * GET  /api/pr/diff    — Get the unified diff for a PR (text/plain)
 * GET  /api/pr/files   — Get the changed-files list for a PR (JSON)
 *
 * All endpoints use the acting user's own GitHub credential (OAuth or PAT
 * from Settings → GitHub). The reviewer GitHub App was removed, so there is
 * no installation-token path and no automated formal-review endpoint.
 */

import { Router, Request, Response } from 'express';
import type { Project, RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { githubUserApiRequest } from '../github-oauth.js';
import { resolveUserToken } from './pr-list.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { fetchPrDiff, fetchPrFiles } from '../pr-read-fetch.js';
import { respondGitHubNotConnected } from '../github-auth-policy.js';
import { parseNativePrUrl } from '../native-pr/url.js';
import { NativePrError } from '../native-pr/errors.js';
import type { NativePrService } from '../native-pr/service.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { parseRepoFullName } from './pr-list.js';
import { handleGithubCardOnMerge } from '../github-card-on-merge.js';
import { setGithubPrAutoMerge } from '../pr-auto-merge.js';
import { postGraphql } from '../pr-pull-list-enrichment.js';

interface PrActionBody {
  prUrl: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
}

interface AutoMergeBody {
  prUrl: string;
  enabled?: boolean;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
}

interface ParsedPR {
  owner: string;
  repo: string;
  number: string;
}

interface GithubPrMetadata {
  title?: string;
  head?: { ref?: string };
}

/** Native PR reference (Agent Hub-hosted project) resolved from a prUrl. */
interface ParsedNativePR {
  kind: 'agenthub';
  projectId: string;
  number: number;
}

function parsePrUrl(prUrl: string | null | undefined): ParsedPR | null {
  const match = prUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function resolveGithubProjectForPr(deps: RouteDeps, pr: ParsedPR): Project | null {
  const ownerRepo = `${pr.owner}/${pr.repo}`.toLowerCase();
  return (
    deps.getProjects().find((project) => {
      const parsed = parseRepoFullName(project.githubRepo);
      return parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() === ownerRepo : false;
    }) ?? null
  );
}

function markGithubCardMerged(
  deps: RouteDeps,
  args: {
    project: Project | null;
    prUrl: string;
    pr: ParsedPR;
    metadata: GithubPrMetadata | null;
    mergedBy: string;
    mergeMethod: string;
  },
): void {
  if (!args.project) return;
  handleGithubCardOnMerge(
    { stmts: deps.stmts, broadcast: deps.broadcast },
    {
      projectId: args.project.id,
      prUrl: args.prUrl,
      prNumber: Number.parseInt(args.pr.number, 10),
      prTitle: args.metadata?.title ?? null,
      headRef: args.metadata?.head?.ref ?? null,
      mergedBy: args.mergedBy,
      mergeMethod: args.mergeMethod,
    },
  );
}

async function fetchGithubPrMetadata(
  accessToken: string,
  pr: ParsedPR,
): Promise<GithubPrMetadata | null> {
  try {
    return await githubUserApiRequest<GithubPrMetadata>({
      accessToken,
      endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
    });
  } catch {
    return null;
  }
}

/**
 * Native-PR resolution for the /api/pr/* surface (which is keyed on
 * `prUrl`, not project-scoped, so the project visibility gate does not
 * run). Resolves the URL → project, enforces visibility (mask as null →
 * 400/404 to the caller), and requires the project to still be hosted.
 */
function resolveNativePrRef(
  req: Request,
  prUrl: string | null | undefined,
  deps: Pick<RouteDeps, 'findProject' | 'nativePr'>,
): { ref: ParsedNativePR; project: Project; nativePr: NativePrService } | null {
  const parsed = parseNativePrUrl(prUrl);
  if (!parsed || !deps.nativePr) return null;
  const project = deps.findProject(parsed.projectId);
  if (!project || project.gitHost !== 'agenthub') return null;
  if (!canViewProject(project, resolveVisibilityCaller(req))) return null;
  return {
    ref: { kind: 'agenthub', projectId: parsed.projectId, number: parsed.number },
    project,
    nativePr: deps.nativePr,
  };
}

function nativeActor(req: Request): string {
  const areq = req as AuthenticatedRequest;
  return areq.authUser ?? areq.authUserId ?? 'unknown';
}

const ALLOWED_MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

export default function createPrActionRoutes(deps: RouteDeps): Router {
  const { config } = deps;
  const router = Router();

  // ─── Merge a PR ─────────────────────────────────────────────────

  router.post('/api/pr/merge', async (req: Request, res: Response) => {
    const { prUrl, mergeMethod = 'squash' } = req.body as PrActionBody;
    if (!ALLOWED_MERGE_METHODS.has(mergeMethod)) {
      return res.status(400).json({ error: 'Invalid merge method' });
    }

    const native = resolveNativePrRef(req, prUrl, deps);
    if (native) {
      if (mergeMethod === 'rebase') {
        return res
          .status(400)
          .json({ error: 'rebase merges are not supported for Agent Hub-hosted projects' });
      }
      try {
        const result = await native.nativePr.merge({
          project: native.project,
          number: native.ref.number,
          mergeMethod,
          actor: nativeActor(req),
        });
        if (!result.ok) {
          return res.status(result.status).json({
            error: result.error,
            ...(result.mergeable === false ? { mergeable: false } : {}),
          });
        }
        return res.json({ ok: true, method: 'agenthub', pr: String(native.ref.number) });
      } catch (err: unknown) {
        const status = err instanceof NativePrError ? err.status : 500;
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(status).json({ error: `Merge failed: ${msg.split('\n')[0]}` });
      }
    }

    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }
    const project = resolveGithubProjectForPr(deps, pr);

    const userToken = await resolveUserToken(req, config);
    if (!userToken) {
      return respondGitHubNotConnected(res);
    }

    try {
      await githubUserApiRequest({
        accessToken: userToken,
        endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`,
        method: 'PUT',
        body: { merge_method: mergeMethod },
      });
      const prData = await fetchGithubPrMetadata(userToken, pr);
      try {
        if (prData?.head?.ref) {
          await githubUserApiRequest({
            accessToken: userToken,
            endpoint: `/repos/${pr.owner}/${pr.repo}/git/refs/heads/${prData.head.ref}`,
            method: 'DELETE',
          });
        }
      } catch {
        /* branch deletion is best-effort */
      }
      markGithubCardMerged(deps, {
        project,
        prUrl,
        pr,
        metadata: prData,
        mergedBy: nativeActor(req),
        mergeMethod,
      });
      return res.json({ ok: true, method: 'user-oauth', pr: pr.number });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already.*merged/i.test(msg)) {
        const prData = await fetchGithubPrMetadata(userToken, pr);
        markGithubCardMerged(deps, {
          project,
          prUrl,
          pr,
          metadata: prData,
          mergedBy: nativeActor(req),
          mergeMethod,
        });
        return res.json({ ok: true, alreadyMerged: true, pr: pr.number });
      }
      return res.status(500).json({ error: `Merge failed: ${msg.split('\n')[0]}` });
    }
  });

  // ─── Arm / disarm GitHub native auto-merge ──────────────────────
  //
  // Enables GitHub's native auto-merge so the PR merges itself once required
  // checks pass and required reviews approve — the toggle on the PR pages.
  // Uses the acting user's OAuth token (GraphQL); mirrors the manual merge
  // button's per-user credential model. Native (Agent Hub-hosted) PRs are
  // covered by the session Finalize automation level instead.

  router.post('/api/pr/auto-merge', async (req: Request, res: Response) => {
    const { prUrl, enabled, mergeMethod = 'squash' } = req.body as AutoMergeBody;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    if (!ALLOWED_MERGE_METHODS.has(mergeMethod)) {
      return res.status(400).json({ error: 'Invalid merge method' });
    }

    const native = resolveNativePrRef(req, prUrl, deps);
    if (native) {
      return res.status(400).json({
        error:
          'Auto-merge toggle is not supported for Agent Hub-hosted PRs — use the session Finalize automation level instead.',
      });
    }

    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }

    const userToken = await resolveUserToken(req, config);
    if (!userToken) {
      return respondGitHubNotConnected(res);
    }

    try {
      const result = await setGithubPrAutoMerge({
        owner: pr.owner,
        repo: pr.repo,
        number: Number.parseInt(pr.number, 10),
        enabled,
        mergeMethod,
        deps: {
          getPr: (owner, repo, number) =>
            githubUserApiRequest<Record<string, unknown>>({
              accessToken: userToken,
              endpoint: `/repos/${owner}/${repo}/pulls/${number}`,
            }),
          graphql: (query, variables) => postGraphql(userToken, query, variables),
        },
      });
      return res.json({
        ok: true,
        enabled: result.enabled,
        mergeMethod: result.mergeMethod,
        pr: pr.number,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(422).json({
        error: `Auto-merge ${enabled ? 'enable' : 'disable'} failed: ${msg.split('\n')[0]}`,
      });
    }
  });

  // ─── Close a PR ─────────────────────────────────────────────────

  router.post('/api/pr/close', async (req: Request, res: Response) => {
    const { prUrl } = req.body as PrActionBody;

    const native = resolveNativePrRef(req, prUrl, deps);
    if (native) {
      try {
        native.nativePr.close({ project: native.project, number: native.ref.number });
        return res.json({ ok: true, method: 'agenthub', pr: String(native.ref.number) });
      } catch (err: unknown) {
        const status = err instanceof NativePrError ? err.status : 500;
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(status).json({ error: `Close failed: ${msg.split('\n')[0]}` });
      }
    }

    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }

    const userToken = await resolveUserToken(req, config);
    if (!userToken) {
      return respondGitHubNotConnected(res);
    }

    try {
      await githubUserApiRequest({
        accessToken: userToken,
        endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        method: 'PATCH',
        body: { state: 'closed' },
      });
      return res.json({ ok: true, method: 'user-oauth', pr: pr.number });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Close failed: ${msg.split('\n')[0]}` });
    }
  });

  // ─── Get PR status ──────────────────────────────────────────────

  router.get('/api/pr/status', async (req: Request, res: Response) => {
    const prUrl = req.query.prUrl as string;

    const native = resolveNativePrRef(req, prUrl, deps);
    if (native) {
      try {
        const detail = await native.nativePr.getDetail({
          project: native.project,
          number: native.ref.number,
        });
        const pr = detail.pr as Record<string, unknown>;
        return res.json({
          number: String(native.ref.number),
          state: pr.state,
          mergeable: pr.mergeable,
          mergeable_state: pr.mergeable_state,
          title: pr.title,
          user: pr.user,
          head: pr.head,
          base: pr.base,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files,
        });
      } catch (err: unknown) {
        const status = err instanceof NativePrError ? err.status : 500;
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(status).json({ error: `Status check failed: ${msg.split('\n')[0]}` });
      }
    }

    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL (pass as ?prUrl=...)' });
    }

    const userToken = await resolveUserToken(req, config);
    if (!userToken) {
      return respondGitHubNotConnected(res);
    }

    try {
      const data = await githubUserApiRequest<Record<string, unknown>>({
        accessToken: userToken,
        endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      });
      const head = data.head as Record<string, unknown> | undefined;
      const base = data.base as Record<string, unknown> | undefined;
      const user = data.user as Record<string, unknown> | undefined;
      return res.json({
        number: pr.number,
        state: data.state,
        mergeable: data.mergeable,
        mergeable_state: data.mergeable_state,
        title: data.title,
        user: user?.login,
        head: head?.ref,
        base: base?.ref,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changed_files,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Status check failed: ${msg.split('\n')[0]}` });
    }
  });

  // ─── Read-side proxies (user OAuth) ─────────────────────────────
  //
  // Let the PR UI (and reviewer-role spawns, which have no local GitHub
  // credentials) fetch PR contents using the acting user's server-side
  // OAuth/PAT without exposing a token to a spawned process.
  //
  // Accepts either `?prUrl=https://github.com/owner/repo/pull/N` or the
  // explicit triple `?owner=…&repo=…&number=N`.

  function parsePrQuery(req: Request): ParsedPR | { error: string } {
    const prUrlRaw = (req.query.prUrl ?? req.query.url) as string | undefined;
    if (prUrlRaw) {
      const parsed = parsePrUrl(prUrlRaw);
      if (!parsed) return { error: 'Invalid PR URL (must be github.com/owner/repo/pull/N)' };
      return parsed;
    }
    const owner = req.query.owner as string | undefined;
    const repo = req.query.repo as string | undefined;
    const number = (req.query.number ?? req.query.pr) as string | undefined;
    if (!owner || !repo || !number) {
      return { error: 'Pass ?prUrl=…, or ?owner=…&repo=…&number=…' };
    }
    if (!/^\d+$/.test(number)) return { error: 'number must be a positive integer' };
    return { owner, repo, number };
  }

  // Shared native branch for the read proxies — they all key on ?prUrl.
  function nativeFromQuery(req: Request) {
    const prUrlRaw = (req.query.prUrl ?? req.query.url) as string | undefined;
    return prUrlRaw ? resolveNativePrRef(req, prUrlRaw, deps) : null;
  }

  // GET /api/pr/data — full PR detail (metadata + reviews + comments + checks)
  router.get('/api/pr/data', async (req: Request, res: Response) => {
    const native = nativeFromQuery(req);
    if (native) {
      try {
        const detail = await native.nativePr.getDetail({
          project: native.project,
          number: native.ref.number,
        });
        return res.json({
          source: detail.source,
          pr: detail.pr,
          reviews: detail.reviews,
          comments: detail.comments,
          checks: detail.checks,
        });
      } catch (err: unknown) {
        const status = err instanceof NativePrError ? err.status : 502;
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(status).json({ error: `PR data fetch failed: ${msg.split('\n')[0]}` });
      }
    }

    const parsed = parsePrQuery(req);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const userAccessToken = await resolveUserToken(req, config);
      const detail = await fetchPrDetail(
        config,
        { owner: parsed.owner, repo: parsed.repo },
        Number(parsed.number),
        { userAccessToken },
      );
      return res.json({
        source: detail.source,
        pr: detail.pr,
        reviews: detail.reviews,
        comments: detail.comments,
        checks: detail.checks,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ error: `PR data fetch failed: ${msg.split('\n')[0]}` });
    }
  });

  // GET /api/pr/diff — unified diff (text/plain)
  router.get('/api/pr/diff', async (req: Request, res: Response) => {
    const native = nativeFromQuery(req);
    if (native) {
      try {
        const result = await native.nativePr.diff({
          project: native.project,
          number: native.ref.number,
        });
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-PR-Source', result.source);
        return res.send(result.diff);
      } catch (err: unknown) {
        const status = err instanceof NativePrError ? err.status : 502;
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(status).json({ error: `PR diff fetch failed: ${msg.split('\n')[0]}` });
      }
    }

    const parsed = parsePrQuery(req);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const userAccessToken = await resolveUserToken(req, config);
      const result = await fetchPrDiff(
        config,
        { owner: parsed.owner, repo: parsed.repo },
        Number(parsed.number),
        { userAccessToken },
      );
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-PR-Source', result.source);
      return res.send(result.diff);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ error: `PR diff fetch failed: ${msg.split('\n')[0]}` });
    }
  });

  // GET /api/pr/files — changed-files list (paginated, capped)
  router.get('/api/pr/files', async (req: Request, res: Response) => {
    const native = nativeFromQuery(req);
    if (native) {
      try {
        const result = await native.nativePr.files({
          project: native.project,
          number: native.ref.number,
        });
        return res.json({
          source: result.source,
          truncated: false,
          files: result.files,
          count: result.files.length,
        });
      } catch (err: unknown) {
        const status = err instanceof NativePrError ? err.status : 502;
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(status).json({ error: `PR files fetch failed: ${msg.split('\n')[0]}` });
      }
    }

    const parsed = parsePrQuery(req);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const userAccessToken = await resolveUserToken(req, config);
      const result = await fetchPrFiles(
        config,
        { owner: parsed.owner, repo: parsed.repo },
        Number(parsed.number),
        { userAccessToken },
      );
      return res.json({
        source: result.source,
        truncated: result.truncated,
        files: result.files,
        count: result.files.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ error: `PR files fetch failed: ${msg.split('\n')[0]}` });
    }
  });

  return router;
}
