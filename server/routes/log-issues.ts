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
import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole } from '../roles.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import type { RouteDeps, SessionRow } from '../types.js';
import { queryLogRecords } from '../logs/logs-db.js';
import { serializeLogRecord } from '../logs/log-record-api.js';
import {
  listIssues,
  getIssue,
  getIssueReleases,
  setIssueStatus,
  claimIssueAnalyzeSession,
  releaseIssueAnalyzeSession,
  serializeLogIssue,
  type IssueStatus,
} from '../logs/log-issues-store.js';
import { listLogSources } from '../logs/log-sources-store.js';
import { buildAuditedLogContextPack, MAX_CONTEXT_RECORDS } from '../logs/log-context-pack.js';
import { buildAnalyzeSessionContext } from '../logs/log-analyze-prompt.js';
import { resolveEffectiveEngineAndModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { markSessionFinalizeAutomation } from '../session-ship.js';
import { enrichSessionForClient } from '../session-checkpoint-rewind.js';
import { defaultSessionUseWorktreeFlag } from '../project-mode.js';
import { IssueListParamsSchema } from './log-issues.openapi.js';

/** Recent raw records surfaced on an issue detail response. */
const ISSUE_SAMPLE_LIMIT = 20;

/**
 * Conservative session-title charset. The issue title/exception are log-derived
 * (attacker-controlled) free text, so the Analyze session name is built from a
 * sanitized slice — never the raw untrusted value — even though the UI renders
 * names as text.
 */
function safeSessionTitleFragment(issue: { exception_type: string | null; title: string }): string {
  const raw = issue.exception_type || issue.title || 'log issue';
  const cleaned = raw
    .replace(/[^\w .:@/#+-]/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'log issue';
}

/** Analyze-only picker: lead first, then a dev/developer; never reviewer/docs. */
function pickAnalyzeAgent(project: {
  agents: Array<{ id: string; name: string; role?: string }>;
}): { id: string; name: string } | null {
  const lead = project.agents.find((candidate) => candidate.role === 'lead');
  if (lead) return { id: lead.id, name: lead.name };
  const dev = project.agents.find(
    (candidate) => candidate.role === 'dev' || candidate.role === 'developer',
  );
  return dev ? { id: dev.id, name: dev.name } : null;
}

export default function createLogIssueRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, config, handleChat, broadcast, stmts } = deps;
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

  // ─── Analyze — one-click read-only root-cause investigation (LOG-ANALYZE) ──
  //
  // Starts (or reopens) a NORMAL chat session on the project's default eligible
  // dev/lead agent, seeded with a bounded, redacted, fenced context pack and a
  // read-only investigation brief. finalize_automation is forced to `manual` so
  // the session can never silently ship, and it stays linked to the issue so the
  // user can reopen it. Idempotent: while a live linked session exists, repeat
  // calls return it instead of spawning a duplicate investigation.
  router.post(
    '/api/projects/:projectId/logs/issues/:issueId/analyze',
    requireRole('User'),
    async (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res)) return;
      const projectId = req.params.projectId as string;
      const issueId = req.params.issueId as string;

      const issue = getIssue(projectId, issueId);
      if (!issue) {
        res.status(404).json({ error: 'Issue not found' });
        return;
      }
      const project = findProject(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const ownerUserId = resolveOwnerUserId(req as AuthenticatedRequest);

      // Idempotency: reuse the linked session while it still exists (not soft-
      // deleted). "Reopen" is just returning that session so the client can
      // navigate to it — a second Analyze click must not spawn a duplicate.
      if (issue.analyze_session_id) {
        const existing = stmts.getSession.get(issue.analyze_session_id) as SessionRow | undefined;
        if (existing && !existing.deleted_at) {
          res.json({
            sessionId: existing.id,
            agentId: existing.agent_id,
            reused: true,
            issue: serializeLogIssue(issue),
          });
          return;
        }
      }

      const pick = pickAnalyzeAgent(project);
      if (!pick) {
        res.status(400).json({ error: 'No eligible agent for this project' });
        return;
      }
      const found = findAgent(pick.id);
      if (!found) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const { agent } = found;

      const sessionId = crypto.randomUUID();
      // Claim the issue in logs.db BEFORE touching sessions.db. The claim row
      // is the cross-database coordination boundary: a second request either
      // sees the winner's session or can compare-and-swap a stale/deleted link,
      // but it cannot create a second live investigation.
      let claim = claimIssueAnalyzeSession(projectId, issueId, sessionId, issue.analyze_session_id);
      if (!claim.claimed) {
        const winnerId = claim.sessionId;
        const winner = winnerId
          ? (stmts.getSession.get(winnerId) as SessionRow | undefined)
          : undefined;
        if (winner && !winner.deleted_at) {
          res.json({
            sessionId: winner.id,
            agentId: winner.agent_id,
            reused: true,
            issue: serializeLogIssue(getIssue(projectId, issueId) ?? issue),
          });
          return;
        }
        // A prior process may have died after claiming but before creating its
        // session. Replace only that exact stale claim; a concurrent live
        // creator cannot be displaced because its session now exists.
        claim = claimIssueAnalyzeSession(projectId, issueId, sessionId, winnerId);
        if (!claim.claimed) {
          res.status(409).json({ error: 'Analyze session is starting; retry shortly' });
          return;
        }
      }

      let pack: ReturnType<typeof buildAuditedLogContextPack>['pack'];
      const title = `Analyze: ${safeSessionTitleFragment(issue)}`;
      try {
        // Build the redacted, audited, prompt-safe context pack (LOG-TRUST).
        // The audited seam persists who launched Analyze and which records were
        // included — a pack can't reach the agent without it.
        const nowMs = Date.now();
        const records = queryLogRecords({
          projectId,
          fingerprint: issue.fingerprint,
          limit: MAX_CONTEXT_RECORDS,
        }).records;
        const releases = getIssueReleases(issue.id);
        const sourceNames = new Map(listLogSources(projectId).map((s) => [s.id, s.name]));
        pack = buildAuditedLogContextPack({
          action: 'analyze',
          actorUserId: ownerUserId,
          nowMs,
          pack: { issue, records, releases, sourceNames },
        }).pack;

        const { engine, model } = resolveEffectiveEngineAndModel(config, {
          agentId: agent.id,
          agentEngine: agent.engine || 'claude-code',
          agentModel: agent.model ?? null,
          ownerUserId,
        });
        // Normal chat session (ask_mode = 0): the read-only constraint comes from
        // the seed prompt, not plan mode, so the user can later ask for a fix in
        // this same session without losing context. Worktree isolation when the
        // project supports it (LOG-ANALYZE).
        stmts.createSession.run(
          sessionId,
          agent.id,
          title,
          engine,
          model,
          defaultSessionUseWorktreeFlag(project),
          0,
          1,
        );
      } catch (err) {
        releaseIssueAnalyzeSession(projectId, issueId, sessionId);
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to start analysis session: ${message}` });
        return;
      }
      markSessionFinalizeAutomation(stmts, sessionId, 'manual');
      setSessionOwner(sessionId, ownerUserId);

      const content = buildAnalyzeSessionContext({
        projectId,
        issueId,
        contextBlock: pack.contextBlock,
      });
      const initialChatMessage = {
        type: 'chat' as const,
        agentId: agent.id,
        sessionId,
        content,
        hookSpecificOutput: { sessionTitle: title },
      };
      const cleanupFailedAnalyze = (err: unknown): void => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Analyze] handleChat failed for session ${sessionId}:`, message);
        // The session row and claim were published before the asynchronous
        // chat turn completed. Remove both on failure so a rejected initial
        // prompt cannot leave a dead session that appears safely reopenable.
        try {
          stmts.deleteSession.run(sessionId);
        } catch (cleanupErr) {
          console.error(
            `[Analyze] failed to delete rejected session ${sessionId}:`,
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          );
        }
        try {
          releaseIssueAnalyzeSession(projectId, issueId, sessionId);
        } catch (cleanupErr) {
          console.error(
            `[Analyze] failed to release claim for ${sessionId}:`,
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          );
        }
        broadcast({ type: 'session_deleted', sessionId });
        broadcast({
          type: 'error',
          agentId: agent.id,
          sessionId,
          message: `Failed to start analysis session: ${message}`,
        });
      };
      let initialChat: Promise<void>;
      try {
        // Guard the invocation itself as well as the returned Promise: a
        // mocked/alternate handler may throw synchronously before returning.
        initialChat = handleChat(null, initialChatMessage);
      } catch (err) {
        cleanupFailedAnalyze(err);
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to start analysis session: ${message}` });
        return;
      }
      void initialChat.catch(cleanupFailedAnalyze);

      const sessionRow = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'session_created',
        agentId: agent.id,
        session: enrichSessionForClient(sessionRow, stmts),
      });

      res.json({
        sessionId,
        agentId: agent.id,
        reused: false,
        issue: serializeLogIssue(getIssue(projectId, issueId) ?? issue),
      });
    },
  );

  return router;
}
