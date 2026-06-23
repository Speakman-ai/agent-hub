/**
 * registry-metadata.ts — fetch the npm registry's `dist` metadata
 * (`tarball` URL + Subresource-Integrity `integrity` hash) for a single
 * package@version.
 *
 * Why this exists: a security bump rewrites a lockfile entry's `version`, but
 * a correct npm lockfile entry also carries the matching `resolved` (tarball
 * URL) and `integrity` (SRI hash) for that exact version. Those two fields
 * can't be recomputed offline, so {@link ./bump.ts} historically DROPPED them
 * and left a note telling a reviewer/CI to run `npm install` to reconcile —
 * which is the recurring "lockfile entry is missing resolved/integrity" review
 * comment every security bump PR collected.
 *
 * The npm registry already publishes both fields. `GET <registry>/<name>/<ver>`
 * returns `{ dist: { tarball, integrity, shasum } }`. Fetching it lets the bump
 * write a COMPLETE, fully-pinned lockfile entry, so there is nothing left for
 * the reviewer to flag. This is a best-effort enrichment: every failure mode
 * (network down, 404, missing fields, malformed JSON) resolves to `null` and
 * the caller falls back to the offline drop-behavior — the bump never fails
 * because the registry was unreachable.
 */

export interface NpmDistMetadata {
  /** The tarball URL → the lockfile entry's `resolved` field. */
  resolved: string;
  /** The Subresource-Integrity hash → the lockfile entry's `integrity` field. */
  integrity: string;
}

export interface FetchNpmDistMetadataOptions {
  /** Registry base URL (no trailing slash). Defaults to the public npm registry. */
  registryUrl?: string;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort the request after this many ms (best-effort). Default 8000. */
  timeoutMs?: number;
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Encode a package name for a registry path. A scoped name `@scope/pkg` keeps
 * its `@` but the internal slash must be percent-encoded (`@scope%2fpkg`) so it
 * isn't read as a path separator; unscoped names need no encoding.
 */
function encodePackageName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2f') : name;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Derive the registry base URL from an existing lockfile `resolved` tarball URL,
 * so enrichment queries the SAME registry the lockfile is already pinned to
 * (public npm, a private registry, or a corporate mirror) rather than silently
 * rewriting `resolved` provenance to the public registry.
 *
 * npm registry tarball URLs have the canonical shape
 * `<registryBase>/<name>/-/<file>.tgz` (scoped: `<base>/@scope/pkg/-/…`), so the
 * base is everything before the `/<name>/-/` marker. Returns `null` when the URL
 * is not a recognizable http(s) registry tarball for `packageName` — a git/url/
 * file specifier, a name mismatch, or a missing marker — so the caller can
 * decline to enrich and safely drop the fields instead of guessing a registry.
 */
export function registryBaseFromResolvedUrl(resolved: string, packageName: string): string | null {
  if (!isNonEmptyString(resolved) || !isNonEmptyString(packageName)) return null;
  // Only http(s) registry tarballs carry a provenance host worth preserving.
  if (!/^https?:\/\//i.test(resolved)) return null;
  const marker = `/${packageName}/-/`;
  const idx = resolved.indexOf(marker);
  if (idx <= 0) return null;
  return resolved.slice(0, idx);
}

/**
 * Resolve the `{ resolved, integrity }` pair for `packageName@version` from the
 * npm registry. Returns `null` for ANY failure — never throws, never rejects —
 * so callers can treat a `null` as "couldn't enrich, fall back to dropping the
 * fields".
 */
export async function fetchNpmDistMetadata(
  packageName: string,
  version: string,
  opts: FetchNpmDistMetadataOptions = {},
): Promise<NpmDistMetadata | null> {
  if (!isNonEmptyString(packageName) || !isNonEmptyString(version)) return null;

  const registry = (opts.registryUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const url = `${registry}/${encodePackageName(packageName)}/${encodeURIComponent(version)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const dist = (body as { dist?: unknown }).dist;
    if (typeof dist !== 'object' || dist === null) return null;
    const { tarball, integrity } = dist as { tarball?: unknown; integrity?: unknown };
    if (!isNonEmptyString(tarball) || !isNonEmptyString(integrity)) return null;
    return { resolved: tarball, integrity };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
