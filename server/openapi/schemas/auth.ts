// Centralised Zod schemas for the auth route group.
//
// Two layers of validation cooperate in the auth routes:
//
//   1. Shape validation (this file). Zod parses the request body / query
//      and confirms each field has the right *type*. Failures surface as
//      400 with the issue list — see `formatZodError` below.
//   2. Domain validation (still in the route handlers). Login identifier /
//      password length and character-set rules live in `auth-validation.ts`
//      because the boot-time provisioning path needs the same rules. Keeping
//      the Zod schemas to "is this a string?" preserves the existing
//      error-message contract that callers and tests depend on. New and updated
//      login identifiers are emails, while login still accepts legacy
//      non-email usernames during the deprecation window.
//
// Schemas declared here are also registered with the OpenAPI registry so
// the generated `openapi.yaml` documents every auth body + response.

import { z, registerComponent } from '../registry.js';

// ── Common building blocks ─────────────────────────────────────────────

export const ErrorResponse = registerComponent(
  'ErrorResponse',
  z
    .object({
      error: z.string().openapi({ description: 'Human-readable error message.' }),
      code: z.string().optional(),
    })
    .openapi({ description: 'Standard error envelope used across the API.' }),
);

export const ZodIssueShape = registerComponent(
  'ZodIssue',
  z
    .object({
      path: z.array(z.union([z.string(), z.number()])),
      message: z.string(),
      code: z.string().optional(),
    })
    .openapi({
      description:
        'A single Zod validation issue. Returned on 400 responses caused by request-body shape errors.',
    }),
);

export const ZodErrorResponse = registerComponent(
  'ZodErrorResponse',
  z
    .object({
      error: z.string(),
      issues: z.array(ZodIssueShape).optional(),
    })
    .openapi({
      description:
        'A 400 response produced by Zod body/query validation. `issues` lists each field that failed.',
    }),
);

export const UserSummary = registerComponent(
  'UserSummary',
  z.object({
    id: z.string().optional().nullable(),
    email: z.string().nullable(),
    // Login identifier. May be an email or a plain username; the UI uses it as
    // a display label (and a fallback when `email` is null for non-email logins).
    username: z.string().optional(),
    needsEmailUpdate: z.boolean().optional(),
    role: z.enum(['Owner', 'Admin', 'User']),
    createdAt: z.union([z.string(), z.number()]).optional().nullable(),
    mfaEnabled: z.boolean().optional(),
  }),
);

export const TokenResponse = registerComponent(
  'TokenResponse',
  z.object({
    token: z.string(),
    expiresAt: z.string(),
    user: z.object({
      id: z.string().optional(),
      email: z.string().nullable(),
      needsEmailUpdate: z.boolean().optional(),
      role: z.enum(['Owner', 'Admin', 'User']),
    }),
  }),
);

export const MfaRequiredResponse = registerComponent(
  'MfaRequiredResponse',
  z.object({
    mfaRequired: z.literal(true),
    challengeId: z.string(),
    expiresAt: z.string(),
    user: z.object({
      id: z.string().optional(),
      email: z.string().nullable(),
      needsEmailUpdate: z.boolean().optional(),
      role: z.enum(['Owner', 'Admin', 'User']),
    }),
  }),
);

// ── Bodies (request shapes) ────────────────────────────────────────────

function credentialBody<T extends z.ZodRawShape>(extra: T, description: string) {
  return z
    .union([
      z.object({
        email: z.string(),
        username: z.string().optional(),
        ...extra,
      }),
      z.object({
        username: z.string(),
        email: z.string().optional(),
        ...extra,
      }),
    ])
    .openapi({ description });
}

export const SetupBody = registerComponent(
  'AuthSetupBody',
  credentialBody(
    { password: z.string() },
    '`email` is canonical. `username` is accepted for compatibility. One identifier is required.',
  ),
);

export const LoginBody = registerComponent(
  'AuthLoginBody',
  credentialBody(
    { password: z.string() },
    '`email` is canonical. `username` is accepted for legacy non-email account login. One identifier is required.',
  ),
);

export const MfaCodeBody = registerComponent(
  'AuthMfaCodeBody',
  z.object({
    code: z.string(),
  }),
);

