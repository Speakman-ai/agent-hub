/**
 * Per-user session folders. Folders and filing are scoped to the caller, so
 * there is no route that reads or writes another user's folders.
 */
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps, SessionRow } from '../types.js';
import { userOwnsSession } from '../session-ownership.js';
import {
  createSessionFolder,
  deleteSessionFolder,
  getSessionFolder,
  listSessionFolders,
  renameSessionFolder,
  setSessionFolder,
} from '../session-folders-store.js';
import {
  CreateSessionFolderRequestSchema,
  RenameSessionFolderRequestSchema,
  SetSessionFolderRequestSchema,
} from './session-folders.openapi.js';

/**
 * Callers without a per-user identity (auth disabled, break-glass API key,
 * the local single-tenant bundle) already passed the auth middleware as
 * full-privilege callers; they share one folder set.
 */
export const SHARED_FOLDER_OWNER = 'local';

function folderOwner(req: Request): string {
  return (req as AuthenticatedRequest).authUserId || SHARED_FOLDER_OWNER;
}

function parse<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  res.status(400).json({ error: `${where}${issue?.message ?? 'Invalid body'}` });
  return null;
}

export default function createSessionFolderRoutes(deps: RouteDeps): Router {
  const { stmts, findAgent } = deps;
  const router = Router();

  router.get('/api/agents/:agentId/session-folders', (req: Request, res: Response) => {
    const agentId = String(req.params.agentId);
    if (!findAgent(agentId)) return res.status(404).json({ error: 'Agent not found' });
    res.json(listSessionFolders(folderOwner(req), agentId));
  });

  router.post('/api/agents/:agentId/session-folders', (req: Request, res: Response) => {
    const agentId = String(req.params.agentId);
    if (!findAgent(agentId)) return res.status(404).json({ error: 'Agent not found' });
    const body = parse(CreateSessionFolderRequestSchema, req, res);
    if (!body) return;
    res.status(201).json({ folder: createSessionFolder(folderOwner(req), agentId, body.name) });
  });

  router.patch('/api/session-folders/:folderId', (req: Request, res: Response) => {
    const body = parse(RenameSessionFolderRequestSchema, req, res);
    if (!body) return;
    const folder = renameSessionFolder(folderOwner(req), String(req.params.folderId), body.name);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    res.json({ folder });
  });

  router.delete('/api/session-folders/:folderId', (req: Request, res: Response) => {
    if (!deleteSessionFolder(folderOwner(req), String(req.params.folderId))) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    res.json({ ok: true });
  });

  router.put('/api/sessions/:sessionId/folder', (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId);
    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (
      !session ||
      session.deleted_at ||
      !userOwnsSession(req as AuthenticatedRequest, sessionId)
    ) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const body = parse(SetSessionFolderRequestSchema, req, res);
    if (!body) return;
    const owner = folderOwner(req);
    if (body.folderId !== null) {
      const folder = getSessionFolder(owner, body.folderId);
      if (!folder || folder.agentId !== session.agent_id) {
        return res.status(404).json({ error: 'Folder not found' });
      }
    }
    setSessionFolder(owner, sessionId, body.folderId);
    res.json({ sessionId, folderId: body.folderId });
  });

  return router;
}
