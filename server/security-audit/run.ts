/**
 * run.ts — top-level "scan this project now" orchestration.
 *
 * Wires the pieces together for a single hosted repo: resolve the bare
 * repo + ref → read lockfiles → query the advisory source → persist with
 * de-dupe → open a kanban card for genuinely new findings. This is the
 * one function the REST trigger calls today, and the seam a scheduled
 * cron / on-push hook will call next (see follow-up cards).
 *
 * All collaborators (store, advisory source, card generator, clock) are
 * injected so the orchestration is unit-testable without git or network.
 */

import type { BroadcastFn, Project, Stmts } from '../types.js';
import config from '../config.js';
import {
  gitHostRepoPath,
  hostedRepoDefaultBranch,
  hostedRepoExists,
} from '../git-host/repo-store.js';
import { gitRepoFileReader, scanResolvedDependencies, type RepoFileReader } from './scanner.js';
import { revParse } from '../native-pr/git-read.js';
import type { AdvisorySource, DependencyFinding } from './types.js';
import type { OpenSecurityBumpPrsResult } from './auto-pr.js';
import {
  createSecurityAuditStore,
  type RecordScanSummary,
  type SecurityAuditStore,
} from './findings-store.js';
import { generateSecurityCard, type SecurityCardDeps } from './card-generation.js';
import { getDb } from '../db.js';

export class SecurityScanError extends Error {
  constructor(
    message: string,
    readonly code: 'not_hosted' | 'empty_repo' | 'bad_ref',
  ) {
    super(message);
    this.name = 'SecurityScanError';
  }
}

/**
 * Per-project scan serialization. Concurrent scans for the SAME project must
 * not interleave: scan A could read an old (vulnerable) tree, scan B could read
 * a newer (fixed) tree, and if A's `recordScanResults` lands AFTER B's, A would
 * reopen findings B already resolved — leaving the store reflecting the older
 * scan. The Hub is the single DB writer, so an in-process promise-chain mutex
 * keyed by project id fully serializes them: the last scan to run wins, and its
 * `now` (captured at record time) is monotonic w.r.t. earlier completions.
 *
 * Scans for DIFFERENT projects still run concurrently.
 */
const scanTails = new Map<string, Promise<unknown>>();

function serializeProjectScan<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const prev = scanTails.get(projectId) ?? Promise.resolve();
  // Run `task` only after the previous scan settles (success OR failure), so one
  // failing scan never blocks the queue.
  const run = prev.then(task, task);
  const tail = run.then(
    () => {},
    () => {},
  );
  scanTails.set(projectId, tail);
  // Drop the map entry once settled if nothing newer queued behind us, so the
  // map doesn't retain a resolved promise per project forever.
  void tail.finally(() => {
    if (scanTails.get(projectId) === tail) scanTails.delete(projectId);
  });
  return run;
}

export interface RunSecurityScanDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  advisorySource: AdvisorySource;
  /** Override the store (tests). Defaults to one bound to the shared db. */
  store?: SecurityAuditStore;
  /** Override the file reader (tests). Defaults to the git-backed reader. */
  reader?: RepoFileReader;
  /** Override card generation (tests). Defaults to {@link generateSecurityCard}. */
  cardGenerator?: typeof generateSecurityCard;
  /** Clock seam (tests). */
  now?: () => number;
  dataDir?: string;
  /**
   * Optional auto-PR opener. When provided AND the scan persisted (i.e. NOT a
   * dry run on a non-default ref), open/refresh the SINGLE combined native Hub
   * PR carrying every fixable advisory bump, reusing the findings just
   * computed. Best-effort: a failure
   * is logged and swallowed so it never fails the scan. The route wires this
   * only when the project opted in (`securityAutoPr.enabled`) and a native PR
   * service is available.
   */
  openBumpPrs?: (ctx: {
    project: Project;
    findings: DependencyFinding[];
    repoPath: string;
    reader: RepoFileReader;
    baseBranch: string;
    baseSha: string;
  }) => Promise<OpenSecurityBumpPrsResult>;
}

