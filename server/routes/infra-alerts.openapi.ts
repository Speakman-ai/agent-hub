/**
 * Zod schemas + OpenAPI registrations for the infra alert-rule and alert
 * lifecycle routes.
 *
 * Companion to `server/routes/infra-alerts.ts`, loaded for its side effects by
 * `server/openapi/generate.ts`. New route files start at
 * `allowed_unregistered: 0` in the coverage baseline, so every handler added
 * there must be registered here.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import {
  INFRA_ALARM_STATES,
  INFRA_ALARM_REASONS,
  INFRA_COMPARISON_OPERATORS,
  INFRA_TREAT_MISSING_DATA_MODES,
} from '../infra/alert-evaluator.js';
import {
  INFRA_ALERT_SEVERITIES,
  INFRA_ALERT_STATUSES,
  MAX_INFRA_ALERT_LIST_LIMIT,
} from '../infra/infra-schema.js';

/** `readonly [...]` const tuples widened to the mutable tuple `z.enum` demands. */
function asEnum<T extends string>(values: readonly T[]): [T, ...T[]] {
  return values as unknown as [T, ...T[]];
}

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug (e.g. `agent-hub`).' }),
});

const RuleParams = ProjectIdParam.extend({
  ruleId: z.string().openapi({ description: 'Alert rule id.' }),
});

const AlertParams = ProjectIdParam.extend({
  alertId: z.string().openapi({ description: 'Alert id.' }),
});

const ErrorEnvelope = z.object({
  error: z.string().openapi({ description: 'Human-readable failure reason.' }),
});

// ── Rules ──────────────────────────────────────────────────────────────────

/**
 * The tag predicate, shaped like `infra_scopes.tag_filter_json`: tag key to the
 * values that satisfy it. Bounded on both axes because it is operator-authored
 * text that the evaluator walks per resource per tick.
 */
const TagFilter = z
  .record(z.string().min(1).max(128), z.array(z.string().max(256)).min(1).max(50))
  .refine((v) => Object.keys(v).length <= 50, { message: 'At most 50 tag keys' });

/**
 * The rule body, minus the fields the server owns.
 *
 * `datapointsToAlarm > evaluationPeriods` is rejected here *and* in the store,
 * so a direct store caller (the default rule packs) cannot persist a rule that
 * can never reach ALARM either.
 */
const AlertRuleWritable = z.object({
  name: z.string().min(1).max(200).openapi({
    description: 'Operator-facing rule name, shown on the alert.',
    example: 'ALB unhealthy hosts',
  }),
  description: z.string().max(2000).nullish(),

  service: z.string().min(1).max(64).openapi({
    description:
      'Service token the rule applies to (`ec2`, `rds`, `elbv2`, …), matching `infra_resources.service`. Required: it decides which namespace the rule can apply to.',
    example: 'elbv2',
  }),
  accountId: z.string().max(64).nullish().openapi({
    description: 'Narrow to one account. Null/absent matches every account in scope.',
  }),
  region: z.string().max(32).nullish().openapi({
    description: 'Narrow to one region. Null/absent matches every region in scope.',
  }),
  resourceKey: z.string().max(512).nullish().openapi({
    description:
      'Pin to exactly one resource (`infra_resources.resource_key`). Null/absent matches every resource satisfying the rest of the selector, including ones discovered after the rule was written.',
  }),
  tagFilter: TagFilter.nullish().openapi({
    description:
      'Tag predicate, e.g. `{"Environment":["prod"]}`. An empty object is stored as no filter.',
  }),

  namespace: z.string().min(1).max(255).openapi({ example: 'AWS/ApplicationELB' }),
  metricName: z.string().min(1).max(255).openapi({ example: 'UnHealthyHostCount' }),
  stat: z.string().min(1).max(64).openapi({
    description: 'CloudWatch statistic (`Average`, `Maximum`, `Sum`, `p99`, …).',
    example: 'Minimum',
  }),
  periodS: z.number().int().min(1).max(86_400).openapi({
    description:
      'Period in seconds. CloudWatch only serves 60s within 15 days, 300s within 63 days and 3600s beyond, so a period finer than the data available returns nothing.',
    example: 60,
  }),

  threshold: z.number().finite(),
  comparisonOperator: z.enum(asEnum(INFRA_COMPARISON_OPERATORS)).openapi({
    description:
      'Static-threshold operators only. The anomaly-detection operators `PutMetricAlarm` also accepts are rejected: we fit no model, so there is no threshold band for them to compare against.',
  }),
  evaluationPeriods: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .openapi({ description: 'N — periods the metric is compared over.' }),
  datapointsToAlarm: z.number().int().min(1).max(1440).nullish().openapi({
    description:
      'M of N. Null/absent means N (consecutive alarm), which is AWS’s own default. Must not exceed `evaluationPeriods` — such a rule could never reach ALARM.',
  }),
  treatMissingData: z.enum(asEnum(INFRA_TREAT_MISSING_DATA_MODES)).nullish().openapi({
    description: 'Defaults to `missing`, matching CloudWatch.',
  }),

  severity: z.enum(asEnum(INFRA_ALERT_SEVERITIES)).nullish().openapi({
    description: 'Routing severity. Defaults to `warning`. Not a CloudWatch concept — ours.',
  }),
  enabled: z.boolean().optional().openapi({
    description:
      'Defaults to true. Disabling stops evaluation while retaining the alert history a delete would cascade away.',
  }),
});

