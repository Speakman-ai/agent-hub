/**
 * routes/pr-actions.ts — API endpoints for human PR actions (merge/close).
 *
 * POST /api/pr/merge  — Merge a PR by URL
 * POST /api/pr/close  — Close a PR by URL
 * GET  /api/pr/status  — Get PR status (mergeable, CI, reviews)
 */

import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RouteDeps, AppConfig, GitHubAppConfig } from '../types.js';
import { githubApiRequest, resolveInstallationId } from '../github-app.js';

const execFileAsync = promisify(execFile);

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

function hasGitHubApp(config: AppConfig): boolean {
  const app = config.githubApp;
  if (!(app?.appId && app?.privateKey)) return false;
  return !!(app.installationId || (app.installations && app.installations.length > 0));
}

function botGhEnv(config: AppConfig): NodeJS.ProcessEnv | undefined {
  if (!config.botGithubToken) return undefined;
  return { ...process.env, GH_TOKEN: config.botGithubToken };
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

    // Try GitHub App first
    if (hasGitHubApp(config)) {
      try {
        const app = config.githubApp as GitHubAppConfig;
        const instId = resolveInstallationId(app, pr.owner);
        if (instId) {
          await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, {
            method: 'PUT',
            body: { merge_method: mergeMethod },
            appId: app.appId,
            privateKey: app.privateKey,
            installationId: instId,
          });
          // Try to delete branch
          try {
            const prData = (await githubApiRequest(
              `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
              { appId: app.appId, privateKey: app.privateKey, installationId: instId },
            )) as { head?: { ref?: string } };
            if (prData.head?.ref) {
              await githubApiRequest(
                `/repos/${pr.owner}/${pr.repo}/git/refs/heads/${prData.head.ref}`,
                {
                  method: 'DELETE',
                  appId: app.appId,
                  privateKey: app.privateKey,
                  installationId: instId,
                },
              );
            }
          } catch {
            /* branch deletion is best-effort */
          }
          return res.json({ ok: true, method: 'github-app', pr: pr.number });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (/already.*merged|405/i.test(msg)) {
          return res.json({ ok: true, alreadyMerged: true, pr: pr.number });
        }
        console.warn(`[PR Action] GitHub App merge failed, trying gh CLI: ${msg.split('\n')[0]}`);
      }
    }

    // Fallback to gh CLI
    const env = botGhEnv(config);
    try {
      await execFileAsync(
        'gh',
        [
          'pr',
          'merge',
          pr.number,
          '--repo',
          `${pr.owner}/${pr.repo}`,
          `--${mergeMethod}`,
          '--delete-branch',
        ],
        { timeout: 30000, ...(env && { env }) },
      );
      return res.json({ ok: true, method: 'gh-cli', pr: pr.number });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already.*merged|405/i.test(msg)) {
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

    // Try GitHub App first
    if (hasGitHubApp(config)) {
      try {
        const app = config.githubApp as GitHubAppConfig;
        const instId = resolveInstallationId(app, pr.owner);
        if (instId) {
          await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
            method: 'PATCH',
            body: { state: 'closed' },
            appId: app.appId,
            privateKey: app.privateKey,
            installationId: instId,
          });
          return res.json({ ok: true, method: 'github-app', pr: pr.number });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        console.warn(`[PR Action] GitHub App close failed, trying gh CLI: ${msg.split('\n')[0]}`);
      }
    }

    // Fallback to gh CLI
    const env = botGhEnv(config);
    try {
      await execFileAsync('gh', ['pr', 'close', pr.number, '--repo', `${pr.owner}/${pr.repo}`], {
        timeout: 30000,
        ...(env && { env }),
      });
      return res.json({ ok: true, method: 'gh-cli', pr: pr.number });
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

    // Try GitHub App
    if (hasGitHubApp(config)) {
      try {
        const app = config.githubApp as GitHubAppConfig;
        const instId = resolveInstallationId(app, pr.owner);
        if (instId) {
          const data = (await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
            appId: app.appId,
            privateKey: app.privateKey,
            installationId: instId,
          })) as Record<string, unknown>;
          return res.json({
            number: pr.number,
            state: data.state,
            mergeable: data.mergeable,
            mergeable_state: data.mergeable_state,
            title: data.title,
            user: (data.user as Record<string, unknown>)?.login,
            head: (data.head as Record<string, unknown>)?.ref,
            base: (data.base as Record<string, unknown>)?.ref,
            additions: data.additions,
            deletions: data.deletions,
            changed_files: data.changed_files,
          });
        }
      } catch (err: unknown) {
        console.warn(`[PR Action] GitHub App status failed: ${(err as Error).message}`);
      }
    }

    // Fallback to gh CLI
    const env = botGhEnv(config);
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'view',
          pr.number,
          '--repo',
          `${pr.owner}/${pr.repo}`,
          '--json',
          'number,state,mergeable,title,headRefName,baseRefName,additions,deletions,changedFiles,author',
        ],
        { timeout: 15000, ...(env && { env }) },
      );
      const data = JSON.parse(stdout);
      return res.json({
        number: data.number,
        state: data.state?.toLowerCase(),
        mergeable: data.mergeable === 'MERGEABLE',
        title: data.title,
        user: data.author?.login,
        head: data.headRefName,
        base: data.baseRefName,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changedFiles,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Status check failed: ${msg.split('\n')[0]}` });
    }
  });

  return router;
}
