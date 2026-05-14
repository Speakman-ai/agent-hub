/**
 * Zod schemas + OpenAPI registrations for the post-scaffold audit + roster
 * route group.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'AuditErrorResponse',
  z
    .object({
      error: z.string(),
      details: z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          }),
        )
        .optional(),
    })
    .openapi({ description: 'Error envelope for audit/roster routes.' }),
);

// The audit report shape is owned by the audit service and stored as a
// JSON blob — keep it open at the OpenAPI layer.
export const AuditReportComponent = registerComponent(
  'AuditReport',
  z.object({}).passthrough().openapi({
    description:
      'Post-scaffold audit report. Concrete shape lives in `server/audit/audit-service.ts`.',
  }),
);

const TrackInput = z.object({
  id: z.string().min(1, 'id must be a non-empty string'),
  label: z.string().optional(),
  agentId: z.string().nullable().optional(),
  custom: z.boolean().optional(),
});

const ResolvedTrack = z.object({
  id: z.string(),
  label: z.string(),
  agentId: z.string(),
  custom: z.boolean(),
});

export const TrackSuggestionComponent = registerComponent(
  'TrackSuggestion',
  z
    .object({
      id: z.string(),
      label: z.string(),
      agentId: z.string().nullable(),
      score: z.number().optional(),
    })
    .passthrough()
    .openapi({ description: 'Keyword-matched track → agent suggestion.' }),
);

export const PostRosterRequestSchema = z.object({
  tracks: z.array(TrackInput).min(1, 'invalid payload: no usable tracks').openapi({
    description:
      'Each track must have **either** a non-empty `agentId` XOR `custom: true` (not both, not neither).',
  }),
});

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug or id.' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/audit',
  tags: ['Audit'],
  summary: 'Read the latest persisted audit report',
  request: { params: projectIdParams },
  responses: {
    200: { description: 'Audit report.', content: jsonContent(AuditReportComponent) },
    404: errorResponse('No audit yet — POST /audit/refresh to generate one.'),
    500: errorResponse('Stored report is corrupt JSON.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/audit/refresh',
  tags: ['Audit'],
  summary: 'Regenerate the audit report and persist it',
  request: { params: projectIdParams },
  responses: {
    200: { description: 'Fresh audit report.', content: jsonContent(AuditReportComponent) },
    404: errorResponse('Project not found.'),
    500: errorResponse('Audit run failed.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/roster/suggest',
  tags: ['Audit'],
  summary: 'Suggest a track → agent roster',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Suggested tracks.',
      content: jsonContent(z.object({ tracks: z.array(TrackSuggestionComponent) })),
    },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/roster',
  tags: ['Audit'],
  summary: 'Read back the persisted roster',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Persisted roster.',
      content: jsonContent(
        z.object({
          tracks: z.array(ResolvedTrack),
          updatedAt: z.string(),
        }),
      ),
    },
    404: errorResponse('Roster not set.'),
    500: errorResponse('Stored roster is corrupt.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/roster',
  tags: ['Audit'],
  summary: 'Persist the user-chosen roster (and create custom agents)',
  description:
    'Custom tracks (`custom: true`) get a freshly-created agent row id `<projectId>-<trackId>`. Idempotent: re-running with the same custom track refreshes label/role rather than colliding. AGENTS.md in the project workspace is rewritten between roster markers.',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(PostRosterRequestSchema) },
  },
  responses: {
    200: {
      description: 'Persisted roster (echoes resolved tracks).',
      content: jsonContent(
        z.object({
          tracks: z.array(ResolvedTrack),
          updatedAt: z.string(),
        }),
      ),
    },
    400: errorResponse('Invalid payload (XOR violation, unknown agentId, etc.).'),
    404: errorResponse('Project not found.'),
  },
});
