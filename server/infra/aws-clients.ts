/**
 * Per-project AWS SDK clients for infrastructure monitoring.
 *
 * This is the seam every infra collector goes through, and the reason
 * `aws-credentials.ts` exists: a client built here carries a credential
 * provider scoped to one project profile, so no collector can accidentally
 * read (and bill) an account other than the one the operator designated.
 * Nothing here spawns the `aws` CLI.
 *
 * Two things are cached, for different reasons:
 *
 *   - **Credentials**, in `aws-credentials.ts`, so a tick that opens many
 *     clients performs one STS round trip rather than one per client.
 *   - **Clients**, here, so the SDK's connection pool is reused across ticks.
 *     A `CloudWatchClient` holds sockets; constructing one per call would
 *     re-handshake TLS on every metric read. Keyed by
 *     `(project, profile, region, use)` — see {@link clientKey} for why `use`
 *     is load-bearing rather than incidental.
 *
 * The client cache holds the credential *facade*, not resolved credentials, so
 * an invalidation in the credential layer is observed by clients that were
 * built before it. `invalidateProjectAwsAccess()` still tears clients down as
 * well, because a profile edit can change the region a client was pinned to,
 * and a region is baked into the client at construction.
 */

import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECSClient } from '@aws-sdk/client-ecs';
import { findProject } from '../project-model.js';
import { getProjectAwsMonitoringProfile, getProjectAwsSsoProfiles } from '../project-aws-spawn.js';
import {
  resolveProjectAwsMonitoringProfile,
  isProjectAwsSsoProfile,
  ProjectAwsProfileValidationError,
} from '../project-aws-profiles.js';
import {
  resolveProjectAwsCredentials,
  invalidateProjectAwsCredentials,
  getProjectAwsProfileRegion,
  MonitoringProfileRequiredError,
  type AwsCredentialUse,
  type MonitoringProfileProblem,
} from './aws-credentials.js';

export interface ProjectAwsClientOpts {
  /** Defaults to the project's designated monitoring profile. */
  profileName?: string;
  /** Defaults to the region the profile's own stanza names. */
  region?: string;
  /** Defaults to `background`; see `aws-credentials.ts`. */
  use?: AwsCredentialUse;
}

/**
 * The profile background collection runs as, or a typed refusal.
 *
 * There is deliberately no fallback to "the only profile configured": a
 * monitoring designation is an operator saying "spend AWS API budget on this
 * account unattended", and inferring that from a project that happens to have
 * one profile would start billing someone who never asked. See
 * `resolveProjectAwsMonitoringProfile`.
 */
export function requireProjectMonitoringProfile(projectId: string): string {
  const project = findProject(projectId);
  if (!project) {
    throw new ProjectAwsProfileValidationError(`unknown project "${projectId}"`);
  }
  const profiles = getProjectAwsSsoProfiles(project);
  const designated = getProjectAwsMonitoringProfile(project);
  const resolved = resolveProjectAwsMonitoringProfile(profiles, designated);
  if (resolved) return resolved;

  // `resolveProjectAwsMonitoringProfile` returns null for three different
  // situations, and they are not the same problem to an operator, so re-derive
  // which one it was instead of reporting all three as "nothing designated".
  //
  // The SSO arm is reachable despite `validateProjectAwsMonitoringProfile`
  // rejecting an SSO designation at save time: a profile can be edited from
  // static or role to SSO after it was designated, and `projects.json` can be
  // hand-edited. That is precisely the case worth naming, because the fix is
  // "this profile cannot run unattended" rather than "you never picked one".
  const designatedProfile = designated ? profiles[designated] : undefined;
  const reason: MonitoringProfileProblem =
    designatedProfile && isProjectAwsSsoProfile(designatedProfile)
      ? 'interactive_sso'
      : 'not_designated';
  throw new MonitoringProfileRequiredError(projectId, designated, reason);
}

const KEY_SEPARATOR = '\u0000';

/** Anything with the one method {@link destroyProjectAwsClients} needs. */
interface DestroyableClient {
  destroy(): void;
}

