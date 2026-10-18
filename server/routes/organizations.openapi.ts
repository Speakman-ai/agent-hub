import { z, registerComponent, registerPath } from '../openapi/registry.js';

const id = z.string().min(1).max(200);
export const OrganizationParams = z.object({ organizationId: id });
export const OrganizationMemberParams = OrganizationParams.extend({ userId: id });
export const OrganizationProjectParams = OrganizationParams.extend({ projectId: id });
export const OrganizationNameBody = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export const OrganizationRole = z.enum(['Owner', 'Admin', 'Member']);
export const OrganizationMemberBody = z.object({ role: OrganizationRole }).strict();
export const OrganizationQuery = z.object({}).strict();

export const Organization = registerComponent(
  'BusinessOrganization',
  z.object({
    id: z.string(),
    serverId: z.string(),
    name: z.string(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    role: OrganizationRole.nullable(),
    canManage: z.boolean(),
  }),
);
export const OrganizationMember = registerComponent(
  'BusinessOrganizationMember',
  z.object({
    userId: z.string(),
    username: z.string(),
    role: OrganizationRole,
    createdAt: z.string(),
  }),
);
export const OrganizationProject = registerComponent(
  'BusinessOrganizationProject',
  z.object({
    id: z.string(),
    name: z.string(),
    visibility: z.enum(['shared', 'private']),
  }),
);
const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
const error = json(z.object({ error: z.string() }));
const errors = {
  400: { description: 'Invalid request.', content: error },
  401: { description: 'An authenticated user identity is required.', content: error },
  403: { description: 'Organization administration requires Owner/Admin.', content: error },
  404: {
    description: 'Resource absent or inaccessible in the authenticated Server.',
    content: error,
  },
  409: { description: 'The last organization Owner cannot be removed or demoted.', content: error },
};
const base = '/api/organizations';
const detail = `${base}/{organizationId}`;
const ok = z.object({ ok: z.literal(true) });
const scope =
  ' Scoped to the authenticated Server and current user. Organization membership never grants project access. Global API keys without a user identity cannot access this surface.';

registerPath({
  method: 'get',
  path: base,
  tags: ['Organizations'],
  summary: 'List accessible organizations',
  description: scope,
  request: { query: OrganizationQuery },
  responses: {
    200: {
      description: 'Only accessible active organizations; no unfiltered counts.',
      content: json(z.object({ organizations: z.array(Organization) })),
    },
    ...errors,
  },
});
registerPath({
  method: 'post',
  path: base,
  tags: ['Organizations'],
  summary: 'Create an organization with the caller as Owner',
  description: scope,
  request: {
    query: OrganizationQuery,
    body: { required: true, content: json(OrganizationNameBody) },
  },
  responses: {
    201: { description: 'Created.', content: json(z.object({ organization: Organization })) },
    ...errors,
  },
});
registerPath({
  method: 'get',
  path: detail,
  tags: ['Organizations'],
  summary: 'Read an organization',
  description: scope,
  request: { params: OrganizationParams, query: OrganizationQuery },
  responses: {
    200: {
      description: 'Accessible organization metadata.',
      content: json(z.object({ organization: Organization })),
    },
    ...errors,
  },
});
registerPath({
  method: 'patch',
  path: detail,
  tags: ['Organizations'],
  summary: 'Rename an organization',
  description: scope,
  request: {
    params: OrganizationParams,
    query: OrganizationQuery,
    body: { required: true, content: json(OrganizationNameBody) },
  },
  responses: {
    200: {
      description: 'Renamed with stable identity.',
      content: json(z.object({ organization: Organization })),
    },
    ...errors,
  },
});
registerPath({
  method: 'delete',
  path: detail,
  tags: ['Organizations'],
  summary: 'Archive an organization',
  description:
    'Revokes organization membership and removes links; preserves projects and session history.' +
    scope,
  request: { params: OrganizationParams, query: OrganizationQuery },
  responses: { 200: { description: 'Archived.', content: json(ok) }, ...errors },
});
registerPath({
  method: 'get',
  path: `${detail}/members`,
  tags: ['Organizations'],
  summary: 'List organization members',
  description: scope,
  request: { params: OrganizationParams, query: OrganizationQuery },
  responses: {
    200: {
      description: 'Organization members.',
      content: json(z.object({ members: z.array(OrganizationMember) })),
    },
    ...errors,
  },
});
registerPath({
  method: 'put',
  path: `${detail}/members/{userId}`,
  tags: ['Organizations'],
  summary: 'Add a Server member or change their organization role',
  description: 'Requires organization or Server Owner/Admin. The last Owner is protected.' + scope,
  request: {
    params: OrganizationMemberParams,
    query: OrganizationQuery,
    body: { required: true, content: json(OrganizationMemberBody) },
  },
  responses: { 200: { description: 'Membership saved.', content: json(ok) }, ...errors },
});
registerPath({
  method: 'delete',
  path: `${detail}/members/{userId}`,
  tags: ['Organizations'],
  summary: 'Remove organization membership',
  description: scope,
  request: { params: OrganizationMemberParams, query: OrganizationQuery },
  responses: {
    200: { description: 'Membership removed; repeated removal is a no-op.', content: json(ok) },
    ...errors,
  },
});
registerPath({
  method: 'get',
  path: `${detail}/projects`,
  tags: ['Organizations'],
  summary: 'List linked projects the caller may read',
  description: scope,
  request: { params: OrganizationParams, query: OrganizationQuery },
  responses: {
    200: {
      description: 'Authorized project summaries only; no hidden counts.',
      content: json(z.object({ projects: z.array(OrganizationProject) })),
    },
    ...errors,
  },
});
registerPath({
  method: 'put',
  path: `${detail}/projects/{projectId}`,
  tags: ['Organizations'],
  summary: 'Attach an accessible project',
  description: 'Idempotent; neither copies the project nor changes its ACL.' + scope,
  request: { params: OrganizationProjectParams, query: OrganizationQuery },
  responses: { 200: { description: 'Project linked.', content: json(ok) }, ...errors },
});
registerPath({
  method: 'delete',
  path: `${detail}/projects/{projectId}`,
  tags: ['Organizations'],
  summary: 'Detach an accessible project',
  description: 'Idempotent; preserves the project and other organization links.' + scope,
  request: { params: OrganizationProjectParams, query: OrganizationQuery },
  responses: { 200: { description: 'Project unlinked.', content: json(ok) }, ...errors },
});

registerPath({
  method: 'get',
  path: '/api/organizations/project-choices',
  tags: ['Organizations'],
  summary: 'List projects available for organization attachment',
  description:
    'Includes independent projects. Excludes hidden/internal workspaces and inaccessible projects, using the authenticated Server registry.' +
    scope,
  request: { query: OrganizationQuery },
  responses: {
    200: {
      description: 'Attachable project summaries only.',
      content: json(z.object({ projects: z.array(OrganizationProject) })),
    },
    ...errors,
  },
});
