/**
 * Zod schemas + OpenAPI registrations for Agent Hub chat (`/api/chat/*`,
 * `server/routes/hub-chat.ts`). The route file validates request bodies and
 * queries with the schemas exported here, so the documented contract and the
 * enforced one are the same objects.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { HUB_CHAT_REF_MAX_ID } from '../../shared/utils/hubChatRefTokens.js';

const TAG = 'Hub Chat';

const ErrorResponse = registerComponent(
  'HubChatErrorResponse',
  z
    .object({ error: z.string(), code: z.string().optional() })
    .openapi({ description: 'Error envelope for chat routes.' }),
);

export const ChannelKindSchema = z.enum(['dm', 'group', 'channel', 'trigger', 'agent', 'summary']);
export const NotifyLevelSchema = z.enum(['all', 'mentions', 'none']);
const MemberRoleSchema = z.enum(['owner', 'member']);
const AuthorKindSchema = z.enum(['user', 'agent', 'system', 'trigger']);
const RefKindSchema = z.enum(['user', 'agent', 'session', 'card', 'ticket', 'pr']);

const MembershipComponent = z
  .object({
    role: MemberRoleSchema,
    lastReadSeq: z.number().int(),
    notifyLevel: NotifyLevelSchema,
    mutedUntil: z.string().nullable(),
  })
  .openapi({ description: "The caller's membership in the channel." });

export const HubChatChannelComponent = registerComponent(
  'HubChatChannel',
  z
    .object({
      id: z.string(),
      orgId: z.string(),
      kind: ChannelKindSchema,
      name: z.string().openapi({ description: 'Empty for DMs; render the peer instead.' }),
      topic: z.string().nullable(),
      isPrivate: z.boolean(),
      projectId: z.string().nullable(),
      agentId: z.string().nullable(),
      dmPeerUserId: z.string().nullable().openapi({
        description:
          "For DMs, the other participant's user id (the caller's own id for a self-DM).",
      }),
      createdByUserId: z.string().nullable(),
      archivedAt: z.string().nullable(),
      createdAt: z.string(),
      lastSeq: z.number().int().openapi({ description: 'Highest message seq in the channel.' }),
      membership: MembershipComponent.nullable().openapi({
        description: 'Null when the caller is not a member (a public channel they can join).',
      }),
      unreadCount: z.number().int(),
      mentionCount: z.number().int(),
    })
    .openapi({ description: 'A chat channel as seen by the caller, with their unread state.' }),
);

const HubChatMemberComponent = registerComponent(
  'HubChatMember',
  z.object({
    userId: z.string(),
    username: z.string().nullable(),
    role: MemberRoleSchema,
    joinedAt: z.string(),
  }),
);

export const HubChatMessageComponent = registerComponent(
  'HubChatMessage',
  z
    .object({
      id: z.string(),
      channelId: z.string(),
      seq: z.number().int(),
      authorKind: AuthorKindSchema,
      authorUserId: z.string().nullable(),
      authorAgentId: z.string().nullable(),
      authorAgentName: z.string().nullable().optional().openapi({
        description: 'Display name of the posting agent, for agent-authored messages.',
      }),
      body: z.string().openapi({ description: 'Markdown. Empty once deleted.' }),
      refs: z.array(
        z.object({
          kind: RefKindSchema,
          targetId: z.string(),
          projectId: z.string().nullable().optional(),
        }),
      ),
      payload: z.unknown().nullable().openapi({
        description: 'Structured card payload for trigger and summary messages.',
      }),
      editedAt: z.string().nullable(),
      deletedAt: z.string().nullable(),
      createdAt: z.string(),
    })
    .openapi({ description: 'One chat message. Deleted messages keep their seq.' }),
);

const OrgMemberComponent = registerComponent(
  'HubChatOrgMember',
  z.object({ userId: z.string(), username: z.string(), role: z.string() }),
);

const MAX_NAME = 80;
const MAX_TOPIC = 250;
export const MAX_BODY = 20_000;

export const CreateChannelRequestSchema = z
  .object({
    kind: z.enum(['channel', 'group']).default('channel'),
    name: z.string().trim().max(MAX_NAME).optional(),
    topic: z.string().trim().max(MAX_TOPIC).nullable().optional(),
    isPrivate: z.boolean().optional().openapi({
      description: 'Channels only; groups are always private.',
    }),
    memberUserIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict()
  .refine((v) => v.kind !== 'channel' || (v.name ?? '').length > 0, {
    message: 'name is required for a channel',
    path: ['name'],
  });

export const UpdateChannelRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME).optional(),
    topic: z.string().trim().max(MAX_TOPIC).nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.topic !== undefined, {
    message: 'Pass name or topic',
  });

export const CreateDmRequestSchema = z.object({ userId: z.string().min(1) }).strict();

export const AddMembersRequestSchema = z
  .object({ userIds: z.array(z.string().min(1)).min(1).max(100) })
  .strict();

export const ListMessagesQuerySchema = z
  .object({
    before: z.coerce.number().int().min(1).optional().openapi({
      description: 'Return the messages immediately before this seq (scroll back).',
    }),
    after: z.coerce.number().int().min(0).optional().openapi({
      description: 'Return the messages immediately after this seq (catch up).',
    }),
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({
      description: 'Page size, 1..100 (default 50).',
    }),
  })
  .refine((q) => q.before === undefined || q.after === undefined, {
    message: 'Pass before or after, not both',
  });

export const ListChannelsQuerySchema = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
});

export const PostMessageRequestSchema = z
  .object({
    body: z
      .string()
      .max(MAX_BODY)
      .refine((s) => s.trim().length > 0, 'body is required'),
  })
  .strict();

export const EditMessageRequestSchema = PostMessageRequestSchema;

export const MarkReadRequestSchema = z
  .object({
    seq: z.number().int().min(0).optional().openapi({
      description: 'Read up to this seq. Defaults to the channel tail. Never moves backwards.',
    }),
  })
  .strict();

export const NotifyLevelRequestSchema = z.object({ notifyLevel: NotifyLevelSchema }).strict();

export const MuteRequestSchema = z
  .object({
    mutedUntil: z.string().datetime({ offset: true }).nullable().openapi({
      description: 'ISO timestamp the mute expires; null unmutes.',
    }),
  })
  .strict();

export const SearchRefsQuerySchema = z.object({
  trigger: z.enum(['@', '#']).openapi({
    description: '`@` finds users and agents; `#` finds cards, sessions, support tickets and PRs.',
  }),
  q: z.string().max(200).optional().openapi({
    description: 'Typed text after the trigger. Cards match `PREFIX-N`; PRs match `project#N`.',
  }),
});

export const ResolveRefsRequestSchema = z
  .object({
    refs: z
      .array(
        z
          .object({ kind: RefKindSchema, targetId: z.string().min(1).max(HUB_CHAT_REF_MAX_ID) })
          .strict(),
      )
      .max(200),
  })
  .strict();

const RefSuggestionComponent = registerComponent(
  'HubChatRefSuggestion',
  z
    .object({
      kind: RefKindSchema,
      targetId: z.string(),
      label: z.string().openapi({ description: 'Text the composer inserts after the trigger.' }),
      detail: z.string().nullable(),
      projectId: z.string().nullable(),
    })
    .openapi({ description: 'One composer autocomplete row.' }),
);

const ResolvedRefComponent = registerComponent(
  'HubChatResolvedRef',
  z
    .object({
      kind: RefKindSchema,
      targetId: z.string(),
      visible: z.boolean().openapi({
        description: 'False when the caller cannot open the target; render the label only.',
      }),
      projectId: z.string().nullable(),
      label: z.string().nullable(),
      title: z.string().nullable(),
      status: z.string().nullable().openapi({
        description: 'Card column, PR status, session state or ticket status.',
      }),
      agentId: z.string().nullable(),
      number: z.number().int().nullable(),
    })
    .openapi({ description: 'Live detail for one message ref, as the caller sees it.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const channelParams = z.object({ channelId: z.string().openapi({ description: 'Channel id.' }) });
const memberParams = channelParams.extend({
  userId: z.string().openapi({ description: 'User id.' }),
});
const messageParams = z.object({ messageId: z.string().openapi({ description: 'Message id.' }) });

const common = {
  401: errorResponse('Authentication required, or the caller has no user identity.'),
  403: errorResponse('Caller is not a member of the active org.'),
};
const commonNo403 = { 401: common[401] };
const notFound = errorResponse(
  'Channel not found, or private and the caller is not a member (hidden as 404).',
);

const channelEnvelope = z.object({ channel: HubChatChannelComponent });
const messageEnvelope = z.object({ message: HubChatMessageComponent });
const membershipEnvelope = z.object({ membership: MembershipComponent });

registerPath({
  method: 'get',
  path: '/api/chat/members',
  tags: [TAG],
  summary: 'List org members (DM and invite picker)',
  responses: {
    200: {
      description: 'Members of the active org.',
      content: jsonContent(z.object({ members: z.array(OrgMemberComponent) })),
    },
    ...common,
  },
});

registerPath({
  method: 'get',
  path: '/api/chat/channels',
  tags: [TAG],
  summary: "List the caller's channels with unread and mention counts",
  request: { query: ListChannelsQuerySchema },
  responses: {
    200: {
      description: 'Channels the caller belongs to in the active org.',
      content: jsonContent(
        z.object({
          channels: z.array(HubChatChannelComponent),
          viewerUserId: z.string().openapi({
            description: 'The user the caller acts as, for telling own messages apart.',
          }),
        }),
      ),
    },
    ...common,
  },
});

registerPath({
  method: 'get',
  path: '/api/chat/channels/browse',
  tags: [TAG],
  summary: 'List public channels the caller can join',
  responses: {
    200: {
      description: 'Public, unarchived channels in the active org the caller has not joined.',
      content: jsonContent(z.object({ channels: z.array(HubChatChannelComponent) })),
    },
    ...common,
  },
});

registerPath({
  method: 'post',
  path: '/api/chat/channels',
  tags: [TAG],
  summary: 'Create a channel or group',
  request: { body: { content: jsonContent(CreateChannelRequestSchema) } },
  responses: {
    201: {
      description: 'Created; the caller is the owner.',
      content: jsonContent(channelEnvelope),
    },
    400: errorResponse('Validation failed, or a member is not in the org.'),
    ...common,
  },
});

registerPath({
  method: 'post',
  path: '/api/chat/dms',
  tags: [TAG],
  summary: 'Open (get or create) a DM with an org member',
  request: { body: { content: jsonContent(CreateDmRequestSchema) } },
  responses: {
    200: { description: 'The existing DM.', content: jsonContent(channelEnvelope) },
    201: { description: 'A new DM.', content: jsonContent(channelEnvelope) },
    400: errorResponse('The user is not a member of the org.'),
    ...common,
  },
});

registerPath({
  method: 'get',
  path: '/api/chat/channels/{channelId}',
  tags: [TAG],
  summary: 'Get a channel and its members',
  request: { params: channelParams },
  responses: {
    200: {
      description: 'The channel.',
      content: jsonContent(
        z.object({ channel: HubChatChannelComponent, members: z.array(HubChatMemberComponent) }),
      ),
    },
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'patch',
  path: '/api/chat/channels/{channelId}',
  tags: [TAG],
  summary: 'Rename a channel or change its topic',
  request: { params: channelParams, body: { content: jsonContent(UpdateChannelRequestSchema) } },
  responses: {
    200: { description: 'The updated channel.', content: jsonContent(channelEnvelope) },
    400: errorResponse('Validation failed, or the channel is a DM.'),
    404: notFound,
    409: errorResponse('The caller has not joined the channel.'),
    ...common,
  },
});

registerPath({
  method: 'post',
  path: '/api/chat/channels/{channelId}/join',
  tags: [TAG],
  summary: 'Join a public channel',
  request: { params: channelParams },
  responses: {
    200: { description: 'Joined (idempotent).', content: jsonContent(channelEnvelope) },
    409: errorResponse('The channel is archived.'),
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'post',
  path: '/api/chat/channels/{channelId}/members',
  tags: [TAG],
  summary: 'Add members to a channel or group',
  request: { params: channelParams, body: { content: jsonContent(AddMembersRequestSchema) } },
  responses: {
    200: {
      description: 'The updated member list.',
      content: jsonContent(z.object({ members: z.array(HubChatMemberComponent) })),
    },
    400: errorResponse('A user is not in the org, or the channel is a DM.'),
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'delete',
  path: '/api/chat/channels/{channelId}/members/{userId}',
  tags: [TAG],
  summary: 'Leave a channel, or remove a member (channel owners only)',
  request: { params: memberParams },
  responses: {
    200: { description: 'Removed.', content: jsonContent(z.object({ ok: z.boolean() })) },
    400: errorResponse('DM membership cannot change.'),
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'get',
  path: '/api/chat/channels/{channelId}/messages',
  tags: [TAG],
  summary: 'Page messages by seq',
  request: { params: channelParams, query: ListMessagesQuerySchema },
  responses: {
    200: {
      description:
        'Messages in ascending seq. hasMore says whether another page exists in the requested direction.',
      content: jsonContent(
        z.object({ messages: z.array(HubChatMessageComponent), hasMore: z.boolean() }),
      ),
    },
    400: errorResponse('Invalid pagination query.'),
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'post',
  path: '/api/chat/channels/{channelId}/messages',
  tags: [TAG],
  summary: 'Post a message',
  description:
    'The body may carry `@[label](kind:id)` refs (kinds user, agent, session, card, ticket, pr; a PR id is `project#number`). The server resolves each as the author: refs the author cannot see are flattened to their label, the rest are stored and returned in `refs`. A user ref counts as a mention for that user.',
  request: { params: channelParams, body: { content: jsonContent(PostMessageRequestSchema) } },
  responses: {
    201: { description: 'Posted.', content: jsonContent(messageEnvelope) },
    400: errorResponse('Validation failed.'),
    409: errorResponse('The channel is archived, or the caller has not joined it.'),
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'get',
  path: '/api/chat/messages/{messageId}',
  tags: [TAG],
  summary: 'Look up one message',
  description:
    'Resolves a message link to its channel and seq. Deleted messages are returned with `deletedAt` set, since they keep their place in the conversation.',
  request: { params: messageParams },
  responses: {
    200: { description: 'The message.', content: jsonContent(messageEnvelope) },
    404: errorResponse('Message not found, or its channel is not visible to the caller.'),
    ...common,
  },
});

registerPath({
  method: 'patch',
  path: '/api/chat/messages/{messageId}',
  tags: [TAG],
  summary: 'Edit your own message',
  description: 'Refs in the new body are re-resolved the same way as on post.',
  request: { params: messageParams, body: { content: jsonContent(EditMessageRequestSchema) } },
  responses: {
    200: { description: 'Edited.', content: jsonContent(messageEnvelope) },
    400: errorResponse('Validation failed.'),
    403: errorResponse('Not in the active org, or the message was written by someone else.'),
    404: errorResponse('Message not found, already deleted, or not visible to the caller.'),
    ...commonNo403,
  },
});

registerPath({
  method: 'delete',
  path: '/api/chat/messages/{messageId}',
  tags: [TAG],
  summary: 'Delete your own message (soft delete)',
  request: { params: messageParams },
  responses: {
    200: { description: 'Deleted; the row keeps its seq.', content: jsonContent(messageEnvelope) },
    403: errorResponse('Not in the active org, or the message was written by someone else.'),
    404: errorResponse('Message not found, already deleted, or not visible to the caller.'),
    ...commonNo403,
  },
});

registerPath({
  method: 'post',
  path: '/api/chat/channels/{channelId}/read',
  tags: [TAG],
  summary: 'Mark a channel read',
  request: { params: channelParams, body: { content: jsonContent(MarkReadRequestSchema) } },
  responses: {
    200: {
      description: 'The resulting read pointer.',
      content: jsonContent(z.object({ lastReadSeq: z.number().int() })),
    },
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'put',
  path: '/api/chat/channels/{channelId}/notify-level',
  tags: [TAG],
  summary: 'Set the notification level for a channel',
  request: { params: channelParams, body: { content: jsonContent(NotifyLevelRequestSchema) } },
  responses: {
    200: { description: 'Updated membership.', content: jsonContent(membershipEnvelope) },
    400: errorResponse('Validation failed.'),
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'put',
  path: '/api/chat/channels/{channelId}/mute',
  tags: [TAG],
  summary: 'Mute a channel until a time, or unmute it',
  request: { params: channelParams, body: { content: jsonContent(MuteRequestSchema) } },
  responses: {
    200: { description: 'Updated membership.', content: jsonContent(membershipEnvelope) },
    400: errorResponse('Validation failed.'),
    404: notFound,
    ...common,
  },
});

registerPath({
  method: 'get',
  path: '/api/chat/refs/search',
  tags: [TAG],
  summary: 'Autocomplete mentions and #references for the composer',
  request: { query: SearchRefsQuerySchema },
  responses: {
    200: {
      description: 'Suggestions limited to what the caller can see.',
      content: jsonContent(z.object({ suggestions: z.array(RefSuggestionComponent) })),
    },
    400: errorResponse('Validation failed.'),
    ...common,
  },
});

registerPath({
  method: 'post',
  path: '/api/chat/refs/resolve',
  tags: [TAG],
  summary: 'Resolve message refs to live chip detail for the caller',
  request: { body: { content: jsonContent(ResolveRefsRequestSchema) } },
  responses: {
    200: {
      description: 'One entry per requested ref, in request order.',
      content: jsonContent(z.object({ refs: z.array(ResolvedRefComponent) })),
    },
    400: errorResponse('Validation failed.'),
    ...common,
  },
});
