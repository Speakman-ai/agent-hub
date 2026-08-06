/**
 * In-process AWS credential resolution for a project profile.
 *
 * Decision INFRA-CRED: infrastructure monitoring reads CloudWatch from inside
 * the Hub process, not by spawning the `aws` CLI. A collector tick issues
 * hundreds of API calls; paying process startup and ~250 MB RSS per call is
 * not an option. The CLI-spawn path stays for `sts get-caller-identity` and
 * the interactive SSO login button, where a human is waiting anyway.
 *
 * What this module resolves against, and what it deliberately does not:
 *
 *   - It reads **only** the project-scoped ini files `writeProjectAwsFiles()`
 *     renders under `<dataDir>/project-aws-config/<projectId>/`. Never the
 *     ambient provider chain, never `~/.aws`, never the Hub's own
 *     `AWS_ACCESS_KEY_ID` / `AWS_PROFILE`. A profile that is missing or
 *     unresolvable is an error, not a silent fallback to whatever identity the
 *     host happens to carry: falling back would read a *different* AWS account
 *     than the operator selected, and bill it.
 *   - A `role` profile still reaches the Hub's ambient identity, but only
 *     through the `credential_source` its stanza names. That is an explicit
 *     operator-authored origin, which is the whole point of the role arm.
 *
 * SSO profiles resolve for **interactive** callers only. The SSO token cache
 * is keyed off `$HOME/.aws/sso/cache` and `AWS_CONFIG_FILE` relocates only the
 * profile config, never the cache; a background poller has no HOME to
 * attribute a token to and no human to re-run `aws sso login` when it expires.
 * Handing one to a background caller therefore fails fast with
 * {@link MonitoringProfileRequiredError} rather than working for an hour and
 * then going dark. Even for interactive callers, SSO resolves against the Hub
 * process's own token cache, which is not the per-user HOME the AWS settings
 * module probes: see the wiki page
 * `aws-sso-status-home-asymmetry-and-the-union-probe`.
 */

import { createHash } from 'crypto';
import { fromIni } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { findProject } from '../project-model.js';
import { writeProjectAwsFiles } from '../project-aws-config-file.js';
import { getProjectAwsSsoProfiles } from '../project-aws-spawn.js';
import {
  isProjectAwsSsoProfile,
  resolveAmbientCredentialSource,
  ProjectAwsProfileValidationError,
  type ProjectAwsProfile,
  type ProjectAwsSsoProfilesMap,
} from '../project-aws-profiles.js';

/** Who is asking. Decides whether an SSO profile is acceptable. */
export type AwsCredentialUse = 'interactive' | 'background';

export interface ResolveProjectAwsCredentialsOpts {
  /** Defaults to `background`, the stricter arm, so a forgotten flag fails loudly. */
  use?: AwsCredentialUse;
}

/**
 * Why a project cannot be monitored unattended. Both arms are fixed by the
 * same operator action, but the Infrastructure module words the empty state
 * differently for each, so the distinction is carried on the error rather than
 * inferred from a message string.
 */
export type MonitoringProfileProblem = 'not_designated' | 'interactive_sso';

/**
 * Background work asked for credentials it cannot have. The fix is an operator
 * action (designate a static or assume-role monitoring profile), not a retry,
 * so this is typed separately from a generic credential failure and carries
 * what the UI needs for its empty state.
 */
export class MonitoringProfileRequiredError extends Error {
  readonly statusCode = 409;
  readonly code = 'monitoring_profile_required';
  readonly projectId: string;
  /** Null when nothing is designated at all. */
  readonly profileName: string | null;
  readonly reason: MonitoringProfileProblem;

