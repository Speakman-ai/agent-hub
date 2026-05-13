// Centralised Zod schemas for the auth route group.
//
// Two layers of validation cooperate in the auth routes:
//
//   1. Shape validation (this file). Zod parses the request body / query
//      and confirms each field has the right *type*. Failures surface as
//      400 with the issue list — see `formatZodError` below.
//   2. Domain validation (still in the route handlers). Username / password
//      length & character-set rules live in `auth-validation.ts` because
//      the boot-time provisioning path needs the same rules. Keeping the
//      Zod schemas to "is this a string?" preserves the existing
//      error-message contract that callers and tests depend on.
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
    username: z.string(),
    role: z.enum(['Owner', 'Admin', 'User']),
    createdAt: z.union([z.string(), z.number()]).optional().nullable(),
  }),
);

export const TokenResponse = registerComponent(
  'TokenResponse',
  z.object({
    token: z.string(),
    expiresAt: z.string(),
    user: z.object({
      id: z.string().optional(),
      username: z.string(),
      role: z.enum(['Owner', 'Admin', 'User']),
    }),
  }),
);

// ── Bodies (request shapes) ────────────────────────────────────────────

export const SetupBody = registerComponent(
  'AuthSetupBody',
  z.object({
    username: z.string(),
    password: z.string(),
  }),
);

export const LoginBody = registerComponent(
  'AuthLoginBody',
  z.object({
    username: z.string(),
    password: z.string(),
  }),
);

export const CreateUserBody = registerComponent(
  'AuthCreateUserBody',
  z.object({
    username: z.string(),
    password: z.string(),
    role: z.enum(['Owner', 'Admin', 'User']).optional(),
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
    role: z.enum(['Owner', 'Admin', 'User']).optional(),
    email: z.string().optional().nullable(),
    ttlHours: z.number().optional(),
  }),
);

export const AcceptInviteBody = registerComponent(
  'AcceptInviteBody',
  z.object({
    username: z.string(),
    password: z.string(),
  }),
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
  z.object({
    skill_id: z.string(),
    key_name: z.string(),
    agent_id: z.string(),
    value: z.string().optional(),
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