export interface RunSecurityScanResult {
  ref: string;
  scannedManifests: string[];
  /** Every lockfile present in the tree this scan (parsed, failed, or truncated). */
  presentManifests: string[];
  /** Lockfiles that matched a parser but could not be read/parsed this scan. */
  failedManifests: string[];
  /** True when more lockfiles existed than the per-scan cap; overflow unscanned. */
  truncated: boolean;
  dependencyCount: number;
  /** Vulnerable dependency occurrences detected this scan, persisted or not. */
  vulnerableFindings: number;
  /**
   * True when the scanned ref is NOT the default-branch tip: the scan ran but
   * persisted NOTHING (no findings written, no sweep, no card). The persisted
   * findings model is project-wide, so only the canonical default branch is
   * authoritative — auditing a feature branch / old commit must not rewrite it.
   */
  dryRun: boolean;
  summary: RecordScanSummary;
  /** Id of the kanban card opened for new findings, when one was created. */
  cardId: string | null;
  /**
   * Result of auto-PR generation: PRs opened/refreshed and bumps skipped.
   * `null` when auto-PR wasn't requested for this run (no opener injected) or
   * this was a dry run.
   */
  autoPr: OpenSecurityBumpPrsResult | null;
}

/** Empty summary for a dry-run (non-default ref): nothing was persisted. */
const EMPTY_SUMMARY: RecordScanSummary = {
  newFindings: [],
  reopenedFindings: [],
  updated: 0,
  fixed: 0,
  suppressed: 0,
};

/**
 * Run a dependency security scan for a single project and persist the
 * results. `ref` defaults to the hosted repo's default branch.
 *
 * Persistence is restricted to the default-branch tip: scanning any other ref
 * (feature branch, old commit) runs the audit but writes NOTHING (`dryRun`),
 * because the persisted findings model is project-wide and a non-default tree
 * must not rewrite it.
 *
 * @throws {SecurityScanError} when the project isn't Hub-hosted (`not_hosted`),
 * the repo has no default branch (`empty_repo`), or `ref` doesn't resolve to a
 * commit (`bad_ref`). A git/network failure mid-scan throws a plain Error so
 * the caller aborts rather than persisting a partial, falsely-clean result.
 */
