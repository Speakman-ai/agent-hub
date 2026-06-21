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
// stay valid and the schema documents the new webhookConfigured field
// that drives the missing-webhook UI banner. A future "schematise the
// rest of Project" follow-up can grow this object without breaking
// existing consumers.
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
      webhookConfigured: z
        .boolean()
        .nullable()
        .openapi({
          description:
            'Whether this project has at least one enabled webhook_configs row. ' +
            '`true` — at least one enabled row delivers events. ' +
            '`false` — `githubRepo` is set but no enabled row exists; PR events will NOT reach the reviewer pipeline. Drives the missing-webhook UI banner. ' +
            '`null` — `githubRepo` is unset (non-GitHub remote or scratch project); webhook config is not applicable.',
        }),
    })
    .passthrough()
    .openapi({
      description:
        'Project detail response. Includes the full Project shape stored in `projects.json` plus the derived `webhookConfigured` flag. Additional fields beyond the documented ones (agents, githubWorkflow, prEnv, …) flow through via passthrough — schematise as that legacy surface migrates onto the schema-first contract.',
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

// ─── Webhook auto-configure ───────────────────────────────────────

export const WebhookConfigRowSchema = registerComponent(
  'WebhookConfigRow',
  z
    .object({
      id: z.number(),
      project_id: z.string(),
      repo_url: z.string(),
      secret: z.string().nullable(),
      events: z.string().openapi({ description: 'JSON-encoded event-toggle map.' }),
      enabled: z.number().openapi({ description: '1 if enabled, 0 if disabled.' }),
      author_allowlist: z.string().openapi({
        description: 'JSON-encoded array of GitHub logins whose PRs trigger the reviewer.',
      }),
      created_at: z.string(),
      updated_at: z.string().nullable(),
    })
    .openapi({ description: 'Persisted webhook_configs row.' }),
);

export const WebhookRegistrationResultSchema = registerComponent(
  'WebhookRegistrationResult',
  z
    .union([
      z.object({
        ok: z.literal(true),
        skipped: z.literal(true).optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
        hookId: z.number().optional(),
        url: z.string().optional(),
        events: z.array(z.string()).optional(),
        updated: z.boolean().optional(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
      }),
    ])
    .openapi({
      description:
        'Outcome of the GitHub-side webhook registration. `skipped: true` with `reason: "github_app_installed"` means the GitHub App already delivers events for this repo, so no per-repo registration is needed — the local `webhook_configs` row is still created for UI clarity.',
    }),
);

export const WebhookAutoConfigureResponseComponent = registerComponent(
  'WebhookAutoConfigureResponse',
  z
    .object({
      config: WebhookConfigRowSchema,
      registration: WebhookRegistrationResultSchema,
    })
    .openapi({
      description:
        'Auto-configure result: the created `webhook_configs` row plus the registration outcome from GitHub.',
    }),
);

export const WebhookAutoConfigureErrorComponent = registerComponent(
  'WebhookAutoConfigureErrorResponse',
  z
    .object({
      error: z.string(),
      existingConfigId: z.number().optional(),
    })
    .openapi({
      description:
        'Error envelope. `existingConfigId` is set on 409 conflicts to point the UI at the row already in place.',
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
    'Returns the full project record from `projects.json` plus the derived `webhookConfigured` flag the missing-webhook UI banner depends on. ' +
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

// POST /api/projects/:projectId/webhook/auto-configure
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/webhook/auto-configure',
  tags: ['Projects'],
  summary: 'One-click GitHub webhook setup for a project',
  description:
    'Creates a `webhook_configs` row with the standard event bundle (pull_request.opened / .synchronize / .review_comment.created enabled; .closed / review.submitted / check_suite.completed disabled) and registers the webhook on GitHub via the installation-token path when a GitHub App is configured, or the gh-CLI fallback otherwise. ' +
    'Idempotent: returns 409 with `existingConfigId` if an enabled webhook config already exists for the project. ' +
    'Requires `githubRepo` set on the project; returns 400 otherwise. ' +
    'When the GitHub App is installed on the repo owner, the per-repo registration is skipped — the local row is still created so the missing-webhook UI banner clears, but the App is the active delivery path.',
  request: {
    params: z.object({
      projectId: z.string().openapi({ description: 'Project slug (e.g. `agent-hub`).' }),
    }),
  },
  responses: {
    200: {
      description:
        'Webhook config created + registration attempted. Inspect `registration.ok` to learn whether the GitHub side succeeded; the local row is created either way.',
      content: jsonContent(WebhookAutoConfigureResponseComponent),
    },
    400: {
      description: 'Project has no `githubRepo` configured.',
      content: jsonContent(WebhookAutoConfigureErrorComponent),
    },
    404: {
      description: 'No project with this slug, or the caller cannot see it.',
      content: jsonContent(WebhookAutoConfigureErrorComponent),
    },
    409: {
      description: 'An enabled webhook config already exists for this project.',
      content: jsonContent(WebhookAutoConfigureErrorComponent),
    },
    500: {
      description: 'Server-side failure (DB outage, GitHub API exception).',
      content: jsonContent(WebhookAutoConfigureErrorComponent),
    },
  },
});

// ─── Per-user project settings ──────────────────────────────────────

const FinalizeAutomationLevelSchema = z.enum(['manual', 'review', 'push', 'merge']).openapi({
  description:
    'Finalize automation level: `manual` (Build), `review` (Build and Review), `push` (Build and Push), `merge` (Auto Merge).',
});

export const UserProjectSettingsComponent = registerComponent(
  'UserProjectSettings',
  z
    .object({
      projectId: z.string().openapi({ description: 'Project slug.' }),
      defaultFinalizeAutomation: FinalizeAutomationLevelSchema.nullable().openapi({
        description:
          "The requesting user's default Finalize automation level for new ad-hoc sessions in this project, or null when they have set no preference (the session falls back to the global default `manual`).",
      }),
    })
    .openapi({
      description:
        'Per-user, project-scoped settings for the authenticated caller. Scoped strictly to the requesting user.',
    }),
);

export const UserProjectSettingsRequestSchema = z
  .object({
    defaultFinalizeAutomation: FinalizeAutomationLevelSchema.nullable().optional().openapi({
      description:
        'The default Finalize automation level to store for the requesting user in this project. A known level sets it; `null` clears it; omitting the key leaves the existing value unchanged.',
    }),
  })
  .openapi({ description: 'Body for PUT /api/projects/{projectId}/user-settings.' });

export const UserProjectSettingsErrorComponent = registerComponent(
  'UserProjectSettingsErrorResponse',
  z.object({ error: z.string() }).openapi({
    description:
      'Error envelope: 404 when the project is missing or not visible to the caller; 400 when the body is malformed.',
  }),
);

const userSettingsParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug (e.g. `agent-hub`).' }),
});

// GET /api/projects/:projectId/user-settings
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/user-settings',
  tags: ['Projects'],
  summary: "Read the caller's per-project settings",
  description:
    "Returns the authenticated caller's per-project settings — currently their default Finalize automation level for new ad-hoc sessions. Scoped to the requesting user; never exposes another user's preference.",
  request: { params: userSettingsParams },
  responses: {
    200: {
      description: 'Per-user project settings.',
      content: jsonContent(UserProjectSettingsComponent),
    },
    404: {
      description: 'No project with this slug, or the caller cannot see it.',
      content: jsonContent(UserProjectSettingsErrorComponent),
    },
  },
});

// PUT /api/projects/:projectId/user-settings
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/user-settings',
  tags: ['Projects'],
  summary: "Update the caller's per-project settings",
  description:
    "Upserts the authenticated caller's per-project settings. Send `defaultFinalizeAutomation` as a known level to set it, `null` to clear it, or omit the key to leave it unchanged. Returns the resulting settings.",
  request: {
    params: userSettingsParams,
    body: { content: jsonContent(UserProjectSettingsRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated per-user project settings.',
      content: jsonContent(UserProjectSettingsComponent),
    },
    400: {
      description: 'Malformed body.',
      content: jsonContent(UserProjectSettingsErrorComponent),
    },
    404: {
      description: 'No project with this slug, or the caller cannot see it.',
      content: jsonContent(UserProjectSettingsErrorComponent),
    },
  },
});
