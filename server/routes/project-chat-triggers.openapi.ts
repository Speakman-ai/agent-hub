/**
 * Zod schemas + OpenAPI registrations for project chat triggers
 * (`server/routes/project-chat-triggers.ts`). The route validates with these
 * same objects.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { CHAT_TRIGGER_EVENTS } from '../../shared/utils/chatTriggers.js';

const TAG = 'Chat Triggers';

const ErrorResponse = registerComponent(
  'ChatTriggerErrorResponse',
  z
    .object({ error: z.string(), code: z.string().optional() })
    .openapi({ description: 'Error envelope for chat trigger routes.' }),
);

export const ChatTriggerEventSchema = z.enum(CHAT_TRIGGER_EVENTS).openapi({
  description:
    'Project event the trigger routes. Session events only post sessions owned by the trigger creator (or unowned ones); private crons likewise.',
});

const shortList = z.array(z.string().trim().min(1).max(200)).max(50);

export const ChatTriggerFilterSchema = z
  .object({
    columns: shortList.optional().openapi({
      description: 'card_created / card_moved: column names (case-insensitive).',
    }),
    epicId: z.string().min(1).max(200).optional().openapi({
      description: 'card_created / card_moved: only cards in this epic.',
    }),
    labels: shortList.optional().openapi({
      description: 'card_created / card_moved: cards with any of these labels.',
    }),
    outcome: z.enum(['pass', 'fail', 'success', 'error']).optional().openapi({
      description: 'finalize_run_completed: pass | fail. cron_finished: success | error.',
    }),
    agentIds: shortList.optional().openapi({
      description: 'Session events: only sessions of these agents.',
    }),
    severities: shortList.optional().openapi({
      description: 'infra_alert: severities (case-insensitive).',
    }),
  })
  .strict();

/** Accepts `AAAA` or `spaces/AAAA`; stored and returned as `AAAA`. */
export const GoogleChatSpaceIdSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/^spaces\//, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'invalid Google Chat space id'))
  .openapi({
    type: 'string',
    description:
      'Google Chat space to also post into, as the trigger creator. `AAAA` or `spaces/AAAA`. Needs the creator to have connected Google with Chat send access.',
  });

const TriggerChannelComponent = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    isPrivate: z.boolean(),
    archived: z.boolean(),
  })
  .openapi({ description: 'Destination channel, as the caller may see it.' });

export const ChatTriggerComponent = registerComponent(
  'ChatTrigger',
  z.object({
    id: z.string(),
    projectId: z.string(),
    event: ChatTriggerEventSchema,
    filter: ChatTriggerFilterSchema,
    channelId: z.string().nullable().openapi({
      description: 'Null when the caller is not a member of the destination channel.',
    }),
    channel: TriggerChannelComponent.nullable().openapi({
      description:
        'Null when the caller is not a member of the destination channel, public or private.',
    }),
    googleChat: z.boolean().openapi({
      description: 'True when the trigger also posts to a Google Chat space.',
    }),
    googleChatSpaceId: z.string().nullable().openapi({
      description:
        "The Google Chat space id. Shown to the trigger's creator only (the space is theirs); null for everyone else.",
    }),
    enabled: z.boolean(),
    createdByUserId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    canManage: z.boolean().openapi({
      description:
        'True when the caller may enable, disable or delete the trigger (creator or org admin). Changing its event, filter or channel is creator-only.',
    }),
  }),
);

export const CreateChatTriggerRequestSchema = z
  .object({
    event: ChatTriggerEventSchema,
    filter: ChatTriggerFilterSchema.optional(),
    enabled: z.boolean().optional(),
    channelId: z.string().min(1).max(200).optional().openapi({
      description: 'Existing channel or group the caller belongs to.',
    }),
    newChannel: z
      .object({
        name: z.string().trim().min(1).max(80),
        isPrivate: z.boolean().optional().openapi({
          description: 'Defaults to private; add members to the channel to share it.',
        }),
      })
      .strict()
      .optional()
      .openapi({ description: 'Create a trigger channel for the project and route into it.' }),
    googleChatSpaceId: GoogleChatSpaceIdSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.channelId) !== Boolean(v.newChannel), {
    message: 'Pass exactly one of channelId or newChannel',
    path: ['channelId'],
  });

export const UpdateChatTriggerRequestSchema = z
  .object({
    event: ChatTriggerEventSchema.optional(),
    filter: ChatTriggerFilterSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    channelId: z.string().min(1).max(200).optional(),
    googleChatSpaceId: z.union([GoogleChatSpaceIdSchema, z.null()]).optional().openapi({
      description: 'Google Chat space to also post into; null removes it. Creator-only.',
    }),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to update',
  });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const projectParams = z.object({ projectId: z.string().openapi({ description: 'Project id.' }) });
const triggerParams = projectParams.extend({
  triggerId: z.string().openapi({ description: 'Trigger id.' }),
});
const common = {
  401: errorResponse('Authentication required, or the caller has no user identity.'),
  403: errorResponse('Caller is not a member of the active org.'),
  404: errorResponse('Project (or trigger) not found.'),
};
const triggerEnvelope = z.object({ trigger: ChatTriggerComponent });

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/chat-triggers',
  tags: [TAG],
  summary: "List a project's chat triggers",
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Triggers, oldest first, plus the suggested name for a first channel.',
      content: jsonContent(
        z.object({
          triggers: z.array(ChatTriggerComponent),
          defaultChannelName: z.string().openapi({ description: 'e.g. `agent-hub-activity`.' }),
        }),
      ),
    },
    ...common,
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/chat-triggers',
  tags: [TAG],
  summary: 'Create a chat trigger',
  description:
    'Routes one project event into a chat channel. Pass `channelId` for a channel the caller belongs to, or `newChannel` to create a trigger channel (e.g. the default `#<project>-activity`).',
  request: {
    params: projectParams,
    body: { content: jsonContent(CreateChatTriggerRequestSchema) },
  },
  responses: {
    201: { description: 'Trigger created.', content: jsonContent(triggerEnvelope) },
    400: errorResponse('Invalid body, or the channel cannot receive triggers.'),
    ...common,
  },
});

registerPath({
  method: 'patch',
  path: '/api/projects/{projectId}/chat-triggers/{triggerId}',
  tags: [TAG],
  summary: 'Update a chat trigger',
  description:
    'Enable/disable (creator or org admin), or change the event, filter or destination channel (creator only).',
  request: {
    params: triggerParams,
    body: { content: jsonContent(UpdateChatTriggerRequestSchema) },
  },
  responses: {
    200: { description: 'Updated trigger.', content: jsonContent(triggerEnvelope) },
    400: errorResponse('Invalid body, or the channel cannot receive triggers.'),
    ...common,
    403: errorResponse(
      'Not the creator or an org admin (`forbidden`), or a non-creator tried to change the event, filter or channel (`creator_only`).',
    ),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/chat-triggers/{triggerId}',
  tags: [TAG],
  summary: 'Delete a chat trigger',
  description: 'The channel and its messages stay.',
  request: { params: triggerParams },
  responses: {
    200: { description: 'Deleted.', content: jsonContent(z.object({ ok: z.literal(true) })) },
    ...common,
    403: errorResponse('Only the creator or an org admin may delete a trigger.'),
  },
});