export async function runSecurityScan(
  deps: RunSecurityScanDeps,
  args: { project: Project; ref?: string; generateCard?: boolean; createdBy?: string | null },
): Promise<RunSecurityScanResult> {
  const dataDir = deps.dataDir ?? config.dataDir;
  const { project } = args;

  if (project.gitHost !== 'agenthub' || !hostedRepoExists(project.id, dataDir)) {
    throw new SecurityScanError(
      `Project ${project.id} is not Agent Hub-hosted; nothing to scan.`,
      'not_hosted',
    );
  }

  // Serialize per project so concurrent scans can't persist stale results out of
  // order (see serializeProjectScan). The whole critical section — ref resolve,
  // git/OSV work, and the store write — runs under the lock.
  return serializeProjectScan(project.id, async () => {
    const defaultBranch = await hostedRepoDefaultBranch(project.id, dataDir);
    const ref = args.ref ?? defaultBranch;
    if (!ref) {
      throw new SecurityScanError(`Project ${project.id} has no default branch.`, 'empty_repo');
    }

    const repoPath = gitHostRepoPath(project.id, dataDir);
    const reader = deps.reader ?? gitRepoFileReader(repoPath);
    const store = deps.store ?? createSecurityAuditStore(getDb());

    // Resolve the requested ref to an immutable commit SHA up front (pins the
    // audited tree; closes a TOCTOU within the scan) and validate it. This is
    // INDEPENDENT of whether a custom reader was injected: the store model is
    // default-branch-only, so a test / future scheduler passing a custom reader
    // (or an arbitrary `ref`) cannot bypass validation or the dry-run gate. A bad
    // ref aborts with a clear error rather than falling through to an empty scan
    // that would mark every open finding `fixed`.
    const scanRef = await revParse(repoPath, ref);
    if (!scanRef) {
      throw new SecurityScanError(`Unknown ref "${ref}" in project ${project.id}.`, 'bad_ref');
    }

    const scan = await scanResolvedDependencies({
      reader,
      ref: scanRef,
      advisorySource: deps.advisorySource,
    });

    // Persist ONLY when the scanned commit is STILL the default-branch tip. The
    // tip is re-resolved HERE — after the (possibly long) git/OSV work, right
    // before persistence — so a branch that advanced mid-scan demotes this run to
    // a dry run instead of overwriting current findings with stale data. The
    // findings model is project-wide, so a non-default ref (feature branch, old
    // commit) must never rewrite it; default to a safe dry-run when the
    // relationship can't be confirmed.
    const defaultTip = defaultBranch ? await revParse(repoPath, defaultBranch) : null;
    const dryRun = !defaultTip || scanRef !== defaultTip;

    // Dry run: the scan ran for visibility, but persist nothing — no findings,
    // no vanished sweep, no card. Return what was found.
    if (dryRun) {
      return {
        ref,
        scannedManifests: scan.scannedManifests,
        presentManifests: scan.presentManifests,
        failedManifests: scan.failedManifests,
        truncated: scan.truncated,
        dependencyCount: scan.dependencyCount,
        vulnerableFindings: scan.findings.length,
        dryRun: true,
        summary: EMPTY_SUMMARY,
        cardId: null,
        autoPr: null,
      };
    }

    // Capture `now` AFTER the async git/OSV work, right before persisting, so it
    // reflects completion order. Combined with the per-project lock this keeps
    // last_seen_at monotonic across serialized scans.
    const now = (deps.now ?? Date.now)();

    // Persist findings AND open the card atomically: if card generation throws,
    // the recorded findings roll back too, so a retry re-classifies them as
    // `newFindings` and a card is still created. Otherwise a failed card insert
    // after a committed scan would strand those vulnerabilities card-less forever
    // (the retry would see them as existing/updated). Both steps are synchronous,
    // so they fit in one better-sqlite3 transaction (recordScanResults nests via
    // a savepoint).
    const cardGenerator = deps.cardGenerator ?? generateSecurityCard;
    const { summary, cardId } = store.transaction(
      (): { summary: RecordScanSummary; cardId: string | null } => {
        const innerSummary = store.recordScanResults({
          projectId: project.id,
          findings: scan.findings,
          scannedManifests: scan.scannedManifests,
          // Full set of lockfiles present in the tree, so the sweep can tell a
          // deleted/renamed manifest (resolve its findings) from one that merely
          // failed to parse / was truncated (preserve its findings).
          presentManifests: scan.presentManifests,
          // Record the exact commit audited (the pinned SHA), not the symbolic
          // ref, so scan_ref reproduces precisely which tree was scanned.
          ref: scanRef,
          now,
        });

        // Both genuinely-new findings and regressions (fixed → open) are
        // card-worthy: a reopened vuln's original card was likely closed, so it
        // must re-enter the remediation workflow.
        const cardFindings = [...innerSummary.newFindings, ...innerSummary.reopenedFindings];
        let card: string | null = null;
        if (args.generateCard !== false && cardFindings.length > 0) {
          const cardDeps: SecurityCardDeps = { stmts: deps.stmts, broadcast: deps.broadcast };
          const result = cardGenerator(cardDeps, {
            projectId: project.id,
            newFindings: cardFindings,
            createdBy: args.createdBy ?? null,
          });
          card = result.card?.id ?? null;
        }
        return { summary: innerSummary, cardId: card };
      },
    );

    // Auto-PR generation runs AFTER the (synchronous) persistence transaction:
    // it does async git writes + PR opens, so it can't sit inside the
    // better-sqlite3 transaction. Best-effort — a failure is logged and never
    // fails the scan. The per-project serialize lock orders same-process scans;
    // cross-process/worker races on a bump branch are handled at the git layer
    // by the compare-and-swap update-ref in commitFilesToBareBranch.
    let autoPr: OpenSecurityBumpPrsResult | null = null;
    if (deps.openBumpPrs) {
      try {
        // Open PRs only for ACTIONABLE findings — i.e. those that reconciled to
        // `open` in the store. `scan.findings` is the raw detection set and
        // includes advisories the user suppressed or manually dismissed; handing
        // those to openBumpPrs would resurrect a bump PR for something the user
        // explicitly silenced. Intersect the freshly-computed findings (which
        // carry the rich advisory/fix data) with the store's open rows by their
        // unique identity (advisory+package+version+manifest).
        const openKeys = new Set(
          store
            .listFindings(project.id, { status: 'open' })
            .map((r) =>
              JSON.stringify([r.advisory_id, r.package_name, r.package_version, r.manifest_path]),
            ),
        );
        const actionable = scan.findings.filter((f) =>
          openKeys.has(
            JSON.stringify([
              f.advisory.id,
              f.dependency.name,
              f.dependency.version,
              f.dependency.manifestPath,
            ]),
          ),
        );
        autoPr = await deps.openBumpPrs({
          project,
          findings: actionable,
          repoPath,
          reader,
          // Non-dry-run guarantees defaultTip resolved, hence defaultBranch is
          // set; `?? ref` only satisfies the type checker.
          baseBranch: defaultBranch ?? ref,
          baseSha: scanRef,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[security-audit] auto-PR generation failed for ${project.id}: ${msg}`);
      }
    }

    return {
      ref,
      scannedManifests: scan.scannedManifests,
      presentManifests: scan.presentManifests,
      failedManifests: scan.failedManifests,
      truncated: scan.truncated,
      dependencyCount: scan.dependencyCount,
      vulnerableFindings: scan.findings.length,
      dryRun: false,
      summary,
      cardId,
      autoPr,
    };
  });
}
