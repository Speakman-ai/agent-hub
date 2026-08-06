import { z, registerComponent, registerPath } from '../openapi/registry.js';
import { INFRA_ALERT_CHANNELS, INFRA_ALERT_SEVERITIES } from '../infra/infra-schema.js';

const severity = z.enum(INFRA_ALERT_SEVERITIES);
const channel = z.enum(INFRA_ALERT_CHANNELS);
const projectParams = z.object({ projectId: z.string() });

export const InfraAlertRoutingEntrySchema = registerComponent(
  'InfraAlertRoutingEntry',
  z.object({ severity, channel, enabled: z.boolean() }),
);

export const InfraAlertRoutingResponseSchema = registerComponent(
  'InfraAlertRoutingResponse',
  z.object({
    projectId: z.string(),
    routing: z.array(
      z.object({
        projectId: z.string(),
        severity,
        channels: z.object({
          in_app: z.boolean(),
          push: z.boolean(),
          email: z.boolean(),
        }),
        isDefault: z.boolean(),
        overrides: z.array(
          z.object({
            id: z.string(),
            project_id: z.string(),
            severity,
            channel,
            enabled: z.number().int(),
            created_at: z.number().int(),
            updated_at: z.number().int(),
          }),
        ),
      }),
    ),
  }),
);

export const InfraAlertRoutingUpdateSchema = InfraAlertRoutingEntrySchema;
const ErrorResponse = registerComponent('InfraAlertRoutingError', z.object({ error: z.string() }));

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/alert-routing',
  tags: ['Infrastructure'],
  summary: 'Resolve infrastructure alert delivery routing',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Resolved alert routing.',
      content: { 'application/json': { schema: InfraAlertRoutingResponseSchema } },
    },
    404: {
      description: 'Project not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/infra/alert-routing',
  tags: ['Infrastructure'],
  summary: 'Set an infrastructure alert delivery override',
  request: {
    params: projectParams,
    body: { content: { 'application/json': { schema: InfraAlertRoutingUpdateSchema } } },
  },
  responses: {
    200: {
      description: 'Updated alert routing.',
      content: { 'application/json': { schema: InfraAlertRoutingResponseSchema } },
    },
    400: {
      description: 'Invalid routing entry.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Project not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/infra/alert-routing/{severity}/{channel}',
  tags: ['Infrastructure'],
  summary: 'Remove an infrastructure alert delivery override',
  request: { params: projectParams.extend({ severity, channel }) },
  responses: {
    200: {
      description: 'Updated alert routing.',
      content: { 'application/json': { schema: InfraAlertRoutingResponseSchema } },
    },
    404: {
      description: 'Project or routing override not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});
