/**
 * REST surface for shared, organization-wide todos (`/api/orgs/:orgId/todos`).
 *
 * The team-visible counterpart to `/api/me/todos`. Unlike personal todos, an
 * org todo has NO per-user ownership: every member of the org may list, create,
 * update, delete, and reorder the same shared list (that is the whole point —
 * one list everyone sees). This is a distinct list, NOT an aggregation of
 * members' personal todos.
 *
 * Access: the caller must be a member of `:orgId` (any role). The global
 * apiKey break-glass, the local-bundled single-tenant bypass, and the
 * no-auth-configured dev mode are all allowed through, matching the rest of the
 * org routes. A non-member gets 403; an unknown org gets 404.
 *
 * Endpoints:
 *   GET    /api/orgs/:orgId/todos          list (optional ?status=open|done)
 *   POST   /api/orgs/:orgId/todos          create (append at end of the list)
 *   PUT    /api/orgs/:orgId/todos/:id      update (partial)
 *   DELETE /api/orgs/:orgId/todos/:id      delete
 *   POST   /api/orgs/:orgId/todos/reorder  reassign per-org positions
 *
 * Every write broadcasts an `org_todo_update` WebSocket event carrying the
 * `orgId`; the broadcast filter delivers it to every member of that org.
 */

import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { getAuthRecord } from '../auth-store.js';
import config from '../config.js';
import { getMembershipRole } from '../memberships-store.js';
import { getActiveOrgId, getOrg } from '../orgs.js';
import type { RouteDeps } from '../types.js';
import {
  createOrgTodo,
  deleteOrgTodo,
  getOrgTodo,
  listOrgTodos,
  reorderOrgTodos,
  updateOrgTodo,
  type OrgTodoPriority,
  type OrgTodoStatus,
} from '../org-todos-store.js';

function bad(res: Response, code: number, message: string): void {
  res.status(code).json({ error: message });
}

function authIsConfigured(): boolean {
  return Boolean(getAuthRecord()) || Boolean(config.apiKey);
}

function parseStatus(v: unknown): OrgTodoStatus | null {
  return v === 'open' || v === 'done' ? v : null;
}

function parsePriority(v: unknown): OrgTodoPriority | null {
  return v === 'urgent' || v === 'high' || v === 'medium' || v === 'low' ? v : null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * A scheduling date/time field (do_date / do_start_at / do_end_at). `undefined`
 * means the caller omitted it; `null` clears it; a string must parse as a date.
 */
type DateFieldResult = { ok: true; value: string | null | undefined } | { ok: false };

function parseDateField(v: unknown): DateFieldResult {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v))) {
    return { ok: true, value: v };
  }
  return { ok: false };
}

