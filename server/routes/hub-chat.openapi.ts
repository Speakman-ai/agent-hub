/**
 * Zod schemas + OpenAPI registrations for Agent Hub chat (`/api/chat/*`,
 * `server/routes/hub-chat.ts`). The route file validates request bodies and
 * queries with the schemas exported here, so the documented contract and the
 * enforced one are the same objects.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { HUB_CHAT_REF_MAX_ID } from '../../shared/utils/hubChatRefTokens.js';
import {
  MAX_CHAT_DIGEST_PROJECTS,
  MAX_CHAT_DIGEST_PROMPT_CHARS,
} from '../../shared/utils/chatDigest.js';

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

const AgentStateComponent = registerComponent(
  'HubChatAgentState',
  z.object({
    sessionId: z.string().nullable().openapi({
      description: 'The session posts run in; null until the first post.',
    }),
    sessionName: z.string().nullable(),
    running: z.boolean().openapi({ description: 'True while the agent is answering a post.' }),
  }),
);

const MentionPendingComponent = registerComponent(
  'HubChatMentionPending',
  z.object({
    agentId: z.string(),
    agentName: z.string(),
    sessionId: z.string().nullable().openapi({
      description: 'The session answering; null until it is known.',
    }),
  }),
);

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
      agentState: AgentStateComponent.nullable().openapi({
        description: 'Agent channels only: the linked session and whether it is working.',
      }),
      mentionPending: z.array(MentionPendingComponent).nullable().openapi({
        description:
          'Channels, groups and DMs: agents an `@` mention asked that have not answered yet. Null for other kinds. Live updates arrive as `hub_chat_channel_update` with reason `mention_state`.',
      }),
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

const ReactionComponent = registerComponent(
  'HubChatReaction',
  z
    .object({
      emoji: z.string(),
      count: z.number().int(),
      userIds: z.array(z.string()).openapi({ description: 'Who reacted, earliest first.' }),
    })
    .openapi({ description: 'One emoji on a message and who reacted with it.' }),
);

const PinInfoComponent = registerComponent(
  'HubChatPinInfo',
  z
    .object({ byUserId: z.string().nullable(), at: z.string() })
    .openapi({ description: 'Who pinned the message, and when.' }),
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
      metaRev: z.number().int().openapi({
        description:
          'Revision of `reactions` and `pinned`, bumped on every change. Keep the copy with the higher value.',
      }),
      reactions: z.array(ReactionComponent),
      pinned: PinInfoComponent.nullable(),
    })
    .openapi({ description: 'One chat message. Deleted messages keep their seq.' }),
);

export const MessageMetaComponent = registerComponent(
  'HubChatMessageMeta',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      metaRev: z.number().int(),
      reactions: z.array(ReactionComponent),
      pinned: PinInfoComponent.nullable(),
    })
    .openapi({
      description:
        'Reaction and pin state of one message. Same shape as the `hub_chat_message_meta` WebSocket event.',
    }),
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
    kind: z.enum(['channel', 'group', 'agent']).default('channel'),
    name: z.string().trim().max(MAX_NAME).optional().openapi({
      description: "Required for a channel. An agent channel defaults to the agent's name.",
    }),
    topic: z.string().trim().max(MAX_TOPIC).nullable().optional(),
    isPrivate: z.boolean().optional().openapi({
      description: 'Channels and agent channels; groups are always private.',
    }),
    projectId: z.string().min(1).max(200).optional().openapi({
      description: 'Agent channels: the project the agent belongs to.',
    }),
    agentId: z.string().min(1).max(200).optional().openapi({
      description: "Agent channels: the agent whose session answers the channel's posts.",
    }),
    memberUserIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict()
  .refine((v) => v.kind !== 'channel' || (v.name ?? '').length > 0, {
    message: 'name is required for a channel',
    path: ['name'],
  })
  .refine((v) => v.kind !== 'agent' || (Boolean(v.projectId) && Boolean(v.agentId)), {
    message: 'projectId and agentId are required for an agent channel',
    path: ['agentId'],
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

// Exactly one emoji sequence: a keycap, a flag (two regional indicators), or
// a pictograph with an optional presentation selector or skin tone, optional
// tag sequence (subdivision flags), and further pictographs only when joined
// by a ZWJ. Concatenated emoji and stray components (digits, lone modifiers)
// are refused.
const EMOJI_ELEMENT = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?`;
const EMOJI_RE = new RegExp(
  String.raw`^(?:[0-9#*]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|` +
    String.raw`${EMOJI_ELEMENT}(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D${EMOJI_ELEMENT})*)$`,
  'u',
);

export const EmojiSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine((v) => EMOJI_RE.test(v), { message: 'emoji must be a single emoji' })
  .openapi({ description: 'One emoji, e.g. 👍.', example: '👍' });

export const ReactionRequestSchema = z.object({ emoji: EmojiSchema }).strict();
export const RemoveReactionQuerySchema = z.object({ emoji: EmojiSchema });

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

export const SearchMessagesQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).openapi({
    description:
      'Words to find. Every word must appear (each matches as a prefix); punctuation is ignored.',
  }),
  channelId: z.string().min(1).optional().openapi({
    description: 'Only search this channel.',
  }),
  limit: z.coerce.number().int().min(1).max(50).optional().openapi({
    description: 'Max results, 1..50 (default 20).',
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
  summary: 'Create a channel, group, or agent channel',
  description:
    'An agent channel (`kind: agent`) binds a project agent (`projectId` + `agentId`); posts in it run in one shared session owned by the creator.',
  request: { body: { content: jsonContent(CreateChannelRequestSchema) } },
  responses: {
    201: {
      description: 'Created; the caller is the owner.',
      content: jsonContent(channelEnvelope),
    },
    400: errorResponse(
      'Validation failed, a member is not in the org, or the agent cannot host a chat session.',
    ),
    404: errorResponse('Agent channel: the project or agent was not found or is not visible.'),
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
  method: 'post',
  path: '/api/chat/summary-channel',
  tags: [TAG],
  summary: "Open (get or create) the caller's Summaries channel",
  responses: {
    200: { description: 'The existing Summaries channel.', content: jsonContent(channelEnvelope) },
    201: { description: 'A new Summaries channel.', content: jsonContent(channelEnvelope) },
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
    "The body may carry `@[label](kind:id)` refs (kinds user, agent, session, card, ticket, pr; a PR id is `project#number`). The server resolves each as the author: refs the author cannot see are flattened to their label, the rest are stored and returned in `refs`. A user ref counts as a mention for that user. In an agent channel a member's post also runs in the channel's session (dispatched on first post, continued after); the agent's reply is posted back as an agent message with a session ref.",
  request: { params: channelParams, body: { content: jsonContent(PostMessageRequestSchema) } },
  responses: {
    201: {
      description: 'Posted.',
      content: jsonContent(
        messageEnvelope.extend({
          agentSessionId: z.string().nullable().optional().openapi({
            description: 'Agent channels: the session the post was handed to, when it started.',
          }),
          mentionSessions: z
            .array(z.object({ agentId: z.string(), sessionId: z.string().nullable() }))
            .optional()
            .openapi({
              description:
                'Channels, groups and DMs: each `@agent` the post dispatched (at most 3) and the poster-owned session it runs in. Null when it failed to start; the channel gets a notice.',
            }),
          mentionNotices: z
            .array(
              z.object({
                agentId: z.string(),
                code: z.enum(['mention_forbidden', 'mention_not_eligible', 'mention_limit']),
                message: z.string(),
              }),
            )
            .optional()
            .openapi({
              description:
                'Mentions that were not dispatched. Shown only to the poster (also sent live as `hub_chat_notice`) and never stored.',
            }),
        }),
      ),
    },
    400: errorResponse('Validation failed.'),
    403: errorResponse(
      "Caller is not a member of the active org, or (agent channel) cannot see the channel's project.",
    ),
    409: errorResponse('The channel is archived, or the caller has not joined it.'),
    404: notFound,
    ...commonNo403,
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
  description:
    "Also marks the caller's DM and mention inbox rows for messages up to the new pointer read, emitting `notification_read` to the caller's clients when any flipped.",
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

const SearchHitComponent = registerComponent(
  'HubChatSearchHit',
  z.object({
    message: HubChatMessageComponent,
    channel: z.object({
      id: z.string(),
      kind: ChannelKindSchema,
      name: z.string(),
      dmPeerUserId: z.string().nullable(),
      isPrivate: z.boolean(),
      isMember: z.boolean().openapi({
        description: 'False for a public channel the caller has not joined.',
      }),
    }),
  }),
);

registerPath({
  method: 'get',
  path: '/api/chat/search',
  tags: [TAG],
  summary: 'Search messages',
  description:
    "Full-text search over live messages in the caller's active org, newest first. Only channels the caller can read are searched: public channels and the private channels, groups and DMs they belong to.",
  request: { query: SearchMessagesQuerySchema },
  responses: {
    200: {
      description: 'Matching messages with their channel. hasMore says more matches exist.',
      content: jsonContent(
        z.object({ results: z.array(SearchHitComponent), hasMore: z.boolean() }),
      ),
    },
    400: errorResponse('Validation failed.'),
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

export const BacklinkKindSchema = z.enum(['card', 'pr', 'session', 'ticket']);

export const ListBacklinksQuerySchema = z.object({
  kind: BacklinkKindSchema,
  targetId: z.string().min(1).max(HUB_CHAT_REF_MAX_ID).openapi({
    description: 'Row id; for a PR, `<projectId>#<number>`.',
  }),
  limit: z.coerce.number().int().min(1).max(100).optional().openapi({
    description: 'Most recent messages to return (default 20).',
  }),
});

const BacklinkComponent = registerComponent(
  'HubChatBacklink',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      channelKind: ChannelKindSchema,
      channelLabel: z.string().openapi({
        description: 'Display name: `# name` for channels, the peer for a DM.',
      }),
      authorKind: AuthorKindSchema,
      authorName: z.string().nullable(),
      excerpt: z.string().openapi({ description: 'Plain-text preview of the message.' }),
      createdAt: z.string(),
    })
    .openapi({ description: 'A chat message that references the entity.' }),
);

registerPath({
  method: 'get',
  path: '/api/chat/backlinks',
  tags: [TAG],
  summary: 'List chat messages that reference a card, PR, session or ticket',
  description:
    'Newest first. Only messages in channels the caller can read (public channels and ones they belong to) are returned, and none when the caller cannot see the entity itself. Trigger posts are excluded.',
  request: { query: ListBacklinksQuerySchema },
  responses: {
    200: {
      description: 'Backlinks visible to the caller.',
      content: jsonContent(
        z.object({ target: ResolvedRefComponent, backlinks: z.array(BacklinkComponent) }),
      ),
    },
    400: errorResponse('Validation failed.'),
    ...common,
  },
});

export const DigestScopeSchema = z.enum(['channel', 'project', 'my_work']);

/** Mirrors `MAX_DIGESTS_PER_CHANNEL` in `hub-chat-digests-store.ts`. */
const MAX_DIGESTS_PER_CHANNEL = 10;