const cloudWatchClients = new Map<string, CloudWatchClient>();
const ec2Clients = new Map<string, EC2Client>();
const ecsClients = new Map<string, ECSClient>();

/**
 * Every client cache, so adding a service means adding one map here rather than
 * remembering to extend the teardown loop. A cache missed by
 * `destroyProjectAwsClients` leaks sockets and, worse, survives a profile edit
 * still pinned to the region it was built for.
 */
const clientCaches: Array<Map<string, DestroyableClient>> = [
  cloudWatchClients,
  ec2Clients,
  ecsClients,
];

/**
 * `use` is part of the key, not just a construction detail.
 *
 * A client is built around a credential provider that closed over its `use`,
 * and only the `background` provider refuses an SSO profile. Keying without
 * `use` would let an interactive client built first be handed back to a
 * background caller for the same project/profile/region, which is exactly the
 * unattended-SSO collection the split exists to prevent.
 */
function clientKey(
  projectId: string,
  profileName: string,
  region: string,
  use: AwsCredentialUse,
): string {
  return [projectId, profileName, region, use].join(KEY_SEPARATOR);
}

interface ResolvedTarget {
  profileName: string;
  region: string;
  use: AwsCredentialUse;
}

function resolveTarget(projectId: string, opts: ProjectAwsClientOpts): ResolvedTarget {
  const profileName = opts.profileName ?? requireProjectMonitoringProfile(projectId);
  return {
    profileName,
    region: opts.region ?? getProjectAwsProfileRegion(projectId, profileName),
    use: opts.use ?? 'background',
  };
}

/**
 * A CloudWatch client bound to one project profile and region.
 *
 * Throws {@link MonitoringProfileRequiredError} when the project has no usable
 * monitoring profile, so a collector fails at construction with an actionable
 * error rather than at the first `GetMetricData` with an AWS auth failure.
 */
export function getProjectCloudWatchClient(
  projectId: string,
  opts: ProjectAwsClientOpts = {},
): CloudWatchClient {
  const { profileName, region, use } = resolveTarget(projectId, opts);
  const key = clientKey(projectId, profileName, region, use);
  const existing = cloudWatchClients.get(key);
  if (existing) return existing;

  const client = new CloudWatchClient({
    region,
    // The facade, not a snapshot: the client re-enters the credential cache on
    // every signed request, so a rotated profile is picked up without
    // rebuilding the client.
    credentials: resolveProjectAwsCredentials(projectId, profileName, { use }),
  });
  cloudWatchClients.set(key, client);
  return client;
}

/**
 * An EC2 client bound to one project profile and region.
 *
 * Inventory sync (decision INFRA-SCOPE) is the caller: `DescribeInstances` is
 * the authoritative list of *existing* resources, where `ListMetrics` only ever
 * reports the ones that emitted a datapoint in the past two weeks. Same
 * refusal semantics as the CloudWatch client — an unusable monitoring profile
 * throws {@link MonitoringProfileRequiredError} at construction.
 */
export function getProjectEc2Client(projectId: string, opts: ProjectAwsClientOpts = {}): EC2Client {
  const { profileName, region, use } = resolveTarget(projectId, opts);
  const key = clientKey(projectId, profileName, region, use);
  const existing = ec2Clients.get(key);
  if (existing) return existing;

  const client = new EC2Client({
    region,
    credentials: resolveProjectAwsCredentials(projectId, profileName, { use }),
  });
  ec2Clients.set(key, client);
  return client;
}

/**
 * An ECS client bound to one project profile and region.
 *
 * Inventory sync calls `ListClusters` / `DescribeClusters` / `ListServices` /
 * `DescribeServices` through it. `DescribeClusters` is also where the Container
 * Insights setting comes from, which decides whether the paid
 * `ECS/ContainerInsights` metrics are collected at all — so this client is on
 * the path that keeps a disabled feature from being billed for.
 */
