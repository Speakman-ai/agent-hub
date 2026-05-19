/**
 * Authentication & user-management routes.
 *
 * Auth bootstrap (still single-user at install time):
 *   POST /api/auth/setup    { username, password } → { ok, token, user }
 *   POST /api/auth/login    { username, password } → { token, expiresAt, user }
 *   GET  /api/auth/me       → { user: { username, role } }  (requires bearer token)
 *   POST /api/auth/logout   → { ok }
 *   GET  /api/auth/status   → { authConfigured, username?, role? }
 *
 * Phase 3 additions — users + memberships + invites:
 *   GET    /api/auth/users             (Admin+)  list members of active org
 *   POST   /api/auth/users             (Owner)   create user + membership
 *   PUT    /api/auth/users/:id/role    (Admin+/Owner) change membership role
 *   DELETE /api/auth/users/:id         (Owner)   remove from active org
 *   POST   /api/auth/users/:id/password            self or Owner — reset
 *   POST   /api/auth/invites           (Admin+)  issue invite token
 *   GET    /api/auth/invites           (Admin+)  list active invites
 *   DELETE /api/auth/invites/:token    (Admin+)  revoke invite
 *   GET    /api/auth/invites/:token    (public)  invite landing metadata
 *   POST   /api/auth/invites/:token/accept (public) redeem invite
 *
 * PUBLIC_PATHS + PUBLIC_PREFIXES in `server/auth.ts` let `/status`,
 * `/login`, and the invite landing/accept endpoints through without
 * authentication. Everything else goes through the auth middleware.
 */
import { Router, Request, Response } from 'express';
import { existsSync } from 'fs';
import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';
import config from '../config.js';
import { signJwt } from '../jwt.js';
import { hashPassword, verifyPassword } from '../password.js';
import {
  getAuthRecord,
  isAuthConfigured,
  saveAuthRecord,
  generateJwtSecret,
} from '../auth-store.js';
import { requireRole, hasAtLeastRole, parseRole, type Role } from '../roles.js';
import { isLocalBundledServer, type AuthenticatedRequest } from '../auth.js';
import { getActiveOrgId, getOrg, getOrgsDb } from '../orgs.js';
import {
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  deleteUser,
  updateUserPassword,
  countUsers,
  migrateAuthRecordIfNeeded,
  getUserClaudeAuth,
  setUserClaudeAuth,
  getUserCursorAuth,
  setUserCursorAuth,
  getUserGeminiAuth,
  setUserGeminiAuth,
  getUserCodexAuth,
  setUserCodexAuth,
} from '../users-store.js';
import {
  getUserPreferencesRow,
  mergeUserPreferencesJson,
  type AgentEngineOverride,
} from '../user-preferences-store.js';
import {
  createMembership,
  deleteMembership,
  getMembershipRole,
  setMembershipRole,
  countOwnersForOrg,
  countMembershipsForUser,
  listMembersForOrg,
} from '../memberships-store.js';
import {
  createInvite,
  deleteInvite,
  getInvite,
  inviteState,
  listActiveInvitesForOrg,
  markInviteAccepted,
} from '../invites-store.js';
import {
  sanitizeUsername,
  sanitizePassword,
  MIN_PASSWORD_LEN,
  MAX_PASSWORD_LEN,
} from '../auth-validation.js';
import { parseClaudeOAuthExpiry } from '../oauth-expiry.js';
import { detectCodexAuthMode } from '../codex-auth.js';
import { computeCodexUiStatus } from '../codex-device-auth-parse.js';
import {
  isCodexDeviceLoginInProgress,
  perUserCodexHomePath,
} from '../per-user-codex-device-login.js';
import { createApiKey, listApiKeys, revokeApiKey, countApiKeysForUser } from '../api-keys-store.js';
import { recoverActiveSessionsAfterSetup } from '../spawn-creds-setup-recovery.js';
import {
  listMaskedUserSkillCredentials,
  upsertUserSkillCredential,
  deleteUserSkillCredential,
  existsUserSkillCredential,
  deleteUserSkillCredentialByKey,
} from '../skill-credentials-store.js';
import { readCredentialsSchemaForSkill } from '../skill-credentials-resolve.js';
import { findAgent } from '../project-model.js';
import { registerPath, z } from '../openapi/registry.js';
import {
  AcceptInviteBody,
  CreateApiKeyBody,
  CreateInviteBody,
  CreateUserBody,
  ErrorResponse,
  LoginBody,
  PasswordResetBody,
  SetupBody,
  TokenResponse,
  UpdateClaudeAuthBody,
  UpdateSingleKeyAuthBody,
  UpdateUserRoleBody,
  UpsertSkillCredentialBody,
  PutAgentEngineOverridesBody,
  UserSummary,
  ZodErrorResponse,
  formatZodError,
} from '../openapi/schemas/auth.js';

// ── OpenAPI registrations (Auth & user management) ─────────────────────
//
// Registered at module-load so `server/openapi/generate.ts` picks them up
// before the router factory runs.

