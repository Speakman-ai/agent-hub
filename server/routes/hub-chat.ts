/**
 * REST surface for Agent Hub chat (`/api/chat/*`). Store: `hub-chat-store.ts`;
 * schemas and OpenAPI registrations: `hub-chat.openapi.ts`.
 *
 * Every route acts as one Hub user inside the caller's active org:
 *   - The user is the JWT / per-user key identity, or, for an agent on the
 *     global key, the owner of the calling session (same resolution as the
 *     Google proxy), so a bundled chat wrapper posts as the session owner.
 *   - The caller must be a member of the org (local bypass and the global key
 *     are trusted).
 *   - Private channels, groups and DMs are member-only. To a non-member they
 *     do not exist (404), as do channels in another org. Public channels are
 *     readable by any org member and joinable; posting requires joining.
 *   - Only the author can edit or delete a message.
 */

import { Router, type Request, type Response } from 'express';
import type { z } from '../openapi/registry.js';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { AGENT_HUB_SESSION_ID_HEADER } from '../kanban-caller-session.js';
import { getMembershipRole, listMembersForOrg } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { getUserById } from '../users-store.js';
import { isHubSystemProject } from '../../shared/utils/hub.js';
import { canViewProject } from '../project-visibility.js';
import { isEligibleBackgroundSessionAgent } from '../background-agent-session.js';
import {
  agentDisplayName,
  broadcastHubChatMessage,
  shapeMessage,
  shapeMessageMeta,
} from '../hub-chat-broadcast.js';
import { locateChatMarkdownCode } from '../hub-chat-markdown.js';
import { hubChatRefsToPlainText } from '../../shared/utils/hubChatRefTokens.js';
import { channelLabel } from '../../shared/utils/hubChat.js';
import {
  agentChannelState,
  reserveAgentChannelTurn,
  runAgentChannelPost,
} from '../hub-chat-agent-channels.js';
import { getDb } from '../db.js';
import type {
  HubChatChannelRow,
  HubChatChannelSummary,
  HubChatMemberRow,
  HubChatMessageRow,
  RouteDeps,
} from '../types.js';
import {
  addMember,
  addReaction,
  appendMessage,
  createChannel,
  editMessage,
  getChannel,
  getChannelSummary,
  getChannelTailSeq,
  getMember,
  getMessage,
  getOrCreateDm,
  getPin,
  listChannelsForUser,
  listJoinableChannels,
  listRefBacklinks,
  listMembers,
  listMessages,
  listPins,
  listReactions,
  markRead,
  pinMessage,
  removeMember,
  removeReaction,
  unpinMessage,
  softDeleteMessage,
  updateChannel,
  updateMemberPrefs,
} from '../hub-chat-store.js';
import {
  AddMembersRequestSchema,
  CreateChannelRequestSchema,
  CreateDmRequestSchema,
  EditMessageRequestSchema,
  ListBacklinksQuerySchema,
  ListChannelsQuerySchema,
  ListMessagesQuerySchema,
  MarkReadRequestSchema,
  MuteRequestSchema,
  NotifyLevelRequestSchema,
  PostMessageRequestSchema,
  ReactionRequestSchema,
  RemoveReactionQuerySchema,
  ResolveRefsRequestSchema,
  SearchMessagesQuerySchema,
  SearchRefsQuerySchema,
  UpdateChannelRequestSchema,
  DIGEST_ROUTE_PREFIXES,
  SaveDigestRequestSchema,
  type SaveDigestRequest,
} from './hub-chat.openapi.js';
import {
  createChannelDigest,
  deleteChannelDigest,
  digestProjectIds,
  getChannelDigest,
  listChannelDigests,
  updateChannelDigest,
  MAX_DIGESTS_PER_CHANNEL,
  type ChannelDigestInput,
  type ChannelDigestRow,
} from '../hub-chat-digests-store.js';
import { runChannelDigestNow } from '../hub-chat-digests.js';
import { defaultDigestName } from '../hub-chat-schema.js';
import { searchHubChatMessages } from '../hub-chat-search.js';
import { isValidCron } from '../cron-match.js';
import { isValidTimeZone } from '../daily-summary-schedule.js';
import {
  buildRefViewer,
  resolveBodyRefs,
  resolveRef,
  searchRefs,
  type RefLookups,
  type RefViewer,
} from '../hub-chat-refs.js';
import {
  HUB_CHAT_CHANNEL_UPDATE_EVENT,
  HUB_CHAT_MESSAGE_EVENT,
  HUB_CHAT_MESSAGE_META_EVENT,
  HUB_CHAT_MESSAGE_UPDATE_EVENT,
  HUB_CHAT_READ_EVENT,
  recipientsOf,
  type HubChatChannelUpdateReason,
} from '../hub-chat-events.js';

