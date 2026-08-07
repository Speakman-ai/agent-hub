/**
 * Every AWS IAM action the infrastructure collectors call, and the glob matcher
 * that decides whether a policy document grants one.
 *
 * This is the source of truth. The customer-managed policy committed under
 * `docs/guides/aws-monitoring-iam/` is checked against it by
 * `infra-iam-policy.test.ts`, so a collector that starts calling a new API adds
 * its action here and the doc test fails until the published policy catches up.
 * An operator who granted exactly what we published then never discovers the
 * gap as an AccessDenied in a background poller nobody is watching.
 *
 * Why not the AWS managed policies:
 *
 *   - `ReadOnlyAccess` is far too much. It carries data-plane reads —
 *     `s3:GetObject`, `dynamodb:GetItem`/`Query`/`Scan`,
 *     `logs:FilterLogEvents`, `rds:Download*` — which means granting it hands a
 *     monitoring integration the ability to read the customer's actual data. A
 *     security-conscious operator refuses that, correctly, and we should not be
 *     asking. {@link INFRA_IAM_FORBIDDEN_ACTIONS} is the machine-checked form
 *     of that promise.
 *   - `ViewOnlyAccess` is too little in two specific ways, both documented in
 *     the published guide: its CloudWatch grant is `Get*`/`List*` only, so
 *     `cloudwatch:DescribeAlarms` is missing, and it carries no `ce:`,
 *     `health:`, `compute-optimizer:` or `servicequotas:` actions at all.
 *
 * Hence a customer-managed policy, versioned and diffable.
 */

/** Bumped whenever the published policy document changes. */
export const INFRA_IAM_POLICY_VERSION = 2;

/**
 * Statement `Sid` per capability in the published policy. Every capability gets
 * its own statement so an operator can delete one block to opt out and read
 * from the guide exactly what stops working — and so the doc test can assert
 * statement-by-statement that the published actions are precisely this
 * manifest, with no wildcard quietly widening the grant.
 */
export const INFRA_IAM_STATEMENT_SIDS: Record<InfraIamCapability, string> = {
  identity: 'AgentHubCallerIdentity',
  inventory: 'AgentHubResourceInventory',
  metrics: 'AgentHubMetricRead',
  alarms: 'AgentHubAlarmRead',
  tags: 'AgentHubTagRead',
  quotas: 'AgentHubQuotaRead',
  cost: 'AgentHubCostExplorerRead',
  health: 'AgentHubHealthRead',
};

/** Capabilities in published-policy statement order. */
export const INFRA_IAM_CAPABILITIES: readonly InfraIamCapability[] = [
  'identity',
  'inventory',
  'metrics',
  'alarms',
  'tags',
  'quotas',
  'cost',
  'health',
];

/**
 * Which collector needs the action. Groups the statements in the published
 * policy, so an operator can delete a whole `Sid` to opt out of a capability
 * and know exactly what stops working.
 */
export type InfraIamCapability =
  | 'identity'
  | 'inventory'
  | 'metrics'
  | 'alarms'
  | 'tags'
  | 'quotas'
  | 'cost'
  | 'health';

export interface InfraIamAction {
  /** IAM action in `service:Action` form, cased as the service authorization reference spells it. */
  action: string;
  capability: InfraIamCapability;
  /** The collector behaviour that breaks without it. */
  why: string;
  /**
   * True when the capability is behind an explicit operator opt-in, so the
   * published policy carries the statement but an operator may drop it. Cost
   * Explorer and Health both bill or gate on a support plan.
   */
  optIn?: boolean;
}

/**
 * The full action set. Ordered by capability so the generated documentation
 * reads in the same order as the policy statements.
 */
