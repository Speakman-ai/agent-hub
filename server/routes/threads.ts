import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { RouteDeps, ThreadRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

export default function createThreadRoutes(deps: RouteDeps): Router {
  const { stmts, broadcast, findProject } = deps;
  const router = Router();

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

  return router;
}
