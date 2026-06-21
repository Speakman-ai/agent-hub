/**
 * findings-store.ts — persistence, de-dupe, and suppression for the
 * dependency security audit.
 *
 * Two tables, both self-contained (own DDL exported for db.ts to exec at
 * init; statements prepared lazily from the shared handle):
 *
 *   security_findings      — one row per (project, advisory, package,
 *                            version, manifest). `status` is the lifecycle:
 *                            open → fixed (gone from a later scan) or
 *                            dismissed (operator suppressed it).
 *   security_suppressions  — operator decisions to ignore an advisory
 *                            (optionally scoped to one package). A matching
 *                            suppression forces a finding to `dismissed` and
 *                            keeps it out of card generation across re-scans.
 *
 * De-dupe is the unique index on the finding key: re-scanning the same repo
 * updates the existing row in place (refreshing severity/fix/last_seen)
 * rather than appending duplicates. Findings that vanish from a later scan
 * are auto-marked `fixed`. Everything is synchronous better-sqlite3, so the
 * record-scan transaction is race-free in-process.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { DependencyFinding, Severity } from './types.js';

export const SECURITY_AUDIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS security_findings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    ecosystem TEXT NOT NULL,
    package_name TEXT NOT NULL,
    package_version TEXT NOT NULL,
    advisory_id TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'unknown',
    summary TEXT NOT NULL DEFAULT '',
    fixed_version TEXT,
    advisory_url TEXT NOT NULL DEFAULT '',
    manifest_path TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    scan_ref TEXT,
    -- Unique id of the scan run that last SAW this finding present. The "fixed"
    -- sweep marks open findings whose last_scan_id != the current run, which is
    -- exact regardless of clock resolution (two scans in the same millisecond
    -- would tie on last_seen_at, but never on this marker).
    last_scan_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_security_findings_key
    ON security_findings(project_id, advisory_id, package_name, package_version, manifest_path);
  CREATE INDEX IF NOT EXISTS idx_security_findings_project
    ON security_findings(project_id, status);

  CREATE TABLE IF NOT EXISTS security_suppressions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    advisory_id TEXT NOT NULL,
    package_name TEXT NOT NULL DEFAULT '',
    reason TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_security_suppressions_key
    ON security_suppressions(project_id, advisory_id, package_name);
`;

/**
 * Heal installs whose `security_findings` table predates the `last_scan_id`
 * column. `CREATE TABLE IF NOT EXISTS` in {@link SECURITY_AUDIT_SCHEMA} never
 * adds columns to an existing table, so a DB created before `last_scan_id`
 * existed would throw `SqliteError: table security_findings has no column named
 * last_scan_id` on the very first scan store (insert/update both reference it).
 *
 * Idempotent: the probe SELECT succeeds once the column is present, so the
 * ALTER only runs on legacy tables. Safe to call on every boot after exec'ing
 * the schema. No-op when the table doesn't exist yet (the schema just created
 * it with the column).
 */
export function migrateSecurityFindingsAddLastScanId(db: Database.Database): void {
  try {
    db.prepare('SELECT last_scan_id FROM security_findings LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE security_findings ADD COLUMN last_scan_id TEXT');
  }
}

export type FindingStatus = 'open' | 'fixed' | 'dismissed';

export interface SecurityFindingRow {
  id: string;
  project_id: string;
  ecosystem: string;
  package_name: string;
  package_version: string;
  advisory_id: string;
  severity: Severity;
  summary: string;
  fixed_version: string | null;
  advisory_url: string;
  manifest_path: string;
  status: FindingStatus;
  first_seen_at: number;
  last_seen_at: number;
  scan_ref: string | null;
  /** Unique id of the scan run that last saw this finding present. */
  last_scan_id: string | null;
}

export interface SecuritySuppressionRow {
  id: string;
  project_id: string;
  advisory_id: string;
  /** Empty string = advisory-wide for the project. */
  package_name: string;
  reason: string | null;
  created_by: string | null;
  created_at: number;
}

