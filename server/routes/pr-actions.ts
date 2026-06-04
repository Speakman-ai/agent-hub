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
import type { RouteDeps } from '../types.js';
import { githubUserApiRequest } from '../github-oauth.js';
import { resolveUserToken } from './pr-list.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { fetchPrDiff, fetchPrFiles } from '../pr-read-fetch.js';
import { CONNECT_GITHUB_HINT } from '../github-auth-policy.js';

interface PrActionBody {
  prUrl: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
}

interface ParsedPR {
  owner: string;
  repo: string;
  number: string;
}

function parsePrUrl(prUrl: string | null | undefined): ParsedPR | null {
  const match = prUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

const ALLOWED_MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

export default function createPrActionRoutes(deps: RouteDeps): Router {
  const { config } = deps;
  const router = Router();

  // ─── Merge a PR ─────────────────────────────────────────────────

  router.post('/api/pr/merge', async (req: Request, res: Response) => {
    const { prUrl, mergeMethod = 'squash' } = req.body as PrActionBody;
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }
    if (!ALLOWED_MERGE_METHODS.has(mergeMethod)) {
      return res.status(400).json({ error: 'Invalid merge method' });
    }

    const userToken = await resolveUserToken(req, config);
    if (!userToken) {
      return res.status(401).json({ error: CONNECT_GITHUB_HINT });
    }

    try {
      await githubUserApiRequest({
        accessToken: userToken,
        endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`,
        method: 'PUT',
        body: { merge_method: mergeMethod },
      });
      try {
        const prData = await githubUserApiRequest<{ head?: { ref?: string } }>({
          accessToken: userToken,
          endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        });
        if (prData.head?.ref) {
          await githubUserApiRequest({
            accessToken: userToken,
            endpoint: `/repos/${pr.owner}/${pr.repo}/git/refs/heads/${prData.head.ref}`,
            method: 'DELETE',
          });
        }
      } catch {
        /* branch deletion is best-effort */
      }
      return res.json({ ok: true, method: 'user-oauth', pr: pr.number });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already.*merged/i.test(msg)) {
        return res.json({ ok: true, alreadyMerged: true, pr: pr.number });
      }
      return res.status(500).json({ error: `Merge failed: ${msg.split('\n')[0]}` });
    }
  });

  // ─── Close a PR ─────────────────────────────────────────────────

  router.post('/api/pr/close', async (req: Request, res: Response) => {
    const { prUrl } = req.body as PrActionBody;
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }

    const userToken = await resolveUserToken(req, config);
    if (!userToken) {
      return res.status(401).json({ error: CONNECT_GITHUB_HINT });
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
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL (pass as ?prUrl=...)' });
    }

    const userToken = await resolveUserToken(req, config);
    if (!userToken) {
      return res.status(401).json({ error: CONNECT_GITHUB_HINT });
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

  // GET /api/pr/data — full PR detail (metadata + reviews + comments + checks)
  router.get('/api/pr/data', async (req: Request, res: Response) => {
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
