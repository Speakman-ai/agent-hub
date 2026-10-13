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
import { getMembershipRole, listMembersForOrg } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { getUserById } from '../users-store.js';
import type {
  HubChatChannelRow,
  HubChatChannelSummary,
  HubChatMemberRow,
  HubChatMessageRow,
  RouteDeps,
} from '../types.js';
import {
  addMember,
  appendMessage,
  createChannel,
  editMessage,
  getChannel,
  getChannelSummary,
  getChannelTailSeq,
  getMember,
  getMessage,
  getOrCreateDm,
  listChannelsForUser,
  listJoinableChannels,
  listMembers,
  listMessages,
  markRead,
  removeMember,
  softDeleteMessage,
  updateChannel,
  updateMemberPrefs,
} from '../hub-chat-store.js';
import {
  AddMembersRequestSchema,
  CreateChannelRequestSchema,
  CreateDmRequestSchema,
  EditMessageRequestSchema,
  ListChannelsQuerySchema,
  ListMessagesQuerySchema,
  MarkReadRequestSchema,
  MuteRequestSchema,
  NotifyLevelRequestSchema,
  PostMessageRequestSchema,
  ResolveRefsRequestSchema,
  SearchRefsQuerySchema,
  UpdateChannelRequestSchema,
} from './hub-chat.openapi.js';
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
  HUB_CHAT_MESSAGE_UPDATE_EVENT,
  HUB_CHAT_READ_EVENT,
  recipientsOf,
  type HubChatChannelUpdateReason,
} from '../hub-chat-events.js';

const DEFAULT_PAGE = 50;

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
}

function dmPeer(row: HubChatChannelRow, userId: string): string | null {
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

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function shapeMessage(m: HubChatMessageRow) {
  const refs = parseJson(m.refs_json);
  return {
    id: m.id,
    channelId: m.channel_id,
    seq: m.seq,
    authorKind: m.author_kind,
    authorUserId: m.author_user_id,
    authorAgentId: m.author_agent_id,
    body: m.body,
    refs: Array.isArray(refs) ? refs : [],
    payload: parseJson(m.payload_json),
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    createdAt: m.created_at,
  };
}

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
    emit(type, recipientsOf(listMembers(channel.id)), {
      orgId: channel.org_id,
      channelId: channel.id,
      channelKind: channel.kind,
      channelName: channel.name,
      authorName: message.author_user_id
        ? (getUserById(message.author_user_id)?.username ?? null)
        : null,
      message: shapeMessage(message),
    });
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
    return { userId, orgId, localBypass: Boolean(areq.authLocalOrgBypass) };
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
    const channel = createChannel({
      orgId: caller.orgId,
      kind: body.kind,
      name: body.name ?? '',
      topic: body.topic ?? null,
      isPrivate: body.isPrivate,
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
    const resolved = resolveBodyRefs(refLookups, refViewer(caller), body.body);
    const message = appendMessage({
      channelId: m.channel.id,
      authorKind: 'user',
      authorUserId: caller.userId,
      body: resolved.body,
      refs: resolved.refs,
    });
    emitMessage(HUB_CHAT_MESSAGE_EVENT, m.channel, message);
    // The author's read pointer moved past their own message.
    emitRead(caller, m.channel.id, message.seq);
    res.status(201).json({ message: shapeMessage(message) });
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
    const deleted = softDeleteMessage(msg.id);
    if (!deleted) {
      bad(res, 404, 'Message not found', 'message_not_found');
      return;
    }
    const channel = getChannel(deleted.channel_id);
    if (channel) emitMessage(HUB_CHAT_MESSAGE_UPDATE_EVENT, channel, deleted);
    res.json({ message: shapeMessage(deleted) });
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

  return router;
}
