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

const ProjectAnalysisEngineSchema = z.enum(['claude-code', 'cursor-agent', 'codex-cli']).openapi({
  description:
    'Agent CLI engine to use for project analysis. Gemini is excluded because it is reserved for embeddings/RAG.',
});

export const ProjectAnalyzeRequestSchema = z
  .object({
    cwd: z.string().min(1).openapi({
      description: 'Directory to analyze. `~` is expanded against the server process HOME.',
    }),
    engine: ProjectAnalysisEngineSchema.optional().openapi({
      description:
        'Optional selected analysis engine. When supplied, analysis uses this engine only and returns a targeted setup error if it cannot run.',
    }),
    model: z.string().min(1).optional().openapi({
      description:
        'Optional selected model. Must belong to the selected engine, or to one of the supported project-analysis engines when engine is omitted.',
    }),
  })
  .openapi({ description: 'Body for POST /api/projects/analyze.' });

export const ProjectAnalyzeResponseComponent = registerComponent(
  'ProjectAnalyzeResponse',
  z
    .object({
      analyzeId: z.string().openapi({
        description:
          'Opaque id used to correlate WebSocket analyze-progress / analyze-complete / analyze-error events.',
      }),
    })
    .openapi({ description: 'Analysis job accepted.' }),
);

export const ProjectAnalyzeErrorComponent = registerComponent(
  'ProjectAnalyzeErrorResponse',
  z
    .object({
      error: z.string(),
      code: z.string().optional(),
      acceptedEngines: z.array(ProjectAnalysisEngineSchema).optional(),
      acceptedModels: z
        .union([z.array(z.string()), z.record(z.string(), z.array(z.string()))])
        .optional(),
      availability: z.record(z.string(), z.object({}).passthrough()).optional(),
    })
    .openapi({
      description:
        'Error envelope returned when the cwd, selected engine/model, or engine setup is invalid.',
    }),
);

const WikiIntakeCategorySchema = z
  .enum([
    'general',
    'api-docs',
    'architecture',
    'conventions',
    'test-patterns',
    'troubleshooting',
    'onboarding',
  ])
  .openapi({
    description:
      'Starter wiki page category. Unknown values submitted to the legacy handler are normalized to `onboarding`.',
  });

export const ProjectOnboardWikiPageSchema = z
  .object({
    title: z.string().min(1).max(160).openapi({
      description: 'Starter wiki page title reviewed by the user in the Open Project wizard.',
    }),
    content: z.string().optional().openapi({
      description: 'Markdown body for the starter wiki page.',
    }),
    category: WikiIntakeCategorySchema.optional().openapi({
      description: 'Wiki category for the starter page.',
    }),
  })
  .openapi({
    description:
      'Generated wiki page draft from project analysis, optionally edited by the user before onboarding.',
  });

export const ProjectOnboardRequestSchema = z
  .object({
    project: z
      .object({
        id: z.string().min(1).openapi({ description: 'New project slug.' }),
        name: z.string().optional().openapi({ description: 'Human-readable project name.' }),
        cwd: z.string().optional().openapi({ description: 'Project working directory.' }),
        color: z.string().optional().openapi({ description: 'Sidebar accent color.' }),
        githubRepo: z
          .object({
            owner: z.string(),
            repo: z.string(),
          })
          .optional()
          .openapi({ description: 'GitHub repository selected during onboarding.' }),
        preCommitCommands: z.unknown().optional(),
        checkHealCommands: z.unknown().optional(),
        checkHealMaxRounds: z.unknown().optional(),
      })
      .passthrough(),
    agents: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            role: z.string().optional(),
            engine: z.string().optional(),
            systemPrompt: z.string().optional(),
            color: z.string().optional(),
            identity: z.string().optional(),
          })
          .passthrough(),
      )
      .optional()
      .openapi({ description: 'Reviewed dev agent roster generated by analysis.' }),
    contextFiles: z.record(z.string(), z.string()).optional().openapi({
      description: 'Reviewed workspace context files written into the project data directory.',
    }),
    commands: z
      .object({
        install: z.string().nullable().optional(),
        build: z.string().nullable().optional(),
        test: z.string().nullable().optional(),
        lint: z.string().nullable().optional(),
      })
      .optional()
      .nullable()
      .openapi({ description: 'Detected project commands.' }),
    wikiPages: z.array(ProjectOnboardWikiPageSchema).optional().openapi({
      description:
        'Reviewed starter wiki pages generated during project analysis. Empty or omitted means no wiki pages are seeded.',
    }),
  })
  .openapi({ description: 'Body for POST /api/projects/onboard.' });

