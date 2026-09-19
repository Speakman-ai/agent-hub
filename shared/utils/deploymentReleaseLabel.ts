/**
 * User-facing deployment/release label. Prefer `meta.releaseVersion` /
 * `meta.releaseTag`, then a version-like tag, then a short ref (SHA truncated to 12).
 * `refs/tags/nightly` is a label, not a `version`.
 */

/** Fields read off a deployment row / DTO. */
export interface ReleaseLabelDeployment {
  ref?: string | null;
  /**
   * May carry `releaseVersion` / `releaseTag`. Server stores JSON string;
   * client DTO may already be parsed. Both accepted.
   */
  meta?: string | Record<string, unknown> | null;
  /** Optional fallback id when a deployment has no ref. */
  id?: string | null;
}

export interface ReleaseLabel {
  version: string | null;
  label: string;
}

const REFS_TAGS_PREFIX = 'refs/tags/';
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;
// Optional leading `v`, then MAJOR.MINOR(.PATCH) plus prerelease/build suffix.
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

function stripRefsTags(ref: string): string {
  return ref.startsWith(REFS_TAGS_PREFIX) ? ref.slice(REFS_TAGS_PREFIX.length) : ref;
}

/** Version number only; a `refs/tags/` prefix is not enough. */
function versionFromRef(ref: string): string | null {
  const tag = stripRefsTags(ref.trim()).trim();
  if (!tag) return null;
  return VERSION_TAG_RE.test(tag) ? tag : null;
}

function shortRefLabel(ref: string): string {
  const stripped = stripRefsTags(ref.trim()).trim();
  if (!stripped) return '-';
  if (HEX_SHA_RE.test(stripped) && stripped.length > 12) return stripped.slice(0, 12);
  return stripped;
}

/** Prefer a release version over the commit hash. */
export function deploymentReleaseLabel(deployment: ReleaseLabelDeployment): ReleaseLabel {
  const ref = String(deployment?.ref ?? '');
  const version = versionFromMeta(deployment?.meta) ?? versionFromRef(ref);
  if (version) return { version, label: version };
  const fallback = ref.trim() || String(deployment?.id ?? '').trim();
  return { version: null, label: fallback ? shortRefLabel(fallback) : '-' };
}
