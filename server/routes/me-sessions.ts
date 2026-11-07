/**
 * The caller's sessions across every agent, for surfaces that aren't the web
 * client (the desktop app's WoW bridge reads these):
 *
 *   GET  /api/me/sessions/recent              newest activity first, with state + latest reply
 *   POST /api/me/sessions/:sessionId/reply    run a message as the next turn (queued when busy)
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AuthenticatedRequest } from '../auth.js';
import type { MessageRow, RouteDeps, SessionRow } from '../types.js';
import { getDb } from '../db.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { userOwnsSession } from '../session-ownership.js';
import { isSessionChatBusy } from '../session-chat-busy.js';
import { computeSessionState } from '../session-state.js';
import { isInternalSystemProject } from '../../shared/utils/hub.js';
import {
  IDEMPOTENT_REPLAY_HEADER,
  idempotencyScope,
  lookupIdempotent,
  payloadHash,
  readIdempotencyKey,
  recordIdempotent,
} from '../request-idempotency.js';
import {
  RecentSessionsQuerySchema,
  SessionReplyRequestSchema,
  MAX_RECENT_SESSIONS,
} from './me-sessions.openapi.js';

const REPLY_ROUTE = 'POST /api/me/sessions/:sessionId/reply';
/** How long a request waits for handleChat to store the message before answering 503. */
const ACCEPT_TIMEOUT_MS = 30_000;
const RETRY_AFTER_SECONDS = 30;

// Reply dispatches that haven't yet said whether they stored their message,
// by caller + Idempotency-Key. While one is here a retry must not dispatch
// again: it could still store late. The server is a single process, so a
// dispatch that isn't here (finished, or lost in a restart) can't store
// anything any more, and a key whose message is missing is safe to rerun.
const pendingReplies = new Set<string>();

export interface MeSessionsRouteOptions {
  acceptTimeoutMs?: number;
}

