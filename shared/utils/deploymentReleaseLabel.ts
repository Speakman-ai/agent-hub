/**
 * deploymentReleaseLabel.ts — the single, canonical user-facing label for a
 * deployment / release, shared by server (release-notification emails), the web
 * client, and mobile. A deployment is keyed internally by its git `ref`, which
 * for production deploys is a resolved commit SHA. Showing a raw 40-char SHA is
 * noise: when the deploy corresponds to a published release, users want the
 * version (e.g. `v2.31.18`), not `f27b422f...`.
 *
 * This module is the ONE place the resolution order lives — server, web, and
 * mobile all import it, so their labels can never drift:
 *
 *   1. `meta.releaseVersion` / `meta.releaseTag` — an explicit version recorded
 *      on the deployment (e.g. captured from a release workflow step). Wins.
 *   2. A version-like tag — `refs/tags/v1.2.3` → `v1.2.3`, or a bare
 *      version-like ref such as `v1.2.3` / `2.31.18` / `v1.2.0-rc.1`.
 *   3. Fall back to a short display of the ref: strip a `refs/tags/` prefix, and
 *      truncate a hex commit SHA to 12 chars — the "(if available)" clause.
 *
 * Version-likeness is required for BOTH tag refs and bare refs. A `refs/tags/`
 * prefix alone does not make something a `version`: `refs/tags/nightly` yields
 * `{ version: null, label: 'nightly' }` — the tag name is a fine LABEL, but it
 * is not reported as a release version. This keeps the `version` field honest
 * (only genuine version numbers) while still rendering a clean label.
 *
 * Everything here is PURE (deployment fields in → label out) so it is trivially
 * unit-testable without a DB, a runner, or the network.
 */

/** Fields this module reads off a deployment row / DTO. */
export interface ReleaseLabelDeployment {
  ref?: string | null;
  /**
   * Free-form metadata that may carry `releaseVersion` / `releaseTag`. The
   * server stores this as a JSON string; the client/mobile deployment DTO
   * returns it already parsed — both shapes are accepted.
   */
  meta?: string | Record<string, unknown> | null;
  /** Optional fallback id when a deployment has no ref. */
  id?: string | null;
}

export interface ReleaseLabel {
  /** The release version when one is available (meta / version-like tag), else null. */
  version: string | null;
  /** The best user-facing label: the version when available, else a short ref. */
  label: string;
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

function versionFromMeta(meta: ReleaseLabelDeployment['meta']): string | null {
  if (meta == null) return null;
  let record: Record<string, unknown>;
  if (typeof meta === 'string') {
    try {
      const parsed: unknown = JSON.parse(meta);
      if (typeof parsed !== 'object' || parsed === null) return null;
      record = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    record = meta;
  }
  return firstNonEmptyString(record.releaseVersion, record.releaseTag);
}

/** Strip a `refs/tags/` prefix, leaving a bare tag name. */
function stripRefsTags(ref: string): string {
  return ref.startsWith(REFS_TAGS_PREFIX) ? ref.slice(REFS_TAGS_PREFIX.length) : ref;
}

/** A genuine version number only — a `refs/tags/` prefix alone is not enough. */
function versionFromRef(ref: string): string | null {
  const tag = stripRefsTags(ref.trim()).trim();
  if (!tag) return null;
  return VERSION_TAG_RE.test(tag) ? tag : null;
}

/** Best display for a non-version ref: strip `refs/tags/`, truncate a hex SHA. */
function shortRefLabel(ref: string): string {
  const stripped = stripRefsTags(ref.trim()).trim();
  if (!stripped) return '-';
  if (HEX_SHA_RE.test(stripped) && stripped.length > 12) return stripped.slice(0, 12);
  return stripped;
}

/**
 * Resolve the best user-facing release label for a deployment, preferring a
 * release version over the commit hash. See the module header for the order.
 */
export function deploymentReleaseLabel(deployment: ReleaseLabelDeployment): ReleaseLabel {
  const ref = String(deployment?.ref ?? '');
  const version = versionFromMeta(deployment?.meta) ?? versionFromRef(ref);
  if (version) return { version, label: version };
  const fallback = ref.trim() || String(deployment?.id ?? '').trim();
  return { version: null, label: fallback ? shortRefLabel(fallback) : '-' };
}