export const AlertRuleCreateSchema = AlertRuleWritable;
registerComponent('InfraAlertRuleCreateRequest', AlertRuleCreateSchema);

/** Every writable field optional; absent keys are left alone. */
export const AlertRuleUpdateSchema = AlertRuleWritable.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);
registerComponent('InfraAlertRuleUpdateRequest', AlertRuleUpdateSchema);

const AlertRule = registerComponent(
  'InfraAlertRule',
  AlertRuleWritable.extend({
    id: z.string(),
    projectId: z.string(),
    enabled: z.boolean(),
    createdAt: z.number().int().openapi({ description: 'Epoch ms.' }),
    updatedAt: z.number().int().openapi({ description: 'Epoch ms.' }),
  }).openapi({
    description:
      'A threshold rule Agent Hub evaluates in its own poller. We never call `PutMetricAlarm`, so this rule does not exist in the monitored AWS account.',
  }),
);

const AlertRuleListResponse = registerComponent(
  'InfraAlertRuleList',
  z.object({ rules: z.array(AlertRule) }),
);

export const AlertRuleListParamsSchema = z.object({
  service: z.string().max(64).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

// ── Alerts ─────────────────────────────────────────────────────────────────

const AlertTransition = registerComponent(
  'InfraAlertTransition',
  z
    .object({
      fromState: z.enum(asEnum(INFRA_ALARM_STATES)),
      toState: z.enum(asEnum(INFRA_ALARM_STATES)),
      fromStatus: z.enum(asEnum(INFRA_ALERT_STATUSES)),
      toStatus: z.enum(asEnum(INFRA_ALERT_STATUSES)),
      reason: z.enum(asEnum(INFRA_ALARM_REASONS)).nullable(),
      actor: z.string().openapi({
        description:
          'Acting user id, or one of `system:evaluator`, `system:recurrence`, `system:recovery`.',
      }),
      atMs: z.number().int(),
    })
    .openapi({
      description:
        'One recorded move. Both state and status are captured on every row, so the timeline reads as complete snapshots rather than half-updates.',
    }),
);

const Alert = registerComponent(
  'InfraAlert',
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      ruleId: z.string(),
      resourceKey: z.string(),
      state: z.enum(asEnum(INFRA_ALARM_STATES)).openapi({
        description: 'What the metric says. Owned by the evaluator.',
      }),
      reason: z.enum(asEnum(INFRA_ALARM_REASONS)).nullable(),
      stateUpdatedAt: z.number().int().openapi({
        description:
          'Observation timestamp the current state was decided from — the data’s clock, not the tick’s. An evaluation older than this updates the aggregates but cannot rewrite the state.',
      }),
      status: z.enum(asEnum(INFRA_ALERT_STATUSES)).openapi({
        description:
          'What the operator decided. Recurrence reopens `resolved`; `ignored` stays muted through a full breach/recover round trip.',
      }),
      statusUpdatedAt: z.number().int().nullable(),
      statusUpdatedBy: z.string().nullable(),
      firstSeen: z.number().int().openapi({
        description: 'True minimum over every ALARM observation, including out-of-order ones.',
      }),
      lastSeen: z.number().int().openapi({ description: 'True maximum, same guarantee.' }),
      occurrenceCount: z.number().int(),
      lastValue: z.number().nullable(),
      breachingDatapoints: z.number().int().nullable(),
      createdAt: z.number().int(),
      updatedAt: z.number().int(),
      transitions: z.array(AlertTransition).optional().openapi({
        description: 'Present on the detail route only.',
      }),
    })
    .openapi({
      description:
        'One fired alert, keyed (rule, resource). Carries resource identifiers only — never credentials or account-identifying secrets.',
    }),
);

