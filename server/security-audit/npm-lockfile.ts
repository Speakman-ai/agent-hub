/**
 * npm-lockfile.ts — parse `package-lock.json` / `npm-shrinkwrap.json` into a
 * flat list of resolved dependencies.
 *
 * Supports all three lockfile formats npm has shipped:
 *   - lockfileVersion 1 — recursive `dependencies` tree (npm 5/6).
 *   - lockfileVersion 2 — both a `packages` map and a legacy `dependencies`
 *     tree (npm 7, for back-compat). We read `packages` (authoritative).
 *   - lockfileVersion 3 — `packages` map only (npm 9+).
 *
 * The `packages` map keys are install paths (`node_modules/lodash`,
 * `node_modules/a/node_modules/b`); the empty-string key is the root
 * project and is skipped (it has no version to audit). We dedupe on
 * (name, version) because the same package@version can appear at multiple
 * install paths.
 */

import type { LockfileParser, ResolvedDependency } from './types.js';

/** Extract the package name from a `packages` map key (install path). */
function nameFromPackagePath(pkgPath: string): string | null {
  // Last `node_modules/` segment wins: `node_modules/a/node_modules/@s/b`
  // → `@s/b`. Scoped names keep their single internal slash.
  const idx = pkgPath.lastIndexOf('node_modules/');
  if (idx === -1) return null;
  const name = pkgPath.slice(idx + 'node_modules/'.length);
  return name.length > 0 ? name : null;
}

interface PackagesEntry {
  version?: unknown;
  /**
   * Real registry package name. Present (and authoritative) for aliased
   * installs, where the install path carries the ALIAS but `name` carries the
   * package actually fetched — e.g. `node_modules/safe-name` with
   * `{ name: 'lodash', version: '4.17.11' }`. We must audit `name`, not the
   * alias, or the vulnerability is missed.
   */
  name?: unknown;
  /** Bundled/linked deps have no registry version to audit; we skip them. */
  link?: unknown;
}

interface DependenciesEntry {
  version?: unknown;
  dependencies?: Record<string, DependenciesEntry>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Walk a lockfileVersion-1 / legacy `dependencies` tree recursively. */
function collectFromDependenciesTree(
  tree: Record<string, DependenciesEntry> | undefined,
  out: ResolvedDependency[],
  manifestPath: string,
): void {
  if (!isObject(tree)) return;
  for (const [name, entry] of Object.entries(tree)) {
    if (!isObject(entry)) continue;
    if (typeof entry.version === 'string' && entry.version.length > 0) {
      out.push({ ecosystem: 'npm', name, version: entry.version, manifestPath });
    }
    if (isObject(entry.dependencies)) {
      collectFromDependenciesTree(
        entry.dependencies as Record<string, DependenciesEntry>,
        out,
        manifestPath,
      );
    }
  }
}

/**
 * Parse an npm lockfile. Never throws, but distinguishes two outcomes:
 *
 *   - `null`  — the content could NOT be parsed as a lockfile (corrupt /
 *               truncated JSON, or a non-object top level). The scanner
 *               treats this as a *parse failure* and excludes the manifest
 *               from the "fixed" sweep, so a temporarily-unparsable
 *               `package-lock.json` can never mark real open findings fixed.
 *   - `[]` …  — parsed successfully; the array (possibly empty) is the
 *               resolved dependency set. An empty array means a valid
 *               lockfile with nothing to audit.
 */
export function parseNpmLockfile(
  content: string,
  manifestPath: string,
): ResolvedDependency[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  // A lockfile is a JSON *object* (arrays / null / scalars are corrupt input).
  if (!isObject(parsed) || Array.isArray(parsed)) return null;

  const seen = new Set<string>();
  const out: ResolvedDependency[] = [];

  const push = (name: string, version: string): void => {
    if (!name || !version) return;
    const key = `${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ecosystem: 'npm', name, version, manifestPath });
  };

  // Preferred: the `packages` map (lockfileVersion 2 & 3).
  if (isObject(parsed.packages)) {
    for (const [pkgPath, rawEntry] of Object.entries(parsed.packages)) {
      if (pkgPath === '') continue; // root project — nothing to audit
      if (!isObject(rawEntry)) continue;
      const entry = rawEntry as PackagesEntry;
      if (entry.link === true) continue; // symlinked workspace, not a registry dep
      // Prefer the entry's `name` (the real registry package) over the
      // path-derived name so aliased installs are audited under their true
      // package, not the alias. Fall back to the install path otherwise.
      const name =
        typeof entry.name === 'string' && entry.name.length > 0
          ? entry.name
          : nameFromPackagePath(pkgPath);
      if (!name) continue;
      if (typeof entry.version === 'string') push(name, entry.version);
    }
    if (out.length > 0) return out;
  }

  // Fallback: the recursive `dependencies` tree (lockfileVersion 1, or a
  // v2 lockfile that somehow had an empty `packages`).
  if (isObject(parsed.dependencies)) {
    const tree: ResolvedDependency[] = [];
    collectFromDependenciesTree(
      parsed.dependencies as Record<string, DependenciesEntry>,
      tree,
      manifestPath,
    );
    for (const dep of tree) push(dep.name, dep.version);
  }

  return out;
}

/** npm lockfile parser registration for the scanner's parser list. */
export const npmLockfileParser: LockfileParser = {
  ecosystem: 'npm',
  filenames: ['package-lock.json', 'npm-shrinkwrap.json'],
  parse: parseNpmLockfile,
};