export function getProjectEcsClient(projectId: string, opts: ProjectAwsClientOpts = {}): ECSClient {
  const { profileName, region, use } = resolveTarget(projectId, opts);
  const key = clientKey(projectId, profileName, region, use);
  const existing = ecsClients.get(key);
  if (existing) return existing;

  const client = new ECSClient({
    region,
    credentials: resolveProjectAwsCredentials(projectId, profileName, { use }),
  });
  ecsClients.set(key, client);
  return client;
}

/** Destroy and drop cached clients. Omit `projectId` to drop all of them. */
export function destroyProjectAwsClients(projectId?: string): void {
  const prefix = projectId === undefined ? null : `${projectId}${KEY_SEPARATOR}`;
  for (const cache of clientCaches) {
    for (const [key, client] of cache) {
      if (prefix !== null && !key.startsWith(prefix)) continue;
      try {
        client.destroy();
      } catch {
        /* a client that cannot be destroyed is still one we are done with */
      }
      cache.delete(key);
    }
  }
}

/**
 * Forget everything cached about a project's AWS access: credentials and the
 * clients holding them.
 *
 * Single entry point on purpose. Callers that change what a profile means (the
 * profile editor) should not have to know that credentials and clients are
 * cached in two layers, and a caller that clears only one of them leaves a
 * client pinned to the old region.
 */
export function invalidateProjectAwsAccess(projectId?: string): void {
  invalidateProjectAwsCredentials(projectId);
  destroyProjectAwsClients(projectId);
}

export interface MonitoringAccessProbe {
  /**
   * The profile the probe used. On a refusal this is the profile the operator
   * designated (so the UI can name it), which is null only when nothing was
   * designated at all.
   */
  profile: string | null;
  /** Null when resolution failed before a region was determined. */
  region: string | null;
  /** True when the credentials resolved and CloudWatch answered. */
  reachable: boolean;
  /** Machine-readable failure cause; absent when reachable. */
  code?: string;
  /** Why a monitoring profile is unusable, when that is the failure. */
  reason?: MonitoringProfileProblem;
  /** Operator-facing failure detail; absent when reachable. */
  error?: string;
}

/**
 * Can this project actually be monitored right now?
 *
 * `DescribeAlarms` with `MaxRecords: 1` is the probe because it exercises the
 * whole path a collector depends on: profile resolution, credential
 * resolution, signing, regional endpoint reachability, and the `cloudwatch:`
 * IAM grant.
 *
 * On cost, precisely: `DescribeAlarms` is a `Requests`-usage-type call, so it
 * counts against the AWS Free Tier allowance of 1 million CloudWatch API
 * requests per month and is billed per 1,000 requests *beyond* that allowance.
 * It is not free in the unconditional sense — it is merely not one of the
 * three operations (`GetMetricData`, `GetInsightRuleReport`,
 * `GetMetricWidgetImage`) that AWS charges from the first call. This function
 * issues exactly one request per invocation and caches nothing, so the cost is
 * a direct function of how often a caller invokes it; poll it when a view
 * opens, not on a tight timer. `GetMetricData` is deliberately never used for
 * a status check.
 */
export async function probeProjectMonitoringAccess(
  projectId: string,
  opts: ProjectAwsClientOpts = {},
): Promise<MonitoringAccessProbe> {
  let profile: string | null = null;
  let region: string | null = null;
  try {
    const target = resolveTarget(projectId, opts);
    profile = target.profileName;
    region = target.region;
    const client = getProjectCloudWatchClient(projectId, target);
    await client.send(new DescribeAlarmsCommand({ MaxRecords: 1 }));
    return { profile, region, reachable: true };
  } catch (err) {
    if (err instanceof MonitoringProfileRequiredError) {
      return {
        profile: err.profileName,
        region,
        reachable: false,
        code: err.code,
        reason: err.reason,
        error: err.message,
      };
    }
    const e = err as { name?: string; message?: string };
    return {
      profile,
      region,
      reachable: false,
      code: e.name || 'unknown_error',
      error: e.message || String(err),
    };
  }
}