export const INFRA_IAM_ACTIONS: readonly InfraIamAction[] = [
  {
    action: 'sts:GetCallerIdentity',
    capability: 'identity',
    why: 'Resolve the account id behind a monitoring profile, and prove the role is assumable before any billed call runs. AWS allows this for every identity and ignores an explicit Deny, so the statement is documentation of what we call rather than a grant that changes anything.',
  },

  // ── Inventory (INFRA-SCOPE hourly sync) ──────────────────────────
  // Describe-first, because ListMetrics omits anything with no datapoint in
  // the past two weeks: it lists *reporting* resources, never existing ones.
  {
    action: 'ec2:DescribeRegions',
    capability: 'inventory',
    why: 'Enumerate the regions a scope may name, bounded and confirmed with the operator rather than swept.',
  },
  {
    action: 'ec2:DescribeInstances',
    capability: 'inventory',
    why: 'EC2 inventory: instance id, type, state and tags for the resource browser and the metric query list.',
  },
  {
    action: 'ec2:DescribeInstanceStatus',
    capability: 'inventory',
    why: 'System and instance status checks, which are the free 1-minute EC2 health signal.',
  },
  {
    action: 'ec2:DescribeVolumes',
    capability: 'inventory',
    why: 'EBS inventory, so volume metrics attach to the instance they belong to.',
  },
  {
    action: 'ec2:DescribeNatGateways',
    capability: 'inventory',
    why: 'NAT Gateway inventory for the networking pack (ErrorPortAllocation is a genuine outage predictor).',
  },
  {
    action: 'ec2:DescribeTags',
    capability: 'inventory',
    why: 'Resolve tags for scope tag filters on resources whose describe response omits them.',
  },
  {
    action: 'ecs:ListClusters',
    capability: 'inventory',
    why: 'ECS cluster enumeration.',
  },
  {
    action: 'ecs:DescribeClusters',
    capability: 'inventory',
    why: 'Cluster settings, including whether Container Insights is on — the UI says which panels are empty because a paid AWS feature is off.',
  },
  {
    action: 'ecs:ListServices',
    capability: 'inventory',
    why: 'ECS service enumeration per cluster.',
  },
  {
    action: 'ecs:DescribeServices',
    capability: 'inventory',
    why: 'Desired vs running task counts and deployment state per service.',
  },
  {
    action: 'ecs:ListAccountSettings',
    capability: 'inventory',
    why: 'Resolve the account-wide Container Insights default. A cluster that was never configured explicitly returns an empty settings list and inherits this value, so without it such a cluster reads as "off" and its paid metrics are never collected.',
  },
  {
    action: 'rds:DescribeDBInstances',
    capability: 'inventory',
    why: 'RDS instance inventory (1-minute metrics, free by default).',
  },
  {
    action: 'rds:DescribeDBClusters',
    capability: 'inventory',
    why: 'Aurora cluster inventory, so writer and reader instances group correctly.',
  },
  {
    action: 'elasticloadbalancing:DescribeLoadBalancers',
    capability: 'inventory',
    why: 'ALB / NLB inventory and the dimension values CloudWatch keys their metrics on.',
  },
  {
    action: 'elasticloadbalancing:DescribeTargetGroups',
    capability: 'inventory',
    why: 'Target-group dimensions for UnHealthyHostCount, which is alarmed per target group.',
  },
  {
    action: 'elasticloadbalancing:DescribeTags',
    capability: 'inventory',
    why: 'Load balancer and target group tags. Separate from the describe calls because, alone among the inventoried services, an ELBv2 describe response carries no tags — so without this a scope tag filter matches nothing and every load balancer loses its Name.',
  },
  {
    action: 'elasticloadbalancing:DescribeTargetHealth',
    capability: 'inventory',
    why: 'Which targets are unhealthy right now, so an alert names the instance rather than only a count.',
  },
  {
    action: 'lambda:ListFunctions',
    capability: 'inventory',
    why: 'Lambda inventory.',
  },
  {
    action: 'lambda:GetFunctionConfiguration',
    capability: 'inventory',
    why: 'Per-function memory, timeout and reserved concurrency, needed to turn raw Duration into a headroom percentage.',
  },
  {
    action: 's3:ListAllMyBuckets',
    capability: 'inventory',
    why: 'Bucket inventory. Account-level, so it cannot be scoped to a resource ARN.',
  },
  {
    action: 's3:GetBucketLocation',
    capability: 'inventory',
    why: 'Which region a bucket lives in — S3 daily storage metrics are only queryable from the bucket region.',
  },
  {
    action: 's3:GetBucketTagging',
    capability: 'inventory',
    why: 'Bucket tags for scope tag filters. Reads tags, never object data.',
  },
  {
    action: 's3:GetMetricsConfiguration',
    capability: 'inventory',
    why: 'The IAM action behind ListBucketMetricsConfigurations: whether a bucket has a CloudWatch metrics configuration, and under which filter ids. S3 request metrics do not exist without one, so this is what makes the paid metrics detected rather than assumed — without it every bucket reads as having none and the request-metric panels go permanently, silently empty.',
  },

  // ── Metrics (INFRA-COLLECT) ──────────────────────────────────────
  {
    action: 'cloudwatch:GetMetricData',
    capability: 'metrics',
    why: 'The primary collector call: up to 500 metric queries per request. Always billed, never in the free tier.',
  },
  {
    action: 'cloudwatch:GetMetricStatistics',
    capability: 'metrics',
    why: 'Low-cardinality fallback for deployments that opt into cost-minimal mode (covered by the free tier, one metric per call).',
  },
  {
    action: 'cloudwatch:ListMetrics',
    capability: 'metrics',
    why: 'Prune query lists to resources currently reporting, via RecentlyActive=PT3H. Never used as an inventory source.',
  },

  // ── Alarm parity (INFRA-ALERT) ───────────────────────────────────
  {
    action: 'cloudwatch:DescribeAlarms',
    capability: 'alarms',
    why: "Show the customer's own CloudWatch alarm state beside ours. Operators diff the two, and this is the action ViewOnlyAccess omits.",
  },

  // ── Tags (INFRA-SCOPE tag filters) ───────────────────────────────
  {
    action: 'tag:GetResources',
    capability: 'tags',
    why: 'Resolve a scope tag filter to resource ARNs in one call instead of per-service tag reads.',
  },

  // ── Service quotas ───────────────────────────────────────────────
  {
    action: 'servicequotas:ListServiceQuotas',
    capability: 'quotas',
    why: 'Quota values to compare against AWS/Usage metrics, so headroom is a percentage rather than a raw number.',
  },
  {
    action: 'servicequotas:GetServiceQuota',
    capability: 'quotas',
    why: 'Single-quota reads for the applied (customer-adjusted) value, which differs from the default.',
  },

  // ── Cost Explorer (opt-in, INFRA-COST) ───────────────────────────
  {
    action: 'ce:GetCostAndUsage',
    capability: 'cost',
    optIn: true,
    why: 'Spend trends. $0.01 per request with every pagination page counted and no free tier, so it is polled at most 3x/day behind a cache.',
  },

  // ── Health (opt-in, needs Business or Enterprise Support) ─────────
  {
    action: 'health:DescribeEvents',
    capability: 'health',
    optIn: true,
    why: 'AWS-side incidents and scheduled changes affecting the account. The Health API needs a Business Support+, Enterprise Support or Unified Operations plan; without one it raises SubscriptionRequiredException, not AccessDenied, so the grant itself is never the thing that failed.',
  },
  {
    action: 'health:DescribeEventDetails',
    capability: 'health',
    optIn: true,
    why: 'Full description of a Health event surfaced in an alert.',
  },
  {
    action: 'health:DescribeAffectedEntities',
    capability: 'health',
    optIn: true,
    why: 'Which of the account resources a Health event actually touches.',
  },
];

