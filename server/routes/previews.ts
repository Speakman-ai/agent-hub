/**
 * routes/previews.ts — REST API for PR preview container management.
 *
 * Endpoints:
 *   GET    /api/previews/status          — Docker availability + running count
 *   GET    /api/projects/:projectId/previews — List previews for a project
 *   POST   /api/projects/:projectId/previews — Create a new preview
 *   GET    /api/projects/:projectId/previews/:id — Get preview details
 *   POST   /api/projects/:projectId/previews/:id/stop — Stop a preview
 *   POST   /api/projects/:projectId/previews/:id/rebuild — Rebuild a preview
 *   GET    /api/projects/:projectId/previews/:id/logs — Get container logs
 *   DELETE /api/projects/:projectId/previews/:id — Delete preview record
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { RouteDeps, PreviewContainerRow } from '../types.js';
import {
  isDockerAvailable,
  createPreview,
  stopPreview,
  rebuildPreview,
  getPreviewLogs,
  DEFAULT_TTL_MINUTES,
  MAX_CONCURRENT_PREVIEWS,
} from '../preview-engine.js';

export default function createPreviewRoutes(deps: RouteDeps): Router {
  const { stmts, findProject } = deps;
  const router = Router();

  // ─── Global status ──────────────────────────────────────────────

  router.get('/api/previews/status', async (_req: Request, res: Response) => {
    try {
      const dockerAvailable = await isDockerAvailable();
      const running = stmts.getRunningPreviews.all() as PreviewContainerRow[];
      res.json({
        dockerAvailable,
        runningCount: running.length,
        maxConcurrent: MAX_CONCURRENT_PREVIEWS,
        defaultTtlMinutes: DEFAULT_TTL_MINUTES,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── List previews for a project ────────────────────────────────

  router.get('/api/projects/:projectId/previews', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const previews = stmts.getPreviewContainersByProject.all(projectId) as PreviewContainerRow[];
    res.json(previews);
  });

  // ─── Create a preview ──────────────────────────────────────────

  router.post('/api/projects/:projectId/previews', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { prNumber, prUrl, branch, commitSha, repoUrl, ttlMinutes } = req.body;

    if (!prNumber || !branch) {
      return res.status(400).json({ error: 'prNumber and branch are required' });
    }

    // Default repo URL from project's githubRepo if available
    const resolvedRepoUrl =
      repoUrl || (project.githubRepo ? `https://github.com/${project.githubRepo}.git` : null);

    if (!resolvedRepoUrl) {
      return res
        .status(400)
        .json({ error: 'repoUrl is required (or set githubRepo on the project)' });
    }

    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      return res.status(503).json({ error: 'Docker is not available on this host' });
    }

    try {
      const id = uuidv4();
      const preview = await createPreview({
        id,
        projectId: projectId as string,
        prNumber: Number(prNumber),
        prUrl: prUrl || null,
        branch,
        commitSha: commitSha || null,
        repoUrl: resolvedRepoUrl,
        ttlMinutes: ttlMinutes ? Number(ttlMinutes) : undefined,
      });
      res.status(201).json(preview);
    } catch (err) {
      const message = (err as Error).message;
      const status = message.includes('Maximum concurrent') ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  // ─── Get preview details ────────────────────────────────────────

  router.get('/api/projects/:projectId/previews/:id', (req: Request, res: Response) => {
    const preview = stmts.getPreviewContainer.get(req.params.id as string) as
      | PreviewContainerRow
      | undefined;
    if (!preview || preview.project_id !== (req.params.projectId as string)) {
      return res.status(404).json({ error: 'Preview not found' });
    }
    res.json(preview);
  });

  // ─── Stop a preview ──────────────────────────────────────────────

  router.post('/api/projects/:projectId/previews/:id/stop', async (req: Request, res: Response) => {
    const preview = stmts.getPreviewContainer.get(req.params.id as string) as
      | PreviewContainerRow
      | undefined;
    if (!preview || preview.project_id !== (req.params.projectId as string)) {
      return res.status(404).json({ error: 'Preview not found' });
    }

    try {
      const updated = await stopPreview(preview.id);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Rebuild a preview ──────────────────────────────────────────

  router.post(
    '/api/projects/:projectId/previews/:id/rebuild',
    async (req: Request, res: Response) => {
      const preview = stmts.getPreviewContainer.get(req.params.id as string) as
        | PreviewContainerRow
        | undefined;
      if (!preview || preview.project_id !== (req.params.projectId as string)) {
        return res.status(404).json({ error: 'Preview not found' });
      }

      try {
        await rebuildPreview(preview.id);
        const updated = stmts.getPreviewContainer.get(preview.id) as PreviewContainerRow;
        res.json(updated);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ─── Get container logs ──────────────────────────────────────────

  router.get('/api/projects/:projectId/previews/:id/logs', async (req: Request, res: Response) => {
    const preview = stmts.getPreviewContainer.get(req.params.id as string) as
      | PreviewContainerRow
      | undefined;
    if (!preview || preview.project_id !== (req.params.projectId as string)) {
      return res.status(404).json({ error: 'Preview not found' });
    }

    const tail = req.query.tail ? Number(req.query.tail) : 200;
    try {
      const logs = await getPreviewLogs(preview.id, tail);
      res.json({ logs: logs || '' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Delete preview record ───────────────────────────────────────

  router.delete('/api/projects/:projectId/previews/:id', async (req: Request, res: Response) => {
    const preview = stmts.getPreviewContainer.get(req.params.id as string) as
      | PreviewContainerRow
      | undefined;
    if (!preview || preview.project_id !== (req.params.projectId as string)) {
      return res.status(404).json({ error: 'Preview not found' });
    }

    // Stop container if still running
    if (preview.status === 'running' || preview.status === 'building') {
      await stopPreview(preview.id).catch(() => {});
    }

    stmts.deletePreviewContainer.run(preview.id);
    res.json({ ok: true });
  });

  return router;
}