export default function createOrgTodosRoutes(deps: RouteDeps): Router {
  const { broadcast } = deps;
  const router = Router();

  /** Fan an org-todo mutation out to every member of the org (filter enforces). */
  function emitUpdate(
    orgId: string,
    action: 'created' | 'updated' | 'deleted' | 'reordered',
  ): void {
    broadcast({ type: 'org_todo_update', orgId, action });
  }

  /**
   * Resolve the `:orgId` param, confirm it exists, and enforce that the caller
   * is a member of it. Returns the org id on success, or writes an error
   * response and returns null. apiKey / local-bundled / no-auth callers pass.
   */
  function requireOrgMember(req: Request, res: Response): string | null {
    const areq = req as AuthenticatedRequest;
    const rawOrgId = String(req.params.orgId ?? '');
    // `:orgId = 'active'` is the alias remote-org clients send (their local org
    // id doesn't exist on this server) — resolve it to the server's active org,
    // matching the dashboard route. Todos then key off the concrete org id.
    const orgId = rawOrgId === 'active' ? getActiveOrgId() : rawOrgId;
    if (!getOrg(orgId)) {
      bad(res, 404, 'Org not found');
      return null;
    }
    if (authIsConfigured() && !areq.authViaApiKey && !areq.authLocalOrgBypass) {
      if (!areq.authUserId) {
        bad(res, 401, 'Authentication required');
        return null;
      }
      if (!getMembershipRole(areq.authUserId, orgId)) {
        bad(res, 403, 'Membership of this org required');
        return null;
      }
    }
    return orgId;
  }

  function callerUserId(req: Request): string | null {
    return (req as AuthenticatedRequest).authUserId ?? null;
  }

  router.get('/api/orgs/:orgId/todos', (req: Request, res: Response) => {
    const orgId = requireOrgMember(req, res);
    if (!orgId) return;
    const statusRaw = req.query.status;
    if (statusRaw !== undefined) {
      const status = parseStatus(statusRaw);
      if (!status) {
        bad(res, 400, 'status must be "open" or "done"');
        return;
      }
      res.json({ todos: listOrgTodos(orgId, { status }) });
      return;
    }
    res.json({ todos: listOrgTodos(orgId) });
  });

  router.post('/api/orgs/:orgId/todos', (req: Request, res: Response) => {
    const orgId = requireOrgMember(req, res);
    if (!orgId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      bad(res, 400, 'title is required');
      return;
    }

    const notes = typeof body.notes === 'string' ? body.notes : undefined;

    let priority: OrgTodoPriority | undefined;
    if (body.priority !== undefined) {
      const parsed = parsePriority(body.priority);
      if (!parsed) {
        bad(res, 400, 'priority must be "urgent", "high", "medium", or "low"');
        return;
      }
      priority = parsed;
    }

    const doDate = parseDateField(body.doDate);
    if (!doDate.ok) {
      bad(res, 400, 'doDate must be an ISO date string or null');
      return;
    }
    const doStartAt = parseDateField(body.doStartAt);
    if (!doStartAt.ok) {
      bad(res, 400, 'doStartAt must be an ISO date string or null');
      return;
    }
    const doEndAt = parseDateField(body.doEndAt);
    if (!doEndAt.ok) {
      bad(res, 400, 'doEndAt must be an ISO date string or null');
      return;
    }

    try {
      const todo = createOrgTodo({
        orgId,
        title,
        notes,
        priority,
        doDate: doDate.value,
        doStartAt: doStartAt.value,
        doEndAt: doEndAt.value,
        createdByUserId: callerUserId(req),
      });
      emitUpdate(orgId, 'created');
      res.status(201).json({ todo });
    } catch (err) {
      bad(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.put('/api/orgs/:orgId/todos/:id', (req: Request, res: Response) => {
    const orgId = requireOrgMember(req, res);
    if (!orgId) return;
    const id = String(req.params.id ?? '');
    if (!getOrgTodo(orgId, id)) {
      bad(res, 404, 'Todo not found');
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateOrgTodo>[2] = {};
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
    if (body.priority !== undefined) {
      const priority = parsePriority(body.priority);
      if (!priority) {
        bad(res, 400, 'priority must be "urgent", "high", "medium", or "low"');
        return;
      }
      patch.priority = priority;
    }
    if (body.doDate !== undefined) {
      const doDate = parseDateField(body.doDate);
      if (!doDate.ok) {
        bad(res, 400, 'doDate must be an ISO date string or null');
        return;
      }
      patch.doDate = doDate.value;
    }
    if (body.doStartAt !== undefined) {
      const doStartAt = parseDateField(body.doStartAt);
      if (!doStartAt.ok) {
        bad(res, 400, 'doStartAt must be an ISO date string or null');
        return;
      }
      patch.doStartAt = doStartAt.value;
    }
    if (body.doEndAt !== undefined) {
      const doEndAt = parseDateField(body.doEndAt);
      if (!doEndAt.ok) {
        bad(res, 400, 'doEndAt must be an ISO date string or null');
        return;
      }
      patch.doEndAt = doEndAt.value;
    }

    try {
      const updated = updateOrgTodo(orgId, id, patch);
      if (!updated) {
        bad(res, 404, 'Todo not found');
        return;
      }
      emitUpdate(orgId, 'updated');
      res.json({ todo: updated });
    } catch (err) {
      bad(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete('/api/orgs/:orgId/todos/:id', (req: Request, res: Response) => {
    const orgId = requireOrgMember(req, res);
    if (!orgId) return;
    const id = String(req.params.id ?? '');
    if (!deleteOrgTodo(orgId, id)) {
      bad(res, 404, 'Todo not found');
      return;
    }
    emitUpdate(orgId, 'deleted');
    res.json({ ok: true });
  });

  router.post('/api/orgs/:orgId/todos/reorder', (req: Request, res: Response) => {
    const orgId = requireOrgMember(req, res);
    if (!orgId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isStringArray(body.orderedIds)) {
      bad(res, 400, 'orderedIds must be an array of strings');
      return;
    }
    const todos = reorderOrgTodos(orgId, body.orderedIds);
    emitUpdate(orgId, 'reordered');
    res.json({ todos });
  });

  return router;
}
