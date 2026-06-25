/**
 * scanner.ts — orchestrate a dependency scan of a Hub-hosted repo at a ref.
 *
 * The flow, all pluggable:
 *   1. List the repo's tracked files at `ref` ({@link RepoFileReader}).
 *   2. Match lockfiles by basename against the registered parsers.
 *   3. Read + parse each lockfile into resolved dependencies.
 *   4. Hand the deduped dependency set to the {@link AdvisorySource}.
 *
 * `scanResolvedDependencies` is the pure core (no git, no network — both
 * injected), so the orchestration is fully unit-testable with a fake
 * reader + fake source. {@link gitRepoFileReader} is the production reader
 * that shells out to `git -C <bare>`.
 */

import path from 'path';
import { git } from '../native-pr/git-read.js';
import type {
  AdvisorySource,
  DependencyFinding,
  LockfileParser,
  ResolvedDependency,
} from './types.js';
import { npmLockfileParser } from './npm-lockfile.js';
import { pipLockfileParsers } from './pip-lockfile.js';
import { severityRank } from './severity.js';

/** Reads a repo's tracked file list and file contents at a git ref. */
export interface RepoFileReader {
  /** Root-relative paths of all tracked files at `ref`. */
  listFiles(ref: string): Promise<string[]>;
  /** UTF-8 content of `filePath` at `ref`, or `null` if absent/too large. */
  readFile(ref: string, filePath: string): Promise<string | null>;
}

/**
 * All lockfile parsers the scanner knows about. npm (`package-lock.json`,
 * `npm-shrinkwrap.json`) plus Python/PyPI (`requirements.txt`, `poetry.lock`,
 * `Pipfile.lock`). Each new ecosystem is a parser registration here — the
 * scanner, OSV query layer, store, and findings UI are all ecosystem-generic.
 */
export const DEFAULT_PARSERS: readonly LockfileParser[] = [
  npmLockfileParser,
  ...pipLockfileParsers,
];

/** Cap on lockfiles scanned per repo — guards against pathological trees. */
const MAX_LOCKFILES = 100;
/** A lockfile larger than this is skipped (a real one is well under). */
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;

export interface ScanResult {
  ref: string;
  /**
   * Lockfiles that parsed SUCCESSFULLY this scan (empty dep set included).
   * This is the authoritative scope for the store's "fixed" sweep: only
   * findings attributed to one of these manifests may be auto-resolved, so a
   * parse failure / truncation can never clear findings from a manifest we
   * didn't actually read.
   */
  scannedManifests: string[];
  /**
   * EVERY lockfile-candidate path that currently EXISTS in the repo tree at
   * `ref` (matched a parser by basename), regardless of whether it parsed,
   * failed, or was truncated out. This lets the store distinguish a manifest
   * that was *deleted/renamed* (absent here → its old findings are resolvable)
   * from one that merely failed to parse / was truncated (present here → its
   * findings must be preserved).
   */
  presentManifests: string[];
  /**
   * Lockfiles that were matched but could NOT be read/parsed (corrupt JSON,
   * too large, or a git read error). Their findings are deliberately left
   * untouched. Surfaced so the caller can warn rather than silently under-report.
   */
  failedManifests: string[];
  /**
   * True when more matching lockfiles existed than {@link MAX_LOCKFILES}; the
   * overflow was not scanned (and so is excluded from the fixed sweep).
   */
  truncated: boolean;
  /** Distinct (name@version) dependencies resolved across all lockfiles. */
  dependencyCount: number;
  /** Vulnerable dependencies, sorted worst-severity first. */
  findings: DependencyFinding[];
}

/** Match a tracked file against a parser by basename (case-insensitive). */
function parserForFile(
  filePath: string,
  parsers: readonly LockfileParser[],
): LockfileParser | null {
  const base = path.posix.basename(filePath).toLowerCase();
  return parsers.find((p) => p.filenames.includes(base)) ?? null;
}

/**
 * Pure core: given a way to read files and an advisory source, find the
 * lockfiles, resolve dependencies, and return findings. No git/network
 * knowledge — both are injected.
 */
