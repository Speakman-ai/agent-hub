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

// ─── Cost (decision INFRA-COST) ─────────────────────────────────────────────

const DegradationLevel = z.enum(['normal', 'widened', 'paused']).openapi({
  description:
    'What the collector is doing about this project’s spend. `normal` polls at the configured tiers; `widened` multiplies every poll interval by 4 once month-to-date spend reaches the ceiling; `paused` stops issuing billed requests entirely once it reaches twice the ceiling.',
});

const MetricInterval = z
  .object({
    metricName: z.string().openapi({ example: 'CPUUtilization' }),
    namespace: z.string().openapi({ example: 'AWS/EC2' }),
    stat: z.string().openapi({ example: 'Average' }),
    minPeriodSeconds: z.number().openapi({
      description:
        'The rate AWS actually publishes this metric at. The poll interval can never go below it — requests for data that has not been published yet are billed and return nothing.',
      example: 300,
    }),
    pollIntervalSeconds: z.number().openapi({
      description:
        'What the collector will request it at: the service tier, raised to `minPeriodSeconds`, raised to the collector tick, then multiplied if the project is `widened`.',
      example: 300,
    }),
    requestsPerMonth: z.number(),
  })
  .openapi({ description: 'Resolved cadence for one metric in a service pack.' });

const ScopeProjection = z
  .object({
    id: z.string().optional(),
    service: z.string().openapi({ example: 'ec2' }),
    profileName: z.string().optional(),
    region: z.string().optional().openapi({ example: 'us-east-2' }),
    resourceCount: z.number(),
    metricsPerResource: z.number().openapi({
      description:
        'Metrics in this service’s pack. Zero means the service is not collected at all.',
    }),
    metricsRequestedPerMonth: z.number(),
    estimatedMonthlyCostUsd: z.number().openapi({
      description:
        'Priced at the scope’s own region. Most regions are $0.01 per 1,000 metrics requested; GovCloud is $0.013 and São Paulo $0.014.',
    }),
    usdPer1000Metrics: z.number().openapi({
      description: 'The `GetMetricData` rate this scope was priced at.',
      example: 0.01,
    }),
    regionPriceKnown: z.boolean().openapi({
      description:
        'False when the region is absent from the published price table and the **dearest** known rate was assumed instead — a guardrail must never knowingly under-report, so an unrecognised region is priced high, not at the list rate. Surfaced so an operator can see why an estimate is inflated (by up to 40%) rather than merely distrusting it.',
    }),
    intervals: z.array(MetricInterval),
  })
  .openapi({ description: 'What one scope contributes to the projected monthly bill.' });

const CostProjection = registerComponent(
  'InfraCostProjection',
  z
    .object({
      metricsRequestedPerMonth: z.number(),
      estimatedMonthlyCostUsd: z.number(),
      perScope: z.array(ScopeProjection),
    })
    .openapi({
      description:
        'Projected monthly `GetMetricData` spend for a set of scopes: resources × metrics × ticks per month. Estimates round *against* the wallet — a 31-day month, and no modelling of AWS’s ≤5-statistics-per-metric bundling — because a projection that under-reports produces the surprise bill this guardrail exists to prevent.',
    }),
);

