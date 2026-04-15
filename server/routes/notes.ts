import { Router, Request, Response } from 'express';
import { listNotes, getNote, createNote, updateNote, deleteNote, searchNotes } from '../notes.js';
import type { RouteDeps } from '../types.js';

export default function createNoteRoutes({ findProject, broadcast }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/api/projects/:projectId/notes', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (req.query.q) {
      res.json(
        searchNotes(projectId, req.query.q as string, parseInt(req.query.limit as string) || 20),
      );
    } else {
      res.json(listNotes(projectId));
    }
  });

  router.get('/api/projects/:projectId/notes/:noteId', (req: Request, res: Response) => {
    const note = getNote(req.params.noteId as string);
    if (!note || note.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json(note);
  });

  router.post('/api/projects/:projectId/notes', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { title, content } = req.body as { title?: string; content?: string };
    if (!title) return res.status(400).json({ error: 'Title is required' });

    try {
      const note = createNote(projectId, { title, content });
      broadcast({ type: 'note_update', projectId, note });
      res.status(201).json(note);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.put('/api/projects/:projectId/notes/:noteId', (req: Request, res: Response) => {
    const { title, content } = req.body as { title?: string; content?: string };
    try {
      const existing = getNote(req.params.noteId as string);
      if (!existing || existing.project_id !== req.params.projectId) {
        return res.status(404).json({ error: 'Note not found' });
      }
      const note = updateNote(req.params.noteId as string, { title, content });
      broadcast({ type: 'note_update', projectId: req.params.projectId, note });
      res.json(note);
    } catch (err) {
      if ((err as Error).message.includes('not found'))
        return res.status(404).json({ error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/projects/:projectId/notes/:noteId', (req: Request, res: Response) => {
    const note = getNote(req.params.noteId as string);
    if (!note || note.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Note not found' });
    }
    deleteNote(req.params.noteId as string);
    broadcast({
      type: 'note_delete',
      projectId: req.params.projectId,
      noteId: req.params.noteId,
    });
    res.json({ ok: true });
  });

  return router;
}