export const ChannelDigestComponent = registerComponent(
  'HubChatChannelDigest',
  z
    .object({
      id: z.string(),
      channelId: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      cron: z.string().openapi({
        description:
          'One or more 5-field cron expressions joined by ` | `, read in `timeZone`. The digest runs whenever any of them fires.',
      }),
      timeZone: z.string().openapi({ description: 'IANA timezone the cron is read in.' }),
      scope: DigestScopeSchema.openapi({
        description:
          "`channel` summarizes this channel's messages since the last run; `project` summarizes a project's activity; `my_work` summarizes the owner's own sessions, assigned cards and todos, and is only allowed on the owner's own Summaries channel.",
      }),
      projectIds: z.array(z.string()).openapi({
        description:
          'Projects a `project` digest summarizes (1 to 10); empty for `channel`. Projects the owner can no longer view are left out of a run with a note.',
      }),
      prompt: z.string().nullable().openapi({
        description: 'Custom instructions for the summary, or null for the default.',
      }),
      ownerUserId: z.string().openapi({
        description: 'User whose engine credentials and access the digest runs on (last editor).',
      }),
      windowStart: z.string().openapi({
        description:
          'Start of the span the next run summarizes. Moves only when a run posts or skips, so a failed span is retried.',
      }),
      lastRunAt: z.string().nullable().openapi({
        description: 'End of the last window that was posted or skipped as empty.',
      }),
      lastStatus: z.enum(['posted', 'skipped', 'error']).nullable(),
      lastError: z.string().nullable(),
      lastMessageId: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({ description: 'Scheduled AI digest posted into a channel as a system message.' }),
);

export const SaveDigestRequestSchema = z
  .object({
    name: z.string().trim().max(80).optional().openapi({
      description: 'Display name; defaults from the scope when blank.',
    }),
    enabled: z.boolean().default(true),
    cron: z.string().trim().min(1).max(600).openapi({
      description:
        'Up to 12 5-field cron expressions joined by `|`; the digest runs whenever any fires.',
    }),
    timeZone: z.string().trim().min(1).max(64),
    scope: DigestScopeSchema,
    projectIds: z
      .array(z.string().trim().min(1).max(200))
      .max(MAX_CHAT_DIGEST_PROJECTS)
      .optional()
      .openapi({
        description: `Required (1 to ${MAX_CHAT_DIGEST_PROJECTS} projects) when \`scope\` is \`project\`; ignored otherwise. The caller must be able to view every one.`,
      }),
    prompt: z.string().trim().max(MAX_CHAT_DIGEST_PROMPT_CHARS).nullable().optional().openapi({
      description:
        'Custom instructions that replace the default instruction paragraph. The window, the facts and the framing around them stay fixed. Null or blank restores the default; omitted on PUT keeps the saved prompt.',
    }),
  })
  .strict();

export type SaveDigestRequest = z.infer<typeof SaveDigestRequestSchema>;

const digestParams = channelParams.extend({ digestId: z.string().min(1) });
const digestEnvelope = z.object({ digest: ChannelDigestComponent });

/**
 * Digest routes answer under the Hub Chat prefix `/api/chat` and under
 * `/api/hub-chat`, the path the digest contract was specified with.
 */
export const DIGEST_ROUTE_PREFIXES = ['/api/chat', '/api/hub-chat'] as const;

for (const prefix of DIGEST_ROUTE_PREFIXES) {
  registerPath({
    method: 'get',
    path: `${prefix}/channels/{channelId}/digests`,
    tags: [TAG],
    summary: "List a channel's scheduled digests",
    request: { params: channelParams },
    responses: {
      200: {
        description: 'Digests, oldest first.',
        content: jsonContent(z.object({ digests: z.array(ChannelDigestComponent) })),
      },
      404: notFound,
      ...common,
    },
  });

  registerPath({
    method: 'post',
    path: `${prefix}/channels/{channelId}/digests`,
    tags: [TAG],
    summary: 'Add a scheduled digest to a channel',
    description: `Members only, at most ${MAX_DIGESTS_PER_CHANNEL} per channel. The caller becomes the digest owner: runs use their engine credentials, and a project digest requires that they can view the project.`,
    request: { params: channelParams, body: { content: jsonContent(SaveDigestRequestSchema) } },
    responses: {
      201: { description: 'The created digest.', content: jsonContent(digestEnvelope) },
      400: errorResponse(
        "Invalid cron, timezone or prompt, a missing project, a project the caller cannot view, or `my_work` outside the caller's own Summaries channel (`my_work_not_allowed`).",
      ),
      404: errorResponse('Channel not found.'),
      409: errorResponse('Not joined, the channel is archived, or it already has the maximum.'),
      ...common,
    },
  });

  registerPath({
    method: 'put',
    path: `${prefix}/channels/{channelId}/digests/{digestId}`,
    tags: [TAG],
    summary: 'Replace a scheduled digest',
    description:
      'Members only. The caller becomes the digest owner. Editing keeps the window cursor; re-enabling a paused digest restarts it.',
    request: { params: digestParams, body: { content: jsonContent(SaveDigestRequestSchema) } },
    responses: {
      200: { description: 'The saved digest.', content: jsonContent(digestEnvelope) },
      400: errorResponse(
        "Invalid cron, timezone or prompt, a missing project, a project the caller cannot view, or `my_work` outside the caller's own Summaries channel (`my_work_not_allowed`).",
      ),
      404: errorResponse('Channel or digest not found.'),
      409: errorResponse('Not joined, or the channel is archived.'),
      ...common,
    },
  });

  registerPath({
    method: 'delete',
    path: `${prefix}/channels/{channelId}/digests/{digestId}`,
    tags: [TAG],
    summary: 'Remove a scheduled digest',
    request: { params: digestParams },
    responses: {
      200: { description: 'Removed.', content: jsonContent(z.object({ ok: z.literal(true) })) },
      404: errorResponse('Channel or digest not found.'),
      409: errorResponse('Not joined.'),
      ...common,
    },
  });

  registerPath({
    method: 'post',
    path: `${prefix}/channels/{channelId}/digests/{digestId}/run`,
    tags: [TAG],
    summary: 'Run a scheduled digest now',
    description:
      "Members only. Runs on the digest owner's credentials over the window since the last run, exactly as a scheduled run would: an empty window posts nothing.",
    request: { params: digestParams },
    responses: {
      200: {
        description: 'The run outcome and the digest after it.',
        content: jsonContent(
          z.object({
            result: z.object({
              status: z.enum(['posted', 'skipped', 'cancelled', 'error']),
              messageId: z.string().optional(),
              reason: z.string().optional(),
              error: z.string().optional(),
            }),
            digest: ChannelDigestComponent.nullable(),
          }),
        ),
      },
      404: errorResponse('Channel or digest not found.'),
      409: errorResponse('Not joined, the channel is archived, or the digest is already running.'),
      ...common,
    },
  });
}

const metaEnvelope = z.object({ meta: MessageMetaComponent });
const reactionResponses = {
  200: {
    description: "The message's reactions and pin state.",
    content: jsonContent(metaEnvelope),
  },
  400: errorResponse(
    'Not a single emoji, or the message already has the most distinct emoji allowed.',
  ),
  404: errorResponse('Message not found, deleted, or not visible to the caller.'),
  409: errorResponse('Join the channel first, or the channel is archived.'),
  ...common,
};

registerPath({
  method: 'put',
  path: '/api/chat/messages/{messageId}/reactions',
  tags: [TAG],
  summary: 'Add your reaction to a message',
  description:
    "Idempotent. Members of the message's channel get a `hub_chat_message_meta` event with the new state.",
  request: { params: messageParams, body: { content: jsonContent(ReactionRequestSchema) } },
  responses: reactionResponses,
});

registerPath({
  method: 'delete',
  path: '/api/chat/messages/{messageId}/reactions',
  tags: [TAG],
  summary: 'Remove your reaction from a message',
  request: { params: messageParams, query: RemoveReactionQuerySchema },
  responses: reactionResponses,
});

const pinResponses = {
  200: {
    description: "The message's reactions and pin state.",
    content: jsonContent(metaEnvelope),
  },
  404: errorResponse('Message not found, deleted, or not visible to the caller.'),
  409: errorResponse('Join the channel first, or the channel is archived.'),
  ...common,
};

registerPath({
  method: 'put',
  path: '/api/chat/messages/{messageId}/pin',
  tags: [TAG],
  summary: 'Pin a message in its channel',
  description: 'Any channel member can pin. Idempotent.',
  request: { params: messageParams },
  responses: pinResponses,
});

registerPath({
  method: 'delete',
  path: '/api/chat/messages/{messageId}/pin',
  tags: [TAG],
  summary: 'Unpin a message',
  description: 'Any channel member can unpin. Idempotent.',
  request: { params: messageParams },
  responses: pinResponses,
});

registerPath({
  method: 'get',
  path: '/api/chat/channels/{channelId}/pins',
  tags: [TAG],
  summary: "List a channel's pinned messages",
  description: 'Most recently pinned first. Deleted messages drop off the list.',
  request: { params: channelParams },
  responses: {
    200: {
      description: 'Pinned messages.',
      content: jsonContent(
        z.object({
          pins: z.array(
            z.object({
              message: HubChatMessageComponent,
              pinnedByUserId: z.string().nullable(),
              pinnedAt: z.string(),
            }),
          ),
        }),
      ),
    },
    404: notFound,
    ...common,
  },
});