const AlertListResponse = registerComponent(
  'InfraAlertList',
  z.object({
    alerts: z.array(Alert),
    nextCursor: z.string().nullable().openapi({
      description: 'Pass back as `cursor` for the next page. Null on the last page.',
    }),
    total: z.number().int().openapi({
      description:
        'Every alert matching the filters, ignoring the page bound. Use this for counts — `alerts.length` is a page size, so a badge derived from it silently reports the limit once a project exceeds it.',
    }),
  }),
);

const coercedInt = z.coerce.number().int().finite();

export const AlertListParamsSchema = z.object({
  status: z.enum(asEnum(INFRA_ALERT_STATUSES)).optional(),
  state: z.enum(asEnum(INFRA_ALARM_STATES)).optional(),
  ruleId: z.string().max(64).optional(),
  resourceKey: z.string().max(512).optional(),
  limit: coercedInt.min(1).max(MAX_INFRA_ALERT_LIST_LIMIT).optional(),
  cursor: z.string().min(1).max(600).optional(),
});

export const AlertStatusRequestSchema = z.object({
  status: z.enum(asEnum(INFRA_ALERT_STATUSES)).openapi({
    description:
      '`resolved` closes it out, `ignored` mutes it through recurrence, `open` reopens it.',
  }),
});
registerComponent('InfraAlertStatusRequest', AlertStatusRequestSchema);

// ── Registrations ──────────────────────────────────────────────────────────

const storeUnavailable = {
  description: 'The infrastructure store is not open on this Hub.',
  content: { 'application/json': { schema: ErrorEnvelope } },
} as const;

const projectNotFound = {
  description: 'Project not found, or the caller cannot see it.',
  content: { 'application/json': { schema: ErrorEnvelope } },
} as const;

