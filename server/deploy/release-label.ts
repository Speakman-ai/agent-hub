/**
 * release-label.ts — user-facing label for a deployment / release.
 *
 * A deployment is keyed internally by its git `ref`, which for production
 * deploys is a resolved commit SHA. Showing a raw 40-char SHA (or a truncated
 * hash) to customers in a release-notification email is noise: when the deploy
 * corresponds to a published GitHub release, they want the version number
 * (e.g. `v2.31.18`), not `f27b422f...`.
 *
 * This module resolves the best available label, preferring a release version
 * over the hash, in this order:
 *
 *   1. `meta.releaseVersion` / `meta.releaseTag` — an explicit version recorded
 *      on the deployment (e.g. by a release step). Wins over everything.
 *   2. A tag-shaped `ref` — `refs/tags/v1.2.3` → `v1.2.3`, or a bare
 *      version-like tag such as `v1.2.3` / `1.2.3`.
 *   3. Fall back to the short commit hash (first 12 chars) when no version is
 *      available — the "(if available)" clause.
 *
 * Everything here is PURE (deployment fields in → label out) so it is trivially
 * unit-testable without a DB, a runner, or the network.
 */

/** Fields this module reads off a deployment row. */
export interface ReleaseLabelDeployment {
  ref: string;
  /** Free-form JSON stash; may carry `releaseVersion` / `releaseTag`. */
  meta?: string | null;
}

const REFS_TAGS_PREFIX = 'refs/tags/';
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;
// Version-like tag: optional leading `v`, then `MAJOR.MINOR(.PATCH)` plus an
// optional prerelease / build suffix (e.g. `v1.2.3`, `2.31.18`, `v1.2.0-rc.1`).
const VERSION_TAG_RE = /^v?\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.-]+)?$/;

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function versionFromMeta(meta: string | null | undefined): string | null {
  if (!meta) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return firstNonEmptyString(record.releaseVersion, record.releaseTag);
}

/** Strip a `refs/tags/` prefix, leaving a bare tag name. */
function stripRefsTags(ref: string): string {
  return ref.startsWith(REFS_TAGS_PREFIX) ? ref.slice(REFS_TAGS_PREFIX.length) : ref;
}

function versionFromRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  // An explicit tag ref is always a version, even if the tag name is unusual.
  if (trimmed.startsWith(REFS_TAGS_PREFIX)) {
    const tag = stripRefsTags(trimmed).trim();
    return tag || null;
  }
  // A bare ref only counts as a version when it looks like one — otherwise it
  // is a branch name or a commit SHA.
  return VERSION_TAG_RE.test(trimmed) ? trimmed : null;
}

function shortHash(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return '-';
  // Only truncate hex SHAs; a branch name or unusual ref is shown verbatim.
  if (HEX_SHA_RE.test(trimmed) && trimmed.length > 12) return trimmed.slice(0, 12);
  return trimmed;
}

export interface ReleaseLabel {
  /** The release version when one is available (tag / meta), else null. */
  version: string | null;
  /** The best user-facing label: the version when available, else the short ref. */
  label: string;
}

/**
 * Resolve the best user-facing release label for a deployment, preferring a
 * GitHub release version over the commit hash. See the module header for the
 * resolution order.
 */
export function deploymentReleaseLabel(deployment: ReleaseLabelDeployment): ReleaseLabel {
  const version = versionFromMeta(deployment.meta) ?? versionFromRef(deployment.ref);
  if (version) return { version, label: version };
  return { version: null, label: shortHash(deployment.ref) };
}