  constructor(projectId: string, profileName: string | null, reason: MonitoringProfileProblem) {
    super(
      reason === 'not_designated'
        ? profileName
          ? `Project "${projectId}" designates AWS monitoring profile "${profileName}", which is no longer a configured profile. Background collection spends AWS API budget unattended, so it runs only against a profile that still exists.`
          : `Project "${projectId}" has no designated AWS monitoring profile. Background collection spends AWS API budget unattended, so it runs only against a profile an operator explicitly designated.`
        : `AWS profile "${profileName}" on project "${projectId}" is an IAM Identity Center (SSO) profile. ` +
            'Its token cache is keyed to a user\'s HOME and expires unattended, with no one to re-run "aws sso login", ' +
            'so background collection would stop within hours. Designate a static or assume-role monitoring profile instead.',
    );
    this.name = 'MonitoringProfileRequiredError';
    this.projectId = projectId;
    this.profileName = profileName;
    this.reason = reason;
  }
}

/**
 * Refresh this long before `expiration`. Matches the SDK's own 5-minute
 * credential-expiry window, so a call that passes our freshness check is not
 * then rejected downstream as too close to expiry.
 */
const EXPIRY_SKEW_MS = 5 * 60_000;

/**
 * Soft TTL for credentials that carry no `expiration` (static keys). They do
 * not rotate on their own, and a profile edit already invalidates via the
 * fingerprint below; this only bounds how long an out-of-band rewrite of the
 * ini files (a spawn, a hand edit) can go unnoticed.
 */
const NON_EXPIRING_TTL_MS = 15 * 60_000;

interface CacheEntry {
  /** Hash of the rendered profile set, so an edit invalidates with no explicit call. */
  fingerprint: string;
  provider: AwsCredentialIdentityProvider;
  credentials: AwsCredentialIdentity | null;
  /** Wall-clock ms after which `credentials` must be re-resolved. */
  freshUntil: number;
  /** Dedupes concurrent refreshes; a collector tick opens many clients at once. */
  inflight: Promise<AwsCredentialIdentity> | null;
}

/** Project ids and profile names are slug-shaped, so NUL cannot collide. */
const KEY_SEPARATOR = '\u0000';
const cache = new Map<string, CacheEntry>();

function cacheKey(projectId: string, profileName: string): string {
  return `${projectId}${KEY_SEPARATOR}${profileName}`;
}

/**
 * Hash rather than store the stanzas: a static profile carries a secret access
 * key, and there is no reason to hold a second copy of it in a cache that
 * outlives the request. The whole set is hashed rather than the selected
 * stanza, so a role profile chained via `source_profile` invalidates when its
 * source changes. The ambient credential source is folded in because it
 * decides what a role profile naming no origin renders as.
 */
function fingerprintProfiles(profiles: ProjectAwsSsoProfilesMap): string {
  return createHash('sha256')
    .update(JSON.stringify(profiles))
    .update(KEY_SEPARATOR)
    .update(resolveAmbientCredentialSource(process.env))
    .digest('hex');
}

interface ResolvedProfile {
  profile: ProjectAwsProfile;
  profiles: ProjectAwsSsoProfilesMap;
}

function lookupProfile(projectId: string, profileName: string): ResolvedProfile {
  const project = findProject(projectId);
  if (!project) {
    throw new ProjectAwsProfileValidationError(`unknown project "${projectId}"`);
  }
  const profiles = getProjectAwsSsoProfiles(project);
  const profile = profiles[profileName];
  if (!profile) {
    throw new ProjectAwsProfileValidationError(
      `unknown AWS profile "${profileName}" on project "${projectId}" - configured: ${
        Object.keys(profiles).join(', ') || '(none)'
      }`,
    );
  }
  return { profile, profiles };
}

function assertUsable(
  projectId: string,
  profileName: string,
  profile: ProjectAwsProfile,
  use: AwsCredentialUse,
): void {
  if (use === 'background' && isProjectAwsSsoProfile(profile)) {
    throw new MonitoringProfileRequiredError(projectId, profileName, 'interactive_sso');
  }
}

