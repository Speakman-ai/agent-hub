/**
 * bump.ts — pure helpers that turn vulnerable findings into a concrete
 * "bump this package to its fixed version" edit of an npm `package-lock.json`
 * (and the sibling `package.json` range), plus the planner that groups raw
 * findings into one bump per (manifest, package, installed-version).
 *
 * Everything here is a pure string/JSON transform — no git, no network, no
 * disk — so the whole bump surface is unit-testable in isolation. The git
 * write + PR open lives in {@link ./auto-pr.ts}.
 *
 * Lockfile completeness: a correct npm lockfile entry carries the target
 * version's `resolved` (tarball URL) + `integrity` (SRI hash). Those can't be
 * recomputed offline, so callers may pass the registry-fetched `dist` pair
 * (see {@link ./registry-metadata.ts}) and the bumped entry is rewritten
 * fully-pinned — nothing left for a reviewer to flag. When `dist` is omitted
 * (registry unreachable, offline test) the now-stale `resolved`/`integrity`
 * are DROPPED instead, leaving a *starter* lockfile a follow-up `npm install`
 * reconciles. Either way the bump itself is a Dependabot-style proposal, not a
 * finished merge.
 */

import type { DependencyFinding, Severity } from './types.js';
import type { NpmDistMetadata } from './registry-metadata.js';
import { registryBaseFromResolvedUrl } from './registry-metadata.js';
import { compareVersions, isValidVersion } from './version-compare.js';

