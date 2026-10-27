/**
 * Project chat triggers: `/api/projects/:projectId/chat-triggers`. Each trigger
 * routes one project event into a chat channel (`chat-trigger-router.ts` does
 * the posting). Schemas: `project-chat-triggers.openapi.ts`.
 *
 * Access:
 *   - The project visibility gate already ran; the caller can view the project.
 *   - The caller is a Hub user in the active org (same identity rules as chat).
 *   - A destination must be a channel or group in that org the caller belongs
 *     to, so nobody can route into a channel they cannot read. Listing shows a
 *     trigger's destination only to its members.
 *   - Anyone who can view the project may list and create. Only the creator
 *     may change a trigger's event, filter, channel or Google Chat space; the
 *     creator or an org Owner/Admin may enable, disable or delete it.
 *   - A Google Chat space posts through the creator's own Google account, so
 *     setting one needs the caller's Google connection with Chat send access,
 *     and the space id is shown to the creator only.
 */

import { Router, type Request, type Response } from 'express';
import type { z } from '../openapi/registry.js';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { getMembershipRole } from '../memberships-store.js';
import { getChatConnectionStatus } from '../google-chat-account.js';
import { hasChatMessagesCreateScope } from '../google-scopes.js';
import { getActiveOrgId } from '../orgs.js';
import { isInternalSystemProject } from '../../shared/utils/hub.js';
import { getDb } from '../db.js';
import { createChannel, getChannel, getMember, listMembers } from '../hub-chat-store.js';
import { HUB_CHAT_CHANNEL_UPDATE_EVENT, recipientsOf } from '../hub-chat-events.js';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggersForProject,
  parseTriggerFilter,
  updateTrigger,
  type ChatTriggerRow,
} from '../chat-triggers-store.js';
import {
  CHAT_TRIGGER_EVENT_INFO,
  defaultTriggerChannelName,
  type ChatTriggerEvent,
  type ChatTriggerFilter,
} from '../../shared/utils/chatTriggers.js';
import {
  CreateChatTriggerRequestSchema,
  UpdateChatTriggerRequestSchema,
} from './project-chat-triggers.openapi.js';
import type { HubChatChannelRow, Project, RouteDeps } from '../types.js';

const DESTINATION_KINDS = new Set(['channel', 'trigger', 'group']);

function bad(res: Response, status: number, error: string, code?: string): void {
  res.status(status).json(code ? { error, code } : { error });
}

function parse<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  res: Response,
): z.infer<T> | null {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  bad(res, 400, r.error.issues[0]?.message || 'Invalid request', 'invalid_request');
  return null;
}

interface Caller {
  userId: string;
  orgId: string;
  /** Local bypass / global key / org Owner or Admin. */
  admin: boolean;
}

/** An `outcome` the event cannot produce would silently match nothing. */
/**
 * Rejects a filter that could never match in this project: an outcome the
 * event cannot produce, or an epic or agent from somewhere else (a stale
 * selection would otherwise save a trigger that silently posts nothing).
 */
function filterError(
  project: Project,
  event: ChatTriggerEvent,
  filter: ChatTriggerFilter | null | undefined,
): string | null {
  if (!filter) return null;
  const info = CHAT_TRIGGER_EVENT_INFO[event];
  if (filter.outcome && !(info.outcomes ?? []).includes(filter.outcome)) {
    return `outcome "${filter.outcome}" does not apply to ${event}`;
  }
  if (filter.epicId && info.filters.includes('epicId')) {
    const epic = getDb()
      .prepare(
        `SELECT 1 FROM kanban_epics e JOIN kanban_boards b ON b.id = e.board_id
         WHERE e.id = ? AND b.project_id = ?`,
      )
      .get(filter.epicId, project.id);
    if (!epic) return `epic "${filter.epicId}" is not in this project`;
  }
  if (filter.agentIds?.length && info.filters.includes('agentIds')) {
    const known = new Set((project.agents ?? []).map((a) => a.id));
    const stray = filter.agentIds.find((id) => !known.has(id));
    if (stray) return `agent "${stray}" is not in this project`;
  }
  return null;
}

