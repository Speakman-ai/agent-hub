/**
 * Zod schemas + OpenAPI registrations for the config / GitHub-CLI /
 * project-import / config-import route group.
 *
 * Notes:
 *
 * - **Response shapes are mostly `passthrough`.** The legacy handlers return
 *   ad-hoc envelopes that mix runtime + persisted state (e.g. masked secrets
 *   like `'••••••••'`, `_file` metadata). Rather than chase every key here we
 *   document the well-known core and let the spec stay forgiving — clients
 *   should treat unknown fields as benign.
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
      grokBin: z.string().optional(),
      defaultModel: z.string().optional().openapi({
        deprecated: true,
        description:
          'Legacy compatibility field. The server no longer uses this host-wide value for model selection.',
      }),
      defaultCwd: z.string(),
      port: z.number().int(),
      publicUrl: z.string(),
      apiKey: z.string(),
      authRequired: z.boolean(),
      openaiApiKey: z.string().openapi({
        description: 'Masked OpenAI API key used for host services. Empty when unset.',
      }),
      openaiApiKeySet: z.boolean().openapi({
        description: 'Whether the host OpenAI API key is configured.',
      }),
      transcriptionProvider: z.enum(['xai', 'openai']).openapi({
        description:
          'Provider used by /api/transcribe for chat voice transcription. `xai` (default) uses the xAI Grok speech-to-text endpoint; `openai` uses Whisper. Selectable on the settings page.',
      }),
      geminiApiKeySet: z.boolean().openapi({
        description:
          'Whether the host Gemini API key is configured (used for wiki RAG memory lookups).',
      }),
      xaiApiKeySet: z.boolean().openapi({
        description:
          'Whether the host xAI (Grok) API key is configured (used for the default xAI transcription provider).',
      }),
      personalOAuth: z.object({
        configured: z.boolean(),
        clientId: z.string().nullable(),
      }),
      anthropicApiKey: z.string(),
      anthropicApiKeySet: z.boolean(),
      codexDangerBypass: z.boolean().optional(),
      codexProfile: z.string().nullable().optional().openapi({
        description:
          'Optional Codex CLI profile name forwarded as `--profile <name>` on every codex spawn (chat, room, design, slack one-shot). Null / empty = no flag. Configurable via `codexProfile` in config.json, `PATCH /api/config`, or env `CODEX_PROFILE`.',
      }),
      _file: z.object({
        claudeBin: z.string().nullable(),
        cursorBin: z.string().nullable(),
        geminiBin: z.string().nullable(),
        codexBin: z.string().nullable(),
        grokBin: z.string().nullable(),
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
  z
    .object({
      defaultModel: z.string().optional().openapi({
        deprecated: true,
        description:
          'Legacy compatibility field. New model resolution ignores this host-wide value.',
      }),
    })
    .passthrough()
    .openapi({
      description:
        'Per-engine model availability. The deprecated `defaultModel` field remains for legacy clients; new selection is per-user and per-agent.',
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
        'Personal GitHub OAuth App status (the OAuth client used for human-identity actions).',
    }),
);

export const GoogleOAuthStatusComponent = registerComponent(
  'GoogleOAuthStatus',
  z
    .object({
      configured: z.boolean(),
      clientId: z.string().nullable(),
      redirectUri: z.string().openapi({
        description:
          'Canonical OAuth redirect URI the server sends to Google, derived from `publicUrl` (falling back to the request origin). The admin must register this exact value as an authorized redirect URI in the Google Cloud Console.',
      }),
    })
    .openapi({
      description:
        'Server-global Google OAuth app status. `configured` is true when both client id and secret are stored; `clientId` is exposed for display, the secret never is.',
    }),
);

// A GitHub numeric id (App id / installation id): a positive integer, accepted
// as a number or a digits-only string. The string branch's negative lookahead
// rejects all-zero values ("0"/"00"), mirroring the route's normalizePositiveIntId.
const PositiveIntIdSchema = z.union([
  z.string().regex(/^(?!0+$)\d+$/),
  z.number().int().positive(),
]);

export const GithubAppInstallationComponent = registerComponent(
  'GithubAppInstallation',
  z
    .object({
      account: z.string().optional().openapi({
        description: 'GitHub account login (org or user) this installation serves.',
      }),
      id: PositiveIntIdSchema.openapi({
        description: 'GitHub installation id — a positive integer.',
      }),
    })
    .openapi({ description: 'One GitHub App installation, keyed by the account it serves.' }),
);

export const GithubAppStatusComponent = registerComponent(
  'GithubAppStatus',
  z
    .object({
      configured: z.boolean().openapi({
        description: 'True when both an App id and a private key are stored (mint-ready).',
      }),
      appId: z.union([z.string(), z.number()]).nullable().openapi({
        description: 'Numeric GitHub App id (display-safe; not a secret).',
      }),
      installationId: z.union([z.string(), z.number()]).nullable().openapi({
        description: 'Default installation id used when no per-owner match is found.',
      }),
      installations: z.array(GithubAppInstallationComponent).openapi({
        description: 'Per-owner installation map so one App serving several orgs resolves right.',
      }),
      hasPrivateKey: z.boolean().openapi({
        description: 'Whether a PEM private key is stored. The key itself is never returned.',
      }),
    })
    .openapi({
      description:
        'Server-global GitHub App status — the mirror-push branch-protection bypass identity. The private key is write-only and never echoed; only `hasPrivateKey` is exposed.',
    }),
);

export const GithubStatusComponent = registerComponent(
  'GithubStatus',
  z
    .object({
      authenticated: z.boolean(),
      user: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      error: z.string().optional(),
    })
    .openapi({
      description: '`gh` CLI auth status.',
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
    grokBin: z.string().optional(),
    defaultModel: z.string().optional().openapi({
      deprecated: true,
      description:
        'Accepted but ignored for compatibility. Configure model selection per user and agent instead.',
    }),
    defaultCwd: z.string().optional(),
    port: z.number().int().optional(),
    apiKey: z.string().nullable().optional(),
    openaiApiKey: z.string().nullable().optional().openapi({
      description:
        'Host OpenAI API key for Whisper transcription and session titles. Empty string or null clears it.',
    }),
    transcriptionProvider: z.enum(['xai', 'openai']).optional().openapi({
      description:
        'Voice-transcription provider for /api/transcribe. Must be `xai` or `openai`; any other value returns 400.',
    }),
    publicUrl: z.string().optional(),
    codexDangerBypass: z.boolean().optional(),
    codexProfile: z.string().nullable().optional().openapi({
      description:
        'Codex CLI profile name. Pass null / empty string to clear. Forwarded as `--profile <name>` on every codex spawn.',
    }),
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

export const PutGoogleOAuthRequestSchema = z
  .object({
    clientId: z.string().min(1, 'clientId is required'),
    clientSecret: z.string().min(1, 'clientSecret is required'),
  })
  .openapi({
    description: 'Google OAuth app client credentials. Both fields are required.',
  });

export const PutGithubAppRequestSchema = z
  .object({
    appId: PositiveIntIdSchema.openapi({
      description:
        'GitHub App id (the `iss` of the signed App JWT) — a positive integer. Digits only, and not zero; a non-numeric or all-zero value is rejected with 400. Required.',
    }),
    privateKey: z.string().optional().openapi({
      description:
        'PEM **RSA** private key. Optional on update: omit to keep the stored key (required on first configuration). A non-RSA or unparseable key is rejected with 400. Write-only — never returned on read.',
    }),
    installationId: PositiveIntIdSchema.nullish().openapi({
      description:
        'Default installation id — a positive integer. Cleared when absent or blank; a non-numeric or all-zero value is rejected with 400.',
    }),
    installations: z.array(GithubAppInstallationComponent).optional().openapi({
      description: 'Per-owner installation map. Replaces the stored list; cleared when omitted.',
    }),
  })
  .openapi({
    description:
      'Server-global GitHub App credentials for the mirror-push bypass identity. `appId` is required; `privateKey` is required only when none is already stored.',
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

export const MaskedSmtpConfigComponent = registerComponent(
  'MaskedSmtpConfig',
  z
    .object({
      enabled: z.boolean(),
      host: z.string(),
      port: z.number().int(),
      tlsMode: z.enum(['none', 'starttls', 'ssl']),
      username: z.string().nullable(),
      password: z.string().nullable().openapi({
        description: '`••••••••` when a password is stored, null otherwise.',
      }),
      passwordSet: z.boolean(),
      from: z.string(),
      configured: z.boolean(),
    })
    .openapi({ description: 'SMTP settings with password masked.' }),
);

export const SmtpSettingsPatchRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    host: z.string().nullable().optional(),
    port: z.union([z.number().int(), z.string()]).optional(),
    tlsMode: z.enum(['none', 'starttls', 'ssl']).optional(),
    username: z.string().nullable().optional(),
    password: z.string().nullable().optional().openapi({
      description:
        'Omit or pass `••••••••` to preserve the existing secret; pass empty string/null to clear.',
    }),
    from: z.string().nullable().optional(),
  })
  .openapi({ description: 'Partial SMTP config update.' });

export const SmtpSettingsResponseSchema = z.object({
  smtp: MaskedSmtpConfigComponent,
  passwordReset: z.object({
    smtpConfigured: z.boolean(),
    fallbackAvailable: z.boolean(),
    fallback: z.enum(['owner_generated_reset_code']).nullable(),
  }),
});

export const SmtpTestSendRequestSchema = z.object({
  to: z.string().optional().openapi({
    description:
      'Optional recipient. Owners may send to any valid address; Admins can only send to their own email.',
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
  method: 'get',
  path: '/api/config/smtp',
  tags: ['Config'],
  summary: 'Read masked SMTP email settings',
  responses: {
    200: {
      description: 'SMTP settings and password-reset fallback status.',
      content: jsonContent(SmtpSettingsResponseSchema),
    },
    403: errorResponse('Admin role required.'),
  },
});

registerPath({
  method: 'patch',
  path: '/api/config/smtp',
  tags: ['Config'],
  summary: 'Update SMTP email settings',
  description:
    'Partial update that preserves the stored password when `password` is omitted or equal to the mask sentinel.',
  request: { body: { content: jsonContent(SmtpSettingsPatchRequestSchema) } },
  responses: {
    200: {
      description: 'Updated masked SMTP settings.',
      content: jsonContent(SmtpSettingsResponseSchema.extend({ ok: z.literal(true) })),
    },
    400: errorResponse('Invalid SMTP settings.'),
    403: errorResponse('Admin role required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/config/smtp/test',
  tags: ['Config'],
  summary: 'Send a test email through the configured SMTP transport',
  request: { body: { content: jsonContent(SmtpTestSendRequestSchema) } },
  responses: {
    200: {
      description: 'Test email accepted by the SMTP transport.',
      content: jsonContent(z.object({ ok: z.literal(true), to: z.string() })),
    },
    400: errorResponse('SMTP is unconfigured, no usable recipient, or invalid recipient.'),
    403: errorResponse('Supplied recipient is not allowed for this caller.'),
    429: errorResponse('Rate-limited.'),
    502: errorResponse('SMTP transport failed without exposing secrets.'),
  },
});

registerPath({
  method: 'patch',
  path: '/api/config',
  tags: ['Config'],
  summary: 'Update one or more config fields',
  description:
    'Allowed keys: `claudeBin`, `cursorBin`, `geminiBin`, `codexBin`, `grokBin`, `defaultModel` (deprecated and ignored), `defaultCwd`, `port`, `apiKey`, `openaiApiKey`, `publicUrl`, `codexDangerBypass`, `codexProfile`. The deprecated `defaultModel` key is accepted but ignored with a deprecation warning. Model selection is per-user and per-agent; unknown keys are silently dropped. Returns the updated subset (with secrets masked).',
  request: { body: { content: jsonContent(PatchConfigRequestSchema) } },
  responses: {
    200: {
      description: 'Updated keys (masked where applicable).',
      content: jsonContent(
        z.object({
          ok: z.boolean(),
          updated: z.record(z.string(), z.unknown()),
          deprecations: z.record(z.string(), z.string()).optional(),
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

// ─── Google OAuth app (server-global, Admin/Owner-gated) ──────────

registerPath({
  method: 'get',
  path: '/api/config/google-oauth',
  tags: ['Config'],
  summary: 'Read server-global Google OAuth app configuration status',
  responses: {
    200: {
      description: 'Google OAuth app status.',
      content: jsonContent(GoogleOAuthStatusComponent),
    },
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/config/google-oauth',
  tags: ['Config'],
  summary: 'Set server-global Google OAuth app credentials',
  request: { body: { content: jsonContent(PutGoogleOAuthRequestSchema) } },
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
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/config/google-oauth',
  tags: ['Config'],
  summary: 'Clear server-global Google OAuth app credentials',
  responses: {
    200: {
      description: 'Removed.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher.'),
  },
});

// ─── GitHub App (server-global, Admin/Owner-gated) ────────────────

registerPath({
  method: 'get',
  path: '/api/config/github-app',
  tags: ['Config'],
  summary: 'Read server-global GitHub App configuration status (mirror-push bypass identity)',
  responses: {
    200: {
      description: 'GitHub App status. The private key is never returned.',
      content: jsonContent(GithubAppStatusComponent),
    },
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/config/github-app',
  tags: ['Config'],
  summary: 'Set server-global GitHub App credentials',
  request: { body: { content: jsonContent(PutGithubAppRequestSchema) } },
  responses: {
    200: {
      description: 'Saved.',
      content: jsonContent(
        z.object({
          ok: z.boolean(),
          configured: z.literal(true),
          appId: z.union([z.string(), z.number()]),
          installationId: z.union([z.string(), z.number()]).nullable(),
          installations: z.array(GithubAppInstallationComponent),
          hasPrivateKey: z.boolean(),
        }),
      ),
    },
    400: errorResponse('appId is required (and privateKey when none is stored).'),
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/config/github-app',
  tags: ['Config'],
  summary: 'Clear server-global GitHub App credentials',
  responses: {
    200: {
      description: 'Removed.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher.'),
  },
});

// ─── DB instrumentation ──────────────────────────────────────────

const DbStatsComponent = registerComponent(
  'DbInstrumentationStats',
  z
    .object({
      enabled: z.boolean().openapi({ description: 'Whether statement timing is active.' }),
      slowThresholdMs: z
        .number()
        .openapi({ description: 'Calls at or above this wall-time (ms) count as slow.' }),
      totalStatements: z
        .number()
        .int()
        .openapi({ description: 'Distinct statement tags with at least one recorded call.' }),
      totalCalls: z.number().int(),
      totalSlowCalls: z.number().int(),
      statements: z
        .array(
          z.object({
            tag: z
              .string()
              .openapi({ description: 'Statement key (never contains SQL text or params).' }),
            count: z.number().int(),
            totalMs: z.number(),
            maxMs: z.number(),
            slowCount: z.number().int(),
          }),
        )
        .openapi({
          description: 'Per-statement aggregates, sorted by total wall time descending.',
        }),
    })
    .openapi({ description: 'Aggregated prepared-statement wall-time timings.' }),
);

registerPath({
  method: 'get',
  path: '/api/config/db-stats',
  tags: ['Config'],
  summary: 'Read aggregated DB prepared-statement wall-time timings',
  description:
    'Per-statement timing aggregates for the async-DB Phase-1 instrumentation. Tags only — no SQL text or bound parameters are exposed. Empty when instrumentation is disabled (the default).',
  responses: {
    200: { description: 'Timing snapshot.', content: jsonContent(DbStatsComponent) },
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/config/db-stats/reset',
  tags: ['Config'],
  summary: 'Clear accumulated DB statement timing aggregates',
  responses: {
    200: { description: 'Cleared.', content: jsonContent(z.object({ ok: z.literal(true) })) },
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher.'),
  },
});

// ─── GitHub CLI ──────────────────────────────────────────────────

registerPath({
  method: 'get',
  path: '/api/github/status',
  tags: ['GitHub'],
  summary: 'Read `gh` CLI auth status',
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
  summary: 'Export a project (project + crons + rooms + wiki + kanban)',
  description:
    'Returns a V3 export envelope as a downloadable JSON attachment. Session-id linkages on kanban cards are stripped.',
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
