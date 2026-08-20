/**
 * OpenAPI for GET/POST /api/me/daily-summary.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'MeDailySummaryErrorResponse',
  z.object({ error: z.string(), code: z.string().optional() }).openapi({
    description: 'Error envelope for Hub Daily Summary routes.',
  }),
);

const DailySummaryReport = registerComponent(
  'MeDailySummaryReport',
  z
    .object({
      date: z.string(),
      timeZone: z.string(),
      markdown: z.string(),
      engine: z.string(),
      model: z.string(),
      generatedAt: z.string(),
    })
    .openapi({
      description:
        "The calling user's Daily Summary for one local calendar day. Cleared when the date is no longer today.",
    }),
);

const DailySummaryResponse = registerComponent(
  'MeDailySummaryResponse',
  z
    .object({
      date: z.string(),
      timeZone: z.string(),
      report: DailySummaryReport.nullable(),
    })
    .openapi({
      description:
        "Today's Daily Summary for the caller, or report=null when none has been generated yet today.",
    }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/me/daily-summary',
  tags: ['Hub'],
  summary: "Read today's Hub Daily Summary without generating",
  description:
    "Returns the stored Daily Summary when it was generated on the caller's local calendar day (`tz`). " +
    'A leftover report from a previous day is treated as empty (`report: null`). Never spawns a model.',
  request: {
    query: z.object({
      tz: z
        .string()
        .optional()
        .openapi({ description: 'IANA timezone used to resolve "today". Defaults to UTC.' }),
    }),
  },
  responses: {
    200: {
      description: 'Stored report for today, or report=null.',
      content: jsonContent(DailySummaryResponse),
    },
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/daily-summary',
  tags: ['Hub'],
  summary: "Generate (or regenerate) today's Hub Daily Summary",
  description:
    'Gathers today / right-now / yesterday facts for the caller and runs an available, non-erroring engine. ' +
    'Replaces any existing report for the same local day. GET is never enough to spawn this.',
  request: {
    body: {
      content: jsonContent(
        z.object({
          tz: z
            .string()
            .optional()
            .openapi({ description: 'IANA timezone used to resolve "today". Defaults to UTC.' }),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: 'Newly generated report.',
      content: jsonContent(DailySummaryResponse),
    },
    400: errorResponse('Engine credentials missing for this account.'),
    401: errorResponse('Authentication required.'),
    503: errorResponse('No AI engines are configured or available.'),
  },
});