export const MfaLoginBody = registerComponent(
  'AuthMfaLoginBody',
  z.object({
    challengeId: z.string(),
    code: z.string(),
  }),
);

export const CreateUserBody = registerComponent(
  'AuthCreateUserBody',
  credentialBody(
    { password: z.string(), role: z.enum(['Owner', 'Admin', 'User']).optional() },
    '`email` is canonical. `username` is accepted for compatibility. One identifier is required.',
  ),
);

export const UpdateEmailBody = registerComponent(
  'AuthUpdateEmailBody',
  z.object({
    email: z.string(),
  }),
);

export const UpdateUserRoleBody = registerComponent(
  'AuthUpdateUserRoleBody',
  z.object({
    role: z.enum(['Owner', 'Admin', 'User']),
  }),
);

export const PasswordResetBody = registerComponent(
  'AuthPasswordResetBody',
  z.object({
    newPassword: z.string(),
  }),
);

export const ForgotPasswordBody = registerComponent(
  'AuthForgotPasswordBody',
  z.object({
    email: z.string(),
  }),
);

export const ResetPasswordBody = registerComponent(
  'AuthResetPasswordBody',
  z.object({
    token: z.string(),
    newPassword: z.string(),
  }),
);

export const CreateApiKeyBody = registerComponent(
  'CreateApiKeyBody',
  z.object({
    name: z.string(),
    expiresInDays: z.union([z.number(), z.string(), z.null()]).optional().openapi({
      description: '1–3650 days, or null/omitted to never expire. Strings are coerced to numbers.',
    }),
  }),
);

export const CreateInviteBody = registerComponent(
  'CreateInviteBody',
  z.object({
    role: z.enum(['Admin', 'User']).optional(),
    email: z.string().optional().nullable(),
    ttlHours: z.number().optional(),
  }),
);

export const AcceptInviteBody = registerComponent(
  'AcceptInviteBody',
  credentialBody(
    { password: z.string() },
    '`email` is canonical. `username` is accepted for compatibility. One identifier is required.',
  ),
);

export const UpdateClaudeAuthBody = registerComponent(
  'UpdateClaudeAuthBody',
  z
    .object({
      anthropicApiKey: z.string().nullable().optional(),
      claudeCodeOAuthToken: z.string().nullable().optional(),
      claudeCodeOAuthExpiresAt: z.string().nullable().optional(),
    })
    .openapi({
      description:
        'Per-user Claude credentials. Each field is whitelisted before reaching the DB — unknown keys are silently dropped.',
    }),
);

export const UpdateSingleKeyAuthBody = registerComponent(
  'UpdateSingleKeyAuthBody',
  z
    .object({
      apiKey: z.string().nullable().optional(),
    })
    .openapi({
      description: 'Per-user single-key engine credentials (Cursor / Gemini / Codex).',
    }),
);

export const UpsertSkillCredentialBody = registerComponent(
  'UpsertSkillCredentialBody',
  z
    .object({
      skill_id: z.string(),
      key_name: z.string(),
      // Optional. When provided, the skill schema is read from that agent's
      // project skill store (`<dataDir>/project-skills/<projectId>/{skill_id}/SKILL.md`) before
      // falling back to bundled defaults — this is the flow used by the
      // SkillsPage credential editor (per-agent context). When omitted,
      // the schema must resolve from bundled `server/default-skills/`
      // (or the global `skill_registry` import), which is the flow used by
      // the Account page personal-credentials section (no agent context).
      agent_id: z.string().optional(),
      value: z.string().optional(),
    })
    .openapi({
      description:
        'Upsert a per-user skill credential. `agent_id` is optional: omit it when ' +
        'setting a personal credential for a bundled default skill from the Account page.',
    }),
);

export const UpsertSkillOptionBody = registerComponent(
  'UpsertSkillOptionBody',
  z
    .object({
      skill_id: z.string(),
      option_name: z.string(),
      // Must be one of the option's declared `choices` values. Same optional
      // `agent_id` schema-source semantics as UpsertSkillCredentialBody:
      // provided → read the option schema from that agent's project skill
      // store first; omitted → bundled default-skills / registry only.
      agent_id: z.string().optional(),
      value: z.string(),
    })
    .openapi({
      description:
        'Select a per-user, non-secret skill option (owner-curated enum, e.g. dev/prod). ' +
        "`value` must be one of the option's declared choices.",
    }),
);