// Over-fetch so rows dropped for visibility don't shrink the page much.
const SCAN_LIMIT = MAX_RECENT_SESSIONS * 4;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default function createMeSessionsRoutes(
  deps: RouteDeps,
  options: MeSessionsRouteOptions = {},
): Router {
  const router = Router();
  const acceptTimeoutMs = options.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS;
  const { stmts, findAgent } = deps;

  router.get('/api/me/sessions/recent', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    const parsed = RecentSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' });
      return;
    }
    const { limit, messages: messageCount, maxChars } = parsed.data;
    const db = getDb();
    const base =
      'SELECT * FROM sessions WHERE deleted_at IS NULL AND hidden = 0 AND sidebar_parent_id IS NULL AND cron_id IS NULL';
    // A signed-in user sees their own sessions. Callers with no per-user
    // identity (local desktop server, break-glass key) own everything, which
    // userOwnsSession reports; anyone else gets nothing.
    let rows: SessionRow[];
    if (areq.authUserId) {
      rows = db
        .prepare(`${base} AND owner_user_id = ? ORDER BY updated_at DESC LIMIT ?`)
        .all(areq.authUserId, SCAN_LIMIT) as SessionRow[];
    } else {
      rows = (
        db.prepare(`${base} ORDER BY updated_at DESC LIMIT ?`).all(SCAN_LIMIT) as SessionRow[]
      ).filter((row) => userOwnsSession(areq, row.id));
    }

    const caller = resolveVisibilityCaller(req);
    const recentMessages = db.prepare(
      `SELECT role, content, created_at FROM messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    );
    const sessions = [];
    for (const row of rows) {
      if (sessions.length >= limit) break;
      const found = findAgent(row.agent_id);
      if (!found || isInternalSystemProject(found.project)) continue;
      if (!canViewProject(found.project, caller)) continue;
      const last = stmts.getLastAssistantMessage.get(row.id) as { content: string } | undefined;
      const msgs =
        messageCount > 0
          ? (recentMessages.all(row.id, messageCount) as Pick<
              MessageRow,
              'role' | 'content' | 'created_at'
            >[])
          : [];
      sessions.push({
        id: row.id,
        name: row.name,
        agentId: row.agent_id,
        agentName: found.agent.name || row.agent_id,
        projectId: found.project.id,
        projectName: found.project.name || found.project.id,
        state: computeSessionState(stmts, row.id),
        updatedAt: row.updated_at,
        lastReply: last?.content ? truncate(last.content, maxChars) : null,
        messages: msgs.reverse().map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: truncate(m.content ?? '', maxChars),
          createdAt: m.created_at,
        })),
      });
    }
    res.json({ sessions });
  });

  router.post('/api/me/sessions/:sessionId/reply', async (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    const sessionId = String(req.params.sessionId);
    const parsed = SessionReplyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    const row = stmts.getSession.get(sessionId) as SessionRow | undefined;
    // 404 for someone else's session too, so ids can't be probed.
    if (!row || row.deleted_at || !userOwnsSession(areq, sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const found = findAgent(row.agent_id);
    if (!found || !canViewProject(found.project, resolveVisibilityCaller(req))) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (!deps.handleChat) {
      res.status(503).json({ error: 'Chat handler is not initialized' });
      return;
    }
    const idem = readIdempotencyKey(req);
    if ('error' in idem) {
      res.status(400).json({ error: idem.error });
      return;
    }
    const content = parsed.data.content;
    const idemScope = idempotencyScope(req);
    const idemHash = payloadHash({ sessionId, content });
    // A repeat replays only once the first attempt's message exists.
    const messageId = uuidv4();
    const pendingKey = idem.key ? `${idemScope}\u0000${idem.key}` : null;
    if (idem.key && pendingKey) {
      const prior = lookupIdempotent(idemScope, REPLY_ROUTE, idem.key, idemHash);
      if (prior.kind === 'mismatch') {
        res
          .status(422)
          .json({ error: 'This Idempotency-Key was already used with a different request' });
        return;
      }
      if (prior.kind === 'replay' && prior.resultId && stmts.getMessageById.get(prior.resultId)) {
        res.set(IDEMPOTENT_REPLAY_HEADER, 'true');
        res.status(202).json({ sessionId, queued: false });
        return;
      }
      if (pendingReplies.has(pendingKey)) {
        res.set('Retry-After', String(RETRY_AFTER_SECONDS));
        res.status(503).json({ error: 'This request is still being processed. Retry shortly.' });
        return;
      }
      recordIdempotent(idemScope, REPLY_ROUTE, idem.key, idemHash, sessionId, messageId);
      pendingReplies.add(pendingKey);
    }
    const queued = isSessionChatBusy(
      sessionId,
      deps.activeProcesses,
      stmts.getActiveTask.get(sessionId) as Parameters<typeof isSessionChatBusy>[2],
    );
    // handleChat reports once whether it stored the message (immediately or
    // in the queue), long before the turn finishes; settling the promise
    // without a report means it didn't. That answer is final, so only then
    // does the key stop counting as pending.
    let reportStored!: (stored: boolean) => void;
    const stored = new Promise<boolean>((resolve) => {
      let settled = false;
      reportStored = (ok) => {
        if (settled) return;
        settled = true;
        if (pendingKey) pendingReplies.delete(pendingKey);
        resolve(ok);
      };
    });
    deps
      .handleChat(null, {
        type: 'chat',
        agentId: row.agent_id,
        sessionId,
        content,
        _userMessageId: messageId,
        _onUserMessagePersisted: (ok) => reportStored(ok),
      })
      .then(
        () => reportStored(false),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[me-sessions] reply to ${sessionId} rejected: ${message}`);
          reportStored(false);
        },
      );
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      stored,
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), acceptTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === 'pending') {
      // Still running: the key stays pending, and a retry replays or reruns
      // once the dispatch has answered.
      res.set('Retry-After', String(RETRY_AFTER_SECONDS));
      res
        .status(503)
        .json({ error: 'The session has not accepted the message yet. Retry shortly.' });
      return;
    }
    if (!outcome) {
      // Confirmed not stored; the key's message is missing, so a retry reruns it.
      res.status(503).json({ error: 'The session did not accept the message. Retry later.' });
      return;
    }
    res.status(202).json({ sessionId, queued });
  });

  return router;
}
