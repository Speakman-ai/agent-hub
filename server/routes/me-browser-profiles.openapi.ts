/**
 * Zod schemas + OpenAPI registrations for the caller's saved browser
 * profiles (`server/routes/me-browser-profiles.ts`).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'BrowserProfileErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

export const BrowserDomainPolicyValueSchema = z.enum(['allow', 'ask', 'block']);

export const BrowserDomainPolicySchema = registerComponent(
  'BrowserDomainPolicy',
  z.object({ domain: z.string(), policy: BrowserDomainPolicyValueSchema }).openapi({
    description:
      'What the host does when the agent acts on this site and its subdomains: `allow` runs ops, `ask` raises an approval before click / type, `block` stops the agent browser loading the site (explicit navigation, redirects, link clicks, history) and refuses every op on a page that reaches it. The most specific domain wins; sites with no entry are `allow`.',
  }),
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
      domainPolicies: z.array(BrowserDomainPolicySchema).openapi({
        description: 'Site policies applied to agent browser ops, sorted by domain.',
      }),
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
  description:
    'Also removes the profile site policies and approval rules, so agent credentials are refused.',
  request: { params: ProfileIdParams },
  responses: {
    200: {
      description: 'Deleted.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: unauthenticated,
    403: {
      description: 'Called with agent credentials. Only people delete browser profiles.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: notFound,
  },
});

const PolicyParams = z.object({ profileId: z.string(), domain: z.string() });
const agentCaller = {
  description: 'Called with agent credentials. Only people change site policies.',
  content: { 'application/json': { schema: ErrorResponse } },
};

registerPath({
  method: 'put',
  path: '/api/me/browser-profiles/{profileId}/domain-policies/{domain}',
  tags: ['Browser Profiles'],
  summary: 'Set the site policy for a domain on one of the caller profiles',
  request: {
    params: PolicyParams,
    body: {
      content: {
        'application/json': { schema: z.object({ policy: BrowserDomainPolicyValueSchema }) },
      },
    },
  },
  responses: {
    200: {
      description: 'Profile after the change.',
      content: { 'application/json': { schema: BrowserProfileSummarySchema } },
    },
    400: {
      description: 'Bad policy or domain.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: unauthenticated,
    403: agentCaller,
    404: notFound,
  },
});

registerPath({
  method: 'delete',
  path: '/api/me/browser-profiles/{profileId}/domain-policies/{domain}',
  tags: ['Browser Profiles'],
  summary: 'Remove the site policy for a domain (back to allow)',
  request: { params: PolicyParams },
  responses: {
    200: {
      description: 'Profile after the change.',
      content: { 'application/json': { schema: BrowserProfileSummarySchema } },
    },
    401: unauthenticated,
    403: agentCaller,
    404: {
      description: 'Profile not found for the caller, or no policy for this domain.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});
