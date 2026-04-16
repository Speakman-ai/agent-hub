/**
 * routes/ios-builds.ts — REST API for iOS PR preview builds.
 *
 * Endpoints:
 *   GET    /api/ios-builds/status                          — Infrastructure availability
 *   GET    /api/projects/:projectId/ios-builds             — List iOS builds for a project
 *   POST   /api/projects/:projectId/ios-builds             — Queue a new iOS build
 *   GET    /api/projects/:projectId/ios-builds/:id         — Get build details
 *   POST   /api/projects/:projectId/ios-builds/:id/cancel  — Cancel a running build
 *   GET    /api/projects/:projectId/ios-builds/:id/logs    — Get build logs
 *   DELETE /api/projects/:projectId/ios-builds/:id         — Delete build record
 *   GET    /api/projects/:projectId/ios-builds/:id/artifacts — List build artifacts
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { RouteDeps, IosBuildRow, IosBuildArtifactRow } from '../types.js';
import {
  isIosBuildAvailable,
  queueIosBuild,
  cancelIosBuild,
  getIosBuildLogs,
  MAX_CONCURRENT_IOS_BUILDS,
  BUILD_TIMEOUT_MINUTES,
} from '../ios-build-engine.js';

export default function createIosBuildRoutes(deps: RouteDeps): Router {
  const { stmts, findProject } = deps;
  const router = Router();

  // ─── Global status ──────────────────────────────────────────────

  router.get('/api/ios-builds/status', async (_req: Request, res: Response) => {
    try {
      const { available, reason } = await isIosBuildAvailable();
      const running = stmts.getRunningIosBuilds.all() as IosBuildRow[];
      res.json({
        available,
        reason: reason ?? null,
        runningCount: running.length,
        maxConcurrent: MAX_CONCURRENT_IOS_BUILDS,
        buildTimeoutMinutes: BUILD_TIMEOUT_MINUTES,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── List builds for a project ─────────────────────────────────

  router.get('/api/projects/:projectId/ios-builds', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const builds = stmts.getIosBuildsByProject.all(project.id) as IosBuildRow[];
    res.json(builds);
  });

  // ─── Queue a new build ─────────────────────────────────────────

  router.post('/api/projects/:projectId/ios-builds', async (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { prNumber, branch, prUrl, repoUrl, commitSha } = req.body;

    if (!prNumber || !branch) {
      return res.status(400).json({ error: 'prNumber and branch are required' });
    }

    const buildId = uuidv4();
    const resolvedRepoUrl =
      repoUrl || (project.githubRepo ? `https://github.com/${project.githubRepo}.git` : '');

    if (!resolvedRepoUrl) {
      return res.status(400).json({
        error:
          'Repository URL is required. Provide repoUrl in the request or set githubRepo on the project.',
      });
    }

    try {
      await queueIosBuild({
        buildId,
        projectId: project.id,
        prNumber: Number(prNumber),
        branch,
        commitSha,
        repoUrl: resolvedRepoUrl,
        prUrl,
      });

      const build = stmts.getIosBuild.get(buildId) as IosBuildRow;
      res.status(201).json(build);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Get build details ─────────────────────────────────────────

  router.get('/api/projects/:projectId/ios-builds/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const build = stmts.getIosBuild.get(req.params.id as string) as IosBuildRow | undefined;
    if (!build || build.project_id !== project.id) {
      return res.status(404).json({ error: 'Build not found' });
    }

    res.json(build);
  });

  // ─── Cancel a build ─────────────────────────────────────────────

  router.post(
    '/api/projects/:projectId/ios-builds/:id/cancel',
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const build = stmts.getIosBuild.get(req.params.id as string) as IosBuildRow | undefined;
      if (!build || build.project_id !== project.id) {
        return res.status(404).json({ error: 'Build not found' });
      }

      try {
        await cancelIosBuild(build.id);
        const updated = stmts.getIosBuild.get(build.id) as IosBuildRow;
        res.json(updated);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    },
  );

  // ─── Get build logs ────────────────────────────────────────────

  router.get('/api/projects/:projectId/ios-builds/:id/logs', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const build = stmts.getIosBuild.get(req.params.id as string) as IosBuildRow | undefined;
    if (!build || build.project_id !== project.id) {
      return res.status(404).json({ error: 'Build not found' });
    }

    try {
      const logs = getIosBuildLogs(build.id);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Delete build record ───────────────────────────────────────

  router.delete('/api/projects/:projectId/ios-builds/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const build = stmts.getIosBuild.get(req.params.id as string) as IosBuildRow | undefined;
    if (!build || build.project_id !== project.id) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const activeStatuses = ['queued', 'provisioning', 'building', 'archiving', 'uploading'];
    if (activeStatuses.includes(build.status)) {
      return res
        .status(400)
        .json({ error: 'Cannot delete a build that is in progress. Cancel it first.' });
    }

    // Clean up artifacts
    stmts.deleteIosBuildArtifacts.run(build.id);
    stmts.deleteIosBuild.run(build.id);
    res.json({ success: true });
  });

  // ─── List build artifacts ──────────────────────────────────────

  router.get('/api/projects/:projectId/ios-builds/:id/artifacts', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const build = stmts.getIosBuild.get(req.params.id as string) as IosBuildRow | undefined;
    if (!build || build.project_id !== project.id) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const artifacts = stmts.getIosBuildArtifacts.all(build.id) as IosBuildArtifactRow[];
    res.json(artifacts);
  });

  return router;
}