const CostResponse = registerComponent(
  'InfraCostStatus',
  z
    .object({
      monthStartMs: z.number().openapi({
        description:
          'First epoch ms of the **UTC** calendar month the spend figures cover. UTC because AWS bills on UTC months; using the Hub’s local timezone would put the ceiling out of phase with the bill it guards.',
      }),
      monthToDateUsd: z.number().openapi({
        description:
          'Summed `estimated_cost_usd` over this month’s collector ticks, including ticks that crashed — a spend audit that only counted completed ticks would under-report the expensive ones.',
      }),
      extrapolatedMonthUsd: z.number().openapi({
        description:
          'Straight-line extrapolation of `monthToDateUsd` to month end. Answers “what is the current configuration on track for”, where `projection` answers “what will this configuration cost”; a scope added mid-month makes the two disagree, which is the signal.',
      }),
      metricsRequested: z.number(),
      queriesIssued: z.number(),
      datapointsReturned: z.number(),
      throttles: z.number(),
      errors: z.number(),
      runs: z.number().openapi({ description: 'Collector ticks recorded this month.' }),
      futureDatedRuns: z.number().openapi({
        description:
          'Runs stamped beyond the end of this month, excluded from the totals above. Only reachable through host clock skew, since a run row is written with the wall clock at tick start. Reported rather than silently dropped — their spend is real but cannot be attributed to this month without double-counting it when that month arrives. Non-zero means the host clock needs looking at.',
      }),
      monthlyCeilingUsd: z.number().nullable().openapi({
        description:
          'Spend ceiling, or null for uncapped (the default). A ceiling of `0` is a real setting distinct from null and means “collect nothing”.',
      }),
      degradation: DegradationLevel,
      degradedAt: z.number().nullable().openapi({
        description: 'Epoch ms the level last changed; null while it has never left `normal`.',
      }),
      configured: z.boolean().openapi({
        description:
          'False when the project has no cost-config row and every setting above is a default — the UI needs this to distinguish “never opened” from “deliberately uncapped”.',
      }),
      projection: CostProjection,
      recentRuns: z.array(
        z.object({
          id: z.string(),
          accountId: z.string().nullable(),
          region: z.string().nullable(),
          startedAt: z.number(),
          finishedAt: z.number().nullable(),
          durationMs: z.number().nullable(),
          queriesIssued: z.number(),
          metricsRequested: z.number(),
          datapointsReturned: z.number(),
          pointsWritten: z.number(),
          throttles: z.number(),
          errors: z.number(),
          estimatedCostUsd: z.number(),
          status: z.string().openapi({ example: 'ok' }),
          errorMessage: z.string().nullable(),
        }),
      ),
    })
    .openapi({
      description:
        'Spend to date and projection for a project’s AWS API usage. Resource identifiers and dollar figures only — never credentials or anything else Admin-gated beyond the route’s own gate.',
    }),
);

// GET /api/projects/{projectId}/infra/cost
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/cost',
  tags: ['Projects'],
  summary: 'AWS API spend to date and projected monthly cost',
  description:
    'Reports what this project has spent on `GetMetricData` so far this UTC month (summed from the `infra_collect_runs` audit trail), the projected monthly cost of its current enabled scopes, the configured ceiling, and the collector’s current degradation level.\n\n**Cost:** free. Every figure is read from local SQLite — this endpoint issues no AWS calls at all.',
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Spend and projection.',
      content: { 'application/json': { schema: CostResponse } },
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const CostProjectionRequestSchema = z
  .object({
    scopes: z
      .array(
        z.object({
          service: z.string().min(1).openapi({ example: 'ec2' }),
          resourceCount: z.number().int().min(0).max(1_000_000),
          id: z.string().optional(),
          profileName: z.string().optional(),
          region: z.string().optional().openapi({ example: 'us-east-2' }),
        }),
      )
      .max(500),
    degradation: z.enum(['normal', 'widened']).optional().openapi({
      description:
        'Price the projection as if the project were already degraded. Omit for the normal cadence.',
    }),
  })
  .openapi({
    description:
      'A proposed scope allowlist to price. `resourceCount` is what the operator expects the scope to match; the editor fills it from the inventory browser.',
  });

registerComponent('InfraCostProjectionRequest', CostProjectionRequestSchema);