const DEFAULT_PAGE = 50;
const DEFAULT_BACKLINKS = 20;
const EXCERPT_MAX = 160;

function excerptOf(body: string): string {
  const text = hubChatRefsToPlainText(body, locateChatMarkdownCode).replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text;
}

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
  /** Single-tenant local server: one user, so no project ACLs apply to refs. */
  localBypass: boolean;
  /**
   * Set when the request comes from an agent session the user owns (bundled
   * `chat.sh`): posts are authored by that agent, on the owner's membership.
   */
  agentId: string | null;
}

function dmPeer(row: Pick<HubChatChannelRow, 'kind' | 'dm_key'>, userId: string): string | null {
  if (row.kind !== 'dm' || !row.dm_key) return null;
  const [a, b] = row.dm_key.split(':');
  return a === userId ? (b ?? a) : (a ?? null);
}

function shapeChannel(
  row: HubChatChannelRow,
  userId: string,
  summary: HubChatChannelSummary | null,
) {
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    isPrivate: row.is_private === 1,
    projectId: row.project_id,
    agentId: row.agent_id,
    dmPeerUserId: dmPeer(row, userId),
    createdByUserId: row.created_by_user_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    lastSeq: summary ? summary.last_seq : getChannelTailSeq(row.id),
    membership: summary
      ? {
          role: summary.role,
          lastReadSeq: summary.last_read_seq,
          notifyLevel: summary.notify_level,
          mutedUntil: summary.muted_until,
        }
      : null,
    unreadCount: summary?.unread_count ?? 0,
    mentionCount: summary?.mention_count ?? 0,
    agentState: agentChannelState(row),
  };
}

function shapeMembership(m: HubChatMemberRow) {
  return {
    role: m.role,
    lastReadSeq: m.last_read_seq,
    notifyLevel: m.notify_level,
    mutedUntil: m.muted_until,
  };
}

function shapeMember(m: HubChatMemberRow) {
  return {
    userId: m.user_id,
    username: getUserById(m.user_id)?.username ?? null,
    role: m.role,
    joinedAt: m.joined_at,
  };
}

function digestPaths(suffix: string): string[] {
  return DIGEST_ROUTE_PREFIXES.map((prefix) => `${prefix}${suffix}`);
}

