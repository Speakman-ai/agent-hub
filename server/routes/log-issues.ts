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
import type { KanbanCardRow, KanbanColumnRow, RouteDeps, SessionRow } from '../types.js';
import { getDb } from '../db.js';
import { getOrCreateBoard, serializeCardForRequest } from './board.js';
import { queryLogRecords } from '../logs/logs-db.js';
import { serializeLogRecord } from '../logs/log-record-api.js';
import {
  listIssues,
  getIssue,
  getIssueReleases,
  setIssueStatus,
  setIssueStatuses,
  claimIssueAnalyzeSession,
  releaseIssueAnalyzeSession,
  ownsIssueAnalyzeSessionClaim,
  claimIssueFixSession,
  releaseIssueFixSession,
  ownsIssueFixSessionClaim,
  serializeLogIssue,
  type IssueStatus,
} from '../logs/log-issues-store.js';
import { listLogSources } from '../logs/log-sources-store.js';
import { buildAuditedLogContextPack, MAX_CONTEXT_RECORDS } from '../logs/log-context-pack.js';
import { buildAnalyzeSessionContext } from '../logs/log-analyze-prompt.js';
import { buildFixSessionContext } from '../logs/log-fix-prompt.js';
import { resolveEffectiveEngineAndModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { markSessionFinalizeAutomation } from '../session-ship.js';
import { enrichSessionForClient } from '../session-checkpoint-rewind.js';
import { defaultSessionUseWorktreeFlag } from '../project-mode.js';
import { getUserProjectDefaultFinalizeAutomation } from '../user-project-settings.js';
import {
  IssueListParamsSchema,
  LogIssueActionRequest,
  LogIssueBulkStatusRequest,
} from './log-issues.openapi.js';

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

function activeFixRows(
  stmts: RouteDeps['stmts'],
  projectId: string,
  issue: { fix_card_id?: string | null; fix_session_id?: string | null },
): { card: KanbanCardRow; session: SessionRow } | null {
  if (!issue.fix_card_id || !issue.fix_session_id) return null;
  const card = stmts.getKanbanCard.get(issue.fix_card_id) as KanbanCardRow | undefined;
  const session = stmts.getSession.get(issue.fix_session_id) as SessionRow | undefined;
  if (!card || !session || session.deleted_at || card.session_id !== session.id) return null;
  const board = stmts.getKanbanBoard.get(projectId) as { id: string } | undefined;
  if (!board || card.board_id !== board.id) return null;
  const column = stmts.getKanbanColumn.get(card.column_id) as KanbanColumnRow | undefined;
  if (!column || column.name.toLowerCase() === 'done') return null;
  return { card, session };
}

/**
 * A missing main-DB row is ambiguous while the winning request is between
 * claiming logs.db and committing its session/card transaction. Never replace
 * that shape automatically: doing so could race a legitimate slow creator.
 * Explicit Done/deleted state is stale immediately and can be CAS-replaced.
 */
function isStaleFixClaim(
  stmts: RouteDeps['stmts'],
  projectId: string,
  claim: { cardId: string | null; sessionId: string | null; claimedAt: number | null },
): boolean {
  if (!claim.cardId || !claim.sessionId) return false;
  const card = stmts.getKanbanCard.get(claim.cardId) as KanbanCardRow | undefined;
  const session = stmts.getSession.get(claim.sessionId) as SessionRow | undefined;
  if (session?.deleted_at) return true;
  if (card && session) {
    if (card.session_id !== session.id) return true;
    const board = stmts.getKanbanBoard.get(projectId) as { id: string } | undefined;
    if (board && card.board_id !== board.id) return true;
    const column = stmts.getKanbanColumn.get(card.column_id) as KanbanColumnRow | undefined;
    if (!column || column.name.toLowerCase() === 'done') return true;
    return false;
  }
  // No card/session rows means the owner may still be building its context or
  // entering the main transaction. Recovery from a crash in that narrow
  // window is intentionally manual rather than a source of duplicate Fixes.
  return false;
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

  function broadcastAction(event: {
    projectId: string;
    issueId: string;
    action: 'analyze' | 'fix';
    status: 'in_flight' | 'completed' | 'failed';
    sessionId?: string | null;
    agentId?: string | null;
    cardId?: string | null;
    error?: string | null;
  }): void {
    broadcast({ type: 'log_issue_action', ...event });
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

  // ─── Bulk lifecycle transition ────────────────────────────────────
  //
  // One transaction for the whole selection so a batch never lands half
  // applied. Ids that do not belong to this project come back in `notFound`
  // instead of failing the batch — a stale client selection (an issue deleted
  // or purged since the page loaded) must not block the rest of the transition.
  router.post(
    '/api/projects/:projectId/logs/issues/bulk-status',
    requireRole('User'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res)) return;
      const parsed = LogIssueBulkStatusRequest.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid bulk request' });
        return;
      }
      const { updated, notFound } = setIssueStatuses(
        req.params.projectId as string,
        parsed.data.issueIds,
        parsed.data.status as IssueStatus,
        actorId(req),
        Date.now(),
      );
      res.json({ updated: updated.map((issue) => serializeLogIssue(issue)), notFound });
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
      const actionRequest = LogIssueActionRequest.safeParse(req.body ?? {});
      if (!actionRequest.success) {
        res.status(400).json({ error: actionRequest.error.issues[0]?.message ?? 'Invalid action' });
        return;
      }
      const startAnother = actionRequest.data.startAnother;

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
      if (!startAnother && issue.analyze_session_id) {
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
        if (winner && !winner.deleted_at && !startAnother) {
          res.json({
            sessionId: winner.id,
            agentId: winner.agent_id,
            reused: true,
            issue: serializeLogIssue(getIssue(projectId, issueId) ?? issue),
          });
          return;
        }
        if (startAnother && winnerId) {
          claim = claimIssueAnalyzeSession(projectId, issueId, sessionId, winnerId);
          if (!claim.claimed) {
            res.status(409).json({ error: 'Analyze session is starting; retry shortly' });
            return;
          }
        } else {
          // A prior process may have died after claiming but before creating its
          // session. Replace only that exact stale claim; a concurrent live
          // creator cannot be displaced because its session now exists.
          claim = claimIssueAnalyzeSession(projectId, issueId, sessionId, winnerId);
          if (!claim.claimed) {
            res.status(409).json({ error: 'Analyze session is starting; retry shortly' });
            return;
          }
        }
      }

      broadcastAction({
        projectId,
        issueId,
        action: 'analyze',
        status: 'in_flight',
        sessionId,
        agentId: agent.id,
      });

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
        broadcastAction({
          projectId,
          issueId,
          action: 'analyze',
          status: 'failed',
          sessionId,
          agentId: agent.id,
          error: message,
        });
        res.status(500).json({ error: `Failed to start analysis session: ${message}` });
        return;
      }
      if (!ownsIssueAnalyzeSessionClaim(projectId, issueId, sessionId)) {
        const message = 'Analyze session claim was superseded; retry shortly';
        try {
          stmts.deleteSession.run(sessionId);
        } catch (cleanupErr) {
          console.error(
            `[Analyze] failed to delete superseded session ${sessionId}:`,
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          );
        }
        broadcastAction({
          projectId,
          issueId,
          action: 'analyze',
          status: 'failed',
          sessionId,
          agentId: agent.id,
          error: message,
        });
        res.status(409).json({ error: message });
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
        broadcastAction({
          projectId,
          issueId,
          action: 'analyze',
          status: 'failed',
          sessionId,
          agentId: agent.id,
          error: message,
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
      broadcastAction({
        projectId,
        issueId,
        action: 'analyze',
        status: 'completed',
        sessionId,
        agentId: agent.id,
      });

      res.json({
        sessionId,
        agentId: agent.id,
        reused: false,
        issue: serializeLogIssue(getIssue(projectId, issueId) ?? issue),
      });
    },
  );

  // ─── Fix — tracked worktree implementation (LOG-FIX) ────────────────
  //
  // This intentionally creates the session/card directly. The board assign
  // route is an orchestration entry point with its own push/merge defaults;
  // Fix must inherit the initiating user's preference instead.
  router.post(
    '/api/projects/:projectId/logs/issues/:issueId/fix',
    requireRole('User'),
    async (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res)) return;
      const projectId = req.params.projectId as string;
      const issueId = req.params.issueId as string;
      const actionRequest = LogIssueActionRequest.safeParse(req.body ?? {});
      if (!actionRequest.success) {
        res.status(400).json({ error: actionRequest.error.issues[0]?.message ?? 'Invalid action' });
        return;
      }
      const startAnother = actionRequest.data.startAnother;
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

      const existing = startAnother ? null : activeFixRows(stmts, projectId, issue);
      if (existing) {
        res.json({
          cardId: existing.card.id,
          sessionId: existing.session.id,
          agentId: existing.session.agent_id,
          automation: existing.session.finalize_automation || 'manual',
          reused: true,
          issue: serializeLogIssue(getIssue(projectId, issueId) ?? issue),
          card: serializeCardForRequest(req, stmts, existing.card.board_id, existing.card),
        });
        return;
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
      const ownerUserId = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = crypto.randomUUID();
      const cardId = crypto.randomUUID();

      // A claim is committed before the cross-database main-DB transaction.
      // This is the only safe way to serialize clicks because logs.db and the
      // Hub operational DB are separate SQLite databases.
      let claim = claimIssueFixSession(projectId, issueId, cardId, sessionId);
      if (!claim.claimed) {
        const winnerIssue = getIssue(projectId, issueId);
        const winner = winnerIssue ? activeFixRows(stmts, projectId, winnerIssue) : null;
        if (winner && !startAnother) {
          res.json({
            cardId: winner.card.id,
            sessionId: winner.session.id,
            agentId: winner.session.agent_id,
            automation: winner.session.finalize_automation || 'manual',
            reused: true,
            issue: serializeLogIssue(winnerIssue ?? issue),
            card: serializeCardForRequest(req, stmts, winner.card.board_id, winner.card),
          });
          return;
        }
        if (startAnother && claim.cardId && claim.sessionId) {
          const replaced = claimIssueFixSession(projectId, issueId, cardId, sessionId, {
            cardId: claim.cardId,
            sessionId: claim.sessionId,
          });
          if (!replaced.claimed) {
            res.status(409).json({ error: 'Fix session is starting; retry shortly' });
            return;
          }
          claim = replaced;
        } else if (isStaleFixClaim(stmts, projectId, claim)) {
          // Compare-and-swap the exact stale winner. If another request
          // replaced it first, this call returns the new winner and we keep
          // the 409 rather than risking two active Fix workflows.
          const replaced = claimIssueFixSession(projectId, issueId, cardId, sessionId, {
            cardId: claim.cardId!,
            sessionId: claim.sessionId!,
          });
          if (replaced.claimed) {
            claim = replaced;
          } else {
            const replacementWinner = getIssue(projectId, issueId);
            const replacementActive = replacementWinner
              ? activeFixRows(stmts, projectId, replacementWinner)
              : null;
            if (replacementActive) {
              res.json({
                cardId: replacementActive.card.id,
                sessionId: replacementActive.session.id,
                agentId: replacementActive.session.agent_id,
                automation: replacementActive.session.finalize_automation || 'manual',
                reused: true,
                issue: serializeLogIssue(replacementWinner ?? issue),
                card: serializeCardForRequest(
                  req,
                  stmts,
                  replacementActive.card.board_id,
                  replacementActive.card,
                ),
              });
              return;
            }
            res.status(409).json({ error: 'Fix session is starting; retry shortly' });
            return;
          }
        } else {
          // Do not replace a claim while its winner is between claim and its
          // main-DB transaction: doing so would permit two active Fix sessions.
          res.status(409).json({ error: 'Fix session is starting; retry shortly' });
          return;
        }
      }

      broadcastAction({
        projectId,
        issueId,
        action: 'fix',
        status: 'in_flight',
        sessionId,
        agentId: agent.id,
        cardId,
      });

      let contextBlock: string;
      try {
        const nowMs = Date.now();
        const records = queryLogRecords({
          projectId,
          fingerprint: issue.fingerprint,
          limit: MAX_CONTEXT_RECORDS,
        }).records;
        const releases = getIssueReleases(issue.id);
        const sourceNames = new Map(listLogSources(projectId).map((s) => [s.id, s.name]));
        contextBlock = buildAuditedLogContextPack({
          action: 'fix',
          actorUserId: ownerUserId,
          nowMs,
          pack: { issue, records, releases, sourceNames },
        }).pack.contextBlock;
      } catch (err) {
        releaseIssueFixSession(projectId, issueId, cardId, sessionId);
        const message = err instanceof Error ? err.message : String(err);
        broadcastAction({
          projectId,
          issueId,
          action: 'fix',
          status: 'failed',
          sessionId,
          agentId: agent.id,
          cardId,
          error: message,
        });
        res.status(500).json({ error: `Failed to prepare fix context: ${message}` });
        return;
      }

      // Context construction is intentionally outside the main DB
      // transaction, so revalidate the logs.db claim immediately before
      // opening that transaction. This prevents a stale/replaced owner from
      // publishing a card after another request won the CAS race.
      if (!ownsIssueFixSessionClaim(projectId, issueId, cardId, sessionId)) {
        broadcastAction({
          projectId,
          issueId,
          action: 'fix',
          status: 'failed',
          sessionId,
          agentId: agent.id,
          cardId,
          error: 'Fix session claim was superseded; retry shortly',
        });
        res.status(409).json({ error: 'Fix session claim was superseded; retry shortly' });
        return;
      }

      const title = `Fix: ${safeSessionTitleFragment(issue)}`;
      const automation =
        getUserProjectDefaultFinalizeAutomation(stmts, ownerUserId, projectId) ?? 'manual';
      let created: { card: KanbanCardRow; session: SessionRow } | null;
      try {
        const db = getDb();
        created = db.transaction(() => {
          // Repeat the ownership check inside the transaction immediately
          // before the first session/card write. The claim is never expired
          // based on elapsed time, so a legitimate slow creator cannot be
          // displaced while this callback is preparing its atomic writes.
          if (!ownsIssueFixSessionClaim(projectId, issueId, cardId, sessionId)) {
            return null;
          }
          const { board, columns } = getOrCreateBoard(stmts, projectId);
          const inProgress = columns.find((c) => c.name.toLowerCase() === 'in progress');
          if (!inProgress) throw new Error('Project board has no In Progress column');
          const todo = columns.find((c) => c.name.toLowerCase() === 'to do') ?? inProgress;
          const existingSource = stmts.getKanbanCardByLogIssueSource.get(projectId, issueId) as
            | KanbanCardRow
            | undefined;
          const existingSourceSession = existingSource?.session_id
            ? (stmts.getSession.get(existingSource.session_id) as SessionRow | undefined)
            : undefined;
          const existingSourceColumn = existingSource
            ? (stmts.getKanbanColumn.get(existingSource.column_id) as KanbanColumnRow | undefined)
            : undefined;
          if (
            !startAnother &&
            existingSource &&
            existingSourceSession &&
            !existingSourceSession.deleted_at &&
            existingSource.session_id === existingSourceSession.id &&
            existingSourceColumn &&
            existingSourceColumn.name.toLowerCase() !== 'done'
          ) {
            throw new Error('An active Fix card already exists for this issue');
          }
          const { engine, model } = resolveEffectiveEngineAndModel(config, {
            agentId: agent.id,
            agentEngine: agent.engine || 'claude-code',
            agentModel: agent.model ?? null,
            ownerUserId,
          });
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
          setSessionOwner(sessionId, ownerUserId);
          markSessionFinalizeAutomation(stmts, sessionId, automation);

          const todoCards = stmts.getKanbanCardsByColumn.all(todo.id) as KanbanCardRow[];
          const todoPosition =
            todoCards.length > 0 ? Math.max(...todoCards.map((card) => card.position)) + 1 : 0;
          const inProgressCards = stmts.getKanbanCardsByColumn.all(
            inProgress.id,
          ) as KanbanCardRow[];
          const position =
            inProgressCards.length > 0
              ? Math.max(...inProgressCards.map((card) => card.position)) + 1
              : 0;
          stmts.createKanbanCard.run(
            cardId,
            todo.id,
            board.id,
            title,
            'Tracked application-error fix. See the linked Fix session for redacted evidence and acceptance criteria.',
            'high',
            agent.name,
            'logs,fix',
            sessionId,
            null,
            ownerUserId,
            null,
            todoPosition,
          );
          const logIssueMeta = JSON.stringify({ fingerprint: issue.fingerprint, projectId });
          try {
            stmts.setKanbanCardProvenance.run('log_issue', issueId, logIssueMeta, cardId);
          } catch (err) {
            // Older installations added source_type with a CHECK constraint
            // before LOG-FIX existed. Preserve the origin triple there using
            // the backwards-compatible manual source plus an explicit kind;
            // fresh databases use the canonical `log_issue` enum value.
            if (!(err instanceof Error && /check constraint/i.test(err.message))) throw err;
            stmts.setKanbanCardProvenance.run(
              'manual',
              issueId,
              JSON.stringify({
                kind: 'log_issue',
                issueId,
                fingerprint: issue.fingerprint,
                projectId,
              }),
              cardId,
            );
          }
          if (ownerUserId) stmts.setKanbanCardAssignedUser.run(ownerUserId, cardId);
          // Keep the transition explicit: the card is created and linked in
          // one transaction, then moved into the active lane before commit.
          stmts.moveKanbanCard.run(inProgress.id, position, cardId);
          return {
            card: stmts.getKanbanCard.get(cardId) as KanbanCardRow,
            session: stmts.getSession.get(sessionId) as SessionRow,
          };
        })();
      } catch (err) {
        releaseIssueFixSession(projectId, issueId, cardId, sessionId);
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to start fix session: ${message}` });
        return;
      }
      if (!created) {
        broadcastAction({
          projectId,
          issueId,
          action: 'fix',
          status: 'failed',
          sessionId,
          agentId: agent.id,
          cardId,
          error: 'Fix session claim was superseded; retry shortly',
        });
        res.status(409).json({ error: 'Fix session claim was superseded; retry shortly' });
        return;
      }

      const content = buildFixSessionContext({
        projectId,
        issueId,
        cardId,
        contextBlock,
      });
      const initialChatMessage = {
        type: 'chat' as const,
        agentId: agent.id,
        sessionId,
        content,
        hookSpecificOutput: { sessionTitle: title },
      };
      const cleanupFailedFix = (err: unknown): void => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Fix] handleChat failed for session ${sessionId}:`, message);
        try {
          getDb().transaction(() => {
            stmts.deleteKanbanCard.run(cardId);
            stmts.deleteSession.run(sessionId);
          })();
        } catch (cleanupErr) {
          console.error(
            `[Fix] failed to delete rejected card/session ${cardId}/${sessionId}:`,
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          );
        }
        releaseIssueFixSession(projectId, issueId, cardId, sessionId);
        broadcast({ type: 'session_deleted', sessionId });
        broadcast({ type: 'kanban_update', projectId });
        broadcast({
          type: 'error',
          agentId: agent.id,
          sessionId,
          message: `Failed to start fix session: ${message}`,
        });
        broadcastAction({
          projectId,
          issueId,
          action: 'fix',
          status: 'failed',
          sessionId,
          agentId: agent.id,
          cardId,
          error: message,
        });
      };
      let initialChat: Promise<void>;
      try {
        initialChat = handleChat(null, initialChatMessage);
      } catch (err) {
        cleanupFailedFix(err);
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to start fix session: ${message}` });
        return;
      }
      void initialChat.catch(cleanupFailedFix);

      broadcast({ type: 'kanban_update', projectId });
      broadcast({
        type: 'session_created',
        agentId: agent.id,
        session: enrichSessionForClient(created.session, stmts),
      });
      broadcastAction({
        projectId,
        issueId,
        action: 'fix',
        status: 'completed',
        sessionId,
        agentId: agent.id,
        cardId,
      });
      res.json({
        cardId,
        sessionId,
        agentId: agent.id,
        automation,
        reused: false,
        issue: serializeLogIssue(getIssue(projectId, issueId) ?? issue),
        card: serializeCardForRequest(req, stmts, created.card.board_id, created.card),
      });
    },
  );

  return router;
}
