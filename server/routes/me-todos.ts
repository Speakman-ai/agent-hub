/**
 * REST surface for cross-project personal todos (`/api/me/todos`).
 *
 * Every route is scoped to `req.authUserId` — a user only ever sees / mutates
 * their own todos (spec TODO-MODEL). There is NO admin override: a todo is a
 * private capture primitive, so even an org Owner reading another user's todos
 * would be a privilege violation. Foreign / missing ids return 404 (not 403)
 * so they don't leak existence, matching the mcp-servers ownership convention.
 *
 * Endpoints:
 *   GET    /api/me/todos            list (optional ?status=open|done)
 *   POST   /api/me/todos            create (append at end of the user's list)
 *   PUT    /api/me/todos/:id        update (partial: title/notes/status/dueAt)
 *   DELETE /api/me/todos/:id        delete
 *   POST   /api/me/todos/reorder    reassign per-user positions from an id order
 *
 * Every write broadcasts a `user_todo_update` WebSocket event carrying
 * `ownerUserId`; the broadcast filter delivers it only to that owner.
 */

import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';
import {
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  reorderTodos,
  updateTodo,
  type TodoSourceType,
  type TodoStatus,
} from '../user-todos-store.js';

function bad(res: Response, code: number, message: string): void {
  res.status(code).json({ error: message });
}

function parseStatus(v: unknown): TodoStatus | null {
  return v === 'open' || v === 'done' ? v : null;
}

function parseSourceType(v: unknown): TodoSourceType | null {
  return v === 'manual' || v === 'email' || v === 'calendar' ? v : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export default function createMeTodosRoutes(deps: RouteDeps): Router {
  const { broadcast } = deps;
  const router = Router();

  /** Fan a per-user todo mutation out to the owner (broadcast filter enforces). */
  function emitUpdate(
    userId: string,
    action: 'created' | 'updated' | 'deleted' | 'reordered',
  ): void {
    broadcast({ type: 'user_todo_update', ownerUserId: userId, action });
  }

  router.get('/api/me/todos', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const statusRaw = req.query.status;
    if (statusRaw !== undefined) {
      const status = parseStatus(statusRaw);
      if (!status) {
        bad(res, 400, 'status must be "open" or "done"');
        return;
      }
      res.json({ todos: listTodos(areq.authUserId, { status }) });
      return;
    }
    res.json({ todos: listTodos(areq.authUserId) });
  });

  router.post('/api/me/todos', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      bad(res, 400, 'title is required');
      return;
    }

    const notes = typeof body.notes === 'string' ? body.notes : undefined;
    const dueAt =
      body.dueAt === null ? null : typeof body.dueAt === 'string' ? body.dueAt : undefined;

    let sourceType: TodoSourceType | undefined;
    if (body.sourceType !== undefined) {
      const parsed = parseSourceType(body.sourceType);
      if (!parsed) {
        bad(res, 400, 'sourceType must be "manual", "email", or "calendar"');
        return;
      }
      sourceType = parsed;
    }
    const sourceId =
      body.sourceId === null ? null : typeof body.sourceId === 'string' ? body.sourceId : undefined;
    const sourceMeta = isPlainObject(body.sourceMeta) ? body.sourceMeta : undefined;

    try {
      const todo = createTodo({
        userId: areq.authUserId,
        title,
        notes,
        dueAt,
        sourceType,
        sourceId,
        sourceMeta,
      });
      emitUpdate(areq.authUserId, 'created');
      res.status(201).json({ todo });
    } catch (err) {
      bad(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.put('/api/me/todos/:id', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const id = String(req.params.id ?? '');
    // Ownership check up front so foreign ids 404 before any write attempt.
    if (!getTodo(areq.authUserId, id)) {
      bad(res, 404, 'Todo not found');
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateTodo>[2] = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) {
        bad(res, 400, 'title cannot be empty');
        return;
      }
      patch.title = body.title;
    }
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string') {
        bad(res, 400, 'notes must be a string');
        return;
      }
      patch.notes = body.notes;
    }
    if (body.status !== undefined) {
      const status = parseStatus(body.status);
      if (!status) {
        bad(res, 400, 'status must be "open" or "done"');
        return;
      }
      patch.status = status;
    }
    if (body.dueAt !== undefined) {
      if (body.dueAt !== null && typeof body.dueAt !== 'string') {
        bad(res, 400, 'dueAt must be a string or null');
        return;
      }
      patch.dueAt = body.dueAt;
    }

    try {
      const updated = updateTodo(areq.authUserId, id, patch);
      if (!updated) {
        bad(res, 404, 'Todo not found');
        return;
      }
      emitUpdate(areq.authUserId, 'updated');
      res.json({ todo: updated });
    } catch (err) {
      bad(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete('/api/me/todos/:id', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const id = String(req.params.id ?? '');
    if (!deleteTodo(areq.authUserId, id)) {
      bad(res, 404, 'Todo not found');
      return;
    }
    emitUpdate(areq.authUserId, 'deleted');
    res.json({ ok: true });
  });

  router.post('/api/me/todos/reorder', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isStringArray(body.orderedIds)) {
      bad(res, 400, 'orderedIds must be an array of strings');
      return;
    }
    const todos = reorderTodos(areq.authUserId, body.orderedIds);
    emitUpdate(areq.authUserId, 'reordered');
    res.json({ todos });
  });

  return router;
}