export interface RecordScanSummary {
  /** Findings newly persisted as `open` this scan (drives card generation). */
  newFindings: SecurityFindingRow[];
  /**
   * Findings that were previously `fixed` and reappeared this scan (a
   * regression). Like `newFindings` these are card-worthy — the original card
   * was likely closed — so card generation surfaces them too.
   */
  reopenedFindings: SecurityFindingRow[];
  /** Count of findings already known and refreshed in place. */
  updated: number;
  /** Count of previously-open findings no longer present (marked `fixed`). */
  fixed: number;
  /** Count of findings suppressed by an active suppression this scan. */
  suppressed: number;
}

/** Does a suppression row match a given advisory + package? */
function suppressionMatches(
  rows: SecuritySuppressionRow[],
  advisoryId: string,
  packageName: string,
): boolean {
  return rows.some(
    (s) =>
      s.advisory_id === advisoryId && (s.package_name === '' || s.package_name === packageName),
  );
}

export interface SecurityAuditStore {
  recordScanResults(args: {
    projectId: string;
    findings: DependencyFinding[];
    /**
     * Manifests that parsed SUCCESSFULLY this scan. A finding on one of these
     * that was NOT re-detected is resolvable (the dep is gone from a lockfile
     * we actually read).
     */
    scannedManifests: string[];
    /**
     * EVERY lockfile that currently EXISTS in the repo tree (parsed, failed, or
     * truncated). The "fixed" sweep PRESERVES only findings on a manifest that
     * exists but was NOT successfully scanned (parse failure / truncation —
     * `presentManifests \ scannedManifests`). Everything else not re-detected is
     * resolved, which crucially includes findings whose lockfile was
     * DELETED/RENAMED (absent from `presentManifests`). When omitted it defaults
     * to `scannedManifests` (treats unscanned manifests as absent).
     */
    presentManifests?: string[];
    ref: string;
    now: number;
  }): RecordScanSummary;
  listFindings(projectId: string, opts?: { status?: FindingStatus }): SecurityFindingRow[];
  getFinding(projectId: string, id: string): SecurityFindingRow | null;
  countOpenBySeverity(projectId: string): Record<Severity, number>;
  dismissFinding(args: {
    projectId: string;
    id: string;
    reason?: string | null;
    createdBy?: string | null;
    suppress?: boolean;
  }): SecurityFindingRow | null;
  listSuppressions(projectId: string): SecuritySuppressionRow[];
  /**
   * Run `fn` inside the store's DB transaction. Lets a caller make
   * recordScanResults and a dependent side effect (kanban card insert) atomic:
   * if the card insert throws, the findings roll back too, so a retry still
   * classifies them as `newFindings` and a card is eventually created.
   * better-sqlite3 nests via savepoints, so an inner recordScanResults
   * transaction composes correctly.
   */
  transaction<T>(fn: () => T): T;
}

/**
 * Build a store bound to a better-sqlite3 handle. The caller must have
 * exec'd {@link SECURITY_AUDIT_SCHEMA} on the same db first (db.ts does
 * this at init; tests do it inline).
 */