function shapeDigest(row: ChannelDigestRow) {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    enabled: row.enabled === 1,
    cron: row.cron,
    timeZone: row.time_zone,
    scope: row.scope,
    projectIds: digestProjectIds(row),
    prompt: row.prompt,
    ownerUserId: row.owner_user_id,
    windowStart: row.window_start,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastMessageId: row.last_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { shapeMessage };

export default function createHubChatRoutes(deps: RouteDeps): Router {
  const router = Router();

  function emit(type: string, recipientUserIds: string[], payload: Record<string, unknown>) {
    if (recipientUserIds.length === 0) return;
    deps.broadcast?.({ type, recipientUserIds, ...payload });
  }

  /**
   * Channel bodies are per-viewer (unread, membership, DM peer), so the event
   * only names the channel and why it changed; clients refetch it.
   */
  function emitChannelUpdate(
    channel: HubChatChannelRow,
    reason: HubChatChannelUpdateReason,
    extraRecipients: string[] = [],
    extra: Record<string, unknown> = {},
  ) {
    emit(HUB_CHAT_CHANNEL_UPDATE_EVENT, recipientsOf(listMembers(channel.id), extraRecipients), {
      orgId: channel.org_id,
      channelId: channel.id,
      reason,
      ...extra,
    });
  }

  function emitMessage(type: string, channel: HubChatChannelRow, message: HubChatMessageRow) {
    broadcastHubChatMessage(deps.broadcast, type, channel, message);
  }

  /** Read state is the caller's alone; this syncs their other clients. */
  function emitRead(caller: Caller, channelId: string, lastReadSeq: number) {
    emit(HUB_CHAT_READ_EVENT, [caller.userId], { orgId: caller.orgId, channelId, lastReadSeq });
  }

  function trustedCaller(req: Request): boolean {
    const areq = req as AuthenticatedRequest;
    return Boolean(areq.authLocalOrgBypass || areq.authViaApiKey);
  }

  /** Resolves the acting user and org, or writes 401/403 and returns null. */
  function requireCaller(req: Request, res: Response): Caller | null {
    const areq = req as AuthenticatedRequest;
    const userId = resolveGoogleConnectionUserId(req, { getSession: deps.stmts?.getSession });
    if (!userId) {
      bad(res, 401, 'A user identity is required for chat', 'authentication_required');
      return null;
    }
    let orgId: string;
    try {
      orgId = areq.authOrgId || getActiveOrgId();
    } catch {
      bad(res, 403, 'No active organization', 'org_required');
      return null;
    }
    if (!trustedCaller(req) && !getMembershipRole(userId, orgId)) {
      bad(res, 403, 'Membership of this org required', 'org_membership_required');
      return null;
    }
    return {
      userId,
      orgId,
      localBypass: Boolean(areq.authLocalOrgBypass),
      agentId: callingAgentId(req, userId),
    };
  }

  /**
   * The agent behind a session-bound call. Only a session the acting user
   * owns counts, so a header naming someone else's session changes nothing.
   */
  function callingAgentId(req: Request, userId: string): string | null {
    const areq = req as AuthenticatedRequest;
    const sessionId =
      areq.authSpawnSessionId?.trim() || req.get(AGENT_HUB_SESSION_ID_HEADER)?.trim() || '';
    if (!sessionId || !deps.stmts?.getSession) return null;
    const session = deps.stmts.getSession.get(sessionId) as
      | { agent_id?: string | null; owner_user_id?: string | null }
      | undefined;
    if (!session?.agent_id || session.owner_user_id !== userId) return null;
    return session.agent_id;
  }

  const refLookups: RefLookups = {
    findProject: (id) => deps.findProject?.(id) ?? null,
    getProjects: () => deps.getProjects?.() ?? [],
  };

  function refViewer(caller: Caller): RefViewer {
    return buildRefViewer(caller.userId, caller.orgId, caller.localBypass);
  }

  function isOrgMember(userId: string, orgId: string): boolean {
    return Boolean(getMembershipRole(userId, orgId));
  }

  /**
   * Loads a channel the caller may see. Missing, other-org, and private
   * channels they are not in all read as 404 so ids leak nothing.
   */
  function visibleChannel(
    caller: Caller,
    channelId: string,
    res: Response,
  ): { channel: HubChatChannelRow; member: HubChatMemberRow | null } | null {
    const channel = getChannel(channelId);
    const member = channel ? getMember(channel.id, caller.userId) : null;
    if (!channel || channel.org_id !== caller.orgId || (channel.is_private === 1 && !member)) {
      bad(res, 404, 'Channel not found', 'channel_not_found');
      return null;
    }
    return { channel, member };
  }

  /** Like `visibleChannel` but the caller must have joined. */
  function memberChannel(
    caller: Caller,
    channelId: string,
    res: Response,
  ): { channel: HubChatChannelRow; member: HubChatMemberRow } | null {
    const v = visibleChannel(caller, channelId, res);
    if (!v) return null;
    if (!v.member) {
      bad(res, 409, 'Join the channel first', 'not_joined');
      return null;
    }
    return { channel: v.channel, member: v.member };
  }

  function channelBody(caller: Caller, channel: HubChatChannelRow) {
    return shapeChannel(channel, caller.userId, getChannelSummary(channel.id, caller.userId));
  }

  /** The caller's own, live message in a channel they can see. */
  function ownMessage(caller: Caller, messageId: string, res: Response): HubChatMessageRow | null {
    const msg = getMessage(messageId);
    if (!msg || msg.deleted_at) {
      bad(res, 404, 'Message not found', 'message_not_found');
      return null;
    }
    if (!visibleChannel(caller, msg.channel_id, res)) return null;
    if (msg.author_kind !== 'user' || msg.author_user_id !== caller.userId) {
      bad(res, 403, 'You can only change your own messages', 'not_author');
      return null;
    }
    return msg;
  }

  /**
   * Validates the project agent an agent channel binds to: a project the
   * caller can see, and an agent in it that can host a chat session.
   */
  function agentBinding(
    caller: Caller,
    projectId: string,
    agentId: string,
    res: Response,
  ): { projectId: string; agentId: string; agentName: string } | null {
    const project = deps.findProject?.(projectId) ?? null;
    if (
      !project ||
      isHubSystemProject(project) ||
      !canViewProject(project, refViewer(caller).visibility)
    ) {
      bad(res, 404, 'Project not found', 'project_not_found');
      return null;
    }
    const agent = project.agents?.find((a) => a.id === agentId);
    if (!agent) {
      bad(res, 404, 'Agent not found in this project', 'agent_not_found');
      return null;
    }
    if (!isEligibleBackgroundSessionAgent(agent)) {
      bad(res, 400, `Agent "${agent.name}" cannot host a chat session`, 'agent_not_eligible');
      return null;
    }
    return { projectId: project.id, agentId: agent.id, agentName: agent.name || agent.id };
  }

  function canUseAgentProject(caller: Caller, channel: HubChatChannelRow): boolean {
    const project = channel.project_id ? (deps.findProject?.(channel.project_id) ?? null) : null;
    return Boolean(project && canViewProject(project, refViewer(caller).visibility));
  }

  router.get('/api/chat/members', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const members = listMembersForOrg(caller.orgId).map((m) => ({
      userId: m.userId,
      username: m.username,
      role: m.role,
    }));
    res.json({ members });
  });

  router.get('/api/chat/search', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const q = parse(SearchMessagesQuerySchema, req.query, res);
    if (!q) return;
    const limit = q.limit ?? 20;
    const rows = searchHubChatMessages(caller.orgId, caller.userId, q.q, {
      channelId: q.channelId,
      limit,
    });
    res.json({
      results: rows.slice(0, limit).map((r) => ({
        message: shapeMessage(r),
        channel: {
          id: r.channel_id,
          kind: r.channel_kind,
          name: r.channel_name,
          dmPeerUserId: dmPeer({ kind: r.channel_kind, dm_key: r.channel_dm_key }, caller.userId),
          isPrivate: r.channel_is_private === 1,
          isMember: r.is_member === 1,
        },
      })),
      hasMore: rows.length > limit,
    });
  });

  router.get('/api/chat/refs/search', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const q = parse(SearchRefsQuerySchema, req.query, res);
    if (!q) return;
    res.json({ suggestions: searchRefs(refLookups, refViewer(caller), q.trigger, q.q ?? '') });
  });

  router.post('/api/chat/refs/resolve', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const body = parse(ResolveRefsRequestSchema, req.body, res);
    if (!body) return;
    const viewer = refViewer(caller);
    res.json({
      refs: body.refs.map((r) => resolveRef(refLookups, viewer, r.kind, r.targetId)),
    });
  });

  router.get('/api/chat/backlinks', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const q = parse(ListBacklinksQuerySchema, req.query, res);
    if (!q) return;
    const target = resolveRef(refLookups, refViewer(caller), q.kind, q.targetId);
    if (!target.visible) {
      res.json({ target, backlinks: [] });
      return;
    }
    const rows = listRefBacklinks(
      caller.orgId,
      caller.userId,
      q.kind,
      q.targetId,
      q.limit ?? DEFAULT_BACKLINKS,
    );
    const usernames = new Map<string, string>();
    const username = (id: string | null): string | null => {
      if (!id) return null;
      if (!usernames.has(id)) usernames.set(id, getUserById(id)?.username ?? 'Unknown user');
      return usernames.get(id) ?? null;
    };
    const backlinks = rows.map((r) => {
      const peer = dmPeer({ kind: r.channel_kind, dm_key: r.dm_key }, caller.userId);
      if (peer) username(peer);
      return {
        messageId: r.message_id,
        channelId: r.channel_id,
        channelKind: r.channel_kind,
        channelLabel: channelLabel(
          { kind: r.channel_kind, name: r.channel_name, dmPeerUserId: peer },
          usernames,
          caller.userId,
        ),
        authorKind: r.author_kind,
        authorName:
          r.author_kind === 'agent' && r.author_agent_id
            ? agentDisplayName(r.author_agent_id)
            : r.author_kind === 'system'
              ? 'Agent Hub'
              : username(r.author_user_id),
        excerpt: excerptOf(r.body),
        createdAt: r.created_at,
      };
    });
    res.json({ target, backlinks });
  });

  router.get('/api/chat/channels', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const q = parse(ListChannelsQuerySchema, req.query, res);
    if (!q) return;
    const rows = listChannelsForUser(caller.orgId, caller.userId, {
      includeArchived: q.includeArchived === 'true',
    });
    res.json({
      channels: rows.map((r) => shapeChannel(r, caller.userId, r)),
      viewerUserId: caller.userId,
    });
  });

  router.get('/api/chat/channels/browse', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const rows = listJoinableChannels(caller.orgId, caller.userId);
    res.json({ channels: rows.map((r) => shapeChannel(r, caller.userId, null)) });
  });

  router.post('/api/chat/channels', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const body = parse(CreateChannelRequestSchema, req.body, res);
    if (!body) return;
    const others = [...new Set(body.memberUserIds ?? [])].filter((id) => id !== caller.userId);
    const outsider = others.find((id) => !isOrgMember(id, caller.orgId));
    if (outsider) {
      bad(res, 400, `User ${outsider} is not a member of this org`, 'member_not_in_org');
      return;
    }
    let binding: { projectId: string; agentId: string; agentName: string } | null = null;
    if (body.kind === 'agent') {
      binding = agentBinding(caller, body.projectId ?? '', body.agentId ?? '', res);
      if (!binding) return;
    }
    const channel = createChannel({
      orgId: caller.orgId,
      kind: body.kind,
      name: body.name || binding?.agentName || '',
      topic: body.topic ?? null,
      isPrivate: body.isPrivate,
      projectId: binding?.projectId ?? null,
      agentId: binding?.agentId ?? null,
      createdByUserId: caller.userId,
      memberUserIds: others,
    });
    emitChannelUpdate(channel, 'created');
    res.status(201).json({ channel: channelBody(caller, channel) });
  });

  router.post('/api/chat/dms', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const body = parse(CreateDmRequestSchema, req.body, res);
    if (!body) return;
    if (body.userId !== caller.userId && !isOrgMember(body.userId, caller.orgId)) {
      bad(res, 400, 'That user is not a member of this org', 'member_not_in_org');
      return;
    }
    const { channel, created } = getOrCreateDm(caller.orgId, caller.userId, body.userId);
    if (created) emitChannelUpdate(channel, 'created');
    res.status(created ? 201 : 200).json({ channel: channelBody(caller, channel) });
  });

  router.get('/api/chat/channels/:channelId', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const v = visibleChannel(caller, String(req.params.channelId), res);
    if (!v) return;
    res.json({
      channel: channelBody(caller, v.channel),
      members: listMembers(v.channel.id).map(shapeMember),
    });
  });

  router.patch('/api/chat/channels/:channelId', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const m = memberChannel(caller, String(req.params.channelId), res);
    if (!m) return;
    const body = parse(UpdateChannelRequestSchema, req.body, res);
    if (!body) return;
    if (m.channel.kind === 'dm') {
      bad(res, 400, 'A DM has no name or topic', 'dm_fixed');
      return;
    }
    const updated = updateChannel(m.channel.id, {
      name: body.name,
      topic: body.topic === '' ? null : body.topic,
    });
    if (!updated) {
      bad(res, 404, 'Channel not found', 'channel_not_found');
      return;
    }
    emitChannelUpdate(updated, 'updated');
    res.json({ channel: channelBody(caller, updated) });
  });

  router.post('/api/chat/channels/:channelId/join', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const v = visibleChannel(caller, String(req.params.channelId), res);
    if (!v) return;
    if (!v.member) {
      if (v.channel.archived_at) {
        bad(res, 409, 'This channel is archived', 'channel_archived');
        return;
      }
      addMember(v.channel.id, caller.userId);
      emitChannelUpdate(v.channel, 'member_added', [], { userIds: [caller.userId] });
    }
    res.json({ channel: channelBody(caller, v.channel) });
  });

  router.post('/api/chat/channels/:channelId/members', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const m = memberChannel(caller, String(req.params.channelId), res);
    if (!m) return;
    const body = parse(AddMembersRequestSchema, req.body, res);
    if (!body) return;
    if (m.channel.kind === 'dm') {
      bad(res, 400, 'Members cannot be added to a DM; start a group instead', 'dm_fixed');
      return;
    }
    const outsider = body.userIds.find((id) => !isOrgMember(id, caller.orgId));
    if (outsider) {
      bad(res, 400, `User ${outsider} is not a member of this org`, 'member_not_in_org');
      return;
    }
    const before = new Set(listMembers(m.channel.id).map((x) => x.user_id));
    const added = [...new Set(body.userIds)].filter((id) => !before.has(id));
    for (const id of added) addMember(m.channel.id, id);
    if (added.length > 0) emitChannelUpdate(m.channel, 'member_added', [], { userIds: added });
    res.json({ members: listMembers(m.channel.id).map(shapeMember) });
  });

  router.delete('/api/chat/channels/:channelId/members/:userId', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const m = memberChannel(caller, String(req.params.channelId), res);
    if (!m) return;
    const target = String(req.params.userId);
    if (m.channel.kind === 'dm') {
      bad(res, 400, 'DM membership cannot change', 'dm_fixed');
      return;
    }
    if (target !== caller.userId && m.member.role !== 'owner') {
      bad(res, 403, 'Only channel owners can remove other members', 'owner_required');
      return;
    }
    if (!removeMember(m.channel.id, target)) {
      bad(res, 404, 'Not a member of this channel', 'member_not_found');
      return;
    }
    // The removed user hears it too, so their clients drop the channel.
    emitChannelUpdate(m.channel, 'member_removed', [target], { userIds: [target] });
    res.json({ ok: true });
  });

  router.get('/api/chat/channels/:channelId/messages', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const v = visibleChannel(caller, String(req.params.channelId), res);
    if (!v) return;
    const q = parse(ListMessagesQuerySchema, req.query, res);
    if (!q) return;
    const limit = q.limit ?? DEFAULT_PAGE;
    // Fetch one extra row to learn whether another page exists.
    const rows = listMessages(v.channel.id, { before: q.before, after: q.after, limit: limit + 1 });
    const hasMore = rows.length > limit;
    // `after` pages forward (drop the newest extra); otherwise we page back (drop the oldest).
    const page = hasMore ? (q.after !== undefined ? rows.slice(0, limit) : rows.slice(1)) : rows;
    res.json({ messages: page.map(shapeMessage), hasMore });
  });

  router.post('/api/chat/channels/:channelId/messages', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const m = memberChannel(caller, String(req.params.channelId), res);
    if (!m) return;
    const body = parse(PostMessageRequestSchema, req.body, res);
    if (!body) return;
    if (m.channel.archived_at) {
      bad(res, 409, 'This channel is archived', 'channel_archived');
      return;
    }
    if (m.channel.kind === 'agent' && !caller.agentId && !canUseAgentProject(caller, m.channel)) {
      bad(res, 403, "You need access to this channel's project to post", 'project_access_required');
      return;
    }
    const resolved = resolveBodyRefs(refLookups, refViewer(caller), body.body);
    // A member's post in an agent channel runs in its session. Agent posts
    // (chat.sh) never do, so two agents cannot loop on each other.
    const runsAgent = m.channel.kind === 'agent' && !caller.agentId;
    // The post and its agent turn are stored together, so a stored post is
    // never left without the record that gets it answered.
    const { message, turnId } = getDb().transaction(() => {
      const message = appendMessage({
        channelId: m.channel.id,
        authorKind: caller.agentId ? 'agent' : 'user',
        authorUserId: caller.userId,
        authorAgentId: caller.agentId,
        body: resolved.body,
        refs: resolved.refs,
      });
      return { message, turnId: runsAgent ? reserveAgentChannelTurn(m.channel) : null };
    })();
    emitMessage(HUB_CHAT_MESSAGE_EVENT, m.channel, message);
    // The author's read pointer moved past their own message. An agent's post
    // stays unread for the owner, so they notice it.
    if (!caller.agentId) emitRead(caller, m.channel.id, message.seq);
    const agentSessionId = turnId
      ? runAgentChannelPost({
          channel: m.channel,
          turnId,
          authorName: getUserById(caller.userId)?.username ?? 'A member',
          body: resolved.body,
        }).sessionId
      : null;
    res.status(201).json({ message: shapeMessage(message), agentSessionId });
  });

  // Resolves a message link to its channel and seq, so a client can load the
  // history up to it instead of guessing how far back it is.
  router.get('/api/chat/messages/:messageId', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const msg = getMessage(String(req.params.messageId));
    if (!msg) {
      bad(res, 404, 'Message not found', 'message_not_found');
      return;
    }
    if (!visibleChannel(caller, msg.channel_id, res)) return;
    res.json({ message: shapeMessage(msg) });
  });

  router.patch('/api/chat/messages/:messageId', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const body = parse(EditMessageRequestSchema, req.body, res);
    if (!body) return;
    const msg = ownMessage(caller, String(req.params.messageId), res);
    if (!msg) return;
    const resolved = resolveBodyRefs(refLookups, refViewer(caller), body.body);
    const updated = editMessage(msg.id, { body: resolved.body, refs: resolved.refs });
    if (!updated) {
      bad(res, 404, 'Message not found', 'message_not_found');
      return;
    }
    const channel = getChannel(updated.channel_id);
    if (channel) emitMessage(HUB_CHAT_MESSAGE_UPDATE_EVENT, channel, updated);
    res.json({ message: shapeMessage(updated) });
  });

  router.delete('/api/chat/messages/:messageId', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const msg = ownMessage(caller, String(req.params.messageId), res);
    if (!msg) return;
    const hadMeta = Boolean(getPin(msg.id)) || listReactions(msg.id).length > 0;
    const deleted = softDeleteMessage(msg.id);
    if (!deleted) {
      bad(res, 404, 'Message not found', 'message_not_found');
      return;
    }
    const channel = getChannel(deleted.channel_id);
    if (channel) {
      emitMessage(HUB_CHAT_MESSAGE_UPDATE_EVENT, channel, deleted);
      // A deleted message loses its reactions and pin; pinned lists refetch.
      if (hadMeta) {
        emit(HUB_CHAT_MESSAGE_META_EVENT, recipientsOf(listMembers(channel.id)), {
          orgId: channel.org_id,
          messageId: deleted.id,
          channelId: channel.id,
          ...shapeMessageMeta(deleted),
          pinChanged: true,
        });
      }
    }
    res.json({ message: shapeMessage(deleted) });
  });

  /**
   * A live message in a channel the caller has joined and can still write to,
   * for reacting and pinning. Writes 404/409 and returns null otherwise.
   */
  function actionableMessage(
    caller: Caller,
    messageId: string,
    res: Response,
  ): { channel: HubChatChannelRow; message: HubChatMessageRow } | null {
    const message = getMessage(messageId);
    if (!message || message.deleted_at) {
      bad(res, 404, 'Message not found', 'message_not_found');
      return null;
    }
    const m = memberChannel(caller, message.channel_id, res);
    if (!m) return null;
    if (m.channel.archived_at) {
      bad(res, 409, 'This channel is archived', 'channel_archived');
      return null;
    }
    return { channel: m.channel, message };
  }

  /** Sends the message's reaction/pin state to members and the caller. */
  function respondMeta(
    res: Response,
    channel: HubChatChannelRow,
    messageId: string,
    changed: boolean,
    pinChanged = false,
  ) {
    const fresh = getMessage(messageId);
    if (!fresh) {
      bad(res, 404, 'Message not found', 'message_not_found');
      return;
    }
    const meta = { messageId: fresh.id, channelId: channel.id, ...shapeMessageMeta(fresh) };
    if (changed) {
      emit(HUB_CHAT_MESSAGE_META_EVENT, recipientsOf(listMembers(channel.id)), {
        orgId: channel.org_id,
        ...meta,
        pinChanged,
      });
    }
    res.json({ meta });
  }

  router.put('/api/chat/messages/:messageId/reactions', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const body = parse(ReactionRequestSchema, req.body, res);
    if (!body) return;
    const a = actionableMessage(caller, String(req.params.messageId), res);
    if (!a) return;
    const result = addReaction(a.message.id, caller.userId, body.emoji);
    if (result === 'too_many') {
      bad(
        res,
        400,
        'This message has as many different reactions as it can hold',
        'too_many_reactions',
      );
      return;
    }
    respondMeta(res, a.channel, a.message.id, result === 'added');
  });

  router.delete('/api/chat/messages/:messageId/reactions', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const q = parse(RemoveReactionQuerySchema, req.query, res);
    if (!q) return;
    const a = actionableMessage(caller, String(req.params.messageId), res);
    if (!a) return;
    const result = removeReaction(a.message.id, caller.userId, q.emoji);
    respondMeta(res, a.channel, a.message.id, result === 'removed');
  });

  router.put('/api/chat/messages/:messageId/pin', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const a = actionableMessage(caller, String(req.params.messageId), res);
    if (!a) return;
    const changed = pinMessage(a.message, caller.userId);
    respondMeta(res, a.channel, a.message.id, changed, true);
  });

  router.delete('/api/chat/messages/:messageId/pin', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const a = actionableMessage(caller, String(req.params.messageId), res);
    if (!a) return;
    const changed = unpinMessage(a.message.id);
    respondMeta(res, a.channel, a.message.id, changed, true);
  });

  router.get('/api/chat/channels/:channelId/pins', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const v = visibleChannel(caller, String(req.params.channelId), res);
    if (!v) return;
    res.json({
      pins: listPins(v.channel.id).map(({ pin, message }) => ({
        message: shapeMessage(message),
        pinnedByUserId: pin.pinned_by_user_id,
        pinnedAt: pin.pinned_at,
      })),
    });
  });

  router.post('/api/chat/channels/:channelId/read', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const m = memberChannel(caller, String(req.params.channelId), res);
    if (!m) return;
    const body = parse(MarkReadRequestSchema, req.body, res);
    if (!body) return;
    const lastReadSeq = markRead(m.channel.id, caller.userId, body.seq) ?? m.member.last_read_seq;
    emitRead(caller, m.channel.id, lastReadSeq);
    res.json({ lastReadSeq });
  });

  router.put('/api/chat/channels/:channelId/notify-level', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const m = memberChannel(caller, String(req.params.channelId), res);
    if (!m) return;
    const body = parse(NotifyLevelRequestSchema, req.body, res);
    if (!body) return;
    const updated = updateMemberPrefs(m.channel.id, caller.userId, {
      notifyLevel: body.notifyLevel,
    });
    const membership = shapeMembership(updated ?? m.member);
    emit(HUB_CHAT_CHANNEL_UPDATE_EVENT, [caller.userId], {
      orgId: caller.orgId,
      channelId: m.channel.id,
      reason: 'membership',
      membership,
    });
    res.json({ membership });
  });

  router.put('/api/chat/channels/:channelId/mute', (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const m = memberChannel(caller, String(req.params.channelId), res);
    if (!m) return;
    const body = parse(MuteRequestSchema, req.body, res);
    if (!body) return;
    const mutedUntil = body.mutedUntil === null ? null : new Date(body.mutedUntil).toISOString();
    const updated = updateMemberPrefs(m.channel.id, caller.userId, { mutedUntil });
    const membership = shapeMembership(updated ?? m.member);
    emit(HUB_CHAT_CHANNEL_UPDATE_EVENT, [caller.userId], {
      orgId: caller.orgId,
      channelId: m.channel.id,
      reason: 'membership',
      membership,
    });
    res.json({ membership });
  });

  /**
   * Validates a digest save as the caller and returns the store input, or
   * writes the error response and returns null.
   */
  const digestInput = (
    caller: Caller,
    body: SaveDigestRequest,
    res: Response,
  ): ChannelDigestInput | null => {
    if (!isValidCron(body.cron)) {
      bad(res, 400, 'Schedule must be a 5-field cron expression', 'invalid_cron');
      return null;
    }
    if (!isValidTimeZone(body.timeZone)) {
      bad(res, 400, 'Unknown timezone', 'invalid_time_zone');
      return null;
    }
    const projectIds: string[] = [];
    if (body.scope === 'project') {
      const ids = body.projectIds ?? [];
      if (ids.length === 0) {
        bad(res, 400, 'Pick a project for a project digest', 'project_required');
        return null;
      }
      for (const id of ids) {
        const project = deps.findProject?.(id) ?? null;
        if (
          !project ||
          isHubSystemProject(project) ||
          !canViewProject(project, refViewer(caller).visibility)
        ) {
          bad(res, 404, 'Project not found', 'project_not_found');
          return null;
        }
        if (!projectIds.includes(project.id)) projectIds.push(project.id);
      }
    }
    return {
      name: body.name?.trim() || defaultDigestName(body.scope),
      enabled: body.enabled,
      cron: body.cron.trim().split(/\s+/).join(' '),
      timeZone: body.timeZone.trim(),
      scope: body.scope,
      projectIds,
      prompt: null,
      ownerUserId: caller.userId,
    };
  };

  /** The digest when it belongs to this channel; otherwise a 404 is sent. */
  const channelDigest = (
    channelId: string,
    digestId: string,
    res: Response,
  ): ChannelDigestRow | null => {
    const row = getChannelDigest(digestId);
    if (!row || row.channel_id !== channelId) {
      bad(res, 404, 'Digest not found', 'digest_not_found');
      return null;
    }
    return row;
  };

  router.get(digestPaths('/channels/:channelId/digests'), (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const v = visibleChannel(caller, String(req.params.channelId), res);
    if (!v) return;
    res.json({ digests: listChannelDigests(v.channel.id).map(shapeDigest) });
  });

  router.post(digestPaths('/channels/:channelId/digests'), (req: Request, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;
    const m = memberChannel(caller, String(req.params.channelId), res);
    if (!m) return;
    const body = parse(SaveDigestRequestSchema, req.body, res);
    if (!body) return;
    if (m.channel.archived_at) {
      bad(res, 409, 'This channel is archived', 'channel_archived');
      return;
    }
    const input = digestInput(caller, body, res);
    if (!input) return;
    const row = createChannelDigest(m.channel.id, input);
    if (!row) {
      bad(
        res,
        409,
        `A channel can hold at most ${MAX_DIGESTS_PER_CHANNEL} digests`,
        'digest_limit_reached',
      );
      return;
    }
    res.status(201).json({ digest: shapeDigest(row) });
  });

  router.put(
    digestPaths('/channels/:channelId/digests/:digestId'),
    (req: Request, res: Response) => {
      const caller = requireCaller(req, res);
      if (!caller) return;
      const m = memberChannel(caller, String(req.params.channelId), res);
      if (!m) return;
      const body = parse(SaveDigestRequestSchema, req.body, res);
      if (!body) return;
      if (!channelDigest(m.channel.id, String(req.params.digestId), res)) return;
      if (m.channel.archived_at) {
        bad(res, 409, 'This channel is archived', 'channel_archived');
        return;
      }
      const input = digestInput(caller, body, res);
      if (!input) return;
      const row = updateChannelDigest(String(req.params.digestId), input);
      if (!row) {
        bad(res, 404, 'Digest not found', 'digest_not_found');
        return;
      }
      res.json({ digest: shapeDigest(row) });
    },
  );

  router.delete(
    digestPaths('/channels/:channelId/digests/:digestId'),
    (req: Request, res: Response) => {
      const caller = requireCaller(req, res);
      if (!caller) return;
      const m = memberChannel(caller, String(req.params.channelId), res);
      if (!m) return;
      const row = channelDigest(m.channel.id, String(req.params.digestId), res);
      if (!row) return;
      deleteChannelDigest(row.id);
      res.json({ ok: true });
    },
  );

  router.post(
    digestPaths('/channels/:channelId/digests/:digestId/run'),
    async (req: Request, res: Response) => {
      const caller = requireCaller(req, res);
      if (!caller) return;
      const m = memberChannel(caller, String(req.params.channelId), res);
      if (!m) return;
      const row = channelDigest(m.channel.id, String(req.params.digestId), res);
      if (!row) return;
      if (m.channel.archived_at) {
        bad(res, 409, 'This channel is archived', 'channel_archived');
        return;
      }
      const result = await runChannelDigestNow(row, new Date(), {
        config: deps.config,
        broadcast: deps.broadcast,
        findProject: (id) => deps.findProject?.(id) ?? null,
        getProjects: () => deps.getProjects?.() ?? [],
      });
      if (result.status === 'busy') {
        bad(res, 409, 'This digest is already running', 'digest_running');
        return;
      }
      const after = getChannelDigest(row.id);
      res.json({ result, digest: after ? shapeDigest(after) : null });
    },
  );

  return router;
}
