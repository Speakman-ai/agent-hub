/**
 * Grouped error-issue API (decision LOG-GROUP).
 *
 *   GET  /api/projects/:projectId/logs/issues                     — list (filter by status)
 *   GET  /api/projects/:projectId/logs/issues/:issueId            — detail + releases + samples
 *   POST /api/projects/:projectId/logs/issues/:issueId/resolve    — mark resolved
 *   POST /api/projects/:projectId/logs/issues/:issueId/ignore     — mute
 *   POST /api/projects/:projectId/logs/issues/:issueId/reopen     — reopen
 *
 * All routes are project-ACL scoped (`canViewProject`) so an issue id from
 * another project never resolves — a hidden project surfaces as 404 so its
 * existence never leaks. Reads and triage mutations require the `User` role.
 * Raw records stay immutable in `log_records`; detail joins recent samples back
 * by fingerprint rather than duplicating them onto the issue.
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole } from '../roles.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import type { RouteDeps } from '../types.js';
import { queryLogRecords } from '../logs/logs-db.js';
import { serializeLogRecord } from '../logs/log-record-api.js';
import {
  listIssues,
  getIssue,
  getIssueReleases,
  setIssueStatus,
  serializeLogIssue,
  type IssueStatus,
} from '../logs/log-issues-store.js';
import { IssueListParamsSchema } from './log-issues.openapi.js';

/** Recent raw records surfaced on an issue detail response. */
const ISSUE_SAMPLE_LIMIT = 20;

export default function createLogIssueRoutes({ findProject }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  function requireVisibleProject(req: Request, res: Response): boolean {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
      res.status(404).json({ error: 'Project not found' });
      return false;
    }
    return true;
  }

  function actorId(req: Request): string | null {
    return (req as AuthenticatedRequest).authUserId ?? null;
  }

  function updateStatus(req: Request, res: Response, status: IssueStatus): void {
    if (!requireVisibleProject(req, res)) return;
    const updated = setIssueStatus(
      req.params.projectId as string,
      req.params.issueId as string,
      status,
      actorId(req),
      Date.now(),
    );
    if (!updated) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json(serializeLogIssue(updated));
  }

  // ─── List ─────────────────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/logs/issues',
    requireRole('User'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res)) return;
      const parsed = IssueListParamsSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid issue query' });
        return;
      }
      const page = listIssues({
        projectId: req.params.projectId as string,
        status: parsed.data.status as IssueStatus | undefined,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      });
      res.json({
        issues: page.issues.map((i) => serializeLogIssue(i)),
        nextCursor: page.nextCursor,
      });
    },
  );

  // ─── Detail ───────────────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/logs/issues/:issueId',
    requireRole('User'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res)) return;
      const projectId = req.params.projectId as string;
      const issue = getIssue(projectId, req.params.issueId as string);
      if (!issue) {
        res.status(404).json({ error: 'Issue not found' });
        return;
      }
      const releases = getIssueReleases(issue.id);
      const samples = queryLogRecords({
        projectId,
        fingerprint: issue.fingerprint,
        limit: ISSUE_SAMPLE_LIMIT,
      });
      res.json({
        ...serializeLogIssue(issue, releases),
        samples: samples.records.map(serializeLogRecord),
      });
    },
  );

  // ─── Lifecycle transitions ────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/logs/issues/:issueId/resolve',
    requireRole('User'),
    (req: Request, res: Response) => updateStatus(req, res, 'resolved'),
  );

  router.post(
    '/api/projects/:projectId/logs/issues/:issueId/ignore',
    requireRole('User'),
    (req: Request, res: Response) => updateStatus(req, res, 'ignored'),
  );

  router.post(
    '/api/projects/:projectId/logs/issues/:issueId/reopen',
    requireRole('User'),
    (req: Request, res: Response) => updateStatus(req, res, 'open'),
  );

  return router;
}
