import { Router, Request, Response } from 'express';
import {
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  searchNotes,
  setNoteShared,
  canViewNote,
  canManageNote,
  type NoteViewer,
} from '../notes.js';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import { getUserById } from '../users-store.js';
import type { NoteRow, RouteDeps } from '../types.js';

type NoteLike = Pick<NoteRow, 'id' | 'owner_user_id' | 'shared'>;

function viewerOf(req: Request): NoteViewer {
  return { userId: resolveOwnerUserId(req as AuthenticatedRequest) };
}

function ownerUsername(ownerUserId: string | null): string | null {
  if (!ownerUserId) return null;
  try {
    return getUserById(ownerUserId)?.username ?? null;
  } catch {
    return null;
  }
}

/** Decorate a row with the per-caller fields the clients render. */
function toWire<T extends NoteLike>(
  note: T,
  viewer: NoteViewer,
  usernames: Map<string, string | null>,
) {
  const owner = note.owner_user_id ?? null;
  if (owner && !usernames.has(owner)) usernames.set(owner, ownerUsername(owner));
  return {
    ...note,
    owner_user_id: owner,
    owner_username: owner ? (usernames.get(owner) ?? null) : null,
    shared: Boolean(note.shared) || !owner,
    can_manage: canManageNote(note, viewer),
  };
}

export default function createNoteRoutes({ findProject, broadcast }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  /**
   * Note events carry no content: every client refetches on receipt. Private
   * notes are tagged so the WebSocket filter delivers them to the owner only.
   */
  function broadcastNoteUpdate(projectId: string, note: NoteRow): void {
    broadcast({
      type: 'note_update',
      projectId,
      note: { id: note.id },
      ...(note.shared ? {} : { noteShared: false, ownerUserId: note.owner_user_id }),
    });
  }

  function loadVisible(req: Request): NoteRow | null {
    const note = getNote(req.params.noteId as string);
    if (!note || note.project_id !== req.params.projectId) return null;
    return canViewNote(note, viewerOf(req)) ? note : null;
  }

  router.get('/api/projects/:projectId/notes', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const viewer = viewerOf(req);
    const rows = req.query.q
      ? searchNotes(
          projectId,
          req.query.q as string,
          parseInt(req.query.limit as string) || 20,
          viewer,
        )
      : listNotes(projectId, viewer);
    const usernames = new Map<string, string | null>();
    res.json((rows as NoteLike[]).map((row) => toWire(row, viewer, usernames)));
  });

  router.get('/api/projects/:projectId/notes/:noteId', (req: Request, res: Response) => {
    const note = loadVisible(req);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json(toWire(note, viewerOf(req), new Map()));
  });

  router.post('/api/projects/:projectId/notes', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { title, content, shared } = req.body as {
      title?: string;
      content?: string;
      shared?: boolean;
    };
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (shared !== undefined && typeof shared !== 'boolean') {
      return res.status(400).json({ error: 'shared must be a boolean' });
    }

    const viewer = viewerOf(req);
    try {
      const note = createNote(projectId, { title, content, ownerUserId: viewer.userId, shared });
      broadcastNoteUpdate(projectId, note);
      res.status(201).json(toWire(note, viewer, new Map()));
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.put('/api/projects/:projectId/notes/:noteId', (req: Request, res: Response) => {
    const { title, content, shared } = req.body as {
      title?: string;
      content?: string;
      shared?: boolean;
    };
    if (shared !== undefined && typeof shared !== 'boolean') {
      return res.status(400).json({ error: 'shared must be a boolean' });
    }
    const projectId = req.params.projectId as string;
    const noteId = req.params.noteId as string;
    const viewer = viewerOf(req);
    try {
      const existing = loadVisible(req);
      if (!existing) return res.status(404).json({ error: 'Note not found' });

      const visibilityChange = shared !== undefined && shared !== Boolean(existing.shared);
      if (visibilityChange && !canManageNote(existing, viewer)) {
        return res.status(403).json({ error: 'Only the note owner can change its visibility' });
      }
      if (visibilityChange && !shared && !existing.owner_user_id && !viewer.userId) {
        return res.status(400).json({ error: 'A private note needs a signed-in owner' });
      }

      let note =
        title !== undefined || content !== undefined
          ? updateNote(noteId, { title, content })
          : existing;
      if (visibilityChange) {
        note = setNoteShared(noteId, shared as boolean, viewer.userId);
        // Untagged so it reaches every project member: teammates refetch and
        // either pick up the newly shared note or drop the now-private one.
        broadcast({ type: 'note_update', projectId, note: { id: noteId } });
      } else {
        broadcastNoteUpdate(projectId, note);
      }
      res.json(toWire(note, viewer, new Map()));
    } catch (err) {
      if ((err as Error).message.includes('not found'))
        return res.status(404).json({ error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/projects/:projectId/notes/:noteId', (req: Request, res: Response) => {
    const note = loadVisible(req);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!canManageNote(note, viewerOf(req))) {
      return res.status(403).json({ error: 'Only the note owner can delete it' });
    }
    deleteNote(note.id);
    broadcast({
      type: 'note_delete',
      projectId: req.params.projectId,
      noteId: note.id,
      ...(note.shared ? {} : { noteShared: false, ownerUserId: note.owner_user_id }),
    });
    res.json({ ok: true });
  });

  return router;
}