export const ProjectOnboardErrorComponent = registerComponent(
  'ProjectOnboardErrorResponse',
  z
    .object({
      error: z.string(),
      message: z.string().optional(),
    })
    .openapi({
      description: 'Error envelope returned when onboarding validation or setup fails.',
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

// POST /api/projects/analyze
registerPath({
  method: 'post',
  path: '/api/projects/analyze',
  tags: ['Projects'],
  summary: 'Analyze a local or cloned project directory',
  description:
    'Starts an asynchronous project-analysis run for the Open Project wizard. ' +
    'The response returns an `analyzeId`; progress and completion arrive over WebSocket events. ' +
    'Callers may select the engine/model from `/api/config/models` before starting analysis.',
  request: {
    body: { content: jsonContent(ProjectAnalyzeRequestSchema) },
  },
  responses: {
    200: {
      description: 'Analysis was accepted and will stream progress over WebSocket.',
      content: jsonContent(ProjectAnalyzeResponseComponent),
    },
    400: {
      description: 'Invalid cwd, selected engine/model, or no usable selected engine.',
      content: jsonContent(ProjectAnalyzeErrorComponent),
    },
    500: {
      description: 'Unexpected engine-selection failure.',
      content: jsonContent(ProjectAnalyzeErrorComponent),
    },
  },
});

// POST /api/projects/onboard
registerPath({
  method: 'post',
  path: '/api/projects/onboard',
  tags: ['Projects'],
  summary: 'Create a project from reviewed analysis output',
  description:
    'Creates a project from the Open Project wizard review step. Persists the selected dev agent roster, context files, detected commands, optional GitHub link, and reviewed starter wiki pages.',
  request: {
    body: { content: jsonContent(ProjectOnboardRequestSchema) },
  },
  responses: {
    201: {
      description: 'Project created.',
      content: jsonContent(ProjectDetailComponent),
    },
    400: {
      description:
        'Invalid project id, duplicate-free roster validation failure, or invalid options.',
      content: jsonContent(ProjectOnboardErrorComponent),
    },
    409: {
      description: 'A project with the requested id already exists.',
      content: jsonContent(ProjectOnboardErrorComponent),
    },
    500: {
      description: 'Project setup failed after validation.',
      content: jsonContent(ProjectOnboardErrorComponent),
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

// ─── Setup status ─────────────────────────────────────────────────

const EngineSetupStatusSchema = z
  .object({
    available: z.boolean().openapi({
      description:
        'Whether the engine binary responded to `<bin> --version` within the probe timeout.',
    }),
    authenticated: z.boolean().openapi({
      description:
        'Whether the requesting user has working credentials for this engine (per-account; no host fallback).',
    }),
    path: z.string().openapi({ description: 'Resolved path to the engine binary.' }),
  })
  .openapi({ description: 'Availability + auth state for a single agent engine.' });

export const SetupStatusComponent = registerComponent(
  'SetupStatusResponse',
  z
    .object({
      firstRun: z.boolean().openapi({
        description:
          'True when no projects exist yet — the client pops the first-run setup wizard.',
      }),
      authConfigured: z.boolean().openapi({
        description:
          'True once an Agent Hub Owner record exists. Authoritative "setup wizard completed" signal.',
      }),
      hasAnyAiCredentials: z.boolean().openapi({
        description: 'True when the requesting user has at least one working engine credential.',
      }),
      engineAuth: z
        .object({
          'claude-code': z.boolean(),
          'cursor-agent': z.boolean(),
          'codex-cli': z.boolean(),
        })
        .openapi({ description: 'Per-engine authentication state for the requesting user.' }),
      engines: z
        .object({
          'claude-code': EngineSetupStatusSchema,
          'cursor-agent': EngineSetupStatusSchema,
          'codex-cli': EngineSetupStatusSchema,
          'grok-cli': EngineSetupStatusSchema,
        })
        .openapi({ description: 'Per-engine binary availability + auth + resolved path.' }),
      dataDir: z.string().openapi({ description: 'Resolved Agent Hub data directory.' }),
      projectsDir: z.string().openapi({ description: 'Resolved per-project data root.' }),
    })
    .openapi({
      description:
        'Boot-time setup + engine status. Hit on every app load to decide whether to show the setup wizard and which engines are usable.',
    }),
);

// GET /api/setup/status
registerPath({
  method: 'get',
  path: '/api/setup/status',
  tags: ['Projects'],
  summary: 'Boot-time setup + engine availability status',
  description:
    'Reports first-run / auth-configured state, the requesting user’s per-engine credential status, and each engine binary’s availability and resolved path. Probes `<bin> --version` in parallel with a 5s timeout per engine. Drives the client’s setup-wizard gating on app load.',
  responses: {
    200: {
      description: 'Setup + engine status.',
      content: jsonContent(SetupStatusComponent),
    },
  },
});

// ─── Per-project member assignment (Owner-managed visibility ACL) ───

const jsonContentMembers = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

export const ProjectMemberComponent = registerComponent(
  'ProjectMember',
  z
    .object({
      userId: z.string().openapi({ description: 'Assigned user id.' }),
      username: z.string().openapi({ description: 'Assigned user’s username.' }),
      addedBy: z.string().nullable().openapi({
        description:
          'User id of the Owner who made the assignment; null if that user was later deleted.',
      }),
      createdAt: z.string().openapi({ description: 'When the assignment was made.' }),
    })
    .openapi({ description: 'A user assigned to a project (a visibility-ACL row).' }),
);

export const ProjectMembersListComponent = registerComponent(
  'ProjectMembersList',
  z
    .object({
      projectId: z.string(),
      ownerUserId: z.string().nullable().openapi({
        description:
          'The project creator; always effectively a member (sees the project) even without an explicit row.',
      }),
      visibility: z.enum(['shared', 'private']).openapi({
        description:
          'Project visibility. Shared projects with no members are org-visible; private projects with no members are owner-only.',
      }),
      restricted: z.boolean().openapi({
        description:
          'True when the project has an active assignment ACL, even if it currently has zero assigned users. False means no explicit member ACL; combine with visibility to determine whether the project is org-visible (shared) or owner-only (private).',
      }),
      members: z.array(ProjectMemberComponent),
    })
    .openapi({ description: 'The assignment ACL for a project.' }),
);

export const ProjectMemberAddedComponent = registerComponent(
  'ProjectMemberAdded',
  z
    .object({
      projectId: z.string(),
      userId: z.string(),
      username: z.string(),
    })
    .openapi({ description: 'Confirmation that a user was assigned to a project.' }),
);

export const ProjectMemberRemovedComponent = registerComponent(
  'ProjectMemberRemoved',
  z
    .object({
      projectId: z.string(),
      userId: z.string(),
      removed: z.literal(true),
    })
    .openapi({ description: 'Confirmation that a user was unassigned from a project.' }),
);

const ProjectMemberErrorComponent = registerComponent(
  'ProjectMemberErrorResponse',
  z.object({ error: z.string() }).openapi({
    description: 'Error envelope for the project-member routes.',
  }),
);

// GET /api/projects/:projectId/members
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/members',
  tags: ['Projects'],
  summary: 'List the users assigned to a project',
  description:
    'Returns the project’s visibility ACL. Owner-only (org Owner role, or the local-bundle / global-apiKey break-glass). ' +
    '`restricted: false` means no assignment ACL: shared projects are org-visible and private projects are owner-only. `restricted: true` means assignment-gated even if no users are currently assigned.',
  request: {
    params: z.object({ projectId: z.string() }),
  },
  responses: {
    200: {
      description: 'The project member list.',
      content: jsonContentMembers(ProjectMembersListComponent),
    },
    403: {
      description: 'Caller is not an Owner.',
      content: jsonContentMembers(ProjectMemberErrorComponent),
    },
    404: {
      description: 'Project not found (or not visible to the caller).',
      content: jsonContentMembers(ProjectMemberErrorComponent),
    },
  },
});

// POST /api/projects/:projectId/members
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/members',
  tags: ['Projects'],
  summary: 'Assign a user to a project',
  description:
    'Adds a user to the project’s visibility ACL so they can see and enter it. Owner-only. ' +
    'Assigning the first member flips the project from org-visible to members-only. Idempotent — re-assigning an existing member is a no-op. ' +
    'Broadcasts `projects_updated` over the WebSocket.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: {
      content: jsonContentMembers(
        z.object({ userId: z.string().openapi({ description: 'Id of the org user to assign.' }) }),
      ),
    },
  },
  responses: {
    200: {
      description: 'User was already assigned; no new row was created.',
      content: jsonContentMembers(ProjectMemberAddedComponent),
    },
    201: {
      description: 'User assigned.',
      content: jsonContentMembers(ProjectMemberAddedComponent),
    },
    400: {
      description: 'Missing userId, or the user is not a member of this org.',
      content: jsonContentMembers(ProjectMemberErrorComponent),
    },
    403: {
      description: 'Caller is not an Owner.',
      content: jsonContentMembers(ProjectMemberErrorComponent),
    },
    404: {
      description: 'Project or user not found.',
      content: jsonContentMembers(ProjectMemberErrorComponent),
    },
  },
});

// DELETE /api/projects/:projectId/members/:userId
registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/members/{userId}',
  tags: ['Projects'],
  summary: 'Unassign a user from a project',
  description:
    'Removes a user from the project’s visibility ACL. Owner-only. ' +
    'Removing the last member keeps the assignment ACL active, so a restricted shared project does not reopen to the whole org. Broadcasts `projects_updated`.',
  request: {
    params: z.object({ projectId: z.string(), userId: z.string() }),
  },
  responses: {
    200: {
      description: 'User unassigned.',
      content: jsonContentMembers(ProjectMemberRemovedComponent),
    },
    403: {
      description: 'Caller is not an Owner.',
      content: jsonContentMembers(ProjectMemberErrorComponent),
    },
    404: {
      description: 'Project not found, or the user was not a member.',
      content: jsonContentMembers(ProjectMemberErrorComponent),
    },
  },
});