const badRequest = {
  description: 'Malformed body or query.',
  content: { 'application/json': { schema: ErrorEnvelope } },
} as const;

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/alert-rules',
  tags: ['Projects'],
  summary: 'List infra alert rules',
  description:
    'Every threshold rule on the project, newest first. Unpaginated: rules are hand-authored plus a per-service default pack, so the population is tens per project.\n\n**Cost:** local SQLite only. No AWS call.',
  request: { params: ProjectIdParam, query: AlertRuleListParamsSchema },
  responses: {
    200: {
      description: 'Rule list. Empty array on a Hub whose infra store never opened.',
      content: { 'application/json': { schema: AlertRuleListResponse } },
    },
    400: badRequest,
    404: projectNotFound,
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/infra/alert-rules',
  tags: ['Projects'],
  summary: 'Create an infra alert rule',
  description:
    'Persists a rule evaluated by Agent Hub’s own poller (decision INFRA-ALERT). Nothing is written to the monitored AWS account: no `PutMetricAlarm`, no SNS topic, no IAM role, and nothing to clean up if the rule is later deleted.\n\nA rule that could never reach ALARM (`datapointsToAlarm` above `evaluationPeriods`) is rejected rather than repaired, so an operator is never handed an alarm that looks armed and is not.',
  request: {
    params: ProjectIdParam,
    body: { content: { 'application/json': { schema: AlertRuleCreateSchema } } },
  },
  responses: {
    201: {
      description: 'Rule created.',
      content: { 'application/json': { schema: AlertRule } },
    },
    400: badRequest,
    404: projectNotFound,
    503: storeUnavailable,
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/infra/alert-rules/{ruleId}',
  tags: ['Projects'],
  summary: 'Update an infra alert rule',
  description:
    'Partial update — absent keys are left alone. The `datapointsToAlarm <= evaluationPeriods` invariant is checked against the merged rule, not the patch, so lowering `evaluationPeriods` alone cannot strand an earlier `datapointsToAlarm`.\n\nExisting alerts keep their state; the next evaluation applies the new threshold.',
  request: {
    params: RuleParams,
    body: { content: { 'application/json': { schema: AlertRuleUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated rule.', content: { 'application/json': { schema: AlertRule } } },
    400: badRequest,
    404: {
      description: 'Project or rule not found.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    503: storeUnavailable,
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/infra/alert-rules/{ruleId}',
  tags: ['Projects'],
  summary: 'Delete an infra alert rule',
  description:
    'Cascades to every alert the rule fired and their transition history — an alert without its rule has no threshold to be read against.\n\nTo stop paging while keeping the incident record, `PUT` the rule with `enabled: false` instead.',
  request: { params: RuleParams },
  responses: {
    204: { description: 'Rule deleted.' },
    404: {
      description: 'Project or rule not found.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    503: storeUnavailable,
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/alerts',
  tags: ['Projects'],
  summary: 'List fired infra alerts',
  description:
    'Most-recently-seen first, keyset-paginated. Filter by lifecycle `status`, alarm `state`, rule or resource.\n\nA resource that has never breached has no row at all — the list is what needs attention, not an inventory with a health column.\n\n**Cost:** local SQLite only. No AWS call.',
  request: { params: ProjectIdParam, query: AlertListParamsSchema },
  responses: {
    200: {
      description: 'Alert page.',
      content: { 'application/json': { schema: AlertListResponse } },
    },
    400: badRequest,
    404: projectNotFound,
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/alerts/{alertId}',
  tags: ['Projects'],
  summary: 'Get one infra alert with its transition history',
  description:
    'The alert plus its recorded transitions, newest first. History is trimmed to a bounded window per alert, so a flapping resource cannot grow it without limit; the aggregate on the alert row (occurrence count, true first and last seen) is the durable record.',
  request: { params: AlertParams },
  responses: {
    200: { description: 'The alert.', content: { 'application/json': { schema: Alert } } },
    404: {
      description: 'Project or alert not found.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    503: storeUnavailable,
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/infra/alerts/{alertId}/status',
  tags: ['Projects'],
  summary: 'Resolve, ignore or reopen an infra alert',
  description:
    'One endpoint for all three moves, because they are one column.\n\n- `resolved` — closed out. A later breach **reopens** it automatically, attributed to `system:recurrence`.\n- `ignored` — muted, and it stays muted through recurrence *and* through recovery. This is the only way to stop a known-bad resource paging on every tick.\n- `open` — reopen a resolved or ignored alert.\n\nThe move is recorded in the alert’s transition history with the acting user as actor, so human and evaluator moves read as one timeline.',
  request: {
    params: AlertParams,
    body: { content: { 'application/json': { schema: AlertStatusRequestSchema } } },
  },
  responses: {
    200: { description: 'Updated alert.', content: { 'application/json': { schema: Alert } } },
    400: badRequest,
    404: {
      description: 'Project or alert not found.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    503: storeUnavailable,
  },
});