// POST /api/projects/{projectId}/infra/cost/projection
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/infra/cost/projection',
  tags: ['Projects'],
  summary: 'Price a proposed scope allowlist before saving it',
  description:
    'Prices a **hypothetical** set of scopes without persisting anything. This is what backs decision INFRA-COST’s requirement that the scope editor show a projected monthly API cost *before* the operator saves — the number that changes behaviour is the one shown at decision time, not the one on next month’s bill.\n\nPure arithmetic over the service metric packs. Issues no AWS calls, writes nothing, and is safe to call on every keystroke.',
  request: {
    params: ProjectIdParam,
    body: { content: { 'application/json': { schema: CostProjectionRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Projected cost for the submitted scopes.',
      content: { 'application/json': { schema: CostProjection } },
    },
    400: {
      description: 'Malformed body.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const CostCeilingRequestSchema = z
  .object({
    monthlyCeilingUsd: z.number().min(0).max(1_000_000).nullable().openapi({
      description:
        'Ceiling in USD, or null to remove it. `0` means “collect nothing” and pauses the collector immediately.',
      example: 25,
    }),
  })
  .openapi({ description: 'Set or clear a project’s monthly AWS API spend ceiling.' });

registerComponent('InfraCostCeilingRequest', CostCeilingRequestSchema);

// PUT /api/projects/{projectId}/infra/cost/config
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/infra/cost/config',
  tags: ['Projects'],
  summary: 'Set the project’s monthly AWS API spend ceiling',
  description:
    'Sets (or clears, with `null`) the ceiling the collector degrades against.\n\nSaving a ceiling deliberately does **not** reset the stored degradation level: that level is a fact about spend which has already happened, and the next collector tick recomputes it. Clearing it here would let an operator un-pause a project by re-saving the same ceiling, and the following tick would pause it again after issuing one more round of billed requests.',
  request: {
    params: ProjectIdParam,
    body: { content: { 'application/json': { schema: CostCeilingRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Ceiling saved; the full cost status is returned.',
      content: { 'application/json': { schema: CostResponse } },
    },
    400: {
      description: 'Malformed body.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const RetentionResponse = registerComponent(
  'InfraRetentionConfig',
  z
    .object({
      retentionDays: z.number().int().openapi({
        description: 'Age window before a metric point is reaped, in days.',
        example: 30,
      }),
      quotaBytes: z.number().int().openapi({
        description:
          'Accounted footprint this project may hold before its oldest points are evicted.',
        example: 8589934592,
      }),
      configured: z.boolean().openapi({
        description:
          'False when this project has no override row and both values above are the code defaults.',
      }),
      updatedAt: z
        .number()
        .nullable()
        .openapi({ description: 'Epoch ms the override was last saved. Null when unconfigured.' }),
      defaults: z
        .object({ retentionDays: z.number().int(), quotaBytes: z.number().int() })
        .openapi({ description: 'What an unconfigured project falls back to.' }),
      bounds: z
        .object({
          minRetentionDays: z.number().int(),
          maxRetentionDays: z.number().int(),
          minQuotaBytes: z.number().int(),
          maxQuotaBytes: z.number().int(),
        })
        .openapi({
          description:
            'Inclusive range each value is clamped to. Out-of-range input is clamped, not rejected.',
        }),
      dbBytes: z.number().int().openapi({
        description:
          'On-disk size of the whole `infra.db` file, across every project. Deliberately not a per-project figure: that would need a full-table aggregate, which on a store of tens of millions of points would stall the server for a page load.',
      }),
    })
    .openapi({
      description:
        'A project’s resolved retention window and byte quota, with the bounds and defaults behind them.',
    }),
);

// GET /api/projects/{projectId}/infra/retention
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/retention',
  tags: ['Projects'],
  summary: 'Resolved metric retention window and byte quota',
  description:
    'Reports the age window and per-project byte quota the retention reaper enforces against `infra_metric_points`, resolved with defaults for a project that has never configured them.\n\n**Cost:** free. Local SQLite metadata only — no AWS calls and no table scan.',
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Resolved retention configuration.',
      content: { 'application/json': { schema: RetentionResponse } },
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const RetentionConfigRequestSchema = z
  .object({
    retentionDays: z.number().int().min(0).max(100_000).optional().openapi({
      description: 'New age window in days. Clamped to the documented bounds. Omit to leave as-is.',
      example: 60,
    }),
    quotaBytes: z.number().int().min(0).max(1_099_511_627_776).optional().openapi({
      description: 'New byte quota. Clamped to the documented bounds. Omit to leave as-is.',
      example: 8589934592,
    }),
  })
  .refine((v) => v.retentionDays !== undefined || v.quotaBytes !== undefined, {
    message: 'Provide retentionDays, quotaBytes, or both',
  })
  .openapi({ description: 'Set a project’s metric retention overrides.' });

registerComponent('InfraRetentionConfigRequest', RetentionConfigRequestSchema);

// PUT /api/projects/{projectId}/infra/retention
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/infra/retention',
  tags: ['Projects'],
  summary: 'Override the project’s metric retention window and byte quota',
  description:
    'Writes this project’s `infra_retention_config` row. Either field may be sent alone; the other keeps its current resolved value.\n\nValues outside the documented bounds are **clamped rather than rejected**, and the clamp is re-applied on read, so narrowing a bound later reinterprets an old row instead of stranding it. The response echoes what was actually stored.\n\nShrinking the window or the quota takes effect on the next reaper tick and deletes points, which is not reversible — the data is not re-fetched from CloudWatch.',
  request: {
    params: ProjectIdParam,
    body: { content: { 'application/json': { schema: RetentionConfigRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Overrides saved; the resolved configuration is returned.',
      content: { 'application/json': { schema: RetentionResponse } },
    },
    400: {
      description: 'Malformed body.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    503: {
      description: 'The infrastructure store is unavailable on this Hub.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});