export function createSecurityAuditStore(db: Database.Database): SecurityAuditStore {
  const insertFinding = db.prepare(`
    INSERT INTO security_findings
      (id, project_id, ecosystem, package_name, package_version, advisory_id,
       severity, summary, fixed_version, advisory_url, manifest_path, status,
       first_seen_at, last_seen_at, scan_ref, last_scan_id)
    VALUES
      (@id, @project_id, @ecosystem, @package_name, @package_version, @advisory_id,
       @severity, @summary, @fixed_version, @advisory_url, @manifest_path, @status,
       @first_seen_at, @last_seen_at, @scan_ref, @last_scan_id)
  `);
  const updateFinding = db.prepare(`
    UPDATE security_findings
       SET severity = @severity,
           summary = @summary,
           fixed_version = @fixed_version,
           advisory_url = @advisory_url,
           ecosystem = @ecosystem,
           last_seen_at = @last_seen_at,
           scan_ref = @scan_ref,
           last_scan_id = @last_scan_id,
           status = CASE WHEN status = 'dismissed' THEN 'dismissed' ELSE @status END
     WHERE id = @id
  `);
  const getByKey = db.prepare(`
    SELECT * FROM security_findings
     WHERE project_id = ? AND advisory_id = ? AND package_name = ?
       AND package_version = ? AND manifest_path = ?
  `);
  // The "fixed" sweep resolves every OPEN finding this run did not re-detect,
  // EXCEPT those on a `preserveManifests` path — manifests that exist but were
  // not successfully scanned (parse failure / truncation). Findings whose
  // lockfile was deleted/renamed are NOT in preserve, so they are correctly
  // resolved. The SQL has a variable-length `NOT IN (...)` built per call;
  // better-sqlite3 caches by text, so re-preparing identical shapes is cheap.
  //
  // "Did not re-detect" is decided by the per-run marker `last_scan_id`, NOT a
  // timestamp inequality: every finding present in this run had its last_scan_id
  // set to `scanId`, so an open finding with a different (or null) last_scan_id
  // is one this run did not see. Exact even when two scans land in the same
  // millisecond (which a `last_seen_at < now` guard would mishandle).
  const markVanishedFixed = (
    projectId: string,
    scanId: string,
    preserveManifests: string[],
  ): number => {
    const base = `UPDATE security_findings
         SET status = 'fixed'
       WHERE project_id = ? AND status = 'open'
         AND (last_scan_id IS NULL OR last_scan_id <> ?)`;
    if (preserveManifests.length === 0) {
      return db.prepare(base).run(projectId, scanId).changes;
    }
    const placeholders = preserveManifests.map(() => '?').join(', ');
    const stmt = db.prepare(`${base} AND manifest_path NOT IN (${placeholders})`);
    return stmt.run(projectId, scanId, ...preserveManifests).changes;
  };
  const selectByProject = db.prepare(
    `SELECT * FROM security_findings WHERE project_id = ? ORDER BY last_seen_at DESC, id`,
  );
  const selectByProjectStatus = db.prepare(
    `SELECT * FROM security_findings WHERE project_id = ? AND status = ? ORDER BY last_seen_at DESC, id`,
  );
  const selectFinding = db.prepare(
    `SELECT * FROM security_findings WHERE project_id = ? AND id = ?`,
  );
  const setFindingStatus = db.prepare(
    `UPDATE security_findings SET status = ? WHERE project_id = ? AND id = ?`,
  );
  const selectSuppressions = db.prepare(
    `SELECT * FROM security_suppressions WHERE project_id = ? ORDER BY created_at DESC`,
  );
  const insertSuppression = db.prepare(`
    INSERT INTO security_suppressions
      (id, project_id, advisory_id, package_name, reason, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, advisory_id, package_name) DO UPDATE SET
      reason = excluded.reason, created_by = excluded.created_by
  `);

  const recordScanResults: SecurityAuditStore['recordScanResults'] = (args) => {
    const { projectId, findings, scannedManifests, ref, now } = args;
    // Manifests to PRESERVE from the sweep = present-but-not-scanned (exists in
    // the repo yet failed to parse / was truncated). Defaults to scannedManifests
    // when presentManifests is omitted, which preserves nothing extra. A deleted
    // lockfile is absent from presentManifests, so it is NOT preserved → its
    // open findings get resolved.
    const presentManifests = args.presentManifests ?? scannedManifests;
    const scannedSet = new Set(scannedManifests);
    const preserveManifests = presentManifests.filter((m) => !scannedSet.has(m));
    // Unique marker for THIS run. Every finding present this scan gets it; the
    // vanish-sweep then resolves open findings that lack it. Independent of the
    // millisecond clock, so same-millisecond scans never tie.
    const scanId = uuidv4();
    const run = db.transaction((): RecordScanSummary => {
      const suppressions = selectSuppressions.all(projectId) as SecuritySuppressionRow[];
      const newFindings: SecurityFindingRow[] = [];
      const reopenedFindings: SecurityFindingRow[] = [];
      let updated = 0;
      let suppressed = 0;

      for (const f of findings) {
        const isSuppressed = suppressionMatches(suppressions, f.advisory.id, f.dependency.name);
        if (isSuppressed) suppressed++;
        const status: FindingStatus = isSuppressed ? 'dismissed' : 'open';
        const existing = getByKey.get(
          projectId,
          f.advisory.id,
          f.dependency.name,
          f.dependency.version,
          f.dependency.manifestPath,
        ) as SecurityFindingRow | undefined;

        if (existing) {
          updateFinding.run({
            id: existing.id,
            severity: f.advisory.severity,
            summary: f.advisory.summary,
            fixed_version: f.advisory.fixedVersion,
            advisory_url: f.advisory.url,
            ecosystem: f.dependency.ecosystem,
            last_seen_at: now,
            scan_ref: ref,
            last_scan_id: scanId,
            status,
          });
          updated++;
          // A previously-resolved finding reappearing is a regression. The
          // update above flipped it back to `open` (the CASE keeps `dismissed`
          // sticky), so surface it for card generation — the original card was
          // likely closed.
          if (existing.status === 'fixed' && status === 'open') {
            reopenedFindings.push(selectFinding.get(projectId, existing.id) as SecurityFindingRow);
          }
        } else {
          const id = uuidv4();
          insertFinding.run({
            id,
            project_id: projectId,
            ecosystem: f.dependency.ecosystem,
            package_name: f.dependency.name,
            package_version: f.dependency.version,
            advisory_id: f.advisory.id,
            severity: f.advisory.severity,
            summary: f.advisory.summary,
            fixed_version: f.advisory.fixedVersion,
            advisory_url: f.advisory.url,
            manifest_path: f.dependency.manifestPath,
            status,
            first_seen_at: now,
            last_seen_at: now,
            scan_ref: ref,
            last_scan_id: scanId,
          });
          if (status === 'open') {
            newFindings.push(selectFinding.get(projectId, id) as SecurityFindingRow);
          }
        }
      }

      // Resolve every open finding this run didn't re-detect, EXCEPT those on a
      // present-but-unscanned manifest (parse failure / truncation). Findings on
      // a deleted/renamed lockfile (absent from presentManifests) are resolved.
      const fixed = markVanishedFixed(projectId, scanId, preserveManifests);
      return { newFindings, reopenedFindings, updated, fixed, suppressed };
    });
    return run();
  };

  return {
    recordScanResults,
    listFindings(projectId, opts) {
      const rows = opts?.status
        ? (selectByProjectStatus.all(projectId, opts.status) as SecurityFindingRow[])
        : (selectByProject.all(projectId) as SecurityFindingRow[]);
      return rows;
    },
    getFinding(projectId, id) {
      return (selectFinding.get(projectId, id) as SecurityFindingRow | undefined) ?? null;
    },
    countOpenBySeverity(projectId) {
      const counts: Record<Severity, number> = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0,
      };
      const rows = selectByProjectStatus.all(projectId, 'open') as SecurityFindingRow[];
      for (const r of rows) counts[r.severity] = (counts[r.severity] ?? 0) + 1;
      return counts;
    },
    dismissFinding(args) {
      const { projectId, id, reason = null, createdBy = null, suppress = true } = args;
      const finding = selectFinding.get(projectId, id) as SecurityFindingRow | undefined;
      if (!finding) return null;
      const run = db.transaction(() => {
        setFindingStatus.run('dismissed', projectId, id);
        if (suppress) {
          insertSuppression.run(
            uuidv4(),
            projectId,
            finding.advisory_id,
            finding.package_name,
            reason,
            createdBy,
            Date.now(),
          );
        }
      });
      run();
      return (selectFinding.get(projectId, id) as SecurityFindingRow | undefined) ?? null;
    },
    listSuppressions(projectId) {
      return selectSuppressions.all(projectId) as SecuritySuppressionRow[];
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}
