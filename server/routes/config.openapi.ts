/**
 * Zod schemas + OpenAPI registrations for the config / GitHub-App / GitHub-CLI /
 * project-import / config-import route group.
 *
 * Notes:
 *
 * - **Response shapes are mostly `passthrough`.** The legacy handlers return
 *   ad-hoc envelopes that mix runtime + persisted state (e.g. masked secrets
 *   like `'••••••••'`, `_file` metadata, optional installation arrays). Rather
 *   than chase every key here we document the well-known core and let the
 *   spec stay forgiving — clients should treat unknown fields as benign.
 *
 * - **GitHub App OAuth callback / register endpoints return HTML or
 *   redirects**, not JSON. They're documented as `text/html` / `302`
 *   responses so the spec doesn't lie about the content type.
 *
 * - **Project-import + config-import payloads are open passthrough objects.**
 *   The validation surface is huge (versioned export envelopes carrying
 *   crons, rooms, kanban, wiki, etc.) and the handler already runs its own
 *   diagnostic boundary per section. Pinning the schema would require
 *   versioning every nested table — out of scope for this migration.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'ConfigErrorResponse',
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
    .openapi({ description: 'Error envelope for config / github routes.' }),
);

// ─── Component schemas ───────────────────────────────────────────

export const AppConfigComponent = registerComponent(
  'AppConfig',
  z
    .object({
      claudeBin: z.string(),
      cursorBin: z.string().optional(),
      geminiBin: z.string().optional(),
      codexBin: z.string().optional(),
      defaultModel: z.string().optional(),
      defaultCwd: z.string(),
      port: z.number().int(),
      publicUrl: z.string(),
      apiKey: z.string(),
      authRequired: z.boolean(),
      githubApp: z
        .object({
          appId: z.string(),
          appSlug: z.string().nullable(),
          hasInstallation: z.boolean(),
          installations: z.array(
            z.object({
              id: z.number().int(),
              account: z.string(),
              accountType: z.string(),
            }),
          ),
        })
        .nullable(),
      personalOAuth: z.object({
        configured: z.boolean(),
        clientId: z.string().nullable(),
      }),
      botGithubToken: z.string(),
      botGithubTokenSet: z.boolean(),
      botGithubUser: z.string().nullable(),
      anthropicApiKey: z.string(),
      anthropicApiKeySet: z.boolean(),
      codexDangerBypass: z.boolean().optional(),
      codexProfile: z.string().nullable().optional().openapi({
        description:
          'Optional Codex CLI profile name forwarded as `--profile <name>` on every codex spawn (chat, room, design, delegation, slack one-shot). Null / empty = no flag. Configurable via `codexProfile` in config.json, `PATCH /api/config`, or env `CODEX_PROFILE`.',
      }),
      lanMode: z.boolean().optional().openapi({
        description:
          'When true, Agent Hub skips webhook auto-registration (suitable for LAN / air-gapped installs that cannot receive inbound webhooks) and relies on the polling fallback for PR state and reviewer dispatch.',
      }),
      _file: z.object({
        claudeBin: z.string().nullable(),
        cursorBin: z.string().nullable(),
        geminiBin: z.string().nullable(),
        codexBin: z.string().nullable(),
      }),
      features: z.object({
        prEnv: z.boolean(),
      }),
    })
    .passthrough()
    .openapi({
      description:
        'Aggregated server configuration. Sensitive fields are masked (`••••••••`); `_file` reflects what is actually persisted to `config.json`.',
    }),
);

export const ModelsConfigComponent = registerComponent(
  'ModelsConfig',
  z.object({}).passthrough().openapi({
    description: 'Per-engine model availability. Shape owned by `buildAuthenticatedModelConfig`.',
  }),
);

export const SpawnPathComponent = registerComponent(
  'SpawnPath',
  z
    .object({
      path: z.string().nullable(),
      source: z.string(),
      capturedAt: z.union([z.string(), z.number()]).nullable().optional(),
      entries: z.array(z.string()),
      ok: z.boolean().optional(),
    })
    .openapi({
      description:
        'Cached login-shell PATH used when spawning agent processes. `entries` is the colon-split form for convenience.',
    }),
);

export const PersonalOAuthStatusComponent = registerComponent(
  'PersonalOAuthStatus',
  z
    .object({
      configured: z.boolean(),
      clientId: z.string().nullable(),
    })
    .openapi({
      description:
        'Personal GitHub OAuth App status (the OAuth client used for human-identity actions, distinct from the reviewer GitHub App).',
    }),
);

export const GithubAppManifestComponent = registerComponent(
  'GithubAppManifest',
  z
    .object({
      manifest: z.object({}).passthrough(),
      githubUrl: z.string(),
      redirectUrl: z.string(),
    })
    .openapi({
      description:
        'GitHub App manifest payload — POST to `githubUrl` with the manifest in a hidden form to register.',
    }),
);

export const GithubAppInstallUrlComponent = registerComponent(
  'GithubAppInstallUrl',
  z
    .object({ installUrl: z.string() })
    .openapi({ description: 'Install-this-app URL for the configured GitHub App.' }),
);

export const GithubAppInstallationListComponent = registerComponent(
  'GithubAppInstallationList',
  z
    .object({
      installed: z.boolean(),
      installationId: z.union([z.number().int(), z.string()]).optional(),
      installations: z
        .array(
          z.object({
            id: z.number().int(),
            account: z.string(),
            accountType: z.string(),
          }),
        )
        .optional(),
      message: z.string().optional(),
    })
    .openapi({ description: 'Result of refreshing GitHub App installations.' }),
);

export const GithubAppStatusComponent = registerComponent(
  'GithubAppStatus',
  z
    .object({
      configured: z.boolean(),
      appId: z.string().optional(),
      appSlug: z.string().nullable().optional(),
      hasInstallation: z.boolean().optional(),
      installationId: z.union([z.number().int(), z.string()]).nullable().optional(),
      installations: z
        .array(
          z.object({
            id: z.number().int(),
            account: z.string(),
            accountType: z.string(),
          }),
        )
        .optional(),
      appName: z.string().nullable().optional(),
      valid: z.boolean().optional(),
    })
    .passthrough()
    .openapi({ description: 'Live GitHub App status (cached up to 5 min).' }),
);

export const GithubAppConnectResponseComponent = registerComponent(
  'GithubAppConnectResponse',
  z
    .object({
      ok: z.boolean(),
      appId: z.string(),
      appSlug: z.string(),
      installationId: z.union([z.number().int(), z.string()]),
    })
    .openapi({
      description: 'Echoed identity of the freshly-connected GitHub App.',
    }),
);

export const GithubStatusComponent = registerComponent(
  'GithubStatus',
  z
    .object({
      authenticated: z.boolean(),
      user: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      githubApp: z
        .object({
          appId: z.string(),
          appSlug: z.string().nullable(),
          hasInstallation: z.boolean(),
          installations: z.array(
            z.object({
              id: z.number().int(),
              account: z.string(),
              accountType: z.string(),
            }),
          ),
        })
        .nullable()
        .optional(),
      botUser: z.string().nullable().optional(),
      error: z.string().optional(),
    })
    .openapi({
      description: '`gh` CLI auth status plus the configured GitHub App / bot identity, if any.',
    }),
);

export const DetectRepoResponseComponent = registerComponent(
  'DetectRepoResponse',
  z
    .object({
      hasRemote: z.boolean(),
      owner: z.string().nullable().optional(),
      repo: z.string().nullable().optional(),
      url: z.string().optional(),
      defaultBranch: z.string().optional(),
    })
    .openapi({
      description:
        'Result of `git remote get-url origin` against `cwd`. `hasRemote: false` if the repo has no origin or git failed.',
    }),
);

export const TestConnectionResponseComponent = registerComponent(
  'TestConnectionResponse',
  z
    .object({
      ok: z.boolean(),
      repoInfo: z.object({}).passthrough().optional(),
      error: z.string().optional(),
    })
    .openapi({
      description:
        'Result of `gh api repos/{owner}/{repo}` — `ok: true` with `repoInfo` on success; `ok: false` with `error` if `gh` rejects.',
    }),
);

export const ProjectExportEnvelopeComponent = registerComponent(
  'ProjectExportEnvelope',
  z
    .object({
      version: z.literal(3).or(z.number().int()),
      type: z.string().optional(),
      exportedAt: z.string().optional(),
      project: z.object({}).passthrough().optional(),
      crons: z.array(z.object({}).passthrough()).optional(),
      rooms: z.array(z.object({}).passthrough()).optional(),
      webhooks: z.array(z.object({}).passthrough()).optional(),
      wiki: z.array(z.object({}).passthrough()).optional(),
      kanban: z.object({}).passthrough().nullable().optional(),
    })
    .passthrough()
    .openapi({
      description:
        'V3 project export envelope. Sub-objects (project, crons, rooms, …) are passed through to the import handler verbatim.',
    }),
);

export const ConfigExportEnvelopeComponent = registerComponent(
  'ConfigExportEnvelope',
  z
    .object({
      version: z.union([z.literal(1), z.literal(2)]).or(z.number().int()),
      exportedAt: z.string().optional(),
      config: z.object({}).passthrough().optional(),
      projects: z.array(z.object({}).passthrough()).optional(),
      agents: z.array(z.object({}).passthrough()).optional(),
      crons: z.array(z.object({}).passthrough()).optional(),
      rooms: z.array(z.object({}).passthrough()).optional(),
      slack: z
        .object({ accounts: z.array(z.object({}).passthrough()).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .openapi({
      description:
        'V1/V2 server-wide export envelope (config, projects/agents, crons, rooms, slack).',
    }),
);

export const ImportResultComponent = registerComponent(
  'ImportResult',
  z
    .object({
      message: z.string(),
      results: z.record(z.string(), z.union([z.string(), z.boolean()])),
      project: z.object({}).passthrough().optional(),
    })
    .openapi({
      description:
        'Per-section result map — each entry is either `true`/`false` or a human-readable summary like `"3 new, 5 skipped"`.',
    }),
);

// ─── Request schemas ─────────────────────────────────────────────

export const PatchConfigRequestSchema = z
  .object({
    claudeBin: z.string().optional(),
    cursorBin: z.string().optional(),
    geminiBin: z.string().optional(),
    codexBin: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultCwd: z.string().optional(),
    port: z.number().int().optional(),
    apiKey: z.string().nullable().optional(),
    publicUrl: z.string().optional(),
    botGithubToken: z.string().nullable().optional(),
    codexDangerBypass: z.boolean().optional(),
    codexProfile: z.string().nullable().optional().openapi({
      description:
        'Codex CLI profile name. Pass null / empty string to clear. Forwarded as `--profile <name>` on every codex spawn.',
    }),
    lanMode: z.boolean().optional(),
  })
  .passthrough()
  .openapi({
    description:
      'Partial config update. Unknown keys are ignored. At least one allowed key must be present, otherwise the handler returns 400.',
  });

export const PutPersonalOAuthRequestSchema = z
  .object({
    clientId: z.string().min(1, 'clientId is required'),
    clientSecret: z.string().min(1, 'clientSecret is required'),
  })
  .openapi({
    description: 'GitHub OAuth App client credentials. Both fields are required.',
  });

export const ConnectGithubAppRequestSchema = z
  .object({
    appId: z.string().min(1, 'appId is required'),
    privateKey: z.string().min(1, 'privateKey is required'),
    installationId: z.string().min(1, 'installationId is required'),
  })
  .openapi({
    description: 'Connect an existing GitHub App by appId + private key + installation id.',
  });

export const DetectRepoRequestSchema = z
  .object({
    cwd: z.string().min(1, 'cwd is required'),
  })
  .openapi({
    description: 'Working directory to inspect with `git remote get-url origin`.',
  });

export const TestConnectionRequestSchema = z
  .object({
    owner: z.string().min(1, 'owner is required'),
    repo: z.string().min(1, 'repo is required'),
  })
  .openapi({
    description:
      'GitHub repo coords. Both fields must match `^[a-zA-Z0-9._-]+$`; the handler enforces the regex.',
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

// ─── Path registrations ──────────────────────────────────────────

registerPath({
  method: 'get',
  path: '/api/config',
  tags: ['Config'],
  summary: 'Read aggregated server config (with masked secrets)',
  responses: {
    200: { description: 'Server config.', content: jsonContent(AppConfigComponent) },
  },
});

registerPath({
  method: 'get',
  path: '/api/config/models',
  tags: ['Config'],
  summary: 'List engines + per-engine authenticated models',
  responses: {
    200: { description: 'Model availability map.', content: jsonContent(ModelsConfigComponent) },
  },
});

registerPath({
  method: 'patch',
  path: '/api/config',
  tags: ['Config'],
  summary: 'Update one or more config fields',
  description:
    'Allowed keys: `claudeBin`, `cursorBin`, `geminiBin`, `codexBin`, `defaultModel`, `defaultCwd`, `port`, `apiKey`, `publicUrl`, `botGithubToken`, `codexDangerBypass`, `codexProfile`, `lanMode`. Unknown keys are silently dropped. Returns the updated subset (with `botGithubToken` masked).',
  request: { body: { content: jsonContent(PatchConfigRequestSchema) } },
  responses: {
    200: {
      description: 'Updated keys (masked where applicable).',
      content: jsonContent(
        z.object({
          ok: z.boolean(),
          updated: z.record(z.string(), z.unknown()),
        }),
      ),
    },
    400: errorResponse('No valid config fields provided.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/config/spawn-path',
  tags: ['Config'],
  summary: 'Read the cached login-shell PATH used when spawning agents',
  responses: {
    200: { description: 'Spawn-PATH snapshot.', content: jsonContent(SpawnPathComponent) },
  },
});

registerPath({
  method: 'post',
  path: '/api/config/refresh-spawn-path',
  tags: ['Config'],
  summary: 'Re-run the login shell to pick up newly installed CLIs',
  description:
    'Idempotent — refreshes the cached PATH that `buildSpawnEnv` merges into every spawn.',
  responses: {
    200: {
      description: 'Refreshed spawn-PATH snapshot.',
      content: jsonContent(SpawnPathComponent),
    },
    500: errorResponse('Login shell failed.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/config/personal-oauth',
  tags: ['Config'],
  summary: 'Read personal GitHub OAuth App configuration status',
  responses: {
    200: {
      description: 'Personal OAuth status.',
      content: jsonContent(PersonalOAuthStatusComponent),
    },
  },
});

registerPath({
  method: 'put',
  path: '/api/config/personal-oauth',
  tags: ['Config'],
  summary: 'Set personal GitHub OAuth App credentials',
  request: { body: { content: jsonContent(PutPersonalOAuthRequestSchema) } },
  responses: {
    200: {
      description: 'Saved.',
      content: jsonContent(
        z.object({
          ok: z.boolean(),
          configured: z.literal(true),
          clientId: z.string(),
        }),
      ),
    },
    400: errorResponse('clientId and clientSecret are both required.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/config/personal-oauth',
  tags: ['Config'],
  summary: 'Clear personal GitHub OAuth App credentials',
  responses: {
    200: {
      description: 'Removed.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
  },
});

// ─── GitHub App ──────────────────────────────────────────────────

registerPath({
  method: 'get',
  path: '/api/github-app/manifest',
  tags: ['GitHub App'],
  summary: 'Build the GitHub App manifest for the manifest-flow registration',
  responses: {
    200: { description: 'Manifest payload.', content: jsonContent(GithubAppManifestComponent) },
    400: errorResponse('Public URL is not configured.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/github-app/register',
  tags: ['GitHub App'],
  summary: 'Render an HTML form that auto-POSTs the manifest to GitHub',
  responses: {
    200: {
      description: 'HTML form (auto-submits).',
      content: { 'text/html': { schema: z.string() } },
    },
    400: {
      description: 'Public URL is not configured.',
      content: { 'text/plain': { schema: z.string() } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/github-app/callback',
  tags: ['GitHub App'],
  summary: 'GitHub manifest-flow callback — exchanges code for app credentials and redirects',
  request: {
    query: z.object({
      code: z.string().openapi({ description: 'Manifest exchange code returned by GitHub.' }),
    }),
  },
  responses: {
    302: { description: 'Redirect to install URL or the settings page.' },
    400: {
      description: 'Missing `code` query param.',
      content: { 'text/plain': { schema: z.string() } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/github-app/install-url',
  tags: ['GitHub App'],
  summary: 'Build the install-this-app URL for the configured GitHub App',
  responses: {
    200: { description: 'Install URL.', content: jsonContent(GithubAppInstallUrlComponent) },
    400: errorResponse('No GitHub App configured.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/github-app/refresh-installation',
  tags: ['GitHub App'],
  summary: 'Re-fetch GitHub App installations and update the config',
  responses: {
    200: {
      description: 'Installations.',
      content: jsonContent(GithubAppInstallationListComponent),
    },
    400: errorResponse('No GitHub App configured.'),
    500: errorResponse('GitHub API call failed.'),
  },
});

const GithubAppSyncWebhookSecretResponse = registerComponent(
  'GithubAppSyncWebhookSecretResponse',
  z
    .object({
      ok: z.literal(true),
      generated: z
        .boolean()
        .openapi({ description: 'True if a fresh secret was generated rather than re-using.' }),
      secretLength: z.number().int(),
      secretPrefix: z
        .string()
        .openapi({ description: 'First 4 chars of the secret for diagnostic display only.' }),
    })
    .openapi({
      description:
        'Result of pushing the GitHub App webhook secret to GitHub. Never returns the full secret.',
    }),
);

registerPath({
  method: 'post',
  path: '/api/github-app/sync-webhook-secret',
  tags: ['GitHub App'],
  summary: "Push the App's webhook secret to GitHub (drift recovery)",
  description:
    'Calls `PATCH /app/hook/config` on GitHub with our locally-stored ' +
    "`config.githubApp.webhookSecret`. If we don't have a local secret, " +
    'a fresh 32-byte hex secret is generated, pushed, and persisted. ' +
    'Pass `{ rotate: true }` to force generation of a new secret even ' +
    'when a local one exists. GitHub returns its current secret as ' +
    '`********` on read, so this push-sync is the only way to put both ' +
    'sides back in lockstep after drift.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            rotate: z.boolean().optional().openapi({
              description:
                'Generate and push a brand-new secret even if one already exists locally.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Secret pushed to GitHub and persisted locally.',
      content: jsonContent(GithubAppSyncWebhookSecretResponse),
    },
    400: errorResponse('No GitHub App configured.'),
    500: {
      description:
        'GitHub accepted the PATCH but persisting locally failed; in-memory has been rolled back.',
      content: jsonContent(
        z.object({
          error: z.string(),
          githubMutated: z.literal(true).openapi({
            description:
              'Always true when this 500 shape is returned. Signals the operator that GitHub already holds the new secret and a re-run with rotate:true is the recovery path.',
          }),
          cause: z.string().optional().openapi({
            description: 'Underlying filesystem error message (e.g. ENOENT, EACCES).',
          }),
        }),
      ),
    },
    502: errorResponse('GitHub rejected the PATCH call.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/github-app/setup-complete',
  tags: ['GitHub App'],
  summary: 'GitHub install-callback landing page (auto-detects installation, redirects)',
  responses: {
    302: { description: 'Redirect to settings (`?githubApp=ready` / `?githubApp=no-install`).' },
  },
});

registerPath({
  method: 'get',
  path: '/api/github-app/status',
  tags: ['GitHub App'],
  summary: 'Read live GitHub App status (cached up to 5 min)',
  responses: {
    200: { description: 'GitHub App status.', content: jsonContent(GithubAppStatusComponent) },
  },
});

registerPath({
  method: 'delete',
  path: '/api/github-app',
  tags: ['GitHub App'],
  summary: 'Disconnect the configured GitHub App',
  responses: {
    200: { description: 'Removed.', content: jsonContent(z.object({ ok: z.boolean() })) },
  },
});

registerPath({
  method: 'post',
  path: '/api/github-app/connect',
  tags: ['GitHub App'],
  summary: 'Connect an existing GitHub App by appId + private key + installation id',
  request: { body: { content: jsonContent(ConnectGithubAppRequestSchema) } },
  responses: {
    200: { description: 'Connected.', content: jsonContent(GithubAppConnectResponseComponent) },
    400: errorResponse('Missing fields or invalid GitHub App credentials.'),
  },
});

// ─── GitHub CLI ──────────────────────────────────────────────────

registerPath({
  method: 'get',
  path: '/api/github/status',
  tags: ['GitHub'],
  summary: 'Read `gh` CLI auth status + configured app / bot identity',
  responses: {
    200: { description: 'GitHub status.', content: jsonContent(GithubStatusComponent) },
  },
});

registerPath({
  method: 'post',
  path: '/api/github/detect-repo',
  tags: ['GitHub'],
  summary: 'Detect the GitHub remote in a working directory',
  request: { body: { content: jsonContent(DetectRepoRequestSchema) } },
  responses: {
    200: {
      description: 'Remote detection result.',
      content: jsonContent(DetectRepoResponseComponent),
    },
    400: errorResponse('cwd is required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/github/test-connection',
  tags: ['GitHub'],
  summary: 'Probe `gh api repos/{owner}/{repo}` to verify connectivity',
  request: { body: { content: jsonContent(TestConnectionRequestSchema) } },
  responses: {
    200: {
      description: 'Connection probe result.',
      content: jsonContent(TestConnectionResponseComponent),
    },
    400: errorResponse('Missing or invalid owner/repo.'),
  },
});

// ─── Project + config import/export ──────────────────────────────

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/export',
  tags: ['Projects'],
  summary: 'Export a project (project + crons + rooms + webhooks + wiki + kanban)',
  description:
    'Returns a V3 export envelope as a downloadable JSON attachment. Webhook secrets are redacted; session-id linkages on kanban cards are stripped.',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Project export.',
      content: jsonContent(ProjectExportEnvelopeComponent),
    },
    404: errorResponse('Project not found.'),
    500: errorResponse('Export failed.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/import',
  tags: ['Projects'],
  summary: 'Merge a V3 project export into an existing project',
  description:
    'Per-section idempotent merge — duplicate names/slugs are skipped. Errors are tagged with the offending section (`crons`, `wiki`, `kanban`, etc.) for debuggability.',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(ProjectExportEnvelopeComponent) },
  },
  responses: {
    200: { description: 'Per-section merge results.', content: jsonContent(ImportResultComponent) },
    400: errorResponse('Invalid envelope (wrong version/type).'),
    404: errorResponse('Target project not found.'),
    500: errorResponse('Import failed (response includes `section` when applicable).'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/import',
  tags: ['Projects'],
  summary: 'Create a new project from a V3 export',
  description:
    'Materialises a fresh project record (and its data dir) from the embedded `project` block, then runs the same merge logic as the per-project endpoint. Generates a unique slug if the exported id collides.',
  request: { body: { content: jsonContent(ProjectExportEnvelopeComponent) } },
  responses: {
    201: { description: 'Created.', content: jsonContent(ImportResultComponent) },
    400: errorResponse('Invalid envelope or missing `project` block.'),
    500: errorResponse('Import failed (response includes `section` when applicable).'),
  },
});

registerPath({
  method: 'get',
  path: '/api/config/export',
  tags: ['Config'],
  summary: 'Export server-wide config (config + projects + crons + rooms + slack)',
  description:
    'Returns a V2 export envelope as a downloadable JSON attachment. Slack bot/app tokens are redacted.',
  responses: {
    200: { description: 'Config export.', content: jsonContent(ConfigExportEnvelopeComponent) },
    500: errorResponse('Export failed.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/config/import',
  tags: ['Config'],
  summary: 'Import a V1 or V2 server-wide config export',
  description:
    'Writes `config.json`, replaces `projects.json` (or upgrades a V1 `agents` array), merges crons + rooms by name, and writes `slack-config.json` only if real (non-redacted) tokens are present.',
  request: { body: { content: jsonContent(ConfigExportEnvelopeComponent) } },
  responses: {
    200: {
      description: 'Per-section import results.',
      content: jsonContent(ImportResultComponent),
    },
    400: errorResponse('Invalid export format (expected version 1 or 2).'),
    500: errorResponse('Import failed.'),
  },
});
