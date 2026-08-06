/**
 * The external ID Agent Hub presents when it assumes a project's AWS role.
 *
 * AWS's confused-deputy guidance is explicit that the *third party* doing the
 * assuming (us) generates the external ID, that it is unique per customer, and
 * that the customer cannot choose it. That last clause is the whole security
 * property, not a nicety: the Hub holds one ambient identity and assumes roles
 * on behalf of every project on the box. If an operator of project B could type
 * the external ID field, they could point a role profile at another tenant's
 * monitoring role ARN and supply that tenant's external ID — and the trust
 * policy, which only ever sees the Hub's principal plus a matching string,
 * would let them in. A value B can never author is what keeps that door shut.
 *
 * So the field is Hub-owned end to end: minted here on first use, persisted on
 * the project record, stamped onto every role profile at save time, and
 * returned read-only to the editor. Client input is discarded, not rejected —
 * a save that round-trips a stale value should not 400.
 */
import { randomUUID } from 'crypto';
import type { ProjectAwsSsoProfilesMap } from './project-aws-profiles.js';
import { isProjectAwsRoleProfile } from './project-aws-profiles.js';

/**
 * Prefix on every generated value so an external ID is self-identifying in a
 * customer's trust policy and in CloudTrail, where it sits next to strings from
 * every other vendor they have onboarded.
 */
export const PROJECT_AWS_EXTERNAL_ID_PREFIX = 'agent-hub-';

/**
 * Shape of the generated value. AWS allows 2–1224 characters matching
 * `[\w+=,.@:\/-]*`; a prefixed UUID is comfortably inside that and carries 122
 * bits of entropy, which is the part that matters — a guessable external ID is
 * the same as no external ID.
 */
export const PROJECT_AWS_EXTERNAL_ID_RE = /^agent-hub-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Project fields this module reads and writes. */
export interface ProjectWithAwsExternalId {
  awsExternalId?: string;
  [key: string]: unknown;
}

export function generateProjectAwsExternalId(): string {
  return `${PROJECT_AWS_EXTERNAL_ID_PREFIX}${randomUUID()}`;
}

/**
 * The project's external ID, minting one on first use.
 *
 * `created` tells the caller whether the project record changed, so a read path
 * can persist a freshly minted id without writing `projects.json` on every GET.
 * Minting lazily rather than at project creation means existing projects pick
 * one up the first time anyone opens the AWS settings module, with no migration.
 */
export function ensureProjectAwsExternalId(project: ProjectWithAwsExternalId): {
  externalId: string;
  created: boolean;
} {
  const existing = typeof project.awsExternalId === 'string' ? project.awsExternalId.trim() : '';
  if (existing) return { externalId: existing, created: false };
  const externalId = generateProjectAwsExternalId();
  project.awsExternalId = externalId;
  return { externalId, created: true };
}

/**
 * Force `external_id` onto every role profile, discarding whatever the client
 * sent. Returns a new map; the input is left alone so validation output stays
 * comparable in tests.
 *
 * Every role profile is stamped, not just cross-account ones, because the Hub
 * cannot tell from a role ARN alone whether the trust policy carries an
 * `sts:ExternalId` condition. Supplying an external ID to a role that does not
 * require one is inert — the condition simply is not there to fail — so the
 * uniform rule costs nothing and removes a per-profile judgement call.
 */
export function stampProjectAwsExternalId(
  profiles: ProjectAwsSsoProfilesMap,
  externalId: string,
): ProjectAwsSsoProfilesMap {
  const out: ProjectAwsSsoProfilesMap = {};
  for (const [name, profile] of Object.entries(profiles)) {
    out[name] = isProjectAwsRoleProfile(profile)
      ? { ...profile, external_id: externalId }
      : profile;
  }
  return out;
}
