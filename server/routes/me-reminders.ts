/**
 * Personal reminders (`/api/me/reminders`).
 *
 * The caller is resolved the same way as the Google proxy routes: a JWT /
 * `ahub_*` / `spawn:<id>` identity, else the owner of the session named by the
 * break-glass `X-Agent-Hub-Session-Id` header. That is what lets an agent in a
 * session set a reminder for the human who owns the session. Foreign ids 404.
 *
 * Create mirrors the reminder onto the owner's Google Calendar when connected
 * (`calendar: 'none'` opts out). Every write broadcasts `reminder_update` to
 * the owner so open Reminders panes refresh.
 */
import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { AGENT_HUB_SESSION_ID_HEADER } from '../kanban-caller-session.js';
import {
  mirrorReminderToCalendar,
  INSERT_LEASE_MS,
  processCalendarCleanup,
  runReminderCalendarEffect,
  type ReminderCalendarDeps,
} from '../reminders-calendar.js';
import { broadcastReminderUpdate } from '../reminders-scheduler.js';
import {
  REMINDER_STATUSES,
  createReminder,
  deleteReminder,
  getReminder,
  listReminders,
  normalizeRemindAt,
  updateReminder,
  type ReminderStatus,
} from '../reminders-store.js';
import type { RouteDeps, SessionRow } from '../types.js';
import {
  CreateReminderRequestSchema,
  ListRemindersQuerySchema,
  UpdateReminderRequestSchema,
} from './me-reminders.openapi.js';

/** A create may land slightly in the past (clock skew, slow agent turn). */
const PAST_GRACE_MS = 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface MeRemindersRouteOptions {
  calendar?: Partial<ReminderCalendarDeps>;
  now?: () => Date;
}

function bad(res: Response, code: number, message: string): void {
  res.status(code).json({ error: message });
}

function firstIssue(err: { issues: Array<{ message: string }> }): string {
  return err.issues[0]?.message || 'Invalid request';
}

interface SessionContext {
  session: SessionRow;
  /** True when the session came from agent credentials rather than the body. */
  fromAgent: boolean;
}

/**
 * The session to attribute a new reminder to. Only a session the caller owns
 * counts; anything else is ignored rather than rejected so a stale header
 * can't block the reminder itself.
 */
function resolveSessionContext(
  req: Request,
  deps: RouteDeps,
  uid: string,
  bodySessionId: string | undefined,
): SessionContext | null {
  const authed = req as AuthenticatedRequest;
  const agentSessionId =
    authed.authSpawnSessionId?.trim() || req.get(AGENT_HUB_SESSION_ID_HEADER)?.trim() || '';
  const sessionId = agentSessionId || bodySessionId?.trim() || '';
  if (!sessionId) return null;
  const session = deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!session || session.owner_user_id !== uid) return null;
  return { session, fromAgent: !!agentSessionId };
}

function parseStatuses(raw: string | undefined): ReminderStatus[] | null {
  if (raw === undefined || raw === '') return ['pending', 'fired'];
  if (raw === 'all') return [...REMINDER_STATUSES];
  const parts = raw.split(',').map((s) => s.trim());
  return parts.every((p) => (REMINDER_STATUSES as readonly string[]).includes(p))
    ? (parts as ReminderStatus[])
    : null;
}

