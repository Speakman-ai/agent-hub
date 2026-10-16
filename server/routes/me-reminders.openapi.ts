/**
 * Zod schemas + OpenAPI registrations for personal reminders
 * (`server/routes/me-reminders.ts`). The route file validates request bodies
 * with the schemas exported here.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { MAX_NOTES_LENGTH, MAX_TITLE_LENGTH, REMINDER_STATUSES } from '../reminders-store.js';

const ErrorResponse = registerComponent(
  'MeRemindersErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for reminder routes.' }),
);

const ReminderStatus = z.enum(REMINDER_STATUSES);

export const ReminderComponent = registerComponent(
  'Reminder',
  z
    .object({
      id: z.string(),
      userId: z.string(),
      title: z.string(),
      notes: z.string(),
      remindAt: z.string().openapi({ description: 'ISO-8601 UTC time the reminder fires.' }),
      status: ReminderStatus.openapi({
        description: '`pending` until due, `fired` once notified, `dismissed` when cleared.',
      }),
      createdBy: z.enum(['user', 'agent']),
      sessionId: z.string().nullable().openapi({ description: 'Session that set it, if any.' }),
      agentId: z.string().nullable(),
      projectId: z.string().nullable(),
      calendar: z.object({
        status: z
          .enum([
            'none',
            'pending',
            'synced',
            'updating',
            'skipped',
            'failed',
            'removing',
            'cancelled',
          ])
          .openapi({
            description:
              '`pending` while the event is being created (or the insert is queued for retry), `synced` when mirrored to Google Calendar, `updating` while an edit is being pushed to the event, `skipped` when the calendar was unavailable, `none` when not requested, `failed` when the Google write errored (retried), `removing` when it was dismissed before firing and its event is queued for removal but Google has not confirmed it yet (`error` holds the last failed attempt), `cancelled` once Google confirmed the removal.',
          }),
        calendarId: z.string().nullable(),
        eventId: z.string().nullable(),
        eventUrl: z.string().nullable(),
        error: z.string().nullable(),
      }),
      firedAt: z.string().nullable(),
      dismissedAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      revision: z.number().int().openapi({
        description:
          'Increases on every write to the reminder. Clients keep the higher revision when a list response and a live `reminder_update` disagree.',
      }),
    })
    .openapi({ description: 'A personal reminder that fires into the notification inbox.' }),
);

export const ListRemindersQuerySchema = z.object({
  status: z.string().optional().openapi({
    description:
      'Comma-separated statuses to include (pending, fired, dismissed). Defaults to pending,fired.',
  }),
  sessionId: z.string().optional().openapi({ description: 'Only reminders set by this session.' }),
});

const Title = z.string().trim().min(1).max(MAX_TITLE_LENGTH);
const Notes = z.string().max(MAX_NOTES_LENGTH);
const RemindAt = z.string().openapi({
  description: 'When to fire, as an ISO-8601 date-time with an offset or Z.',
  example: '2026-10-17T09:00:00-07:00',
});
const InMinutes = z
  .number()
  .int()
  .min(1)
  .max(60 * 24 * 366)
  .openapi({ description: 'Alternative to remindAt: fire this many minutes from now.' });

export const CreateReminderRequestSchema = z
  .object({
    title: Title,
    notes: Notes.optional(),
    remindAt: RemindAt.optional(),
    inMinutes: InMinutes.optional(),
    calendar: z.enum(['auto', 'none']).optional().openapi({
      description:
        "`auto` (default) also puts the reminder on the owner's Google Calendar when it is connected; `none` keeps it in Agent Hub only.",
    }),
    sessionId: z.string().optional().openapi({
      description:
        'Link to a session the caller owns. Agent sessions are linked automatically from their spawn credentials or the X-Agent-Hub-Session-Id header.',
    }),
  })
  .strict()
  .refine((v) => (v.remindAt === undefined) !== (v.inMinutes === undefined), {
    message: 'Provide exactly one of remindAt or inMinutes',
  });

export const UpdateReminderRequestSchema = z
  .object({
    title: Title.optional(),
    notes: Notes.optional(),
    remindAt: RemindAt.optional(),
    snoozeMinutes: InMinutes.optional().openapi({
      description: 'Re-arm the reminder this many minutes from now.',
    }),
    status: ReminderStatus.optional(),
  })
  .strict()
  .refine((v) => !(v.remindAt !== undefined && v.snoozeMinutes !== undefined), {
    message: 'remindAt and snoozeMinutes are mutually exclusive',
  });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});
const idParams = z.object({ id: z.string().openapi({ description: 'Reminder id.' }) });

registerPath({
  method: 'get',
  path: '/api/me/reminders',
  tags: ['Personal Reminders'],
  summary: "List the calling user's reminders, soonest first",
  request: { query: ListRemindersQuerySchema },
  responses: {
    200: {
      description: "The caller's reminders.",
      content: jsonContent(z.object({ reminders: z.array(ReminderComponent) })),
    },
    400: errorResponse('Invalid status filter.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/reminders',
  tags: ['Personal Reminders'],
  summary: 'Create a reminder (and mirror it to Google Calendar when available)',
  description:
    'Agents call this from a session to remind the session owner. The reminder fires into the notification inbox (category `reminder`) at `remindAt`.',
  request: { body: { content: jsonContent(CreateReminderRequestSchema) } },
  responses: {
    201: {
      description: 'Created reminder, including the calendar mirror outcome.',
      content: jsonContent(z.object({ reminder: ReminderComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    410: errorResponse(
      'The reminder was deleted by another request before its calendar event finished saving. Nothing was created; any event is queued for removal.',
    ),
  },
});

registerPath({
  method: 'patch',
  path: '/api/me/reminders/{id}',
  tags: ['Personal Reminders'],
  summary: 'Edit, snooze, or dismiss a reminder',
  request: { params: idParams, body: { content: jsonContent(UpdateReminderRequestSchema) } },
  responses: {
    200: {
      description: 'Updated reminder.',
      content: jsonContent(z.object({ reminder: ReminderComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('Reminder not found.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/me/reminders/{id}',
  tags: ['Personal Reminders'],
  summary: 'Delete a reminder and its calendar event',
  request: { params: idParams },
  responses: {
    200: {
      description: 'Deleted.',
      content: jsonContent(
        z.object({
          ok: z.literal(true),
          calendarCleanup: z.enum(['none', 'done', 'pending']).openapi({
            description:
              '`done` when the mirrored calendar event was removed, `pending` when removal failed and is queued for retry, `none` when there was no event.',
          }),
        }),
      ),
    },
    401: errorResponse('Authentication required.'),
    404: errorResponse('Reminder not found.'),
  },
});
