import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

export default function createThreadRoutes(deps) {
  const { stmts, broadcast, findProject } = deps;
  const router = Router();

  // GET /api/projects/:projectId/threads — list threads for a project
  router.get('/api/projects/:projectId/threads', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { type } = req.query;
    const threads =
      type && (type === 'cron' || type === 'heartbeat')
        ? stmts.getThreadsByProjectAndType.all(project.id, type)
        : stmts.getThreadsByProject.all(project.id);

    res.json(threads);
  });

  // POST /api/projects/:projectId/threads — create a new thread
  router.post('/api/projects/:projectId/threads', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { name, type, source_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!type || !['cron', 'heartbeat'].includes(type)) {
      return res.status(400).json({ error: 'type must be "cron" or "heartbeat"' });
    }

    const id = uuidv4();
    stmts.createThread.run(id, project.id, name, type, source_id || null);
    const thread = stmts.getThread.get(id);

    broadcast({ type: 'thread_created', projectId: project.id, thread });
    res.status(201).json(thread);
  });

  // GET /api/threads/:threadId — get a single thread
  router.get('/api/threads/:threadId', (req, res) => {
    const thread = stmts.getThread.get(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json(thread);
  });

  // DELETE /api/threads/:threadId — delete a thread and its entries
  router.delete('/api/threads/:threadId', (req, res) => {
    const thread = stmts.getThread.get(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    stmts.deleteThread.run(thread.id);
    broadcast({ type: 'thread_deleted', projectId: thread.project_id, threadId: thread.id });
    res.json({ ok: true });
  });

  // GET /api/threads/:threadId/entries — list entries for a thread
  router.get('/api/threads/:threadId/entries', (req, res) => {
    const thread = stmts.getThread.get(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const entries = stmts.getThreadEntries.all(thread.id);
    res.json(entries);
  });

  // POST /api/threads/:threadId/entries — add an entry to a thread
  router.post('/api/threads/:threadId/entries', (req, res) => {
    const thread = stmts.getThread.get(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const id = uuidv4();
    stmts.createThreadEntry.run(id, thread.id, content);
    const entry = stmts.getThreadEntry.get(id);

    broadcast({ type: 'thread_entry_created', threadId: thread.id, entry });
    res.status(201).json(entry);
  });

  return router;
}
