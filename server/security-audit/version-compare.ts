/**
 * version-compare.ts - a tiny, dependency-free semver comparator.
 *
 * Advisory "fixed" versions and installed lockfile versions are concrete
 * release versions (`4.17.21`, `1.2.3`, occasionally `1.2.3-rc.1`). We only
 * need: is a string a parseable version, and ordering between two of them.
 * `semver` would do this but isn't a declared server dependency (and ships
 * no types), so a ~40-line parser covers our needs without the import.
 *
 * Semantics (a practical subset of semver 2.0):
 *   - Compares numeric major.minor.patch (missing components = 0).
 *   - A version with a prerelease tag sorts *below* the same version
 *     without one (`1.0.0-rc.1` < `1.0.0`), matching semver precedence.
 *   - Prerelease identifiers are compared left-to-right, numeric vs string
 *     per spec (numeric identifiers are lower than alphanumeric).
 */

interface ParsedVersion {
  main: [number, number, number];
  prerelease: string[];
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): ParsedVersion | null {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(VERSION_RE);
  if (!m) return null;
  return {
    main: [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** True when `input` parses as a version we can order. */
export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

function comparePrerelease(a: string[], b: string[]): number {
  // No prerelease outranks any prerelease (1.0.0 > 1.0.0-rc).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (an !== bn) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return an ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** -1 if a < b, 0 if equal, 1 if a > b. Unparseable inputs sort last. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < 3; i++) {
    if (pa.main[i] !== pb.main[i]) return pa.main[i] < pb.main[i] ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