registerPath({
  method: 'get',
  path: '/api/auth/status',
  tags: ['Auth'],
  summary: 'Public auth status (used by the login screen).',
  responses: {
    200: {
      description: 'Whether auth is configured and which secrets are present.',
      content: {
        'application/json': {
          schema: z.object({
            authConfigured: z.boolean(),
            username: z.string().nullable(),
            role: z.enum(['Owner', 'Admin', 'User']).nullable(),
            jwtConfigured: z.boolean(),
            apiKeyConfigured: z.boolean(),
            needsMigration: z.boolean(),
            activeOrgIsLocal: z.boolean(),
          }),
        },
      },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/setup',
  tags: ['Auth'],
  summary: 'First-run setup — provisions the Owner user.',
  request: { body: { content: { 'application/json': { schema: SetupBody } } } },
  responses: {
    200: {
      description: 'Setup succeeded; Owner token returned.',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            token: z.string(),
            expiresAt: z.string(),
            user: z.object({
              username: z.string(),
              role: z.enum(['Owner', 'Admin', 'User']),
            }),
          }),
        },
      },
    },
    400: {
      description: 'Invalid body or domain validation failure.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    409: {
      description: 'Auth already configured.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/login',
  tags: ['Auth'],
  summary: 'Issue a JWT for an existing user.',
  request: { body: { content: { 'application/json': { schema: LoginBody } } } },
  responses: {
    200: {
      description: 'Login succeeded.',
      content: { 'application/json': { schema: TokenResponse } },
    },
    400: {
      description: 'Invalid body shape.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    401: {
      description: 'Wrong credentials.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'No membership in active org.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description: 'Auth not configured.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate-limited.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/me',
  tags: ['Auth'],
  summary: 'Identity of the currently authenticated caller.',
  responses: {
    200: {
      description: 'Caller summary.',
      content: {
        'application/json': {
          schema: z.object({
            user: z
              .object({ username: z.string(), role: z.enum(['Owner', 'Admin', 'User']).nullable() })
              .nullable(),
            authConfigured: z.boolean(),
            role: z.enum(['Owner', 'Admin', 'User']).nullable(),
            orgId: z.string().nullable(),
          }),
        },
      },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/me/claude-auth',
  tags: ['Auth'],
  summary: 'Per-user Claude credentials (masked).',
  responses: {
    200: {
      description: 'Stored credentials with masking.',
      content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'put',
  path: '/api/auth/me/claude-auth',
  tags: ['Auth'],
  summary: 'Update per-user Claude credentials.',
  request: { body: { content: { 'application/json': { schema: UpdateClaudeAuthBody } } } },
  responses: {
    200: {
      description: 'Updated.',
      content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: 'Invalid body.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// Common "single-key" shape — cursor / gemini share it exactly. Codex
// uses an extended shape (adds `deviceLogin`) so it's registered
// separately below.
const SingleKeyAuthGetResponse = z.object({
  engine: z.string(),
  apiKey: z.string().nullable(),
  updatedAt: z.union([z.string(), z.number()]).nullable().optional(),
  hostConfigFallback: z.object({ apiKey: z.boolean() }),
});

const CodexAuthDeviceLoginShape = z.object({
  uiStatus: z.enum(['missing', 'pending', 'authenticated']),
  loginInProgress: z.boolean(),
  oauth: z.object({
    loggedIn: z.boolean(),
    mode: z.string().nullable(),
    authJsonPath: z.string().nullable(),
  }),
  codexHomePath: z.string().nullable(),
});

const CodexAuthGetResponse = SingleKeyAuthGetResponse.extend({
  deviceLogin: CodexAuthDeviceLoginShape,
});

for (const engine of ['cursor', 'gemini'] as const) {
  registerPath({
    method: 'get',
    path: `/api/auth/me/${engine}-auth`,
    tags: ['Auth'],
    summary: `Per-user ${engine} credentials (masked).`,
    responses: {
      200: {
        description: 'Stored credentials with masking.',
        content: { 'application/json': { schema: SingleKeyAuthGetResponse } },
      },
      401: {
        description: 'Not authenticated.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'User not found.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  });
  registerPath({
    method: 'put',
    path: `/api/auth/me/${engine}-auth`,
    tags: ['Auth'],
    summary: `Update per-user ${engine} credentials.`,
    request: { body: { content: { 'application/json': { schema: UpdateSingleKeyAuthBody } } } },
    responses: {
      200: {
        description: 'Updated.',
        content: { 'application/json': { schema: SingleKeyAuthGetResponse } },
      },
      400: {
        description: 'Invalid body.',
        content: { 'application/json': { schema: ZodErrorResponse } },
      },
      401: {
        description: 'Not authenticated.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'User not found.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  });
}

// Codex — same single-key shape PLUS the per-user device-login probe.
registerPath({
  method: 'get',
  path: '/api/auth/me/codex-auth',
  tags: ['Auth'],
  summary: 'Per-user Codex credentials (masked) + device-login (CODEX_HOME) status.',
  responses: {
    200: {
      description: 'Stored API key + per-user CODEX_HOME inspection.',
      content: { 'application/json': { schema: CodexAuthGetResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});
registerPath({
  method: 'put',
  path: '/api/auth/me/codex-auth',
  tags: ['Auth'],
  summary: 'Update per-user Codex credentials.',
  request: { body: { content: { 'application/json': { schema: UpdateSingleKeyAuthBody } } } },
  responses: {
    200: {
      description: 'Updated.',
      content: { 'application/json': { schema: SingleKeyAuthGetResponse } },
    },
    400: {
      description: 'Invalid body.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/me/agent-engine-overrides',
  tags: ['Auth'],
  summary: 'Per-user per-agent engine (+ optional model) overrides.',
  responses: {
    200: {
      description:
        'Caller-scoped map of agentId → { engine, model? }. Entries whose engine/model are no longer in `engineValidModels` are filtered out.',
      content: {
        'application/json': {
          schema: z.object({
            agentEngineOverrides: z.record(
              z.string(),
              z.object({ engine: z.string(), model: z.string().optional() }),
            ),
          }),
        },
      },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User row missing.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'put',
  path: '/api/auth/me/agent-engine-overrides',
  tags: ['Auth'],
  summary: 'Replace the caller-scoped per-agent engine override map.',
  description:
    'Pass `{ agentEngineOverrides: {} }` to clear all overrides. Each entry must name an engine present in `engineValidModels`; optional `model` must be a valid model for that engine.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: PutAgentEngineOverridesBody,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated map.',
      content: {
        'application/json': {
          schema: z.object({
            agentEngineOverrides: z.record(
              z.string(),
              z.object({ engine: z.string(), model: z.string().optional() }),
            ),
          }),
        },
      },
    },
    400: {
      description: 'Invalid payload.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User row missing.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/me/skill-credentials',
  tags: ['Auth'],
  summary: 'List masked per-user skill credentials.',
  request: { query: z.object({ skillId: z.string().optional() }) },
  responses: {
    200: {
      description: 'Credential list.',
      content: {
        'application/json': {
          schema: z.object({ credentials: z.array(z.record(z.string(), z.unknown())) }),
        },
      },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Lookup failed.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'put',
  path: '/api/auth/me/skill-credentials',
  tags: ['Auth'],
  summary: 'Upsert a single per-user skill credential.',
  request: { body: { content: { 'application/json': { schema: UpsertSkillCredentialBody } } } },
  responses: {
    200: {
      description: 'Created or cleared.',
      content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: 'Validation failure.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Caller is not a member of the org.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Agent / workspace not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/me/skill-credentials/{id}',
  tags: ['Auth'],
  summary: 'Delete a per-user skill credential by id.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Deleted.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Credential not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/keys',
  tags: ['Auth'],
  summary: "List the caller's active API keys.",
  responses: {
    200: {
      description: 'Key metadata (no plaintext tokens).',
      content: {
        'application/json': {
          schema: z.object({
            keys: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                prefix: z.string(),
                createdAt: z.string(),
                lastUsedAt: z.string().nullable(),
                expiresAt: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/keys',
  tags: ['Auth'],
  summary: 'Create a new per-user API key.',
  request: { body: { content: { 'application/json': { schema: CreateApiKeyBody } } } },
  responses: {
    201: {
      description: 'Key created — plaintext token shown ONCE.',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            name: z.string(),
            token: z.string(),
            prefix: z.string(),
            createdAt: z.string(),
            expiresAt: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid body.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Key cap reached.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/keys/{id}',
  tags: ['Auth'],
  summary: 'Revoke a per-user API key.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Revoked.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Key not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/users',
  tags: ['Auth'],
  summary: 'List members of the active org (Admin+).',
  responses: {
    200: {
      description: 'Member list.',
      content: { 'application/json': { schema: z.object({ users: z.array(UserSummary) }) } },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/users',
  tags: ['Auth'],
  summary: 'Create a user + membership (Owner only).',
  request: { body: { content: { 'application/json': { schema: CreateUserBody } } } },
  responses: {
    201: {
      description: 'Created.',
      content: { 'application/json': { schema: z.object({ user: UserSummary }) } },
    },
    400: {
      description: 'Invalid body or domain failure.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    403: {
      description: 'Only Owner may create Owner.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description: 'Username taken.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'put',
  path: '/api/auth/users/{id}/role',
  tags: ['Auth'],
  summary: "Change a member's role in the active org (Admin+).",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: UpdateUserRoleBody } } },
  },
  responses: {
    200: {
      description: 'Updated.',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            userId: z.string(),
            orgId: z.string(),
            role: z.enum(['Owner', 'Admin', 'User']),
          }),
        },
      },
    },
    400: {
      description: 'Invalid role or sole-Owner demotion.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User or membership missing.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/users/{id}',
  tags: ['Auth'],
  summary: 'Remove a user from the active org (Owner only).',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Removed; cascade summary if the user was deleted entirely.',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            userId: z.string(),
            orgId: z.string(),
            userDeleted: z.boolean(),
            cascadedPrivateProjects: z.array(z.string()),
            orphanedSharedProjects: z.array(z.string()),
          }),
        },
      },
    },
    400: {
      description: 'Sole-Owner protection.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User or membership missing.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/users/{id}/password',
  tags: ['Auth'],
  summary: 'Self-reset or Owner-reset a user password.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: PasswordResetBody } } },
  },
  responses: {
    200: {
      description: 'Password updated.',
      content: {
        'application/json': { schema: z.object({ ok: z.literal(true), userId: z.string() }) },
      },
    },
    400: {
      description: 'Invalid body.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    403: {
      description: 'Only self or Owner may reset.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/invites',
  tags: ['Auth'],
  summary: 'Issue an invite for the active org (Admin+).',
  request: { body: { content: { 'application/json': { schema: CreateInviteBody } } } },
  responses: {
    201: {
      description: 'Invite created.',
      content: {
        'application/json': {
          schema: z.object({
            token: z.string(),
            url: z.string(),
            role: z.enum(['Owner', 'Admin', 'User']),
            email: z.string().nullable(),
            expiresAt: z.string(),
            createdAt: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid role or missing user session.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/invites',
  tags: ['Auth'],
  summary: 'List active invites for the active org (Admin+).',
  responses: {
    200: {
      description: 'Invite list.',
      content: {
        'application/json': {
          schema: z.object({
            invites: z.array(
              z.object({
                token: z.string(),
                orgId: z.string(),
                role: z.enum(['Owner', 'Admin', 'User']),
                email: z.string().nullable(),
                expiresAt: z.string(),
                createdAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/invites/{token}',
  tags: ['Auth'],
  summary: 'Revoke an invite (Admin+, same org only).',
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: {
      description: 'Revoked.',
      content: {
        'application/json': { schema: z.object({ ok: z.literal(true), token: z.string() }) },
      },
    },
    403: {
      description: 'Cross-org or insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Invite not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/invites/{token}',
  tags: ['Auth'],
  summary: 'Public landing metadata for an invite token.',
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: {
      description: 'Invite preview.',
      content: {
        'application/json': {
          schema: z.object({
            orgId: z.string(),
            orgName: z.string(),
            role: z.enum(['Owner', 'Admin', 'User']),
            email: z.string().nullable(),
            expiresAt: z.string(),
            accepted: z.boolean(),
          }),
        },
      },
    },
    404: {
      description: 'Invite not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    410: {
      description: 'Invite expired.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/invites/{token}/accept',
  tags: ['Auth'],
  summary: 'Redeem an invite — creates user, membership, returns a JWT.',
  request: {
    params: z.object({ token: z.string() }),
    body: { content: { 'application/json': { schema: AcceptInviteBody } } },
  },
  responses: {
    201: {
      description: 'User created and signed in.',
      content: { 'application/json': { schema: TokenResponse } },
    },
    400: {
      description: 'Invalid body or domain failure.',
      content: { 'application/json': { schema: ZodErrorResponse } },
    },
    404: {
      description: 'Invite not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description: 'Username taken.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    410: {
      description: 'Invite expired / already accepted / lost race.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate-limited.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Server auth not configured.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/logout',
  tags: ['Auth'],
  summary: 'Stateless logout receipt (client drops its JWT).',
  responses: {
    200: {
      description: 'Receipt.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
  },
});

const DEFAULT_TOKEN_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

function issueToken(user: { id: string; username: string }, role: Role, jwtSecret: string) {
  const token = signJwt(user.username, jwtSecret, {
    expiresInSec: DEFAULT_TOKEN_TTL_SEC,
    claims: { role, uid: user.id },
  });
  const expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_SEC * 1000).toISOString();
  return { token, expiresAt };
}

// ── Rate-limit defaults ────────────────────────────────────────────
// Public launch blocker (see kanban "Auth hardening: rate-limit login
// & invite-accept endpoints"). Without these, two-account brute-force
// works over the internet. Thresholds were chosen to be permissive
// enough that a human fat-fingering their password a few times won't
// lock themselves out, but tight enough that a credential-stuffing
// script can't meaningfully chip away at the space.
// Exported so tests can pin the default thresholds — a typo here
// (dropping a zero, swapping min↔h) would otherwise slip past CI since
// the override-based tests pass their own numbers.
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
export const LOGIN_RATE_LIMIT_MAX = 10;
export const INVITE_ACCEPT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 h
export const INVITE_ACCEPT_RATE_LIMIT_MAX = 5;

/**
 * Render a credential for the UI without leaking the secret. Returns
 * `null` for empty inputs so the client can simply check truthiness to
 * decide whether the field is configured.
 *
 * Format: keep the recognisable prefix up to the first `-` (or first 8
 * chars when no `-`) plus a fixed `…` marker. Never echo the raw value.
 */
export function maskCredential(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dash = trimmed.indexOf('-', 8);
  const prefix = dash > 0 ? trimmed.slice(0, dash + 1) : trimmed.slice(0, 8);
  return `${prefix}…`;
}

export interface AuthRoutesOptions {
  /** Override login limiter. Tests pass tiny windows to exercise 429s quickly. */
  loginRateLimit?: { windowMs: number; limit: number };
  /** Override invite-accept limiter. */
  inviteAcceptRateLimit?: { windowMs: number; limit: number };
  /** Disable rate limiting entirely — used by tests that aren't about the limiter itself. */
  disableRateLimit?: boolean;
  /**
   * Callback invoked when the user-delete path drops a user's last
   * membership and calls `deleteUser`. Implementors sweep the user's
   * private projects (see `cascadeDeleteUserPrivateProjects`). Optional
   * because tests for the auth routes themselves don't need to wire
   * project cascade.
   */
  onUserDeleted?: (userId: string) => {
    deletedProjectIds: string[];
    orphanedSharedProjectIds: string[];
  };
}

type LimiterHandler = NonNullable<RateLimitOptions['handler']>;

function makeLimitHandler(label: string, pathLabel: string): LimiterHandler {
  return (req, res, _next, options) => {
    // Console-warn rather than structured-log for v1 — fuels the
    // Session Health observability work without introducing a new
    // sink. We deliberately log `pathLabel` (the route pattern) rather
    // than `req.originalUrl`: the invite-accept URL contains the real
    // invite token, which is a bearer-equivalent secret. A fat-fingered
    // invitee who trips the limiter would otherwise burn that token
    // straight into PM2 logs. Username is also omitted for the same
    // class of reason — a naive log scrape shouldn't double as an
    // enumerated hit-list of targeted accounts.
    const ip = req.ip ?? 'unknown';
    console.warn(
      `[auth] rate-limit hit label=${label} ip=${ip} path=${pathLabel} limit=${options.limit} windowMs=${options.windowMs}`,
    );
    // express-rate-limit will have already set Retry-After via
    // standardHeaders='draft-7'. We just shape the body.
    res.status(options.statusCode).json({
      error: 'Too many requests. Please try again later.',
      code: 'rate_limited',
    });
  };
}

function buildLoginLimiter(opts: AuthRoutesOptions) {
  if (opts.disableRateLimit) {
    return (_req: Request, _res: Response, next: () => void) => next();
  }
  const { windowMs, limit } = opts.loginRateLimit ?? {
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: LOGIN_RATE_LIMIT_MAX,
  };
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // `skipSuccessfulRequests: true` would mean a successful login
    // doesn't burn quota — but it would also let an attacker who
    // *happens* to guess a password mid-window avoid the rate cap.
    // Keep the default (count everything) so successful logins still
    // tick the meter.
    //
    // `keyGenerator` is omitted — express-rate-limit v8's default
    // already uses `ipKeyGenerator(req.ip, ipv6Subnet)`. Leaving it
    // unset also means IPv6 subnet masking stays consistent with the
    // library default if we ever configure `ipv6Subnet`.
    handler: makeLimitHandler('login', '/api/auth/login'),
  });
}

function buildInviteAcceptLimiter(opts: AuthRoutesOptions) {
  if (opts.disableRateLimit) {
    return (_req: Request, _res: Response, next: () => void) => next();
  }
  const { windowMs, limit } = opts.inviteAcceptRateLimit ?? {
    windowMs: INVITE_ACCEPT_RATE_LIMIT_WINDOW_MS,
    limit: INVITE_ACCEPT_RATE_LIMIT_MAX,
  };
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // See comment in buildLoginLimiter — keyGenerator omitted on
    // purpose to inherit the library default (ipKeyGenerator over
    // req.ip). The pathLabel is critical here: the real URL contains
    // the invite token, which must never hit the logs.
    handler: makeLimitHandler('invite-accept', '/api/auth/invites/:token/accept'),
  });
}

/**
 * Validate a `{ [agentId]: { engine, model? } }` PUT body. Returns the
 * trimmed-and-checked map, or a precise `400` error message naming the
 * first offending entry so the client can show a useful inline error.
 */
function sanitizeAgentEngineOverridesFromBody(
  body: Record<string, { engine: string; model?: string }>,
):
  | { ok: true; agentEngineOverrides: Record<string, AgentEngineOverride> }
  | { ok: false; error: string } {
  const cleaned: Record<string, AgentEngineOverride> = {};
  const knownEngines = new Set(Object.keys(config.engineValidModels));
  for (const [agentId, raw] of Object.entries(body)) {
    const id = typeof agentId === 'string' ? agentId.trim() : '';
    if (!id) continue;
    const engine = typeof raw?.engine === 'string' ? raw.engine.trim() : '';
    if (!engine) {
      return { ok: false, error: `Override for "${id}" is missing an engine` };
    }
    if (!knownEngines.has(engine)) {
      return { ok: false, error: `Unknown engine "${engine}" for agent "${id}"` };
    }
    const model = typeof raw?.model === 'string' ? raw.model.trim() : '';
    if (model) {
      const allowed = config.engineValidModels[engine] || [];
      if (!allowed.includes(model)) {
        return {
          ok: false,
          error: `Model "${model}" is not allowed for engine "${engine}" on agent "${id}". Allowed: ${allowed.join(', ')}`,
        };
      }
      cleaned[id] = { engine, model };
    } else {
      cleaned[id] = { engine };
    }
  }
  return { ok: true, agentEngineOverrides: cleaned };
}

/**
 * Drop persisted override entries whose engine / model are no longer in
 * the live `engineValidModels`. Keeps the API output honest after a
 * config change rotates an engine out of the catalogue.
 */
function filterStoredAgentEngineOverrides(
  stored: Record<string, AgentEngineOverride> | undefined,
): Record<string, AgentEngineOverride> {
  if (!stored) return {};
  const out: Record<string, AgentEngineOverride> = {};
  for (const [agentId, entry] of Object.entries(stored)) {
    if (!entry?.engine) continue;
    const allowed = config.engineValidModels[entry.engine];
    if (!Array.isArray(allowed)) continue;
    if (entry.model && !allowed.includes(entry.model)) {
      // Model is now invalid for this engine — keep the engine override,
      // drop the model so the spawn falls back through per-engine defaults.
      out[agentId] = { engine: entry.engine };
    } else {
      out[agentId] = entry.model
        ? { engine: entry.engine, model: entry.model }
        : { engine: entry.engine };
    }
  }
  return out;
}

export default function createAuthRoutes(options: AuthRoutesOptions = {}): Router {
  const router = Router();
  const loginLimiter = buildLoginLimiter(options);
  const inviteAcceptLimiter = buildInviteAcceptLimiter(options);

  // ── Status (public) ────────────────────────────────────────────
  router.get('/api/auth/status', (_req: Request, res: Response) => {
    const record = getAuthRecord();
    const jwtConfigured = !!record;
    const apiKeyConfigured = !!config.apiKey;
    // `needsMigration` is true only for the apiKey-only deployment state:
    // the server is already protected by the legacy shared secret, but no
    // JWT `auth.json` has been written yet. The client uses this to show
    // the "upgrade my auth" banner. Once /api/auth/setup has run the
    // record exists and this flips to false even if the apiKey is still
    // present (apiKey stays as break-glass, not a migration signal).
    const needsMigration = apiKeyConfigured && !jwtConfigured;
    // Signals to the client whether the auth gate is short-circuited
    // because the server is running as a local bundled install
    // (Electron / dev box). Source-of-truth is the `AGENT_HUB_MODE` env
    // var, set by the launching process — not the orgs DB. See the
    // JSDoc on `isLocalBundledServer()` for why.
    //
    // Field name `activeOrgIsLocal` is preserved for client/back-compat;
    // the AuthGate consumes it to suppress the login screen on local.
    const activeOrgIsLocal = isLocalBundledServer();
    res.json({
      authConfigured: jwtConfigured,
      username: record?.username ?? null,
      // Role is safe to leak publicly — it's the owner's role at install
      // time, not a per-caller claim. The UI uses it to decide whether
      // to show the "first Owner" vs "sign in" copy.
      role: record?.role ?? null,
      jwtConfigured,
      apiKeyConfigured,
      needsMigration,
      activeOrgIsLocal,
    });
  });

  // ── First-run setup (public, but idempotent / locked) ──────────
  router.post('/api/auth/setup', async (req: Request, res: Response) => {
    if (isAuthConfigured()) {
      res.status(409).json({ error: 'Auth already configured' });
      return;
    }
    const parsedSetup = SetupBody.safeParse(req.body ?? {});
    if (!parsedSetup.success) {
      res.status(400).json(formatZodError(parsedSetup.error));
      return;
    }
    const { username: rawUser, password: rawPass } = parsedSetup.data;
    const username = sanitizeUsername(rawUser);
    const password = sanitizePassword(rawPass);
    if (!username) {
      res.status(400).json({
        error: 'username must be 1–64 chars of letters, digits, ., _, -, @',
      });
      return;
    }
    if (!password) {
      res.status(400).json({
        error: `password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars`,
      });
      return;
    }

    const passwordHash = await hashPassword(password);
    // First-run setup always creates the Owner — there's nobody else to
    // promote them, and the install would otherwise have no way to
    // reach admin endpoints.
    const record = saveAuthRecord({
      username,
      passwordHash,
      jwtSecret: generateJwtSecret(),
      role: 'Owner',
    });

    // Phase 3: also seed the users + memberships tables. The migration
    // helper is a no-op after the first run, so it's safe to call every
    // time setup is invoked. Swallow orgs-db-not-initialized — a few
    // legacy test paths skip that setup and we still want auth.json to
    // land.
    let user = null;
    try {
      migrateAuthRecordIfNeeded();
      user = getUserByUsername(record.username);
    } catch (err) {
      console.error('[Auth] migrateAuthRecordIfNeeded after /setup failed:', err);
    }

    // Belt-and-suspenders cache invalidation. `getOrgOwnerUserId` no
    // longer caches `null` (see `session-ownership.ts`), but resetting
    // here keeps the cache honest if a future change re-introduces a
    // negative-cache code path. Without this, system spawns immediately
    // after first-run setup might still resolve to a stale `null`.
    // Imported lazily so test files that mock `../config.js` (without
    // seeding `defaultCwd`) don't trigger `db.ts` module-load initDb.
    try {
      const { resetOrgOwnerCache } = await import('../session-ownership.js');
      resetOrgOwnerCache();
    } catch (err) {
      console.warn('[Auth] failed to reset org owner cache after /setup:', err);
    }

    const { token, expiresAt } = issueToken(
      user ?? { id: '', username: record.username },
      record.role,
      record.jwtSecret,
    );

    // Spawn-env staleness recovery. Sessions spawned before auth.json
    // existed are running with an empty `AGENT_HUB_API_KEY` env; the
    // gate just flipped to require credentials, so their next tool
    // call would 401. Mint a per-session `ahub_*` token for the new
    // Owner and write it to `<dataDir>/spawn-creds/<sessionId>.token`.
    // The shell wrappers (`ah-api.sh:ah_resolve_key`) consult that
    // file as a fallback on every invocation, so the next call after
    // setup runs picks up working creds without a session restart.
    //
    // Best-effort: a failure here must not abort setup. We log a
    // single summary line and a per-session warn if anything fails.
    if (user) {
      try {
        const { getDb } = await import('../db.js');
        const result = recoverActiveSessionsAfterSetup({
          db: getDb(),
          dataDir: config.dataDir,
          ownerUserId: user.id,
        });
        console.log(
          `[Auth] /setup spawn-creds recovery: event=spawn_creds_recovery candidates=${result.candidates} recovered=${result.recovered} failed=${result.failed}`,
        );
      } catch (err) {
        console.warn(
          `[Auth] spawn-creds recovery skipped: event=spawn_creds_recovery error=${(err as Error).message}`,
        );
      }
    }

    res.json({
      ok: true,
      token,
      expiresAt,
      user: { username: record.username, role: record.role },
    });
  });

  // ── Login (public, rate-limited per IP) ────────────────────────
  router.post('/api/auth/login', loginLimiter, async (req: Request, res: Response) => {
    const authRecord = getAuthRecord();
    if (!authRecord) {
      res.status(409).json({ error: 'Auth not configured. Call /api/auth/setup first.' });
      return;
    }
    const parsedLogin = LoginBody.safeParse(req.body ?? {});
    if (!parsedLogin.success) {
      res.status(400).json(formatZodError(parsedLogin.error));
      return;
    }
    const { username: rawUser, password: rawPass } = parsedLogin.data;
    const username = rawUser.trim();
    const password = rawPass;

    // Run verifyPassword even on an unknown user so response time doesn't
    // leak whether the username exists. If orgs.db isn't initialized
    // (some legacy test paths / mid-boot), fall through to the auth.json
    // single-user record so those callers keep working.
    let user = null;
    try {
      user = getUserByUsername(username);
    } catch {
      user = null;
    }
    // Fallback for boot-in-progress: if the users table hasn't been
    // seeded yet (rare — migration should have run), and the input
    // matches the auth-store owner, accept against that record.
    const usingAuthRecordFallback = !user && username === authRecord.username;
    const storedHash = user?.password_hash ?? authRecord.passwordHash;

    const ok = await verifyPassword(password, storedHash);
    if ((!user && !usingAuthRecordFallback) || !ok) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    if (!user) {
      // Run the migration and re-resolve so we can issue a proper uid token.
      try {
        migrateAuthRecordIfNeeded();
        user = getUserByUsername(username);
      } catch {
        user = null;
      }
    }

    // Resolve the caller's role in the currently active org. If they
    // have no membership, reject the login so the client doesn't end up
    // holding a token that fails every API call. If orgs.db isn't
    // initialized yet (legacy boot paths), skip enforcement and fall
    // back to the auth.json role.
    let orgId = '';
    let role: Role | null = null;
    let orgsDbReady = false;
    try {
      orgId = getActiveOrgId();
      orgsDbReady = true;
      role = user ? getMembershipRole(user.id, orgId) : null;
    } catch {
      // orgs.db not initialized — skip membership enforcement.
      orgsDbReady = false;
    }

    // Auto-seed an Owner membership for the *sole* user on a fresh
    // install — this covers the Phase-2 → Phase-3 upgrade where the
    // migration ran but the only user row doesn't yet have a membership
    // in the active org. This is intentionally scoped to `countUsers()
    // === 1`: in a multi-user install, a missing membership is a real
    // permissions state ("removed from org") and we must NOT invent one.
    if (user && !role && orgsDbReady && orgId) {
      try {
        if (countUsers() === 1) {
          createMembership(user.id, orgId, 'Owner');
          role = 'Owner';
        }
      } catch {}
    }

    // Multi-user case: user exists, orgs.db is healthy, they authed
    // successfully, but they have no membership in the active org.
    // Refuse to issue a token — per the comment above, a token without
    // a membership would 403 on every subsequent API call. Surface that
    // as an explicit login failure instead of a half-broken session.
    if (user && !role && orgsDbReady) {
      res.status(403).json({
        error:
          'You are not a member of the active organization. Ask an admin to add you or accept an invite.',
        code: 'no_membership',
      });
      return;
    }

    // At this point either (a) we have a real membership role, or
    // (b) orgs.db wasn't ready and we're on the legacy single-user
    // fallback. Issuing authRecord.role in case (b) is safe because the
    // middleware falls back to the same record for uninitialized-orgs.db
    // requests.
    const resolvedRole: Role = role ?? authRecord.role;
    const subject = user ?? { id: '', username: authRecord.username };
    const { token, expiresAt } = issueToken(subject, resolvedRole, authRecord.jwtSecret);
    res.json({
      token,
      expiresAt,
      user: { username: subject.username, role: resolvedRole },
    });
  });

  // ── Current user (protected by auth middleware) ────────────────
  router.get('/api/auth/me', (req: Request, res: Response) => {
    const record = getAuthRecord();
    const authedReq = req as AuthenticatedRequest;
    const subject = authedReq.authUser || record?.username || null;
    const role: Role | null = authedReq.authRole ?? record?.role ?? null;
    res.json({
      user: subject ? { username: subject, role } : null,
      authConfigured: !!record,
      role,
      orgId: authedReq.authOrgId ?? null,
    });
  });

  // ── Per-user Claude credentials ────────────────────────────────
  //
  // Each authenticated user may attach their own ANTHROPIC_API_KEY and
  // CLAUDE_CODE_OAUTH_TOKEN. When set, `buildSpawnEnv` injects the
  // session owner's values instead of the host-wide config — see
  // `server/config.ts::buildSpawnEnv`. Tokens are returned masked so
  // the page can display "configured" status without leaking secrets;
  // only the metadata (length, prefix, expiry, updatedAt) round-trips.
  router.get('/api/auth/me/claude-auth', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const stored = getUserClaudeAuth(authedReq.authUserId);
    if (!stored) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // Normalise the stored expiry through the same seconds-vs-ms helper the
    // host-config path uses (`server/routes/claude-auth.ts`), so a value
    // written as JWT-style Unix seconds doesn't render as "Expired" in the
    // UI for the next ~55 years. Returning a normalised ISO string plus a
    // server-computed `claudeCodeOAuthExpired` boolean lets the UI render
    // the chip without doing its own `Date.now() > expiresAt` comparison
    // against an un-normalised value.
    const expiry = parseClaudeOAuthExpiry(stored.claudeCodeOAuthExpiresAt);
    res.json({
      anthropicApiKey: maskCredential(stored.anthropicApiKey),
      claudeCodeOAuthToken: maskCredential(stored.claudeCodeOAuthToken),
      claudeCodeOAuthExpiresAt: expiry ? expiry.iso : stored.claudeCodeOAuthExpiresAt,
      claudeCodeOAuthExpired: expiry ? expiry.expired : null,
      updatedAt: stored.updatedAt,
      hostConfigFallback: {
        anthropicApiKey: !!config.anthropicApiKey,
        claudeCodeOAuthToken: !!config.claudeCodeOAuthToken,
      },
    });
  });

  router.put('/api/auth/me/claude-auth', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const parsedClaudeBody = UpdateClaudeAuthBody.safeParse(req.body ?? {});
    if (!parsedClaudeBody.success) {
      res.status(400).json(formatZodError(parsedClaudeBody.error));
      return;
    }
    const body = parsedClaudeBody.data;
    // Whitelist fields to prevent stray JSON keys from reaching the DB.
    const patch: {
      anthropicApiKey?: string | null;
      claudeCodeOAuthToken?: string | null;
      claudeCodeOAuthExpiresAt?: string | null;
    } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'anthropicApiKey')) {
      patch.anthropicApiKey = body.anthropicApiKey ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'claudeCodeOAuthToken')) {
      patch.claudeCodeOAuthToken = body.claudeCodeOAuthToken ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'claudeCodeOAuthExpiresAt')) {
      patch.claudeCodeOAuthExpiresAt = body.claudeCodeOAuthExpiresAt ?? null;
    }
    const updated = setUserClaudeAuth(authedReq.authUserId, patch);
    if (!updated) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // Same normalisation as GET so the UI can re-render the expiry chip
    // immediately on save without waiting for a follow-up GET. Without
    // this, a client that PUTs Unix-seconds expiry would see the raw
    // value echoed back and recompute `expired` against an un-normalised
    // numeric string — the exact bug PR #723 fixed for the host path.
    const expiryAfter = parseClaudeOAuthExpiry(updated.claudeCodeOAuthExpiresAt);
    res.json({
      anthropicApiKey: maskCredential(updated.anthropicApiKey),
      claudeCodeOAuthToken: maskCredential(updated.claudeCodeOAuthToken),
      claudeCodeOAuthExpiresAt: expiryAfter ? expiryAfter.iso : updated.claudeCodeOAuthExpiresAt,
      claudeCodeOAuthExpired: expiryAfter ? expiryAfter.expired : null,
      updatedAt: updated.updatedAt,
      // Mirror GET so a client can re-render the "falling back to host"
      // hint without an extra round-trip after save.
      hostConfigFallback: {
        anthropicApiKey: !!config.anthropicApiKey,
        claudeCodeOAuthToken: !!config.claudeCodeOAuthToken,
      },
    });
  });

  // ── Per-user single-key engine credentials (Cursor / Gemini / Codex) ──
  //
  // Each engine carries one API key today. The shape is intentionally
  // identical across the three so the UI can render them with one
  // component. `buildSpawnEnv` (server/config.ts) handles per-field
  // precedence — per-user override → host config → unset.
  type SingleKeyEngine = 'cursor' | 'gemini' | 'codex';
  const singleKeyEngines: Array<{
    engine: SingleKeyEngine;
    path: string;
    get: (userId: string) => ReturnType<typeof getUserCursorAuth>;
    set: (
      userId: string,
      patch: { apiKey?: string | null },
    ) => ReturnType<typeof setUserCursorAuth>;
    hostHasKey: () => boolean;
  }> = [
    {
      engine: 'cursor',
      path: '/api/auth/me/cursor-auth',
      get: getUserCursorAuth,
      set: setUserCursorAuth,
      hostHasKey: () => !!config.cursorApiKey,
    },
    {
      engine: 'gemini',
      path: '/api/auth/me/gemini-auth',
      get: getUserGeminiAuth,
      set: setUserGeminiAuth,
      hostHasKey: () => !!config.geminiApiKey,
    },
    {
      engine: 'codex',
      path: '/api/auth/me/codex-auth',
      get: getUserCodexAuth,
      set: setUserCodexAuth,
      hostHasKey: () => !!config.codexApiKey,
    },
  ];

  for (const route of singleKeyEngines) {
    router.get(route.path, (req: Request, res: Response) => {
      const authedReq = req as AuthenticatedRequest;
      if (!authedReq.authUserId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const stored = route.get(authedReq.authUserId);
      if (!stored) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      const base = {
        engine: route.engine,
        apiKey: maskCredential(stored.apiKey),
        updatedAt: stored.updatedAt,
        hostConfigFallback: { apiKey: route.hostHasKey() },
      };
      if (route.engine === 'codex') {
        // P4: inspect the per-user CODEX_HOME (carved by
        // POST /api/auth/me/codex-auth/login) so the UI can render
        // "Signed in with ChatGPT" alongside the API-key state.
        // Never throws — bad userIds / missing dirs collapse to
        // "missing".
        let codexHomePath: string | null = null;
        try {
          codexHomePath = perUserCodexHomePath(authedReq.authUserId, config.dataDir);
        } catch {
          codexHomePath = null;
        }
        const authModeInfo = codexHomePath
          ? detectCodexAuthMode(codexHomePath)
          : { present: false, mode: 'unknown' as const, path: '' };
        const chatgptOAuth = authModeInfo.present && authModeInfo.mode === 'chatgpt';
        const cliApiKey = authModeInfo.present && authModeInfo.mode === 'apikey';
        const loginInProgress = isCodexDeviceLoginInProgress(authedReq.authUserId);
        // Gate `uiStatus` on the actual Codex binary, not a hardcoded
        // `true`. Without this check the endpoint would happily report
        // `deviceLogin.uiStatus = 'authenticated'` on hosts that have an
        // API key stored but no Codex CLI installed — and any subsequent
        // chat / heartbeat / `POST /api/auth/me/codex-auth/login` would
        // then fail with "Codex binary not found". Matches the legacy
        // `/api/auth/me/codex-auth/browser` handler.
        const binaryPresent = existsSync(config.codexBin);
        const uiStatus = computeCodexUiStatus({
          binaryPresent,
          loginInProgress,
          apiKeyConfigured: !!stored.apiKey,
          chatgptOAuthFromFile: chatgptOAuth,
          cliApiKeyFromFile: cliApiKey,
        });
        res.json({
          ...base,
          deviceLogin: {
            uiStatus,
            loginInProgress,
            oauth: {
              loggedIn: chatgptOAuth,
              mode: authModeInfo.present ? authModeInfo.mode : null,
              authJsonPath: authModeInfo.present ? authModeInfo.path : null,
            },
            codexHomePath,
          },
        });
        return;
      }
      res.json(base);
    });

    router.put(route.path, (req: Request, res: Response) => {
      const authedReq = req as AuthenticatedRequest;
      if (!authedReq.authUserId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const parsedEngineBody = UpdateSingleKeyAuthBody.safeParse(req.body ?? {});
      if (!parsedEngineBody.success) {
        res.status(400).json(formatZodError(parsedEngineBody.error));
        return;
      }
      const body = parsedEngineBody.data;
      // Whitelist the single supported field so stray JSON keys can't
      // reach the DB.
      const patch: { apiKey?: string | null } = {};
      if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
        patch.apiKey = body.apiKey ?? null;
      }
      const updated = route.set(authedReq.authUserId, patch);
      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({
        engine: route.engine,
        apiKey: maskCredential(updated.apiKey),
        updatedAt: updated.updatedAt,
        hostConfigFallback: { apiKey: route.hostHasKey() },
      });
    });
  }

  router.get('/api/auth/me/agent-engine-overrides', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const rowUser = getUserById(authedReq.authUserId);
    if (!rowUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const stored = getUserPreferencesRow(authedReq.authUserId).agentEngineOverrides;
    res.json({ agentEngineOverrides: filterStoredAgentEngineOverrides(stored) });
  });

  router.put('/api/auth/me/agent-engine-overrides', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const rowUser = getUserById(authedReq.authUserId);
    if (!rowUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const parsed = PutAgentEngineOverridesBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(formatZodError(parsed.error));
      return;
    }
    const checked = sanitizeAgentEngineOverridesFromBody(parsed.data.agentEngineOverrides ?? {});
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    mergeUserPreferencesJson(authedReq.authUserId, {
      agentEngineOverrides: checked.agentEngineOverrides,
    });
    res.json({ agentEngineOverrides: checked.agentEngineOverrides });
  });

  // ── Per-user skill credentials (encrypted; keys merged into spawn env) ──
  router.get('/api/auth/me/skill-credentials', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const skillIdRaw = req.query.skillId;
    const skillId = typeof skillIdRaw === 'string' && skillIdRaw.trim() ? skillIdRaw.trim() : null;
    try {
      const rows = listMaskedUserSkillCredentials(authedReq.authUserId, skillId);
      res.json({ credentials: rows });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/api/auth/me/skill-credentials', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const parsedSkill = UpsertSkillCredentialBody.safeParse(req.body ?? {});
    if (!parsedSkill.success) {
      // Preserve the legacy "are required" wording when skill_id or key_name
      // is missing or the wrong type. (agent_id is optional — the Account
      // page personal-credentials section omits it.)
      const requiredMissing = parsedSkill.error.issues.some(
        (i) =>
          (i.path[0] === 'skill_id' || i.path[0] === 'key_name') &&
          (i.code === 'invalid_type' || i.code === 'too_small'),
      );
      if (requiredMissing) {
        res.status(400).json({ error: 'skill_id and key_name are required' });
        return;
      }
      res.status(400).json(formatZodError(parsedSkill.error));
      return;
    }
    const skill_id = parsedSkill.data.skill_id.trim();
    const key_name = parsedSkill.data.key_name.trim();
    const agent_id =
      typeof parsedSkill.data.agent_id === 'string' ? parsedSkill.data.agent_id.trim() : '';
    const value = typeof parsedSkill.data.value === 'string' ? parsedSkill.data.value : '';
    if (!skill_id || !key_name) {
      res.status(400).json({ error: 'skill_id and key_name are required' });
      return;
    }

    // Two flows:
    //   (A) agent_id provided → SkillsPage editor. The schema is read from
    //       the agent's project workspace first (per-agent skill overrides
    //       are allowed). Requires JWT callers to be a member of the agent's
    //       active org.
    //   (B) agent_id omitted → Account page personal-credentials section.
    //       The schema MUST resolve from bundled `server/default-skills/`
    //       (or the global `skill_registry`); the per-project workspace is
    //       never consulted. No agent-scoped RBAC applies — any
    //       authenticated user may store their own personal credential.
    let projectWorkspaces: string[] = [];
    if (agent_id) {
      const foundAgent = findAgent(agent_id);
      if (!foundAgent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      // RBAC gate: a JWT-authenticated caller must be a member of the active
      // org before they can use one of that org's agents as the schema-source
      // for a credential PUT. Without this, agent ids (which are
      // discoverable globally via the in-memory project list) could be used
      // to validate against any project's `SKILL.md` and seed credentials in
      // the caller's own user row keyed only on `(user_id, skill_id, key_name)`.
      // apiKey + local-bundled bypass continue working — they're already
      // treated as full Owner privilege everywhere else.
      if (!authedReq.authViaApiKey && !authedReq.authLocalOrgBypass) {
        const orgId = getActiveOrgId();
        const role = orgId ? getMembershipRole(authedReq.authUserId, orgId) : null;
        if (!role) {
          res.status(403).json({ error: 'You are not a member of this org.' });
          return;
        }
      }
      const workspace =
        typeof foundAgent.project.ahw === 'string' ? foundAgent.project.ahw.trim() : '';
      if (!workspace) {
        res.status(404).json({ error: 'No workspace configured for this agent' });
        return;
      }
      projectWorkspaces = [workspace];
    }

    const parsed = readCredentialsSchemaForSkill(skill_id, {
      projectWorkspaces,
    });
    if (parsed.error) {
      res.status(400).json({ error: `invalid credential schema for skill: ${parsed.error}` });
      return;
    }
    if (parsed.credentials.length === 0) {
      res.status(400).json({ error: 'This skill declares no credentials in SKILL.md frontmatter' });
      return;
    }
    const spec = parsed.credentials.find((c) => c.name === key_name);
    if (!spec) {
      res
        .status(400)
        .json({ error: `Unknown credential key "${key_name}" for skill "${skill_id}"` });
      return;
    }
    if (spec.required && value.trim().length === 0) {
      res.status(400).json({ error: `Credential "${key_name}" is required` });
      return;
    }
    if (!spec.required && value.trim().length === 0) {
      if (!existsUserSkillCredential(authedReq.authUserId, skill_id, key_name)) {
        res.json({ credential: null, skipped: true as const });
        return;
      }
      deleteUserSkillCredentialByKey(
        authedReq.authUserId,
        skill_id,
        key_name,
        authedReq.authUserId,
      );
      res.json({ credential: null, cleared: true as const });
      return;
    }

    try {
      const row = upsertUserSkillCredential({
        userId: authedReq.authUserId,
        skillId: skill_id,
        keyName: key_name,
        value,
        actorUserId: authedReq.authUserId,
      });
      res.json({ credential: row });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/auth/me/skill-credentials/:id', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { id } = req.params as { id: string };
    const result = deleteUserSkillCredential(authedReq.authUserId, id, authedReq.authUserId);
    if (!result.ok) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }
    res.json({ ok: true });
  });

  // ──────────────────────────────────────────────────────────────
  //  Per-user API keys
  // ──────────────────────────────────────────────────────────────
  //
  // Long-lived programmatic credentials owned by an individual user.
  // Distinct from JWTs (7-day session tokens) and from the global
  // AGENT_HUB_API_KEY break-glass. Use cases: scripts, CI, remote
  // Electron clients that need stable creds without re-logging in.
  //
  //   POST   /api/auth/keys        create a new key — token in response ONCE
  //   GET    /api/auth/keys        list active keys for the caller (no token)
  //   DELETE /api/auth/keys/:id    revoke (soft delete)
  //
  // Generation is rate-limited to MAX_KEYS_PER_USER active keys per user
  // to prevent runaway accumulation; revoke an old one to make room.

  const MAX_KEYS_PER_USER = 50;

  router.get('/api/auth/keys', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const keys = listApiKeys(authedReq.authUserId).map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
    }));
    res.json({ keys });
  });

  router.post('/api/auth/keys', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const parsedKey = CreateApiKeyBody.safeParse(req.body ?? {});
    if (!parsedKey.success) {
      // Preserve "name must be 1-100 characters" wording when the field is
      // missing or the wrong type.
      const nameBad = parsedKey.error.issues.some(
        (i) => i.path[0] === 'name' && (i.code === 'invalid_type' || i.code === 'too_small'),
      );
      if (nameBad) {
        res.status(400).json({ error: 'name must be 1-100 characters' });
        return;
      }
      res.status(400).json(formatZodError(parsedKey.error));
      return;
    }
    const body = parsedKey.data;
    const name = body.name.trim();
    if (name.length === 0 || name.length > 100) {
      res.status(400).json({ error: 'name must be 1-100 characters' });
      return;
    }
    let expiresInDays: number | null = null;
    if (body.expiresInDays != null && body.expiresInDays !== '') {
      const n = Number(body.expiresInDays);
      if (!Number.isFinite(n) || n < 1 || n > 3650) {
        res.status(400).json({ error: 'expiresInDays must be between 1 and 3650' });
        return;
      }
      expiresInDays = Math.floor(n);
    }

    // Cap active keys per user. Revoked keys don't count.
    const active = listApiKeys(authedReq.authUserId).length;
    if (active >= MAX_KEYS_PER_USER) {
      res.status(429).json({
        error: `Limit of ${MAX_KEYS_PER_USER} active API keys per user. Revoke an existing key first.`,
      });
      return;
    }

    try {
      const key = createApiKey(authedReq.authUserId, name, expiresInDays);
      res.status(201).json({
        id: key.id,
        name: key.name,
        token: key.token, // shown ONCE — never returned again
        prefix: key.prefix,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to create API key';
      res.status(400).json({ error: message });
    }
  });

  router.delete('/api/auth/keys/:id', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { id } = req.params as { id: string };
    const ok = revokeApiKey(authedReq.authUserId, id);
    if (!ok) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    res.json({ ok: true });
  });

  // Lightweight back-door for tests / future audit UI: total key count
  // (active + revoked) for the caller. Kept un-exported from the route
  // surface for now; tests import countApiKeysForUser directly. The
  // _unused_ marker suppresses the lint warning while keeping the symbol
  // referenced for tree-shaking awareness.
  void countApiKeysForUser;

  // ──────────────────────────────────────────────────────────────
  //  Users — multi-user roster (Phase 3)
  // ──────────────────────────────────────────────────────────────

  // GET /api/auth/users — Admin+ — members of the active org
  router.get('/api/auth/users', requireRole('Admin'), (_req: Request, res: Response) => {
    const record = getAuthRecord();
    let orgId: string;
    try {
      orgId = getActiveOrgId();
    } catch {
      // orgs.db not initialized (some legacy test harnesses). Fall back
      // to the single-user auth.json view — this keeps the pre-Phase-3
      // behavior intact in those paths.
      const users = record
        ? [{ username: record.username, role: record.role, createdAt: record.createdAt }]
        : [];
      res.json({ users });
      return;
    }

    const members = listMembersForOrg(orgId);
    if (members.length === 0 && record) {
      // orgs.db is healthy but migration hasn't been kicked yet (fresh
      // setup followed by an immediate list). Fall back to the legacy
      // shape — migration will catch up on next boot.
      res.json({
        users: [
          {
            id: null,
            username: record.username,
            role: record.role,
            createdAt: record.createdAt,
          },
        ],
      });
      return;
    }
    res.json({
      users: members.map((m) => ({
        id: m.userId,
        username: m.username,
        role: m.role,
        createdAt: m.createdAt,
      })),
    });
  });

  // POST /api/auth/users — Owner only
  router.post('/api/auth/users', requireRole('Owner'), async (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const parsedCreateUser = CreateUserBody.safeParse(req.body ?? {});
    if (!parsedCreateUser.success) {
      res.status(400).json(formatZodError(parsedCreateUser.error));
      return;
    }
    const { username: rawUser, password: rawPass, role: rawRole } = parsedCreateUser.data;
    const username = sanitizeUsername(rawUser);
    const password = sanitizePassword(rawPass);
    const role = parseRole(rawRole) ?? 'User';
    if (!username) {
      res.status(400).json({ error: 'invalid username' });
      return;
    }
    if (!password) {
      res
        .status(400)
        .json({ error: `password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars` });
      return;
    }
    if (role === 'Owner' && authedReq.authRole !== 'Owner') {
      // Belt-and-suspenders — requireRole('Owner') already gates this,
      // but the extra check keeps the invariant readable at the route.
      res.status(403).json({ error: 'Only an Owner can create another Owner.' });
      return;
    }
    if (getUserByUsername(username)) {
      res.status(409).json({ error: 'username already taken' });
      return;
    }
    const orgId = getActiveOrgId();
    const passwordHash = await hashPassword(password);
    const user = createUser({ username, passwordHash });
    createMembership(user.id, orgId, role);
    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        role,
        createdAt: user.created_at,
      },
    });
  });

  // PUT /api/auth/users/:id/role — change membership role in active org
  router.put('/api/auth/users/:id/role', requireRole('Admin'), (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const { id } = req.params as { id: string };
    const parsedRoleBody = UpdateUserRoleBody.safeParse(req.body ?? {});
    if (!parsedRoleBody.success) {
      // Preserve the legacy "role must be Owner, Admin, or User" wording so
      // existing clients and regex-based tests keep matching, while still
      // routing other shape errors through the structured Zod response.
      const roleIssue = parsedRoleBody.error.issues.some(
        (i) =>
          i.path[0] === 'role' &&
          (i.code === 'invalid_type' || i.code === 'invalid_value' || i.code === 'too_small'),
      );
      if (roleIssue) {
        res.status(400).json({ error: 'role must be Owner, Admin, or User' });
        return;
      }
      res.status(400).json(formatZodError(parsedRoleBody.error));
      return;
    }
    const nextRole = parseRole(parsedRoleBody.data.role);
    if (!nextRole) {
      res.status(400).json({ error: 'role must be Owner, Admin, or User' });
      return;
    }

    const target = getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    const orgId = getActiveOrgId();
    const currentRole = getMembershipRole(id, orgId);
    if (!currentRole) {
      res.status(404).json({ error: 'user is not a member of this org' });
      return;
    }

    // Promotions to or from Owner require Owner privilege on the caller.
    const touchingOwner = currentRole === 'Owner' || nextRole === 'Owner';
    if (touchingOwner && authedReq.authRole !== 'Owner') {
      res.status(403).json({ error: 'Only an Owner can change the Owner role.' });
      return;
    }

    // Preserve the "don't strand the org without an Owner" invariant.
    if (currentRole === 'Owner' && nextRole !== 'Owner') {
      const owners = countOwnersForOrg(orgId);
      if (owners <= 1) {
        res.status(400).json({
          error: 'Cannot demote the only Owner of this org. Promote another user first.',
        });
        return;
      }
    }

    setMembershipRole(id, orgId, nextRole);
    res.json({ ok: true, userId: id, orgId, role: nextRole });
  });

  // DELETE /api/auth/users/:id — remove from active org (Owner only)
  router.delete('/api/auth/users/:id', requireRole('Owner'), (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const target = getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    const orgId = getActiveOrgId();
    const currentRole = getMembershipRole(id, orgId);
    if (!currentRole) {
      res.status(404).json({ error: 'user is not a member of this org' });
      return;
    }
    if (currentRole === 'Owner' && countOwnersForOrg(orgId) <= 1) {
      res.status(400).json({ error: 'Cannot remove the only Owner of this org.' });
      return;
    }

    deleteMembership(id, orgId);
    let userDeleted = false;
    let cascadedPrivateProjects: string[] = [];
    let orphanedSharedProjects: string[] = [];
    if (countMembershipsForUser(id) === 0) {
      deleteUser(id);
      userDeleted = true;
      // Cascade — private projects owned by this user are now unreachable
      // (no member of any org can pass the visibility gate). Auto-delete
      // per the design decision; shared projects survive with a now-stale
      // `ownerUserId`. The cascade is best-effort: per-project failures
      // log but don't fail the user-delete response.
      if (options.onUserDeleted) {
        try {
          const result = options.onUserDeleted(id);
          cascadedPrivateProjects = result.deletedProjectIds;
          orphanedSharedProjects = result.orphanedSharedProjectIds;
          if (cascadedPrivateProjects.length > 0) {
            console.log(
              `[auth] user-delete cascade swept ${cascadedPrivateProjects.length} private project(s) owned by ${id}: ${cascadedPrivateProjects.join(', ')}`,
            );
          }
          if (orphanedSharedProjects.length > 0) {
            console.log(
              `[auth] user-delete left ${orphanedSharedProjects.length} shared project(s) orphaned (ownerUserId now stale): ${orphanedSharedProjects.join(', ')}`,
            );
          }
        } catch (err) {
          console.error('[auth] user-delete cascade threw:', (err as Error).message);
        }
      }
    }
    res.json({
      ok: true,
      userId: id,
      orgId,
      userDeleted,
      cascadedPrivateProjects,
      orphanedSharedProjects,
    });
  });

  // POST /api/auth/users/:id/password — self-reset or Owner-reset
  router.post('/api/auth/users/:id/password', async (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const { id } = req.params as { id: string };
    const parsedPwd = PasswordResetBody.safeParse(req.body ?? {});
    if (!parsedPwd.success) {
      // Preserve the legacy "newPassword must be …" wording when the field
      // is missing/wrong-type; route other shape errors through Zod.
      const pwdIssue = parsedPwd.error.issues.some(
        (i) => i.path[0] === 'newPassword' && (i.code === 'invalid_type' || i.code === 'too_small'),
      );
      if (pwdIssue) {
        res.status(400).json({
          error: `newPassword must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars`,
        });
        return;
      }
      res.status(400).json(formatZodError(parsedPwd.error));
      return;
    }
    const { newPassword } = parsedPwd.data;
    const password = sanitizePassword(newPassword);
    if (!password) {
      res.status(400).json({
        error: `newPassword must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars`,
      });
      return;
    }

    const target = getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'user not found' });
      return;
    }

    const isSelf = authedReq.authUserId === id;
    const isOwner = authedReq.authRole === 'Owner';
    if (!isSelf && !isOwner) {
      res.status(403).json({
        error: 'You can only reset your own password. Owners can reset any password.',
      });
      return;
    }

    const passwordHash = await hashPassword(password);
    updateUserPassword(id, passwordHash);
    // Known limitation: stateless JWTs can't be server-revoked — tokens
    // issued before this call remain valid until their `exp`. Phase 4
    // will layer on a revocation list.
    res.json({ ok: true, userId: id });
  });

  // ──────────────────────────────────────────────────────────────
  //  Invites
  // ──────────────────────────────────────────────────────────────

  // POST /api/auth/invites — Admin+
  router.post('/api/auth/invites', requireRole('Admin'), (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const parsedInvite = CreateInviteBody.safeParse(req.body ?? {});
    if (!parsedInvite.success) {
      // Preserve the legacy invite-role wording when the role field itself
      // is bad; otherwise fall through to structured Zod errors.
      const roleIssue = parsedInvite.error.issues.some(
        (i) =>
          i.path[0] === 'role' &&
          (i.code === 'invalid_type' || i.code === 'invalid_value' || i.code === 'too_small'),
      );
      if (roleIssue) {
        res.status(400).json({ error: 'role must be Admin or User (Owner is never invited)' });
        return;
      }
      res.status(400).json(formatZodError(parsedInvite.error));
      return;
    }
    const { role: rawRole, email, ttlHours } = parsedInvite.data;
    const role = parseRole(rawRole);
    if (!role || role === 'Owner') {
      res.status(400).json({ error: 'role must be Admin or User (Owner is never invited)' });
      return;
    }
    if (!authedReq.authUserId || !authedReq.authOrgId) {
      // API-key caller or misconfigured request — we need both to
      // attribute the invite. Break-glass callers can POST with a
      // bearer token if they need to issue invites.
      res.status(400).json({ error: 'invite issuance requires an authenticated user session' });
      return;
    }
    const invite = createInvite({
      orgId: authedReq.authOrgId,
      role,
      email: email ?? null,
      createdBy: authedReq.authUserId,
      ttlHours,
    });
    const baseUrl = process.env.PUBLIC_ORIGIN || '';
    const url = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/invite/${invite.token}`
      : `/invite/${invite.token}`;
    res.status(201).json({
      token: invite.token,
      url,
      role: invite.role,
      email: invite.email,
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
    });
  });

  // GET /api/auth/invites — Admin+ — list active invites for active org
  router.get('/api/auth/invites', requireRole('Admin'), (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const orgId = authedReq.authOrgId || getActiveOrgId();
    const rows = listActiveInvitesForOrg(orgId);
    res.json({
      invites: rows.map((r) => ({
        token: r.token,
        orgId: r.org_id,
        role: r.role,
        email: r.email,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      })),
    });
  });

  // DELETE /api/auth/invites/:token — Admin+
  router.delete('/api/auth/invites/:token', requireRole('Admin'), (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    const row = getInvite(token);
    if (!row) {
      res.status(404).json({ error: 'invite not found' });
      return;
    }
    const authedReq = req as AuthenticatedRequest;
    if (authedReq.authOrgId && row.org_id !== authedReq.authOrgId) {
      // Prevent cross-org revocation — caller's active org has to
      // match the invite's home org.
      res.status(403).json({ error: 'invite belongs to another org' });
      return;
    }
    deleteInvite(token);
    res.json({ ok: true, token });
  });

  // GET /api/auth/invites/:token — public landing metadata
  router.get('/api/auth/invites/:token', (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    const row = getInvite(token);
    const state = inviteState(row);
    if (!row || state === 'not-found') {
      res.status(404).json({ error: 'invite not found' });
      return;
    }
    if (state === 'expired') {
      res.status(410).json({ error: 'invite expired', state });
      return;
    }
    const org = getOrg(row.org_id);
    res.json({
      orgId: row.org_id,
      orgName: org?.name ?? row.org_id,
      role: row.role,
      email: row.email,
      expiresAt: row.expires_at,
      accepted: state === 'already-accepted',
    });
  });

  // POST /api/auth/invites/:token/accept — public (consumes invite, rate-limited per IP)
  router.post(
    '/api/auth/invites/:token/accept',
    inviteAcceptLimiter,
    async (req: Request, res: Response) => {
      const { token } = req.params as { token: string };
      const row = getInvite(token);
      const state = inviteState(row);
      if (!row || state === 'not-found') {
        res.status(404).json({ error: 'invite not found' });
        return;
      }
      if (state === 'expired' || state === 'already-accepted') {
        res.status(410).json({ error: `invite ${state}` });
        return;
      }

      const parsedAccept = AcceptInviteBody.safeParse(req.body ?? {});
      if (!parsedAccept.success) {
        // Preserve legacy wording so existing clients/regex tests keep
        // working: "invalid username" if the username field is the issue,
        // password message if password is missing/short. Mixed cases fall
        // through to structured Zod output.
        const usernameMissing = parsedAccept.error.issues.some(
          (i) => i.path[0] === 'username' && (i.code === 'invalid_type' || i.code === 'too_small'),
        );
        if (usernameMissing) {
          res.status(400).json({ error: 'invalid username' });
          return;
        }
        const passwordMissing = parsedAccept.error.issues.some(
          (i) => i.path[0] === 'password' && (i.code === 'invalid_type' || i.code === 'too_small'),
        );
        if (passwordMissing) {
          res.status(400).json({
            error: `password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars`,
          });
          return;
        }
        res.status(400).json(formatZodError(parsedAccept.error));
        return;
      }
      const { username: rawUser, password: rawPass } = parsedAccept.data;
      const username = sanitizeUsername(rawUser);
      const password = sanitizePassword(rawPass);
      if (!username) {
        res.status(400).json({ error: 'invalid username' });
        return;
      }
      if (!password) {
        res.status(400).json({
          error: `password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars`,
        });
        return;
      }
      if (getUserByUsername(username)) {
        res.status(409).json({ error: 'username already taken' });
        return;
      }

      const passwordHash = await hashPassword(password);

      // Wrap user creation + invite acceptance + membership in a single
      // DB transaction so a crash mid-flow can't strand a consumed invite
      // against a user row with no membership (a "ghost account" that can
      // log in but 403s on every call). better-sqlite3's db.transaction()
      // returns a function that commits on normal return and rolls back
      // on any thrown error, so we throw an in-band sentinel when the
      // atomic `markInviteAccepted` loses its race.
      class InviteRaceLost extends Error {}
      let user: { id: string; username: string };
      try {
        user = getOrgsDb().transaction(() => {
          const u = createUser({ username, passwordHash });
          const won = markInviteAccepted(token, u.id);
          if (!won) {
            // Losing the race rolls back the createUser + leaves the
            // original winner's acceptance intact.
            throw new InviteRaceLost();
          }
          createMembership(u.id, row.org_id, row.role);
          return u;
        })();
      } catch (err) {
        if (err instanceof InviteRaceLost) {
          res.status(410).json({ error: 'invite no longer valid' });
          return;
        }
        throw err;
      }

      const authRecord = getAuthRecord();
      if (!authRecord) {
        // Can't issue a token with no JWT secret on disk. Invite flow is
        // post-setup only — this is effectively a server-misconfiguration.
        res.status(500).json({ error: 'server auth not configured' });
        return;
      }
      const { token: jwt, expiresAt } = issueToken(user, row.role, authRecord.jwtSecret);
      res.status(201).json({
        token: jwt,
        expiresAt,
        user: { id: user.id, username: user.username, role: row.role },
        orgId: row.org_id,
      });
    },
  );

  // ── Logout (protected) ─────────────────────────────────────────
  // Stateless JWTs — logout is a client-side drop. The endpoint exists so
  // the UI has a symmetric call and so we have a hook for future
  // revocation lists (Phase 4).
  router.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return router;
}

// Re-export so tests can verify helpers without reaching into internals.
export const __internals = { hasAtLeastRole };
