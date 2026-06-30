import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { RouteDeps, ThreadRow, ThreadEntryRow, SessionRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { defaultSessionUseWorktreeFlag } from '../project-mode.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { enrichSessionForClient } from '../session-checkpoint-rewind.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';

export default function createThreadRoutes(deps: RouteDeps): Router {
  const { stmts, broadcast, findProject, findAgent, handleChat, config } = deps;
  const router = Router();

  // Forwarding a single thread entry shares the same caps as the
  // session-forward route (server/routes/sessions.ts) for consistency.
  const MAX_FORWARD_PROMPT_LENGTH = 50_000;

  router.get('/api/projects/:projectId/threads', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { type } = req.query;
    const threads =
      type && (type === 'cron' || type === 'heartbeat')
        ? stmts.getThreadsByProjectAndType.all(project.id, type)
        : stmts.getThreadsByProject.all(project.id);

    res.json(threads);
  });

  router.post('/api/projects/:projectId/threads', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { name, type, source_id } = req.body as {
      name?: string;
      type?: string;
      source_id?: string;
    };
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!type || !['cron', 'heartbeat'].includes(type)) {
      return res.status(400).json({ error: 'type must be "cron" or "heartbeat"' });
    }

    const id = uuidv4();
    stmts.createThread.run(id, project.id, name, type, source_id || null);
    const thread = stmts.getThread.get(id) as ThreadRow | undefined;

    broadcast({ type: 'thread_created', projectId: project.id, thread });
    res.status(201).json(thread);
  });

  router.get('/api/threads/:threadId', (req: Request, res: Response) => {
    const thread = stmts.getThread.get(req.params.threadId) as ThreadRow | undefined;
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json(thread);
  });

  router.delete('/api/threads/:threadId', (req: Request, res: Response) => {
    const thread = stmts.getThread.get(req.params.threadId) as ThreadRow | undefined;
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    stmts.deleteThread.run(thread.id);
    broadcast({ type: 'thread_deleted', projectId: thread.project_id, threadId: thread.id });
    res.json({ ok: true });
  });

  router.get('/api/threads/:threadId/entries', (req: Request, res: Response) => {
    const thread = stmts.getThread.get(req.params.threadId) as ThreadRow | undefined;
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const entries = stmts.getThreadEntries.all(thread.id);
    res.json(entries);
  });

  // Human chatroom write. Daemons (heartbeat / cron) still write directly
  // to `stmts.createThreadEntry` from inside the server process and never
  // go through this route — so anything that DOES land here is a human
  // (or an explicitly-impersonating script) posting via the composer.
  //
  // We stamp `author_user_id` from `req.authUserId` whenever the auth
  // middleware resolved a concrete user (real multi-user deployments).
  // In single-tenant / dev / Electron mode the middleware short-circuits
  // to a synthetic Owner without a user id; we still accept the post and
  // record `author_user_id = NULL`, role='user'. The composer renders
  // role-styled bubbles regardless of whether an id was attached.
  router.post('/api/threads/:threadId/entries', (req: Request, res: Response) => {
    const thread = stmts.getThread.get(req.params.threadId) as ThreadRow | undefined;
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const { content } = req.body as { content?: string };
    if (typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }

    const areq = req as AuthenticatedRequest;
    const authorUserId = areq.authUserId ?? null;

    const id = uuidv4();
    stmts.createUserThreadEntry.run(id, thread.id, content, authorUserId);
    const entry = stmts.getThreadEntry.get(id);

    broadcast({
      type: 'thread_entry_created',
      threadId: thread.id,
      projectId: thread.project_id,
      threadName: thread.name,
      threadType: thread.type,
      entry,
    });
    res.status(201).json(entry);
  });

  /**
   * POST /api/threads/:threadId/entries/:entryId/forward
   *
   * Forward a single thread entry (one daemon log line or human note) to an
   * agent. Creates a NEW session for the target agent seeded with that entry's
   * content as the initial user message. Unlike the session-forward route,
   * there is no source session — the new session is owned by the caller.
   *
   * Body:
   *   targetAgentId  (required) — agent to forward the entry to
   *   prompt         (optional) — extra instructions prepended to the entry
   *   autoStart      (optional) — if true, immediately dispatch the message to
   *                                the target agent's CLI (fire-and-forget).
   *
   * Returns: { session, forwardedMessageId }
   */
  router.post('/api/threads/:threadId/entries/:entryId/forward', (req: Request, res: Response) => {
    try {
      const thread = stmts.getThread.get(req.params.threadId) as ThreadRow | undefined;
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      const entry = stmts.getThreadEntry.get(req.params.entryId) as ThreadEntryRow | undefined;
      if (!entry || entry.thread_id !== thread.id) {
        return res.status(404).json({ error: 'Thread entry not found' });
      }

      // Source-thread visibility: forwarding materializes the entry content
      // into a caller-owned session, so gate it on the caller being able to
      // view the source thread's project — symmetric with the target check
      // below. Mask an unviewable source as the same 404 a missing thread
      // returns so we don't leak its existence. (The plain GET entries route
      // is currently ungated; this keeps the copy-into-owned-session path from
      // being a wider disclosure surface than the read path.)
      const caller = resolveVisibilityCaller(req as AuthenticatedRequest);
      const sourceProject = findProject(thread.project_id);
      if (!sourceProject || !canViewProject(sourceProject, caller)) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const { targetAgentId, prompt, autoStart } = req.body as {
        targetAgentId?: string;
        prompt?: string;
        autoStart?: boolean;
      };

      if (!targetAgentId) {
        return res.status(400).json({ error: 'targetAgentId is required' });
      }
      if (prompt && prompt.length > MAX_FORWARD_PROMPT_LENGTH) {
        return res.status(400).json({
          error: `prompt exceeds maximum length of ${MAX_FORWARD_PROMPT_LENGTH} characters`,
        });
      }

      // Validate target agent + caller visibility. Mask a hidden target as a
      // 404 (same as a genuinely missing agent) so we don't leak existence of
      // agents in projects the caller cannot see.
      const targetFound = findAgent(targetAgentId);
      if (!targetFound) {
        return res.status(404).json({ error: `Target agent not found: ${targetAgentId}` });
      }
      if (!canViewProject(targetFound.project, caller)) {
        return res.status(404).json({ error: `Target agent not found: ${targetAgentId}` });
      }

      if (autoStart && !handleChat) {
        return res.status(503).json({
          error: 'Auto-start is not available — chat handler is not initialized',
        });
      }

      // Assemble the forwarded message: optional instructions, then the
      // single entry wrapped in a labelled block so the target agent has
      // provenance (which thread / type it came from).
      const parts: string[] = [];
      if (prompt) {
        parts.push(prompt.trim());
        parts.push('');
      }
      parts.push(`--- Forwarded from ${thread.type} thread "${thread.name}" ---`);
      parts.push('');
      parts.push(entry.content);
      parts.push('');
      parts.push('--- End of forwarded message ---');
      const forwardedContent = parts.join('\n');

      const targetAgent = targetFound.agent;
      const newSessionId = uuidv4();
      const truncatedName = `[Fwd] ${thread.name}`.slice(0, 100);
      const engine = targetAgent.engine || 'claude-code';
      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const model = resolveEffectiveModel(config, engine, {
        agentModel: targetAgent.model,
        ownerUserId: ownerUid,
      });
      const useWorktree = defaultSessionUseWorktreeFlag(targetFound.project);
      stmts.createSession.run(
        newSessionId,
        targetAgentId,
        truncatedName,
        engine,
        model,
        useWorktree,
        0,
        1,
      );
      setSessionOwner(newSessionId, ownerUid);

      // When autoStart is true, handleChat stores the user message itself, so
      // we only pre-store it when NOT auto-starting (avoids duplicates).
      let forwardedMessageId: string | null = null;
      if (!autoStart) {
        forwardedMessageId = uuidv4();
        stmts.addMessage.run(
          forwardedMessageId,
          newSessionId,
          'user',
          forwardedContent,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        );
        stmts.touchSession.run(newSessionId);
      }

      const newSession = stmts.getSession.get(newSessionId) as SessionRow;
      const newSessionWire = enrichSessionForClient(newSession, stmts);

      broadcast({
        type: 'session_forwarded',
        sourceThreadId: thread.id,
        sourceEntryId: entry.id,
        targetAgentId,
        session: newSessionWire,
        forwardedMessageId,
      });

      res.status(201).json({ session: newSessionWire, forwardedMessageId });

      // Fire-and-forget after the response is sent, matching the session-forward
      // route (server/routes/sessions.ts). `void` + `.catch` so a rejected
      // dispatch never becomes an unhandled rejection or a post-response throw.
      if (autoStart && handleChat) {
        void handleChat(null, {
          type: 'chat',
          agentId: targetAgentId,
          sessionId: newSessionId,
          content: forwardedContent,
        }).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[forward-thread-entry] handleChat failed for session ${newSessionId}: ${message}`,
          );
        });
      }
    } catch (err) {
      console.error('Forward thread entry error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
