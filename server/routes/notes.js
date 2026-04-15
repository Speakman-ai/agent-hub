import { Router } from 'express';
import { listNotes, getNote, createNote, updateNote, deleteNote, searchNotes } from '../notes.js';

export default function createNoteRoutes({ findProject, broadcast }) {
  const router = Router({ mergeParams: true });

  // List notes (with optional search)
  router.get('/api/projects/:projectId/notes', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (req.query.q) {
      res.json(searchNotes(req.params.projectId, req.query.q, parseInt(req.query.limit) || 20));
    } else {
      res.json(listNotes(req.params.projectId));
    }
  });

  // Get a single note
  router.get('/api/projects/:projectId/notes/:noteId', (req, res) => {
    const note = getNote(req.params.noteId);
    if (!note || note.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json(note);
  });

  // Create a note
  router.post('/api/projects/:projectId/notes', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { title, content } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    try {
      const note = createNote(req.params.projectId, { title, content });
      broadcast({ type: 'note_update', projectId: req.params.projectId, note });
      res.status(201).json(note);
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  // Update a note
  router.put('/api/projects/:projectId/notes/:noteId', (req, res) => {
    const { title, content } = req.body;
    try {
      const note = updateNote(req.params.noteId, { title, content });
      if (note.project_id !== req.params.projectId) {
        return res.status(404).json({ error: 'Note not found' });
      }
      broadcast({ type: 'note_update', projectId: req.params.projectId, note });
      res.json(note);
    } catch (err) {
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a note
  router.delete('/api/projects/:projectId/notes/:noteId', (req, res) => {
    const deleted = deleteNote(req.params.noteId);
    if (!deleted) return res.status(404).json({ error: 'Note not found' });
    broadcast({
      type: 'note_delete',
      projectId: req.params.projectId,
      noteId: req.params.noteId,
    });
    res.json({ ok: true });
  });

  return router;
}