export async function scanResolvedDependencies(opts: {
  reader: RepoFileReader;
  ref: string;
  advisorySource: AdvisorySource;
  parsers?: readonly LockfileParser[];
}): Promise<ScanResult> {
  const parsers = opts.parsers ?? DEFAULT_PARSERS;
  const files = await opts.reader.listFiles(opts.ref);

  // Sort the candidate set so truncation is DETERMINISTIC: the same prefix of
  // lockfiles is scanned every run regardless of git's listing order, which is
  // what lets the manifest-scoped fixed sweep be stable (an unstable order
  // could otherwise rotate which manifests fall outside the cap).
  const candidates = files.filter((f) => parserForFile(f, parsers)).sort();
  const truncated = candidates.length > MAX_LOCKFILES;
  const lockfiles = candidates.slice(0, MAX_LOCKFILES);

  // Collect every dependency occurrence, grouped by (ecosystem, name, version).
  // The OSV query is deduped to ONE representative per group (advisories are
  // version-keyed, not manifest-keyed, so querying the same package@version
  // once per lockfile would be redundant). Findings are then EXPANDED back to
  // every manifest the dep appears in — otherwise a vulnerable package@version
  // shared across several lockfiles would be attributed only to whichever
  // lockfile was parsed first, losing per-manifest coverage in monorepos.
  const occurrencesByKey = new Map<string, ResolvedDependency[]>();
  // scannedManifests = parsed OK (the fixed-sweep scope). failedManifests =
  // matched a parser but could not be read/parsed; kept OUT of the sweep scope
  // so a corrupt/temporarily-unparsable lockfile never clears real findings.
  const scannedManifests: string[] = [];
  const failedManifests: string[] = [];

  const depKey = (dep: ResolvedDependency): string => `${dep.ecosystem}:${dep.name}@${dep.version}`;

  for (const filePath of lockfiles) {
    const parser = parserForFile(filePath, parsers);
    if (!parser) continue;
    const content = await opts.reader.readFile(opts.ref, filePath);
    // Unreadable (null) or too large to trust → a read failure, NOT an empty
    // manifest. Record as failed and exclude from the sweep scope.
    if (content == null || content.length > MAX_LOCKFILE_BYTES) {
      failedManifests.push(filePath);
      continue;
    }
    const resolved = parser.parse(content, filePath);
    if (resolved === null) {
      // Corrupt / truncated lockfile — could not be parsed. Exclude from the
      // sweep scope so its existing open findings are preserved.
      failedManifests.push(filePath);
      continue;
    }
    // Parsed successfully (even if it has zero deps): this manifest WAS scanned,
    // so its vanished findings are eligible to be marked fixed.
    scannedManifests.push(filePath);
    for (const dep of resolved) {
      const key = depKey(dep);
      const occ = occurrencesByKey.get(key);
      if (occ) {
        // Guard against the same (manifest, package, version) landing twice.
        if (!occ.some((d) => d.manifestPath === dep.manifestPath)) occ.push(dep);
      } else {
        occurrencesByKey.set(key, [dep]);
      }
    }
  }

  const uniqueDeps = [...occurrencesByKey.values()].map((occ) => occ[0]);
  const groupFindings = uniqueDeps.length > 0 ? await opts.advisorySource.query(uniqueDeps) : [];

  // Expand each group-level finding to every manifest occurrence of that dep.
  const findings: DependencyFinding[] = [];
  for (const f of groupFindings) {
    const occurrences = occurrencesByKey.get(depKey(f.dependency)) ?? [f.dependency];
    for (const occ of occurrences) {
      findings.push({ dependency: occ, advisory: f.advisory });
    }
  }
  findings.sort(
    (a, b) =>
      severityRank(b.advisory.severity) - severityRank(a.advisory.severity) ||
      a.dependency.name.localeCompare(b.dependency.name) ||
      a.dependency.manifestPath.localeCompare(b.dependency.manifestPath),
  );

  return {
    ref: opts.ref,
    scannedManifests,
    // Every lockfile candidate that exists in the tree (parsed, failed, or
    // truncated-out). A finding whose manifest is NOT here was deleted/renamed.
    presentManifests: candidates,
    failedManifests,
    truncated,
    dependencyCount: uniqueDeps.length,
    findings,
  };
}

/**
 * Production {@link RepoFileReader} over a Hub-hosted bare repo. Reads the
 * tree at `ref` with `git ls-tree -r` and blobs with `git show ref:path`.
 */
export function gitRepoFileReader(repoPath: string): RepoFileReader {
  return {
    async listFiles(ref: string): Promise<string[]> {
      // A git failure here (bad/unknown ref, unreadable repo) MUST propagate.
      // Swallowing it into `[]` would make the scan look like a clean repo with
      // zero lockfiles, and recordScanResults would then mark every
      // previously-open finding as `fixed` — a falsely-clean scan triggered by
      // nothing more than a `ref` typo on the public scan route.
      try {
        const out = await git(repoPath, ['ls-tree', '-r', '--name-only', '-z', ref]);
        return out.split('\0').filter(Boolean);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        throw new Error(`security-audit: failed to list files at ref "${ref}": ${msg}`);
      }
    },
    async readFile(ref: string, filePath: string): Promise<string | null> {
      // `null` here is the legitimate "blob absent at this ref" signal (the
      // caller skips it). Paths come from listFiles(), so a read failure is an
      // edge case; we still return null rather than aborting the whole scan for
      // one unreadable file once the ref itself has been shown to be valid.
      try {
        return await git(repoPath, ['show', `${ref}:${filePath}`]);
      } catch {
        return null;
      }
    },
  };
}