/** One package bump: raise every vulnerable installed copy of `packageName` to `toVersion`. */
export interface SecurityBumpPlan {
  /** Root-relative lockfile path the bump applies to. */
  manifestPath: string;
  packageName: string;
  /**
   * Every distinct vulnerable installed version of this package in this
   * manifest, ascending. A package can be installed at several versions at once
   * (a direct dep + transitive copies); all of them are bumped to `toVersion`
   * in a SINGLE PR. Keeping them in one plan/branch is what prevents two plans
   * from colliding on the same branch and overwriting each other's lockfile
   * edit (leaving one copy unbumped).
   */
  fromVersions: string[];
  /** Smallest-safe target: the MAX fixed version across grouped advisories. */
  toVersion: string;
  /** Sorted, de-duped advisory ids this bump resolves. */
  advisoryIds: string[];
  /** Highest severity across the grouped advisories. */
  severity: Severity;
  /** Per-advisory context for the PR body, in `advisoryIds` order. */
  advisories: Array<{ id: string; severity: Severity; summary: string; url: string }>;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

/**
 * Group fixable findings into one bump plan per (manifest, package) — NOT per
 * installed-version. A package can be installed at several versions at once (a
 * direct dep plus transitive copies); they must share ONE plan so they share
 * one branch/PR and one accumulated lockfile edit. Splitting per-version would
 * make two plans target the same deterministic branch, and the later commit
 * (based on the original baseSha) would overwrite the earlier one, leaving a
 * vulnerable copy unbumped.
 *
 * A finding is fixable only when its advisory declares a parseable
 * `fixedVersion` STRICTLY greater than the installed version (a fix
 * at-or-below the installed version is already satisfied / nonsensical). The
 * chosen `toVersion` is the MAX fixed version across the whole group — being
 * >= every grouped advisory's fixed version, it resolves all of them at once
 * for every vulnerable installed copy.
 */
export function planSecurityBumps(findings: DependencyFinding[]): SecurityBumpPlan[] {
  const groups = new Map<
    string,
    {
      manifestPath: string;
      packageName: string;
      /** Distinct vulnerable installed versions, insertion order. */
      fromVersions: Set<string>;
      advisories: Map<string, { id: string; severity: Severity; summary: string; url: string }>;
      fixedVersions: string[];
    }
  >();

  for (const f of findings) {
    const { dependency, advisory } = f;
    if (dependency.ecosystem !== 'npm') continue; // only npm lockfiles are writable today
    const fixed = advisory.fixedVersion;
    if (!fixed || !isValidVersion(fixed) || !isValidVersion(dependency.version)) continue;
    if (compareVersions(fixed, dependency.version) <= 0) continue; // fix not ahead of installed

    const key = JSON.stringify([dependency.manifestPath, dependency.name]);
    let group = groups.get(key);
    if (!group) {
      group = {
        manifestPath: dependency.manifestPath,
        packageName: dependency.name,
        fromVersions: new Set(),
        advisories: new Map(),
        fixedVersions: [],
      };
      groups.set(key, group);
    }
    group.fromVersions.add(dependency.version);
    if (!group.advisories.has(advisory.id)) {
      group.advisories.set(advisory.id, {
        id: advisory.id,
        severity: advisory.severity,
        summary: advisory.summary,
        url: advisory.url,
      });
    }
    group.fixedVersions.push(fixed);
  }

  const plans: SecurityBumpPlan[] = [];
  for (const group of groups.values()) {
    const toVersion = group.fixedVersions.reduce((max, v) =>
      compareVersions(v, max) > 0 ? v : max,
    );
    const advisories = [...group.advisories.values()].sort((a, b) => a.id.localeCompare(b.id));
    const severity = advisories.reduce<Severity>(
      (worst, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[worst] ? a.severity : worst),
      'unknown',
    );
    const fromVersions = [...group.fromVersions].sort(compareVersions);
    plans.push({
      manifestPath: group.manifestPath,
      packageName: group.packageName,
      fromVersions,
      toVersion,
      advisoryIds: advisories.map((a) => a.id),
      severity,
      advisories,
    });
  }

  // Deterministic order (manifest, package) so branch creation and tests are
  // stable regardless of finding arrival order.
  plans.sort(
    (a, b) =>
      a.manifestPath.localeCompare(b.manifestPath) || a.packageName.localeCompare(b.packageName),
  );
  return plans;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Rewrite a bumped lockfile entry's `resolved`/`integrity` for the new version.
 * When the registry `dist` pair is known, pin the entry fully (the complete,
 * reviewer-clean path). When it's not (`undefined`), drop the now-stale fields
 * so the lockfile is an honest starter rather than carrying a wrong hash.
 */
function applyDistFields(entry: Record<string, unknown>, dist: NpmDistMetadata | undefined): void {
  if (dist) {
    entry.resolved = dist.resolved;
    entry.integrity = dist.integrity;
  } else {
    delete entry.resolved;
    delete entry.integrity;
  }
}

/** Extract the package name from a `packages` map key (install path). */
function nameFromPackagePath(pkgPath: string): string | null {
  const idx = pkgPath.lastIndexOf('node_modules/');
  if (idx === -1) return null;
  const name = pkgPath.slice(idx + 'node_modules/'.length);
  return name.length > 0 ? name : null;
}

/**
 * Detect the indentation a JSON document uses so a rewrite preserves it
 * (npm lockfiles + package.json are 2-space by convention, but respect
 * whatever the file actually uses to minimise diff noise). Falls back to 2
 * spaces.
 */
export function detectJsonIndent(content: string): number | string {
  const m = content.match(/\n([ \t]+)"/);
  if (!m) return 2;
  const indent = m[1];
  return indent.includes('\t') ? '\t' : indent.length;
}

function serialize(parsed: unknown, content: string): string {
  const indent = detectJsonIndent(content);
  const out = JSON.stringify(parsed, null, indent);
  // Preserve a trailing newline when the original had one (the common case).
  return content.endsWith('\n') ? `${out}\n` : out;
}

interface TreeBumpResult {
  /** Any entry (top-level or nested/transitive) was bumped. */
  any: boolean;
  /** A TOP-LEVEL entry (direct child of the root `dependencies` map) was bumped. */
  topLevel: boolean;
}

/**
 * Recursively bump a lockfileVersion-1 / legacy `dependencies` tree. `isTopLevel`
 * marks the root map's direct children — bumps there correspond to the root
 * project's direct/hoisted deps; nested bumps are transitive and must NOT drive
 * a root manifest-range change.
 */
function bumpDependenciesTree(
  tree: Record<string, unknown>,
  packageName: string,
  fromVersion: string,
  toVersion: string,
  isTopLevel: boolean,
  dist: NpmDistMetadata | undefined,
): TreeBumpResult {
  let any = false;
  let topLevel = false;
  for (const [name, rawEntry] of Object.entries(tree)) {
    if (!isObject(rawEntry)) continue;
    if (name === packageName && rawEntry.version === fromVersion) {
      rawEntry.version = toVersion;
      applyDistFields(rawEntry, dist);
      any = true;
      if (isTopLevel) topLevel = true;
    }
    if (isObject(rawEntry.dependencies)) {
      const nested = bumpDependenciesTree(
        rawEntry.dependencies,
        packageName,
        fromVersion,
        toVersion,
        false,
        dist,
      );
      any = any || nested.any;
      topLevel = topLevel || nested.topLevel;
    }
  }
  return { any, topLevel };
}

/**
 * A `packages`-map key is a TOP-LEVEL install (the root project's direct or
 * hoisted dependency) when it is `node_modules/<name>` with no further nested
 * `node_modules/` segment. A nested key like
 * `node_modules/foo/node_modules/lodash` is a transitive install.
 */
function isTopLevelInstallPath(pkgPath: string): boolean {
  const prefix = 'node_modules/';
  if (!pkgPath.startsWith(prefix)) return false;
  return !pkgPath.slice(prefix.length).includes(prefix);
}

const RANGE_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * Bump `packageName`'s range in every dependency-section map of a single
 * lockfile/package.json entry, preserving the range operator. Returns true if
 * any range changed. Shared by the lockfile root-entry sync and
 * {@link applyPackageJsonRangeBump}.
 */
function bumpRangeMapsInEntry(
  entry: Record<string, unknown>,
  packageName: string,
  toVersion: string,
): boolean {
  let changed = false;
  for (const field of RANGE_FIELDS) {
    const section = entry[field];
    if (!isObject(section)) continue;
    const current = section[packageName];
    if (typeof current !== 'string') continue;
    const next = bumpRange(current, toVersion);
    if (next && next !== current) {
      section[packageName] = next;
      changed = true;
    }
  }
  return changed;
}

export interface LockfileBumpResult {
  /** The rewritten lockfile text. */
  content: string;
  /**
   * True when a TOP-LEVEL install entry (the root project's direct/hoisted
   * dependency) was bumped — i.e. the root `package.json` / `packages[""]`
   * range MAY correspond to this bump and is safe to sync. False for a purely
   * transitive (nested) bump: callers must then leave the root manifest range
   * untouched, or they would corrupt an unrelated direct dependency that
   * happens to share the package name.
   */
  rootDependencyBumped: boolean;
}

/**
 * Apply a single package bump to an npm lockfile's text. Returns the result
 * when an installed entry at `fromVersion` was found and rewritten, or `null`
 * when the content can't be parsed OR no matching entry exists (already bumped
 * / not present) — the caller treats `null` as "nothing to do, skip this
 * manifest".
 *
 * What gets rewritten:
 *   - the resolved `version` of every matching install entry (packages map +
 *     legacy dependencies tree), top-level OR nested/transitive. When the
 *     registry `dist` pair is supplied the entry is re-pinned with the new
 *     `resolved`/`integrity`; otherwise those now-stale fields are dropped
 *     (see file header);
 *   - ONLY when a TOP-LEVEL entry was among them: the root project's declared
 *     ranges in `packages[""].{dependencies,devDependencies,
 *     optionalDependencies,peerDependencies}` (lockfileVersion 2/3). npm
 *     mirrors the root `package.json` ranges there, so bumping `package.json`
 *     WITHOUT this would leave the lockfile recording the old range — an
 *     `npm ci` mismatch. The same operator-preserving {@link bumpRange} keeps
 *     them in lockstep.
 *
 * The root-range sync is gated on a TOP-LEVEL bump (`rootDependencyBumped`)
 * precisely so a transitive bump of e.g. `node_modules/foo/node_modules/lodash`
 * never rewrites the root's unrelated direct `lodash` range. (When the package
 * is genuinely hoisted-but-not-declared, the root range map simply lacks the
 * key, so the sync is a no-op anyway.)
 */
export function applyNpmLockfileBump(
  content: string,
  args: {
    packageName: string;
    fromVersion: string;
    toVersion: string;
    /**
     * Registry `dist` metadata for `toVersion`. When supplied, every bumped
     * entry is re-pinned with this `resolved`/`integrity`, producing a complete
     * lockfile a reviewer has nothing to flag on. Omit to drop the stale fields
     * (offline fallback).
     */
    dist?: NpmDistMetadata;
  },
): LockfileBumpResult | null {
  const { packageName, fromVersion, toVersion, dist } = args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  let versionChanged = false;
  let rootDependencyBumped = false;

  // lockfileVersion 2 & 3: the authoritative `packages` map.
  if (isObject(parsed.packages)) {
    for (const [pkgPath, rawEntry] of Object.entries(parsed.packages)) {
      if (pkgPath === '' || !isObject(rawEntry)) continue;
      const name =
        typeof rawEntry.name === 'string' && rawEntry.name.length > 0
          ? rawEntry.name
          : nameFromPackagePath(pkgPath);
      if (name !== packageName) continue;
      if (rawEntry.version !== fromVersion) continue;
      rawEntry.version = toVersion;
      applyDistFields(rawEntry, dist);
      versionChanged = true;
      if (isTopLevelInstallPath(pkgPath)) rootDependencyBumped = true;
    }
  }

  // lockfileVersion 1 (and v2 back-compat): the recursive `dependencies` tree.
  if (isObject(parsed.dependencies)) {
    const treeResult = bumpDependenciesTree(
      parsed.dependencies,
      packageName,
      fromVersion,
      toVersion,
      true,
      dist,
    );
    versionChanged = versionChanged || treeResult.any;
    rootDependencyBumped = rootDependencyBumped || treeResult.topLevel;
  }

  if (!versionChanged) return null;

  // Only sync the root range mirror when a TOP-LEVEL entry was bumped — a
  // transitive-only bump must leave the root manifest range alone.
  if (rootDependencyBumped && isObject(parsed.packages)) {
    const root = (parsed.packages as Record<string, unknown>)[''];
    if (isObject(root)) bumpRangeMapsInEntry(root, packageName, toVersion);
  }

  return { content: serialize(parsed, content), rootDependencyBumped };
}

/** Depth-first search of a legacy `dependencies` tree for `name`'s `resolved` URL. */
function findResolvedInTree(tree: Record<string, unknown>, packageName: string): string | null {
  for (const [name, rawEntry] of Object.entries(tree)) {
    if (!isObject(rawEntry)) continue;
    if (name === packageName && typeof rawEntry.resolved === 'string' && rawEntry.resolved) {
      return rawEntry.resolved;
    }
    if (isObject(rawEntry.dependencies)) {
      const nested = findResolvedInTree(rawEntry.dependencies, packageName);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Find the existing `resolved` (tarball) URL recorded for `packageName` anywhere
 * in an npm lockfile — the `packages` map (v2/3) first, then the legacy
 * `dependencies` tree (v1). Returns `null` when no entry for the package carries
 * a `resolved` URL (already-stripped entry, link/workspace, unparseable JSON).
 *
 * This is what makes bump enrichment registry-aware: the URL it returns is the
 * registry the lockfile is ALREADY pinned to, so {@link npmRegistryBaseForPackage}
 * can re-query that same registry instead of defaulting to the public npm one.
 */
export function findResolvedUrlForPackage(content: string, packageName: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  if (isObject(parsed.packages)) {
    for (const [pkgPath, rawEntry] of Object.entries(parsed.packages)) {
      if (pkgPath === '' || !isObject(rawEntry)) continue;
      const name =
        typeof rawEntry.name === 'string' && rawEntry.name.length > 0
          ? rawEntry.name
          : nameFromPackagePath(pkgPath);
      if (name !== packageName) continue;
      if (typeof rawEntry.resolved === 'string' && rawEntry.resolved) return rawEntry.resolved;
    }
  }

  if (isObject(parsed.dependencies)) {
    const fromTree = findResolvedInTree(parsed.dependencies, packageName);
    if (fromTree) return fromTree;
  }

  return null;
}

/**
 * Derive the registry base URL the lockfile already pins `packageName` to, by
 * reading its existing `resolved` tarball URL. Returns `null` when no usable
 * registry can be determined — the caller then declines to enrich (drops the
 * stale fields) rather than rewriting `resolved` to a different registry.
 */
export function npmRegistryBaseForPackage(content: string, packageName: string): string | null {
  const resolved = findResolvedUrlForPackage(content, packageName);
  if (!resolved) return null;
  return registryBaseFromResolvedUrl(resolved, packageName);
}

/**
 * Rewrite a single dependency range to target `toVersion`, preserving the
 * existing range operator (`^`, `~`, `>=`, or pinned-exact). Returns `null`
 * for ranges we won't touch (`*`, `workspace:`, `file:`, git/url specifiers,
 * compound `||` ranges) so the caller leaves them as-is.
 */
export function bumpRange(current: string, toVersion: string): string | null {
  const trimmed = current.trim();
  if (trimmed.startsWith('^')) return `^${toVersion}`;
  if (trimmed.startsWith('~')) return `~${toVersion}`;
  if (trimmed.startsWith('>=')) return `>=${toVersion}`;
  if (isValidVersion(trimmed)) return toVersion; // pinned exact
  return null;
}

/**
 * Apply a package bump to a `package.json`'s declared ranges across all
 * dependency sections. Returns the new text when at least one range changed,
 * else `null` (package not declared / unbumpable range / unparseable JSON).
 */
export function applyPackageJsonRangeBump(
  content: string,
  args: { packageName: string; toVersion: string },
): string | null {
  const { packageName, toVersion } = args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const changed = bumpRangeMapsInEntry(parsed, packageName, toVersion);
  return changed ? serialize(parsed, content) : null;
}
