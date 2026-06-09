/**
 * Zod schemas + OpenAPI registrations for the projects route group.
 *
 * Most of `server/routes/projects.ts` is still on the legacy
 * hand-rolled-validation path (see the `allowed_unregistered: 14` entry
 * in `scripts/openapi-coverage-baseline.json`). This file registers the
 * routes that have been brought up to the schema-first contract — new
 * routes land here so they don't push the baseline upward.
 *
 * Add a `registerPath` block here whenever you add a new project route,
 * then re-run `npm run generate:openapi` to refresh
 * `docs/api/openapi.yaml`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Component schemas ────────────────────────────────────────────

export const ProjectOrderRequestSchema = z
  .object({
    projectIds: z.array(z.string().min(1, 'projectIds must contain non-empty strings')).openapi({
      description:
        'Permutation of the caller-visible project ids. Must cover the same set GET /api/projects returns for this user — no missing ids, no extras, no duplicates.',
    }),
  })
  .openapi({
    description: 'Body for PUT /api/projects/order — the new project order.',
  });

export const ProjectOrderResponseComponent = registerComponent(
  'ProjectOrderResponse',
  z
    .object({
      projectIds: z.array(z.string()).openapi({
        description:
          'Caller-visible project ids in their persisted order after the reorder commit.',
      }),
    })
    .openapi({
      description:
        'Confirmation of the new project order. Mirrors the visibility-filtered slice the caller would see from GET /api/projects.',
    }),
);

export const ProjectOrderErrorComponent = registerComponent(
  'ProjectOrderErrorResponse',
  z
    .object({
      error: z.string(),
    })
    .openapi({
      description:
        'Error envelope returned when the reorder payload is malformed or references projects the caller cannot see.',
    }),
);

// ProjectDetail — minimal partial schema documenting only the fields
// callers should be able to rely on at the OpenAPI contract layer. The
// full Project shape (agents, githubWorkflow, prEnv, ...) is huge and
// still on the hand-rolled validation path; rather than capture every
// field today we passthrough() unknown keys so this registration is
// strictly additive — extra fields a client sees in the wire response
// stay valid. A future "schematise the rest of Project" follow-up can
// grow this object without breaking existing consumers.
export const ProjectDetailComponent = registerComponent(
  'ProjectDetail',
  z
    .object({
      id: z.string().openapi({ description: 'Project slug — unique within the install.' }),
      name: z.string().openapi({ description: 'Human-readable project name.' }),
      cwd: z
        .string()
        .optional()
        .openapi({ description: 'Absolute path to the project working directory on disk.' }),
      githubRepo: z.string().optional().nullable().openapi({
        description:
          'GitHub repo in `owner/repo` form (e.g. `Speakman-ai/agent-hub`). Empty/null when the project has no GitHub remote.',
      }),
    })
    .passthrough()
    .openapi({
      description:
        'Project detail response. Includes the full Project shape stored in `projects.json`. Additional fields beyond the documented ones (agents, githubWorkflow, prEnv, …) flow through via passthrough — schematise as that legacy surface migrates onto the schema-first contract.',
    }),
);

export const ProjectDetailErrorComponent = registerComponent(
  'ProjectDetailErrorResponse',
  z
    .object({
      error: z.string(),
    })
    .openapi({
      description: 'Error envelope returned when the project slug is unknown.',
    }),
);

// ─── Path registrations ───────────────────────────────────────────

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

// PUT /api/projects/order
registerPath({
  method: 'put',
  path: '/api/projects/order',
  tags: ['Projects'],
  summary: 'Reorder the caller-visible project list',
  description:
    'Reorders `projects.json` so the caller-visible slice matches the supplied id list. ' +
    'Projects the caller cannot see (e.g. private projects owned by other users) keep their absolute slot — only the visible subset is permuted. ' +
    'Broadcasts `projects_updated` over the WebSocket on success so other open clients refresh their sidebars.',
  request: {
    body: { content: jsonContent(ProjectOrderRequestSchema) },
  },
  responses: {
    200: {
      description: 'Reorder accepted; returns the new caller-visible order.',
      content: jsonContent(ProjectOrderResponseComponent),
    },
    400: {
      description:
        'Validation failed — body shape was wrong, an id was unknown or inaccessible, an id was missing, or duplicates were supplied.',
      content: jsonContent(ProjectOrderErrorComponent),
    },
  },
});

// GET /api/projects/:projectId
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}',
  tags: ['Projects'],
  summary: 'Get a single project by slug',
  description:
    'Returns the full project record from `projects.json`. ' +
    'The response is a superset of the `Project` row shape — extra fields flow through via `passthrough()` while the schema-first migration is in progress. ' +
    'Visibility-filtered: private projects only resolve for their owner (and the local-bypass / Owner-via-admin paths); other callers see a 404.',
  request: {
    params: z.object({
      projectId: z.string().openapi({ description: 'Project slug (e.g. `agent-hub`).' }),
    }),
  },
  responses: {
    200: {
      description: 'Project detail.',
      content: jsonContent(ProjectDetailComponent),
    },
    404: {
      description: 'No project with this slug, or the caller cannot see it.',
      content: jsonContent(ProjectDetailErrorComponent),
    },
  },
});
