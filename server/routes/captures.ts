import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { RouteDeps, PrCaptureRow } from '../types.js';
import {
  runCapture,
  isPlaywrightAvailable,
  isCaptureInProgress,
  getCaptureArtifacts,
  deleteCaptureArtifacts,
  postPrComment,
} from '../capture-engine.js';
import config from '../config.js';

// ─── Validation ─────────────────────────────────────────────────
// These validators must match the ones in capture-engine.ts — their job is to
// refuse anything that git could interpret as a flag, absolute path, or shell
// metacharacter before we persist it into pr_captures.
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,255}$/;
const COMMIT_SHA_RE = /^[a-f0-9]{7,64}$/i;
const REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?$/;

function validateCaptureInputs(
  branch: string,
  commitSha: string | null,
  repoUrl: string,
): string | null {
  if (!BRANCH_RE.test(branch)) return 'Invalid branch name';
  if (commitSha && !COMMIT_SHA_RE.test(commitSha)) return 'Invalid commit SHA';
  if (!REPO_URL_RE.test(repoUrl)) return 'Invalid repo URL (must be https://github.com/owner/repo)';
  return null;
}

// ─── Global router (no projectId) ───────────────────────────────
// Only /status lives here; all project-scoped operations use the
// project-scoped router below.
export function createCaptureGlobalRoutes(): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const playwrightAvailable = await isPlaywrightAvailable();
      res.json({
        enabled: !!config.capturesEnabled,
        playwrightAvailable,
      });
    } catch (err) {
      console.error('[Captures] Error checking status:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// ─── Project-scoped router ──────────────────────────────────────
export default function createCaptureRoutes(deps: RouteDeps): Router {
  const router = Router({ mergeParams: true });
  const { stmts, findProject } = deps;

  // GET /api/projects/:projectId/captures
  router.get('/', async (req: Request, res: Response) => {
    try {
      const projectId = req.params.projectId as string;
      const project = findProject(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const captures = stmts.getPrCapturesByProject.all(projectId) as PrCaptureRow[];
      res.json(captures);
    } catch (err) {
      console.error('[Captures] Error listing captures:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/projects/:projectId/captures
  router.post('/', async (req: Request, res: Response) => {
    try {
      const projectId = req.params.projectId as string;
      const project = findProject(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!config.capturesEnabled) {
        return res.status(403).json({ error: 'Captures are disabled' });
      }

      if (!(await isPlaywrightAvailable())) {
        return res.status(503).json({ error: 'Playwright/Chromium is not available on this host' });
      }

      const { prNumber, branch, commitSha, repoUrl, prUrl } = req.body as Record<string, unknown>;

      if (!prNumber || !branch) {
        return res.status(400).json({ error: 'prNumber and branch are required' });
      }

      let resolvedRepoUrl = repoUrl as string | undefined;
      if (!resolvedRepoUrl && project.githubRepo) {
        resolvedRepoUrl = `https://github.com/${project.githubRepo}`;
      }
      if (!resolvedRepoUrl) {
        return res
          .status(400)
          .json({ error: 'repoUrl is required (or set githubRepo on the project)' });
      }

      const validationError = validateCaptureInputs(
        String(branch),
        (commitSha as string) || null,
        resolvedRepoUrl,
      );
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const id = uuidv4();
      stmts.createPrCapture.run(
        id,
        projectId,
        prNumber,
        (prUrl as string) || null,
        branch,
        (commitSha as string) || null,
        resolvedRepoUrl,
      );

      runCapture(id).catch((err) => {
        console.error('[Captures] Async capture failed for', id, err);
      });

      const capture = stmts.getPrCapture.get(id) as PrCaptureRow;
      res.status(201).json(capture);
    } catch (err) {
      console.error('[Captures] Error creating capture:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/projects/:projectId/captures/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const projectId = req.params.projectId as string;
      const captureId = req.params.id as string;
      const capture = stmts.getPrCapture.get(captureId) as PrCaptureRow | undefined;

      if (!capture || capture.project_id !== projectId) {
        return res.status(404).json({ error: 'Capture not found' });
      }

      const artifacts = getCaptureArtifacts(captureId);
      res.json({ ...capture, artifacts });
    } catch (err) {
      console.error('[Captures] Error getting capture:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/projects/:projectId/captures/:id/rerun
  router.post('/:id/rerun', async (req: Request, res: Response) => {
    try {
      const projectId = req.params.projectId as string;
      const captureId = req.params.id as string;
      const original = stmts.getPrCapture.get(captureId) as PrCaptureRow | undefined;

      if (!original || original.project_id !== projectId) {
        return res.status(404).json({ error: 'Capture not found' });
      }

      if (!config.capturesEnabled) {
        return res.status(403).json({ error: 'Captures are disabled' });
      }

      const newId = uuidv4();
      stmts.createPrCapture.run(
        newId,
        projectId,
        original.pr_number,
        original.pr_url || null,
        original.branch,
        original.commit_sha || null,
        original.repo_url,
      );

      runCapture(newId).catch((err) => {
        console.error('[Captures] Async rerun capture failed for', newId, err);
      });

      const capture = stmts.getPrCapture.get(newId) as PrCaptureRow;
      res.status(201).json(capture);
    } catch (err) {
      console.error('[Captures] Error re-running capture:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/projects/:projectId/captures/:id/comment
  router.post('/:id/comment', async (req: Request, res: Response) => {
    try {
      const projectId = req.params.projectId as string;
      const captureId = req.params.id as string;
      const capture = stmts.getPrCapture.get(captureId) as PrCaptureRow | undefined;

      if (!capture || capture.project_id !== projectId) {
        return res.status(404).json({ error: 'Capture not found' });
      }

      if (capture.status !== 'done') {
        return res.status(400).json({ error: 'Capture must be completed before posting comment' });
      }

      const result = await postPrComment(captureId);

      if (result === null) {
        return res
          .status(500)
          .json({ error: 'Failed to post PR comment (check GitHub token and PR URL)' });
      }

      res.json({ commentUrl: result });
    } catch (err) {
      console.error('[Captures] Error posting comment:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/projects/:projectId/captures/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const projectId = req.params.projectId as string;
      const captureId = req.params.id as string;
      const capture = stmts.getPrCapture.get(captureId) as PrCaptureRow | undefined;

      if (!capture || capture.project_id !== projectId) {
        return res.status(404).json({ error: 'Capture not found' });
      }

      if (isCaptureInProgress(captureId)) {
        return res.status(409).json({ error: 'Cannot delete while capture is in progress' });
      }

      deleteCaptureArtifacts(captureId);
      stmts.deletePrCapture.run(captureId);

      res.status(204).send();
    } catch (err) {
      console.error('[Captures] Error deleting capture:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Exported for tests.
export const __internal = { validateCaptureInputs, BRANCH_RE, COMMIT_SHA_RE, REPO_URL_RE };
