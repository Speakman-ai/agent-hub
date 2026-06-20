import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SECURITY_AUDIT_SCHEMA,
  createSecurityAuditStore,
  type SecurityAuditStore,
} from './findings-store.js';
import type { DependencyFinding, Severity } from './types.js';

let db: Database.Database;
let store: SecurityAuditStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SECURITY_AUDIT_SCHEMA);
  store = createSecurityAuditStore(db);
});

afterEach(() => db.close());

function finding(
  name: string,
  version: string,
  advisoryId: string,
  severity: Severity = 'high',
  fixedVersion: string | null = null,
  manifestPath = 'package-lock.json',
): DependencyFinding {
  return {
    dependency: { ecosystem: 'npm', name, version, manifestPath },
    advisory: {
      id: advisoryId,
      summary: `${advisoryId} summary`,
      severity,
      aliases: [],
      fixedVersion,
      url: '',
    },
  };
}

/**
 * Default scannedManifests to the single common lockfile, and presentManifests
 * to whatever scannedManifests resolves to (so by default a scanned manifest is
 * also "present"). Tests exercising parse-failure / deletion pass these
 * explicitly.
 */
function record(args: {
  projectId: string;
  findings: DependencyFinding[];
  ref: string;
  now: number;
  scannedManifests?: string[];
  presentManifests?: string[];
}): ReturnType<SecurityAuditStore['recordScanResults']> {
  const scannedManifests = args.scannedManifests ?? ['package-lock.json'];
  return store.recordScanResults({
    ...args,
    scannedManifests,
    presentManifests: args.presentManifests ?? scannedManifests,
  });
}

describe('recordScanResults', () => {
  it('inserts new findings as open and returns them for card generation', () => {
    const summary = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a', 'critical', '4.17.21')],
      ref: 'main',
      now: 1000,
    });
    expect(summary.newFindings).toHaveLength(1);
    expect(summary.newFindings[0]).toMatchObject({
      package_name: 'lodash',
      advisory_id: 'GHSA-a',
      severity: 'critical',
      fixed_version: '4.17.21',
      status: 'open',
    });
    expect(store.listFindings('p1', { status: 'open' })).toHaveLength(1);
  });

  it('de-dupes a repeat finding: updates in place, not a new row', () => {
    record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a', 'high')],
      ref: 'main',
      now: 1000,
    });
    const summary = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a', 'critical', '4.17.21')],
      ref: 'main',
      now: 2000,
    });
    expect(summary.newFindings).toHaveLength(0);
    expect(summary.updated).toBe(1);
    const rows = store.listFindings('p1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      severity: 'critical',
      fixed_version: '4.17.21',
      last_seen_at: 2000,
      first_seen_at: 1000,
    });
  });

  it('marks a finding fixed when it vanishes from a later scan of the same manifest', () => {
    record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    const summary = record({
      projectId: 'p1',
      findings: [],
      ref: 'main',
      now: 2000,
      scannedManifests: ['package-lock.json'], // the manifest WAS scanned, dep gone
    });
    expect(summary.fixed).toBe(1);
    expect(store.listFindings('p1', { status: 'open' })).toHaveLength(0);
    expect(store.listFindings('p1', { status: 'fixed' })).toHaveLength(1);
  });

  it('marks a vanished finding fixed even when both scans share the same millisecond (now)', () => {
    // Regression: a `last_seen_at < now` sweep would mishandle two scans in the
    // same millisecond. The per-run scanId marker resolves it exactly.
    record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 5000,
    });
    const summary = record({
      projectId: 'p1',
      findings: [],
      ref: 'main',
      now: 5000, // identical timestamp to the first scan
      scannedManifests: ['package-lock.json'],
    });
    expect(summary.fixed).toBe(1);
    expect(store.listFindings('p1', { status: 'open' })).toHaveLength(0);
    expect(store.listFindings('p1', { status: 'fixed' })).toHaveLength(1);
  });

  it('does NOT mark a finding fixed when its manifest was not scanned (parse failure / truncation)', () => {
    record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    // A later scan where package-lock.json EXISTS but failed to parse →
    // present but not scanned. The open finding must be preserved, not cleared.
    const summary = record({
      projectId: 'p1',
      findings: [],
      ref: 'main',
      now: 2000,
      scannedManifests: [], // nothing parsed successfully this run
      presentManifests: ['package-lock.json'], // …but the lockfile still exists
    });
    expect(summary.fixed).toBe(0);
    expect(store.listFindings('p1', { status: 'open' })).toHaveLength(1);
    expect(store.listFindings('p1', { status: 'fixed' })).toHaveLength(0);
  });

  it('marks a finding fixed when its lockfile was DELETED (absent from the tree)', () => {
    record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    // The lockfile is gone from the repo entirely → not present, not scanned.
    // Unlike a parse failure, a deleted manifest's findings must be resolved.
    const summary = record({
      projectId: 'p1',
      findings: [],
      ref: 'main',
      now: 2000,
      scannedManifests: [],
      presentManifests: [], // package-lock.json no longer exists
    });
    expect(summary.fixed).toBe(1);
    expect(store.listFindings('p1', { status: 'open' })).toHaveLength(0);
    expect(store.listFindings('p1', { status: 'fixed' })).toHaveLength(1);
  });

  it('sweeps only the scanned manifest, preserving findings on unscanned manifests', () => {
    record({
      projectId: 'p1',
      findings: [
        finding('lodash', '4.17.11', 'GHSA-a', 'high', null, 'a/package-lock.json'),
        finding('minimist', '1.2.0', 'GHSA-b', 'high', null, 'b/package-lock.json'),
      ],
      ref: 'main',
      now: 1000,
      scannedManifests: ['a/package-lock.json', 'b/package-lock.json'],
    });
    // Re-scan where only manifest `a` parsed; `b` exists but failed. `a`'s vuln
    // is gone. `b` is present-but-unscanned → its finding is preserved.
    const summary = record({
      projectId: 'p1',
      findings: [],
      ref: 'main',
      now: 2000,
      scannedManifests: ['a/package-lock.json'],
      presentManifests: ['a/package-lock.json', 'b/package-lock.json'],
    });
    expect(summary.fixed).toBe(1);
    const open = store.listFindings('p1', { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].manifest_path).toBe('b/package-lock.json'); // b preserved
  });

  it('does not resurrect a fixed finding silently — re-detecting reopens it', () => {
    record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    record({ projectId: 'p1', findings: [], ref: 'main', now: 2000 }); // fixed
    const summary = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 3000,
    });
    // Existing row flips back to open; it's an update, not a new insert.
    expect(summary.updated).toBe(1);
    expect(store.listFindings('p1', { status: 'open' })).toHaveLength(1);
  });

  it('surfaces a reopened (fixed -> open) finding in reopenedFindings for card generation', () => {
    const s1 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a', 'critical')],
      ref: 'main',
      now: 1000,
    });
    expect(s1.newFindings).toHaveLength(1);

    // Vanishes → fixed.
    record({ projectId: 'p1', findings: [], ref: 'main', now: 2000 });
    expect(store.listFindings('p1', { status: 'fixed' })).toHaveLength(1);

    // Reappears → a regression. It is an UPDATE (the row exists) so it is NOT in
    // newFindings, but it IS surfaced in reopenedFindings so a card is created.
    const s3 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a', 'critical')],
      ref: 'main',
      now: 3000,
    });
    expect(s3.newFindings).toHaveLength(0);
    expect(s3.reopenedFindings).toHaveLength(1);
    expect(s3.reopenedFindings[0]).toMatchObject({
      advisory_id: 'GHSA-a',
      status: 'open',
    });
  });

  it('does not put a still-open finding in reopenedFindings on re-scan', () => {
    record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    // Same finding seen again while still open → updated, not reopened.
    const s2 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 2000,
    });
    expect(s2.reopenedFindings).toHaveLength(0);
    expect(s2.updated).toBe(1);
  });

  it('keeps a dismissed finding dismissed across re-scans (suppression)', () => {
    const summary1 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    store.dismissFinding({
      projectId: 'p1',
      id: summary1.newFindings[0].id,
      reason: 'not exploitable',
    });
    expect(store.getFinding('p1', summary1.newFindings[0].id)?.status).toBe('dismissed');

    // Re-scan: suppression forces dismissed, and it is NOT returned as new.
    const summary2 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 2000,
    });
    expect(summary2.newFindings).toHaveLength(0);
    expect(summary2.suppressed).toBe(1);
    expect(store.getFinding('p1', summary1.newFindings[0].id)?.status).toBe('dismissed');
  });

  it('suppresses a brand-new finding matching an existing advisory-wide suppression', () => {
    // Seed a finding then dismiss with suppress to create the suppression.
    const s1 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    store.dismissFinding({ projectId: 'p1', id: s1.newFindings[0].id });

    // A different version of the same package + advisory is also suppressed
    // (suppression is scoped to the package name).
    const s2 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.12', 'GHSA-a')],
      ref: 'main',
      now: 2000,
    });
    expect(s2.newFindings).toHaveLength(0);
    expect(s2.suppressed).toBe(1);
    expect(store.listFindings('p1', { status: 'dismissed' })).toHaveLength(2);
  });

  it('scopes findings and suppressions per project', () => {
    record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    record({
      projectId: 'p2',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    expect(store.listFindings('p1')).toHaveLength(1);
    expect(store.listFindings('p2')).toHaveLength(1);
  });
});

