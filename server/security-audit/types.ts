/**
 * types.ts — shared types for the dependency security-audit module.
 *
 * The audit pipeline has three stages, each pluggable:
 *
 *   1. A {@link LockfileParser} turns a lockfile's text into a flat list of
 *      {@link ResolvedDependency} (ecosystem + name + exact installed
 *      version). npm is the first ecosystem; the interface is shaped so
 *      pip/Cargo/Go parsers slot in without touching the scanner.
 *   2. An {@link AdvisorySource} maps those resolved dependencies to
 *      {@link DependencyFinding}s against a vulnerability database
 *      (OSV.dev by default; the GitHub Advisory DB is reachable through
 *      OSV's `GHSA-*` records).
 *   3. The scanner persists findings, de-dupes against prior scans and
 *      dismissals, and surfaces them (REST + kanban card).
 *
 * Keeping these as interfaces (not concrete classes) is what makes the
 * whole pipeline unit-testable without network or a real git repo: tests
 * inject a fake reader / fake advisory source and assert on pure data.
 */

/** Severity bucket, mirroring the GitHub Advisory DB labels. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

/**
 * Package ecosystems the audit can scan. Only `npm` is implemented today;
 * the union is the single place new ecosystems are added so the type
 * system flags every switch that needs a new arm.
 */
export type Ecosystem = 'npm';

/** A single dependency resolved to an exact version from a lockfile. */
export interface ResolvedDependency {
  ecosystem: Ecosystem;
  /** Package name as the ecosystem registry knows it (e.g. `lodash`, `@scope/pkg`). */
  name: string;
  /** Exact installed version (no range), e.g. `4.17.20`. */
  version: string;
  /**
   * Root-relative path of the lockfile this dependency came from. Lets a
   * monorepo with several lockfiles attribute each finding to its manifest.
   */
  manifestPath: string;
}

/**
 * Parses one lockfile format into resolved dependencies. A parser is
 * registered for the basenames it recognises; the scanner walks the repo
 * tree and routes each matching file to its parser.
 */
export interface LockfileParser {
  ecosystem: Ecosystem;
  /** Lockfile basenames this parser handles (lowercase), e.g. `package-lock.json`. */
  filenames: readonly string[];
  /**
   * Parse lockfile `content` into resolved dependencies. `manifestPath` is
   * threaded onto every result for attribution. Implementations must never
   * throw on malformed input. Return value:
   *   - `null` when the content cannot be parsed as this lockfile format
   *     (corrupt / truncated). The scanner records this manifest as a parse
   *     FAILURE and excludes it from the "fixed" sweep, so a temporarily
   *     unparsable lockfile cannot clear real open findings.
   *   - an array (possibly empty) on success — an empty array is a valid
   *     lockfile with no dependencies to audit.
   */
  parse(content: string, manifestPath: string): ResolvedDependency[] | null;
}

/** A vulnerability advisory, normalised from the upstream source. */
export interface Advisory {
  /** Primary id, e.g. `GHSA-jf85-cpcp-j695` or `CVE-2020-8203`. */
  id: string;
  /** One-line human summary. */
  summary: string;
  severity: Severity;
  /** Other ids for the same vuln (CVE/GHSA aliases) — used for de-dupe. */
  aliases: string[];
  /**
   * Smallest fixed version that resolves the advisory for the affected
   * package, when the source declares one. `null` when no fix is published
   * (the bump suggestion is then omitted).
   */
  fixedVersion: string | null;
  /** Canonical advisory URL (best-effort; empty string when none). */
  url: string;
}

/** A vulnerable dependency: the resolved dep plus the advisory hitting it. */
export interface DependencyFinding {
  dependency: ResolvedDependency;
  advisory: Advisory;
}

/**
 * Maps resolved dependencies to the advisories that affect their exact
 * installed versions. Implementations own version-applicability (OSV does
 * this server-side for the querybatch endpoint).
 */
export interface AdvisorySource {
  query(deps: ResolvedDependency[]): Promise<DependencyFinding[]>;
}