function entryFor(
  projectId: string,
  profileName: string,
  profiles: ProjectAwsSsoProfilesMap,
): CacheEntry {
  const key = cacheKey(projectId, profileName);
  const fingerprint = fingerprintProfiles(profiles);
  const existing = cache.get(key);
  if (existing && existing.fingerprint === fingerprint) return existing;

  // Rendered on entry creation, not per call: the two `writeFileSync` calls
  // stay off the hot path while the files are still guaranteed to exist for a
  // project that has never had a spawn. Every profile is written, not just the
  // selected one, because a role profile may chain via `source_profile`.
  const files = writeProjectAwsFiles(projectId, profiles);
  const created: CacheEntry = {
    fingerprint,
    provider: fromIni({
      profile: profileName,
      filepath: files.credentialsPath,
      configFilepath: files.configPath,
      // The shared-ini loader memoizes file contents process-wide by path.
      // Without this, a rewritten ini would keep resolving to the previous
      // contents for the life of the process.
      ignoreCache: true,
    }),
    credentials: null,
    freshUntil: 0,
    inflight: null,
  };
  cache.set(key, created);
  return created;
}

function freshUntilFor(credentials: AwsCredentialIdentity, now: number): number {
  const expiration = credentials.expiration?.getTime();
  if (expiration === undefined || Number.isNaN(expiration)) return now + NON_EXPIRING_TTL_MS;
  return expiration - EXPIRY_SKEW_MS;
}

async function loadCredentials(
  projectId: string,
  profileName: string,
  use: AwsCredentialUse,
): Promise<AwsCredentialIdentity> {
  // Re-read the project on every call: the profile may have been edited, or
  // the project deleted, since the provider was handed out.
  const { profiles, profile } = lookupProfile(projectId, profileName);
  assertUsable(projectId, profileName, profile, use);

  const entry = entryFor(projectId, profileName, profiles);
  if (entry.credentials && Date.now() < entry.freshUntil) return entry.credentials;
  if (entry.inflight) return entry.inflight;

  const inflight = entry
    .provider()
    .then((credentials) => {
      entry.credentials = credentials;
      entry.freshUntil = freshUntilFor(credentials, Date.now());
      entry.inflight = null;
      return credentials;
    })
    .catch((err: unknown) => {
      // Drop the stale identity too: a refresh failure means the cached one is
      // at or past expiry, and returning it would only fail at the API edge
      // with a less useful message.
      entry.credentials = null;
      entry.freshUntil = 0;
      entry.inflight = null;
      throw err;
    });
  entry.inflight = inflight;
  return inflight;
}

/**
 * Credential provider for one project profile, backed by that project's ini
 * files and cached per `(projectId, profileName)`.
 *
 * The returned function is a facade over the cache rather than a snapshot of
 * it: every call re-checks the project, the profile and the expiry, so a
 * caller may hold onto it for the life of a client and still see an
 * invalidation. Validation also runs eagerly here, so a bad profile name
 * surfaces at the call site instead of at the first AWS request.
 */
export function resolveProjectAwsCredentials(
  projectId: string,
  profileName: string,
  opts: ResolveProjectAwsCredentialsOpts = {},
): AwsCredentialIdentityProvider {
  const use = opts.use ?? 'background';
  const { profile } = lookupProfile(projectId, profileName);
  assertUsable(projectId, profileName, profile, use);
  return () => loadCredentials(projectId, profileName, use);
}

/**
 * The region a profile's stanza names. An AWS SDK client needs a region as
 * well as credentials, and taking it from the profile keeps the SDK path
 * pointed at the same region a `--profile` CLI invocation would use, rather
 * than at whatever `AWS_REGION` the Hub process happens to carry.
 */
export function getProjectAwsProfileRegion(projectId: string, profileName: string): string {
  return lookupProfile(projectId, profileName).profile.region;
}

/**
 * Drop cached providers and credentials.
 *
 * Called when `PUT /aws-profiles` rewrites the ini files. The fingerprint
 * check would catch an edited profile set on the next call anyway, but the
 * explicit clear also drops the resolved credentials of an unchanged profile
 * whose upstream role or key was rotated in the same operator action.
 *
 * Both arguments omitted clears everything; `projectId` alone clears one
 * project.
 */
export function invalidateProjectAwsCredentials(projectId?: string, profileName?: string): void {
  if (projectId === undefined) {
    cache.clear();
    return;
  }
  if (profileName !== undefined) {
    cache.delete(cacheKey(projectId, profileName));
    return;
  }
  const prefix = `${projectId}${KEY_SEPARATOR}`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
