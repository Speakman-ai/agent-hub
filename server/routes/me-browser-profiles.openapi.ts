/**
 * Zod schemas + OpenAPI registrations for the caller's saved browser
 * profiles (`server/routes/me-browser-profiles.ts`).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'BrowserProfileErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

export const BrowserProfileSummarySchema = registerComponent(
  'BrowserProfileSummary',
  z
    .object({
      id: z.string(),
      agentId: z.string(),
      agentName: z.string().openapi({ description: 'Agent display name, or the id if unknown.' }),
      projectId: z.string(),
      projectName: z.string().openapi({ description: 'Project name, or the id if unknown.' }),
      domains: z.array(z.string()).openapi({ description: 'Hostnames with saved sign-in state.' }),
      hasState: z.boolean(),
      inUse: z.boolean().openapi({ description: 'A running session holds the write lease.' }),
      lastUsedAt: z.string().nullable().openapi({
        description: 'When a session last saved this profile (UTC, SQLite datetime).',
      }),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({ description: 'One saved browser profile (no cookie contents).' }),
);

export const BrowserProfileListResponseSchema = registerComponent(
  'BrowserProfileListResponse',
  z.object({ profiles: z.array(BrowserProfileSummarySchema) }),
);

export const BrowserProfileDomainsResponseSchema = registerComponent(
  'BrowserProfileDomainsResponse',
  z.object({
    profileId: z.string(),
    domains: z.array(
      z.object({
        domain: z.string(),
        cookieCount: z.number().int(),
        hasSiteStorage: z
          .boolean()
          .openapi({ description: 'localStorage / IndexedDB is saved for this host.' }),
      }),
    ),
  }),
);

const ProfileIdParams = z.object({ profileId: z.string() });
const DomainParams = z.object({ profileId: z.string(), domain: z.string() });

const notFound = {
  description: 'No profile with this id belongs to the caller.',
  content: { 'application/json': { schema: ErrorResponse } },
};
const unauthenticated = {
  description: 'Not authenticated.',
  content: { 'application/json': { schema: ErrorResponse } },
};

registerPath({
  method: 'get',
  path: '/api/me/browser-profiles',
  tags: ['Browser Profiles'],
  summary: "List the calling user's saved browser profiles",
  description:
    'Always scoped to the caller. Owners and Admins cannot list or read other users profiles.',
  responses: {
    200: {
      description: 'Profiles ordered by project then agent.',
      content: { 'application/json': { schema: BrowserProfileListResponseSchema } },
    },
    401: unauthenticated,
  },
});

registerPath({
  method: 'get',
  path: '/api/me/browser-profiles/{profileId}/domains',
  tags: ['Browser Profiles'],
  summary: 'List signed-in domains for one of the caller profiles',
  description: 'Returns per-domain counts only; cookie names and values are never returned.',
  request: { params: ProfileIdParams },
  responses: {
    200: {
      description: 'Domains with saved state.',
      content: { 'application/json': { schema: BrowserProfileDomainsResponseSchema } },
    },
    401: unauthenticated,
    404: notFound,
    409: {
      description: 'Saved state cannot be decrypted. Delete the profile to start fresh.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/me/browser-profiles/{profileId}/domains/{domain}',
  tags: ['Browser Profiles'],
  summary: "Clear one domain's cookies and site storage",
  request: { params: DomainParams },
  responses: {
    200: {
      description: 'Profile after the clear.',
      content: { 'application/json': { schema: BrowserProfileSummarySchema } },
    },
    401: unauthenticated,
    404: {
      description: 'Profile not found for the caller, or the domain is not saved in it.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description: 'A running session holds the profile, or its state cannot be decrypted.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/me/browser-profiles/{profileId}',
  tags: ['Browser Profiles'],
  summary: 'Delete one of the caller profiles and everything it saved',
  request: { params: ProfileIdParams },
  responses: {
    200: {
      description: 'Deleted.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: unauthenticated,
    404: notFound,
  },
});