/**
 * Data-plane reads a monitoring policy must never grant, and the concrete
 * reason `ReadOnlyAccess` is the wrong answer — every one of these is in it.
 *
 * Patterns, matched with {@link iamActionMatches}, so a policy that reached
 * them through a wildcard (`s3:Get*`, `rds:*`) fails the same way an explicit
 * grant would.
 */
export const INFRA_IAM_FORBIDDEN_ACTIONS: readonly string[] = [
  's3:GetObject',
  's3:GetObjectVersion',
  'dynamodb:GetItem',
  'dynamodb:BatchGetItem',
  'dynamodb:Query',
  'dynamodb:Scan',
  'logs:FilterLogEvents',
  'logs:GetLogEvents',
  'rds:DownloadDBLogFilePortion',
  'rds:DownloadCompleteDBLogFile',
  'secretsmanager:GetSecretValue',
  'ssm:GetParameter',
  'ssm:GetParameters',
  'kms:Decrypt',
  'sqs:ReceiveMessage',
  'ec2:GetConsoleOutput',
  'ec2:GetConsoleScreenshot',
];

/**
 * Does an IAM action pattern from a policy grant a concrete action?
 *
 * IAM action matching is case-insensitive and supports `*` (any run) and `?`
 * (one character). Implemented here rather than with a naive `startsWith` on
 * the prefix because the interesting cases are exactly the wildcard ones: the
 * point of the forbidden-action check is that `s3:Get*` must register as
 * granting `s3:GetObject`.
 */
export function iamActionMatches(pattern: string, action: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(action);
}

/** Actions the given capability set needs, in manifest order. */
export function infraIamActionsFor(
  capabilities: readonly InfraIamCapability[],
): readonly InfraIamAction[] {
  const wanted = new Set(capabilities);
  return INFRA_IAM_ACTIONS.filter((a) => wanted.has(a.capability));
}

/** Every action the collectors call, including opt-in capabilities. */
export function allInfraIamActions(): string[] {
  return INFRA_IAM_ACTIONS.map((a) => a.action);
}