export default function createMeRemindersRoutes(
  deps: RouteDeps,
  opts: MeRemindersRouteOptions = {},
): Router {
  const router = Router();
  const now = opts.now ?? (() => new Date());
  const calendarDeps = (): ReminderCalendarDeps => ({
    googleOAuth: deps.config.googleOAuth,
    broadcast: deps.broadcast,
    ...opts.calendar,
  });

  const requireUser = (req: Request, res: Response): string | null => {
    const uid = resolveGoogleConnectionUserId(req, deps.stmts);
    if (!uid) {
      bad(res, 401, 'Authentication required');
      return null;
    }
    return uid;
  };

  router.get('/api/me/reminders', (req: Request, res: Response) => {
    const uid = requireUser(req, res);
    if (!uid) return;
    const query = ListRemindersQuerySchema.safeParse(req.query);
    if (!query.success) return bad(res, 400, firstIssue(query.error));
    const status = parseStatuses(query.data.status);
    if (!status) return bad(res, 400, 'status must be pending, fired, dismissed, or all');
    res.json({ reminders: listReminders(uid, { status, sessionId: query.data.sessionId }) });
  });

  router.post('/api/me/reminders', async (req: Request, res: Response) => {
    const uid = requireUser(req, res);
    if (!uid) return;
    const parsed = CreateReminderRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const body = parsed.data;
    const at = now();
    let remindAt: string | null;
    if (body.inMinutes !== undefined) {
      remindAt = new Date(at.getTime() + body.inMinutes * MINUTE_MS).toISOString();
    } else {
      remindAt = normalizeRemindAt(body.remindAt);
      if (!remindAt)
        return bad(
          res,
          400,
          'remindAt must be an RFC 3339 date-time with an offset or Z, e.g. 2026-10-17T09:00:00-07:00',
        );
      if (Date.parse(remindAt) < at.getTime() - PAST_GRACE_MS) {
        return bad(res, 400, 'remindAt must be in the future');
      }
    }

    const ctx = resolveSessionContext(req, deps, uid, body.sessionId);
    const agentId = ctx?.session.agent_id ?? null;
    const projectId = agentId ? (deps.findAgent(agentId)?.project.id ?? null) : null;
    const created = createReminder({
      userId: uid,
      title: body.title,
      notes: body.notes,
      remindAt,
      createdBy: ctx?.fromAgent ? 'agent' : 'user',
      sessionId: ctx?.session.id ?? null,
      agentId,
      projectId,
      now: at,
    });
    let reminder = created;
    if (body.calendar !== 'none') {
      const mirrored = await mirrorReminderToCalendar(created, calendarDeps(), at);
      // A DELETE landed while the calendar insert ran. It already broadcast
      // `deleted`; announcing `created` now would bring the reminder back in
      // every open client.
      if (mirrored.kind === 'deleted') {
        return bad(res, 410, 'Reminder was deleted before it finished saving');
      }
      reminder = mirrored.reminder;
    }
    broadcastReminderUpdate(deps.broadcast, 'created', reminder);
    res.status(201).json({ reminder });
  });

  router.patch('/api/me/reminders/:id', async (req: Request, res: Response) => {
    const uid = requireUser(req, res);
    if (!uid) return;
    const parsed = UpdateReminderRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const body = parsed.data;
    const id = String(req.params.id);
    const existing = getReminder(uid, id);
    if (!existing) return bad(res, 404, 'Reminder not found');

    const at = now();
    let remindAt: string | undefined;
    if (body.snoozeMinutes !== undefined) {
      remindAt = new Date(at.getTime() + body.snoozeMinutes * MINUTE_MS).toISOString();
    } else if (body.remindAt !== undefined) {
      const normalized = normalizeRemindAt(body.remindAt);
      if (!normalized)
        return bad(
          res,
          400,
          'remindAt must be an RFC 3339 date-time with an offset or Z, e.g. 2026-10-17T09:00:00-07:00',
        );
      remindAt = normalized;
    }
    const result = updateReminder(uid, id, {
      title: body.title,
      notes: body.notes,
      remindAt,
      status: body.status,
      now: at,
      insertLeaseMs: INSERT_LEASE_MS,
    });
    if (!result) return bad(res, 404, 'Reminder not found');
    // Dismissing, re-arming and editing all decide the calendar outcome in
    // the store transaction; this only carries it out.
    const reminder = await runReminderCalendarEffect(
      result.reminder,
      result.calendar,
      calendarDeps(),
      at,
    );
    // Deleted while the calendar work ran: same rule as create.
    if (!reminder) return bad(res, 404, 'Reminder not found');
    broadcastReminderUpdate(deps.broadcast, 'updated', reminder);
    res.json({ reminder });
  });

  router.delete('/api/me/reminders/:id', async (req: Request, res: Response) => {
    const uid = requireUser(req, res);
    if (!uid) return;
    const existing = getReminder(uid, String(req.params.id));
    if (!existing) return bad(res, 404, 'Reminder not found');
    const { deleted, cleanup } = deleteReminder(uid, existing.id, now());
    if (!deleted) return bad(res, 404, 'Reminder not found');
    // The cleanup row is already durable; if this attempt fails the
    // scheduler retries it, so the event is never silently orphaned.
    let calendarCleanup: 'none' | 'done' | 'pending' = 'none';
    if (cleanup) {
      calendarCleanup = (await processCalendarCleanup(cleanup, calendarDeps(), now()))
        ? 'done'
        : 'pending';
    }
    broadcastReminderUpdate(deps.broadcast, 'deleted', existing);
    res.json({ ok: true, calendarCleanup });
  });

  return router;
}