export const AgentEngineOverrideEntry = registerComponent(
  'AgentEngineOverrideEntry',
  z
    .object({
      engine: z.string().min(1),
      model: z.string().min(1).optional(),
    })
    .openapi({
      description:
        'A per-agent engine override on the caller. The optional `model` further pins a specific CLI model id within that engine; when omitted the per-engine default (or hub fallback) is used.',
    }),
);

export const PutAgentEngineOverridesBody = registerComponent(
  'PutAgentEngineOverridesBody',
  z.object({
    agentEngineOverrides: z.record(z.string(), AgentEngineOverrideEntry),
  }),
);

export const PutAgentModelOverridesBody = registerComponent(
  'PutAgentModelOverridesBody',
  z
    .object({
      agentModelOverrides: z.record(z.string(), z.string()),
    })
    .openapi({
      description:
        'Caller-scoped map of agentId → model id — the per-user "default model" picked from the agent / reviewer model dropdown. Pass `{ agentModelOverrides: {} }` to clear. Each model must be valid for some configured engine; pass an empty string to drop a single agent entry.',
    }),
);

export const PutAgentModelOverrideEntryBody = registerComponent(
  'PutAgentModelOverrideEntryBody',
  z
    .object({
      model: z.string().min(1),
    })
    .openapi({
      description:
        "Set the caller's per-user default model for a single agent (path `:agentId`). Merges server-side, so it never disturbs other agents' picks or another tab's concurrent edit. Use DELETE on the same path to clear.",
    }),
);

export const SidebarCollapsedProjectsResponse = registerComponent(
  'SidebarCollapsedProjectsResponse',
  z
    .object({
      sidebarCollapsedProjects: z.array(z.string()),
    })
    .openapi({
      description:
        'Project ids the caller has collapsed in the sidebar project list. Caller-scoped, so the same account sees the same collapsed projects on web, mobile, and Electron.',
    }),
);

export const PutSidebarCollapsedProjectBody = registerComponent(
  'PutSidebarCollapsedProjectBody',
  z
    .object({
      collapsed: z.boolean(),
    })
    .openapi({
      description:
        "Collapse (`true`) or expand (`false`) a single project in the caller's sidebar. Merges server-side so a toggle never clobbers another tab's concurrent edit.",
    }),
);

// ── CLI auth route bodies ──────────────────────────────────────────────

export const ClaudeLoginBody = registerComponent(
  'ClaudeLoginBody',
  z.object({
    method: z.string().optional(),
    email: z.string().optional(),
    sso: z.boolean().optional(),
  }),
);

export const ClaudeCallbackBody = registerComponent(
  'ClaudeCallbackBody',
  z.object({
    code: z.string().openapi({ description: 'OAuth authorization code from Anthropic.' }),
  }),
);

export const ApiKeyOnlyBody = registerComponent(
  'ApiKeyOnlyBody',
  z.object({
    apiKey: z.string().nullable().optional(),
  }),
);

export const ApiKeyRequiredBody = registerComponent(
  'ApiKeyRequiredBody',
  z.object({
    apiKey: z.string().min(1),
  }),
);

export const OauthTokenBody = registerComponent(
  'OauthTokenBody',
  z.object({
    oauthToken: z.string().nullable().optional(),
  }),
);

// ── GitHub OAuth ───────────────────────────────────────────────────────

export const GithubConnectTokenBody = registerComponent(
  'GithubConnectTokenBody',
  z.object({
    token: z.string().min(1),
  }),
);

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Convert a ZodError into the response shape the auth routes return on
 * shape-validation failure. Kept on a single shape so OpenAPI clients can
 * rely on `{ error, issues }` always being present together.
 */
export function formatZodError(err: z.ZodError): {
  error: string;
  issues: Array<{ path: Array<string | number>; message: string; code: string }>;
} {
  const issues = err.issues.map((issue) => ({
    path: issue.path.map((p) => (typeof p === 'number' ? p : String(p))),
    message: issue.message,
    code: issue.code,
  }));
  const summary =
    issues.length > 0
      ? `${issues[0].path.join('.') || '(root)'}: ${issues[0].message}`
      : 'invalid request body';
  return { error: summary, issues };
}
