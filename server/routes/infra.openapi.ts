/**
 * Zod schemas + OpenAPI registrations for the infrastructure-monitoring routes.
 *
 * Companion to `server/routes/infra.ts`. Loaded for its side effects by
 * `server/openapi/generate.ts`. New route files start at
 * `allowed_unregistered: 0` in the coverage baseline, so every handler added
 * to `infra.ts` must be registered here.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug (e.g. `agent-hub`).' }),
});

const ErrorEnvelope = z.object({
  error: z.string().openapi({ description: 'Human-readable failure reason.' }),
});

const MonitoringStatusResponse = registerComponent(
  'InfraMonitoringStatus',
  z
    .object({
      profile: z.string().nullable().openapi({
        description:
          'Profile the probe used. On a failure this is the profile the operator designated, so the UI can name it; null only when nothing was designated at all.',
        example: 'monitoring',
      }),
      region: z.string().nullable().openapi({
        description:
          "Region the probe used, taken from the profile's own stanza. Null when resolution failed before a region was determined.",
        example: 'us-east-2',
      }),
      reachable: z.boolean().openapi({
        description:
          'True when credentials resolved in-process and CloudWatch answered a `DescribeAlarms` call in that region.',
      }),
      code: z.string().optional().openapi({
        description:
          'Machine-readable failure cause. `monitoring_profile_required` when no usable profile is designated; otherwise the AWS SDK error name (e.g. `AccessDeniedException`).',
        example: 'monitoring_profile_required',
      }),
      reason: z.enum(['not_designated', 'interactive_sso']).optional().openapi({
        description:
          'Present only with `code: monitoring_profile_required`. `not_designated` means no monitoring profile is set, or the designation names a profile that no longer exists. `interactive_sso` means the designated profile is an IAM Identity Center profile, whose token cache is keyed to a user HOME and expires unattended.',
      }),
      error: z.string().optional().openapi({
        description: 'Operator-facing failure detail. Absent when `reachable` is true.',
      }),
      checkedAt: z
        .number()
        .openapi({ description: 'Epoch ms the probe ran. Nothing is cached server-side.' }),
    })
    .openapi({
      description:
        'Whether this project can be monitored right now. Never carries credential material — profile name, region and failure text only.',
    }),
);

// GET /api/projects/{projectId}/infra/monitoring-status
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/monitoring-status',
  tags: ['Projects'],
  summary: 'Check whether a project can be monitored unattended',
  description:
    "Resolves the project's designated AWS monitoring profile in-process (no `aws` CLI spawn) and probes CloudWatch with `DescribeAlarms` limited to one record.\n\nA project that cannot be monitored still returns 200 with `reachable: false` — the Infrastructure module renders its empty state from this body, so callers branch on `code` / `reason` rather than on the status code.\n\n**Cost:** each call issues exactly one CloudWatch `DescribeAlarms` request against the target account, and nothing is cached server-side. `DescribeAlarms` is a `Requests`-usage-type operation, so it counts against the AWS Free Tier allowance of 1 million CloudWatch API requests per month and is billed per 1,000 requests beyond that allowance — it is not unconditionally free, it is only outside the three operations (`GetMetricData`, `GetInsightRuleReport`, `GetMetricWidgetImage`) that AWS charges from the first call. Call this when a view opens or on operator action; do not poll it on a tight timer.",
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Probe ran. Inspect `reachable`.',
      content: { 'application/json': { schema: MonitoringStatusResponse } },
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});
