// Detects hand-mirrored modules across the web and mobile clients.
//
// `client/src/utils/X.ts` and `mobile/src/utils/X.ts` sharing a basename is the
// signature of copy-paste parity: one implementation typed twice, drifting with
// nothing to catch it. SPEC-3 resolved that pure logic belongs in `shared/` with
// the platform seam injected, and made this check part of the decision rather
// than a follow-up — without it the mirroring grows back.
//
// The model is a ratchet, matching `openapi-coverage.ts`:
//   - Every mirrored pair that exists today is listed in
//     `scripts/mirrored-modules-baseline.json`. Those are grandfathered.
//   - A pair NOT in the baseline fails the check. You cannot add new mirroring.
//   - A baseline entry whose pair no longer exists ALSO fails, which forces the
//     baseline to shrink as pairs migrate to `shared/`. Otherwise the list would
//     rot into a permanent allowlist that never reaches zero.
//
// This module is pure: it takes two lists of filenames and returns a verdict.
// The CLI wrapper at `scripts/check-mirrored-modules.ts` is the only piece that
// touches the filesystem. Unit tests live at `server/mirrored-modules.test.ts`.

/** One scanned directory pair, e.g. `client/src/utils` vs `mobile/src/utils`. */
export interface ScanScope {
  /** Stable id used in the baseline file, e.g. `utils` or `hooks`. */
  id: string;
  clientDir: string;
  mobileDir: string;
}

export interface MirroredPair {
  scope: string;
  basename: string;
}

export interface MirrorVerdict {
  /** Pairs present on disk but absent from the baseline: new mirroring. */
  added: MirroredPair[];
  /** Baseline entries with no pair on disk: the baseline needs ratcheting down. */
  stale: MirroredPair[];
  /** Every pair currently on disk, sorted. */
  current: MirroredPair[];
}

/**
 * Source modules in a directory listing: `.ts` / `.tsx`, excluding tests and
 * ambient declarations. Basenames drop the extension so a `.ts` on one side and
 * a `.tsx` on the other still count as the same mirrored module.
 */
export function sourceBasenames(filenames: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of filenames) {
    const m = /^(.+)\.(ts|tsx)$/.exec(name);
    if (!m) continue;
    const base = m[1];
    if (/\.test$/.test(base) || /\.d$/.test(base)) continue;
    out.add(base);
  }
  return [...out].sort();
}

/** Basenames present in BOTH listings: the mirrored pairs. */
export function mirroredBasenames(
  clientFiles: readonly string[],
  mobileFiles: readonly string[],
): string[] {
  const mobile = new Set(sourceBasenames(mobileFiles));
  return sourceBasenames(clientFiles).filter((n) => mobile.has(n));
}

function key(p: MirroredPair): string {
  return `${p.scope}/${p.basename}`;
}

function sortPairs(pairs: readonly MirroredPair[]): MirroredPair[] {
  return [...pairs].sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Compare the pairs found on disk against the baseline.
 *
 * Both directions are failures. `added` catches new mirroring; `stale` catches a
 * baseline that was not lowered after a module moved to `shared/`, which is what
 * keeps the allowlist shrinking toward zero instead of drifting out of date.
 */
export function compareWithBaseline(
  current: readonly MirroredPair[],
  baseline: readonly MirroredPair[],
): MirrorVerdict {
  const baselineKeys = new Set(baseline.map(key));
  const currentKeys = new Set(current.map(key));
  return {
    added: sortPairs(current.filter((p) => !baselineKeys.has(key(p)))),
    stale: sortPairs(baseline.filter((p) => !currentKeys.has(key(p)))),
    current: sortPairs(current),
  };
}

/** Serialize pairs back into the baseline file's `{ scope: basename[] }` shape. */
export function toBaselineShape(pairs: readonly MirroredPair[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of sortPairs(pairs)) {
    (out[p.scope] ??= []).push(p.basename);
  }
  return out;
}

/** Parse the `{ scope: basename[] }` baseline shape, ignoring `_`-prefixed docs. */
export function fromBaselineShape(raw: Record<string, unknown>): MirroredPair[] {
  const out: MirroredPair[] = [];
  for (const [scope, value] of Object.entries(raw)) {
    if (scope.startsWith('_')) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new Error(`mirrored-modules baseline: "${scope}" must be an array of basenames`);
    }
    for (const basename of value as string[]) {
      out.push({ scope, basename });
    }
  }
  return sortPairs(out);
}
