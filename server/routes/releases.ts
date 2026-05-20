import { Router, Request, Response } from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findRelease, listUserFacingReleases } from '../github-releases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverVersion: string = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
).version;

export default function createReleasesRoutes(): Router {
  const router = Router();

  // The try/catch on both handlers is defence-in-depth: today
  // `listUserFacingReleases` catches every failure internally (network
  // timeouts in `fetchGithubReleases`, `git tag` / `git log` failures in
  // `releasesFromGitTags`) and resolves with empty data rather than
  // rejecting. The 500 branch exists so a future refactor that adds a
  // throwing code path can't turn into an unhandled rejection.
  router.get('/api/releases', async (req: Request, res: Response) => {
    try {
      const versionQ = typeof req.query.version === 'string' ? req.query.version : undefined;
      const limitQ =
        typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';

      const { repo, releases, source } = await listUserFacingReleases({
        limit: Number.isFinite(limitQ) ? limitQ : undefined,
        forceRefresh: refresh,
      });

      const currentVersion = serverVersion;
      const selected = versionQ
        ? findRelease(releases, versionQ)
        : findRelease(releases, currentVersion);

      res.json({
        repo,
        source,
        currentVersion,
        selected: selected ?? releases[0] ?? null,
        releases: releases.map((r) => ({
          version: r.version,
          tag: r.tag,
          publishedAt: r.publishedAt,
          url: r.url,
          summary: r.summary,
        })),
      });
    } catch (err: unknown) {
      console.error('[releases] list failed:', err);
      res.status(500).json({ error: 'Failed to load release notes' });
    }
  });

  router.get('/api/releases/:version', async (req: Request, res: Response) => {
    try {
      const { repo, releases } = await listUserFacingReleases();
      // Path params are always strings at runtime; Express's TS types widen
      // to `string | string[]` to cover the `key+` / `key*` repeating-param
      // syntax we don't use. A typeof guard keeps the type narrow without
      // dead `Array.isArray` handling.
      const versionParam = req.params.version;
      const versionKey = typeof versionParam === 'string' ? versionParam : '';
      const release = findRelease(releases, versionKey);
      if (!release) {
        return res.status(404).json({ error: 'Release not found' });
      }
      res.json({ repo, release });
    } catch (err: unknown) {
      console.error('[releases] detail failed:', err);
      res.status(500).json({ error: 'Failed to load release notes' });
    }
  });

  return router;
}