export default function createProjectChatTriggerRoutes(deps: RouteDeps): Router {
  const router = Router();

  function requireCaller(req: Request, res: Response): Caller | null {
    const areq = req as AuthenticatedRequest;
    const userId = resolveGoogleConnectionUserId(req, { getSession: deps.stmts?.getSession });
    if (!userId) {
      bad(res, 401, 'A user identity is required', 'authentication_required');
      return null;
    }
    let orgId: string;
    try {
      orgId = areq.authOrgId || getActiveOrgId();
    } catch {
      bad(res, 403, 'No active organization', 'org_required');
      return null;
    }
    const trusted = Boolean(areq.authLocalOrgBypass || areq.authViaApiKey);
    const role = getMembershipRole(userId, orgId);
    if (!trusted && !role) {
      bad(res, 403, 'Membership of this org required', 'org_membership_required');
      return null;
    }
    return { userId, orgId, admin: trusted || role === 'Owner' || role === 'Admin' };
  }

  function requireProject(req: Request, res: Response): Project | null {
    const project = deps.findProject?.(String(req.params.projectId)) ?? null;
    if (!project || isInternalSystemProject(project)) {
      bad(res, 404, 'Project not found', 'project_not_found');
      return null;
    }
    return project;
  }

  function requireTrigger(project: Project, req: Request, res: Response): ChatTriggerRow | null {
    const row = getTrigger(String(req.params.triggerId));
    if (!row || row.project_id !== project.id) {
      bad(res, 404, 'Trigger not found', 'trigger_not_found');
      return null;
    }
    return row;
  }

  function canManage(caller: Caller, row: ChatTriggerRow): boolean {
    return caller.admin || row.created_by === caller.userId;
  }

  /** A channel the caller may route into, or writes 400 and returns null. */
  function destination(caller: Caller, channelId: string, res: Response): HubChatChannelRow | null {
    const channel = getChannel(channelId);
    if (
      !channel ||
      channel.org_id !== caller.orgId ||
      channel.archived_at ||
      !DESTINATION_KINDS.has(channel.kind) ||
      !getMember(channel.id, caller.userId)
    ) {
      bad(
        res,
        400,
        'Pick a channel or group you are a member of in this org',
        'invalid_destination',
      );
      return null;
    }
    return channel;
  }

  /** Whether the caller can post to Google Chat; writes 400 and returns false if not. */
  function googleChatSendable(caller: Caller, res: Response): boolean {
    const status = getChatConnectionStatus(caller.userId);
    if (
      deps.config?.googleOAuth?.clientId &&
      status.connected &&
      hasChatMessagesCreateScope(status.grantedScopes)
    ) {
      return true;
    }
    bad(
      res,
      400,
      'Connect Google with Chat send access (Settings > Account > Google) to post triggers to Google Chat',
      'google_chat_send_access_required',
    );
    return false;
  }

  function shape(caller: Caller, row: ChatTriggerRow) {
    const channel = getChannel(row.channel_id);
    // Destination details are for its members only, public or not: a
    // trigger channel is something you join, not something Settings reveals.
    const visible =
      channel && channel.org_id === caller.orgId && getMember(channel.id, caller.userId);
    return {
      id: row.id,
      projectId: row.project_id,
      event: row.event,
      filter: parseTriggerFilter(row.filter_json),
      channelId: visible ? row.channel_id : null,
      channel: visible
        ? {
            id: channel.id,
            name: channel.name,
            kind: channel.kind,
            isPrivate: channel.is_private === 1,
            archived: Boolean(channel.archived_at),
          }
        : null,
      googleChat: Boolean(row.google_chat_space_id),
      googleChatSpaceId: row.created_by === caller.userId ? row.google_chat_space_id : null,
      enabled: row.enabled === 1,
      createdByUserId: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canManage: canManage(caller, row),
    };
  }

  router.get('/api/projects/:projectId/chat-triggers', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const project = requireProject(req, res);
    if (!project) return;
    res.json({
      triggers: listTriggersForProject(project.id).map((r) => shape(caller, r)),
      defaultChannelName: defaultTriggerChannelName(project.id),
    });
  });

  router.post('/api/projects/:projectId/chat-triggers', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const project = requireProject(req, res);
    if (!project) return;
    const body = parse(CreateChatTriggerRequestSchema, req.body, res);
    if (!body) return;
    const err = filterError(project, body.event, body.filter);
    if (err) return bad(res, 400, err, 'invalid_filter');
    if (body.googleChatSpaceId && !googleChatSendable(caller, res)) return;

    let channel: HubChatChannelRow | null;
    if (body.newChannel) {
      channel = createChannel({
        orgId: caller.orgId,
        kind: 'trigger',
        name: body.newChannel.name,
        // Private unless asked otherwise: members are added deliberately, and
        // a public channel would be listed to the whole org.
        isPrivate: body.newChannel.isPrivate ?? true,
        projectId: project.id,
        createdByUserId: caller.userId,
      });
      deps.broadcast?.({
        type: HUB_CHAT_CHANNEL_UPDATE_EVENT,
        recipientUserIds: recipientsOf(listMembers(channel.id)),
        orgId: channel.org_id,
        channelId: channel.id,
        reason: 'created',
      });
    } else {
      channel = destination(caller, body.channelId ?? '', res);
      if (!channel) return;
    }

    const row = createTrigger({
      projectId: project.id,
      event: body.event,
      channelId: channel.id,
      filter: body.filter,
      googleChatSpaceId: body.googleChatSpaceId ?? null,
      enabled: body.enabled,
      createdBy: caller.userId,
    });
    res.status(201).json({ trigger: shape(caller, row) });
  });

  router.patch(
    '/api/projects/:projectId/chat-triggers/:triggerId',
    (req: Request, res: Response) => {
      const caller = requireCaller(req, res);
      if (!caller) return;
      const project = requireProject(req, res);
      if (!project) return;
      const row = requireTrigger(project, req, res);
      if (!row) return;
      if (!canManage(caller, row)) {
        return bad(
          res,
          403,
          'Only the creator or an org admin can change this trigger',
          'forbidden',
        );
      }
      const body = parse(UpdateChatTriggerRequestSchema, req.body, res);
      if (!body) return;
      // A trigger posts as its creator's choice: session and private-cron
      // events only flow through the owner's own triggers. Letting anyone else
      // change what it routes or where would let them aim the owner's private
      // work at a channel of their choosing, so only the creator may.
      const retargets =
        body.event !== undefined ||
        body.channelId !== undefined ||
        body.filter !== undefined ||
        body.googleChatSpaceId !== undefined;
      if (retargets && row.created_by !== caller.userId) {
        return bad(
          res,
          403,
          'Only the creator can change what this trigger routes or where; admins can turn it off or delete it',
          'creator_only',
        );
      }
      const event = (body.event ?? row.event) as ChatTriggerEvent;
      const filter = body.filter === undefined ? parseTriggerFilter(row.filter_json) : body.filter;
      // Check the filter against the project when the request changes what it
      // matches or switches the trigger on. Turning a trigger off must always
      // work, even when an epic or agent it names has since gone away.
      const checksFilter =
        body.event !== undefined || body.filter !== undefined || body.enabled === true;
      const err = checksFilter ? filterError(project, event, filter) : null;
      if (err) return bad(res, 400, err, 'invalid_filter');
      if (body.channelId !== undefined && body.channelId !== row.channel_id) {
        if (!destination(caller, body.channelId, res)) return;
      }
      if (
        body.googleChatSpaceId &&
        body.googleChatSpaceId !== row.google_chat_space_id &&
        !googleChatSendable(caller, res)
      ) {
        return;
      }
      const updated = updateTrigger(row.id, {
        event: body.event,
        channelId: body.channelId,
        filter: body.filter,
        googleChatSpaceId: body.googleChatSpaceId,
        enabled: body.enabled,
      });
      if (!updated) return bad(res, 404, 'Trigger not found', 'trigger_not_found');
      res.json({ trigger: shape(caller, updated) });
    },
  );

  router.delete(
    '/api/projects/:projectId/chat-triggers/:triggerId',
    (req: Request, res: Response) => {
      const caller = requireCaller(req, res);
      if (!caller) return;
      const project = requireProject(req, res);
      if (!project) return;
      const row = requireTrigger(project, req, res);
      if (!row) return;
      if (!canManage(caller, row)) {
        return bad(
          res,
          403,
          'Only the creator or an org admin can delete this trigger',
          'forbidden',
        );
      }
      deleteTrigger(row.id);
      res.json({ ok: true });
    },
  );

  return router;
}
