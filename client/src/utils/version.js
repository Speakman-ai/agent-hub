/**
 * Version comparison + DMG download URL helpers.
 *
 * Used by the "update available" flow in the Electron desktop app: when the
 * server we're connected to reports a newer version than the client bundle,
 * we prompt the user to download a fresh DMG from S3.
 *
 * We don't need strict semver precedence (prerelease tag ordering etc.) — the
 * DMG we publish is a stable release, so a simple MAJOR.MINOR.PATCH numeric
 * compare is sufficient. Prerelease / build suffixes are stripped before
 * comparison.
 */

const S3_BUCKET_BASE = 'https://agent-hub-prod-releases.s3.us-east-2.amazonaws.com';

/**
 * Parse a version string into a `[major, minor, patch]` tuple of numbers.
 * Returns `null` for inputs that aren't parseable — callers should treat
 * `null` as "unknown, do not compare" rather than falling through to 0.0.0.
 *
 * Tolerant of a leading `v` / `V` prefix and of prerelease / build suffixes
 * (`-beta.1`, `+sha.abc`) which are stripped.
 */
function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^[vV]/, '').split(/[-+]/)[0];
  const parts = stripped.split('.');
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => {
    const n = Number(p);
    return Number.isFinite(n) && /^\d+$/.test(p) ? n : NaN;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

/**
 * Compare two semver-ish version strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Unparseable inputs yield 0 — we treat unknown versions as "equal" so the
 * caller never spuriously prompts the user based on garbage data.
 */
export function compareSemver(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Build the S3 download URL for a specific version + platform + arch.
 *
 *   darwin + arm64 → https://…/v1.2.3/Agent%20Hub-1.2.3-arm64.dmg
 *   darwin + x64   → https://…/v1.2.3/Agent%20Hub-1.2.3.dmg
 *   anything else  → null (we only publish macOS DMGs today)
 *
 * Undefined arch on darwin falls through to x64. Apple Silicon users who
 * grab the wrong DMG just re-download the arm64 one — the worst-case is
 * mild annoyance, not a broken install.
 */
export function buildDmgDownloadUrl({ version, platform, arch } = {}) {
  if (platform !== 'darwin') return null;
  if (typeof version !== 'string' || !version.trim()) return null;
  const v = version.trim().replace(/^[vV]/, '');
  const suffix = arch === 'arm64' ? '-arm64' : '';
  const filename = `Agent%20Hub-${encodeURIComponent(v)}${suffix}.dmg`;
  return `${S3_BUCKET_BASE}/v${encodeURIComponent(v)}/${filename}`;
}

/** Exposed for testing. Not part of the public API. */
export const __test = { parseVersion, S3_BUCKET_BASE };
