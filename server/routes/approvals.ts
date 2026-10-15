/**
 * /api/me/approvals — a human answers the approvals their agents asked for,
 * and manages the always-allow rules those answers saved.
 *
 * An approval belongs to the owner of the session that raised it; only that
 * user may read or answer it. A request from a session with no owner can be
 * answered by an Admin or Owner. Agents must never answer their own
 * approvals, so calls made with agent credentials (the global API key, a
 * per-session spawn key, or the `X-Agent-Hub-Session-Id` header the bundled
 * wrappers send) are refused.
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { hasAtLeastRole } from '../roles.js';
import { AGENT_HUB_SESSION_ID_HEADER } from '../kanban-caller-session.js';
import {
  ANY_APPROVAL_ACTION,
  deleteApprovalRuleForUser,
  getApprovalRequest,
  listApprovalRequestsForUser,
  listApprovalRulesForUser,
  saveApprovalRule,
  type ApprovalRequest,
  type ApprovalStatus,
} from '../approvals-store.js';
import {
  answerApprovalRequest,
  isApprovalDecision,
  normalizeApprovalAction,
  serializeApproval,
} from '../approval-requests.js';
import { getBrowserProfileForUser } from '../browser-profiles-store.js';
import { normalizeBrowserLoginDomain } from '../browser-login-handoff.js';

const STATUSES: readonly ApprovalStatus[] = ['pending', 'allowed', 'denied', 'cancelled'];

/** Agent credentials: the global API key, a spawn key, or the wrapper's session header. */
export function isAgentCaller(req: Request): boolean {
  const r = req as AuthenticatedRequest;
  return !!(r.authViaApiKey || r.authSpawnSessionId || req.get(AGENT_HUB_SESSION_ID_HEADER));
}

export default function createApprovalsRoutes(): Router {
  const router = Router();

  /** The human caller's user id, or null after sending the error response. */
  function human(req: Request, res: Response): string | null {
    if (isAgentCaller(req)) {
      res.status(403).json({ error: 'Approvals must be answered by a person, not an agent' });
      return null;
    }
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return userId;
  }

  function visibleApproval(req: Request, res: Response, userId: string): ApprovalRequest | null {
    const a = getApprovalRequest(String(req.params.approvalId ?? ''));
    const role = (req as AuthenticatedRequest).authRole;
    const allowed = a && (a.userId ? a.userId === userId : hasAtLeastRole(role, 'Admin'));
    if (!a || !allowed) {
      res.status(404).json({ error: 'Approval not found' });
      return null;
    }
    return a;
  }

  router.get('/api/me/approvals', (req: Request, res: Response) => {
    const userId = human(req, res);
    if (!userId) return;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !STATUSES.includes(status as ApprovalStatus)) {
      res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const approvals = listApprovalRequestsForUser(userId, {
      status: status as ApprovalStatus | undefined,
      sessionId,
    });
    res.json({ approvals: approvals.map(serializeApproval) });
  });

  router.get('/api/me/approvals/:approvalId', (req: Request, res: Response) => {
    const userId = human(req, res);
    if (!userId) return;
    const a = visibleApproval(req, res, userId);
    if (a) res.json(serializeApproval(a));
  });

  router.post('/api/me/approvals/:approvalId/answer', (req: Request, res: Response) => {
    const userId = human(req, res);
    if (!userId) return;
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (!isApprovalDecision(decision)) {
      res.status(400).json({ error: 'decision must be allow_once, always_allow or deny' });
      return;
    }
    const a = visibleApproval(req, res, userId);
    if (!a) return;
    const result = answerApprovalRequest(a.id, decision, userId);
    if (!result.ok) {
      if (result.code === 'not_found') {
        res.status(404).json({ error: 'Approval not found' });
        return;
      }
      res.status(409).json({
        error:
          result.code === 'expired'
            ? 'This approval expired and was denied'
            : 'This approval was already answered or is no longer waiting',
        approval: result.approval ? serializeApproval(result.approval) : undefined,
      });
      return;
    }
    res.json({ approval: serializeApproval(result.approval), ruleId: result.rule?.id ?? null });
  });

  router.get('/api/me/approval-rules', (req: Request, res: Response) => {
    const userId = human(req, res);
    if (!userId) return;
    res.json({ rules: listApprovalRulesForUser(userId) });
  });

  router.post('/api/me/approval-rules', (req: Request, res: Response) => {
    const userId = human(req, res);
    if (!userId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const effect = body.effect ?? 'require';
    if (effect !== 'allow' && effect !== 'require') {
      res.status(400).json({ error: 'effect must be allow or require' });
      return;
    }
    const domain = normalizeBrowserLoginDomain(body.domain);
    if (!domain) {
      res.status(400).json({ error: 'domain must be a hostname such as example.com' });
      return;
    }
    const action =
      body.action === ANY_APPROVAL_ACTION
        ? ANY_APPROVAL_ACTION
        : normalizeApprovalAction(body.action);
    if (!action || (action === ANY_APPROVAL_ACTION && effect !== 'require')) {
      res.status(400).json({
        error: 'action must be a verb such as click, type or send ("*" only for require rules)',
      });
      return;
    }
    const profile = getBrowserProfileForUser(userId, String(body.profileId ?? ''));
    if (!profile) {
      res.status(404).json({ error: 'Browser profile not found' });
      return;
    }
    const rule = saveApprovalRule({ profileId: profile.id, userId, domain, action, effect });
    res.status(201).json({ rule });
  });

  router.delete('/api/me/approval-rules/:ruleId', (req: Request, res: Response) => {
    const userId = human(req, res);
    if (!userId) return;
    if (!deleteApprovalRuleForUser(userId, String(req.params.ruleId ?? ''))) {
      res.status(404).json({ error: 'Approval rule not found' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