describe('countOpenBySeverity', () => {
  it('counts only open findings, by bucket', () => {
    record({
      projectId: 'p1',
      findings: [
        finding('a', '1.0.0', 'A', 'critical'),
        finding('b', '1.0.0', 'B', 'high'),
        finding('c', '1.0.0', 'C', 'high'),
      ],
      ref: 'main',
      now: 1000,
    });
    expect(store.countOpenBySeverity('p1')).toEqual({
      critical: 1,
      high: 2,
      medium: 0,
      low: 0,
      unknown: 0,
    });
  });
});

describe('dismissFinding', () => {
  it('returns null for an unknown finding id', () => {
    expect(store.dismissFinding({ projectId: 'p1', id: 'nope' })).toBeNull();
  });

  it('dismiss without suppress: the row stays dismissed, but sibling versions are NOT auto-dismissed', () => {
    const s = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 1000,
    });
    store.dismissFinding({ projectId: 'p1', id: s.newFindings[0].id, suppress: false });
    expect(store.listSuppressions('p1')).toHaveLength(0);

    // Re-scanning the SAME finding keeps that specific row dismissed (a manual
    // dismissal sticks for the row it targeted).
    const s2 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.11', 'GHSA-a')],
      ref: 'main',
      now: 2000,
    });
    expect(s2.suppressed).toBe(0);
    expect(store.getFinding('p1', s.newFindings[0].id)?.status).toBe('dismissed');

    // But a DIFFERENT version surfaces as a fresh open finding, because no
    // package-wide suppression was recorded.
    const s3 = record({
      projectId: 'p1',
      findings: [finding('lodash', '4.17.12', 'GHSA-a')],
      ref: 'main',
      now: 3000,
    });
    expect(s3.newFindings).toHaveLength(1);
    expect(s3.newFindings[0].status).toBe('open');
  });
});
