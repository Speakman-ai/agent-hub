/**
 * auto-pr.ts — open ONE native Hub PR carrying every fixable advisory bump.
 *
 * Dependabot-style grouped update: take the {@link SecurityBumpPlan}s produced
 * from a scan's findings, accumulate every lockfile (+ sibling package.json
 * range) bump into a SINGLE commit on one deterministic rolling branch in the
 * hosted bare repo, and open/refresh a single native PR. A fixed branch name +
 * `createOrGetOpenPullRequest`'s head-branch reuse keep that one security PR
 * idempotent across re-scans: the branch is rebuilt from the current open
 * fixable set each run, so the PR rolls forward as advisories appear/resolve
 * instead of spawning a separate PR per package.
 *
 * All side-effecting collaborators (file read, branch commit, PR open) are
 * injected so the orchestration is unit-testable without git or the DB.
 */

import path from 'path';
import type { DependencyFinding, Severity } from './types.js';
import {
  applyNpmLockfileBump,
  applyPackageJsonRangeBump,
  npmRegistryBaseForPackage,
  planSecurityBumps,
} from './bump.js';
import type { SecurityBumpPlan } from './bump.js';
import type { NpmDistMetadata } from './registry-metadata.js';

/**
 * The single rolling branch every security bump lands on. One PR per project:
 * both the scan-path auto-PR and the per-finding Fix button rebuild THIS branch
 * from the full open fixable set, so they converge on one PR rather than racing
 * each other onto per-package branches.
 */
export const SECURITY_BUMP_BRANCH = 'agenthub/security/bumps';

export interface SecurityBumpPrResult {
  /** Shared rolling branch all bumps in this run land on ({@link SECURITY_BUMP_BRANCH}). */
  branch: string;
  manifestPath: string;
  packageName: string;
  /** Every vulnerable installed version bumped to `toVersion` in this PR, ascending. */
  fromVersions: string[];
  toVersion: string;
  advisoryIds: string[];
  severity: Severity;
  prNumber: number;
  prUrl: string;
  /** True when the PR row was newly created (vs. an open one refreshed). */
  prCreated: boolean;
  /** True when a new branch commit was written (vs. an identical one reused). */
  branchUpdated: boolean;
}

export interface SecurityBumpPrSkip {
  manifestPath: string;
  packageName: string;
  toVersion: string;
  reason: 'lockfile_missing' | 'lockfile_unchanged' | 'error';
  detail?: string;
}

export interface OpenSecurityBumpPrsResult {
  opened: SecurityBumpPrResult[];
  skipped: SecurityBumpPrSkip[];
}

export interface OpenSecurityBumpPrsDeps {
  /** Read a root-relative file from the base tree; `null` when absent. */
  readFile: (relPath: string) => Promise<string | null>;
  /** Commit `files` onto `branch` (based on the bump base); returns head sha. */
  commitFiles: (args: {
    branch: string;
    files: Record<string, string>;
    message: string;
  }) => Promise<{ headSha: string; created: boolean }>;
  /** Open or refresh the native PR for `headBranch`. */
  createOrGetOpenPr: (args: {
    headBranch: string;
    headSha: string;
    title: string;
    body: string;
  }) => { prNumber: number; prUrl: string; prCreated: boolean };
  /**
   * Resolve the registry `dist` (tarball + integrity) for `packageName@version`
   * from `registryUrl` so the bumped lockfile entry can be re-pinned fully
   * instead of dropping those fields — which is what eliminates the recurring
   * "lockfile entry is missing resolved/integrity" reviewer comment.
   *
   * `registryUrl` is the registry the lockfile ALREADY pins this package to
   * (derived from the existing `resolved` URL); querying it keeps the rewritten
   * `resolved` on the same registry/mirror instead of rewriting provenance to
   * the public npm registry. The orchestrator only calls this when a registry
   * could be safely derived; an undeterminable registry skips enrichment and
   * drops the fields. Best-effort: return `null` (or omit the dep) to fall back
   * to the drop-behavior. A rejection is caught per-plan and treated as `null`.
   */
  fetchDistMetadata?: (
    packageName: string,
    version: string,
    registryUrl: string,
  ) => Promise<NpmDistMetadata | null>;
}

/** Per-plan edit outcome, accumulated before the single combined commit. */
interface AppliedBump {
  plan: SecurityBumpPlan;
  bumpedPackageJson: boolean;
  rootDependencyBumped: boolean;
  lockfilePinned: boolean;
}

function prTitle(applied: AppliedBump[]): string {
  if (applied.length === 1) {
    const { plan } = applied[0]!;
    const dir = path.posix.dirname(plan.manifestPath);
    const where = dir && dir !== '.' ? ` in ${dir}` : '';
    return `security: bump ${plan.packageName} to ${plan.toVersion}${where}`;
  }
  return `security: bump ${applied.length} dependencies`;
}

/** Markdown detail block for one bumped package (advisories + lockfile notes). */
function planSection(applied: AppliedBump): string[] {
  const { plan, bumpedPackageJson, rootDependencyBumped, lockfilePinned } = applied;
  const lines: string[] = [];
  const fromList = plan.fromVersions.map((v) => `\`${v}\``).join(', ');
  const plural = plan.fromVersions.length > 1 ? 's' : '';
  lines.push(
    `Bump of \`${plan.packageName}\` from ${fromList} (${plan.fromVersions.length} ` +
      `installed version${plural}) to \`${plan.toVersion}\` in \`${plan.manifestPath}\`.`,
  );
  lines.push('');
  lines.push(
    `Resolves ${plan.advisoryIds.length} advisor${plan.advisoryIds.length === 1 ? 'y' : 'ies'}:`,
  );
  for (const adv of plan.advisories) {
    const link = adv.url ? `[${adv.id}](${adv.url})` : adv.id;
    const summary = adv.summary ? ` — ${adv.summary}` : '';
    lines.push(`- **${adv.severity}** ${link}${summary}`);
  }
  lines.push('');
  if (!rootDependencyBumped) {
    // Transitive: only the nested lockfile entry was bumped; the root manifest
    // range is intentionally left alone.
    lines.push(
      'Transitive dependency — only the lockfile entry was updated; the root `package.json` ' +
        'range was left unchanged.',
    );
  } else {
    lines.push(
      bumpedPackageJson
        ? 'Updated the lockfile version and the matching `package.json` range.'
        : 'Updated the lockfile version (no matching `package.json` range to change).',
    );
  }
  lines.push('');
  if (lockfilePinned) {
    lines.push(
      '> The bumped lockfile entry was re-pinned with the registry `resolved` URL and ' +
        '`integrity` hash for the target version, so the lockfile stays fully pinned and ' +
        'needs no manual reconciliation before merging.',
    );
  } else {
    lines.push(
      '> Note: the registry `resolved`/`integrity` for the target version could not be ' +
        'fetched, so the bumped lockfile entry has its now-stale fields dropped. Run ' +
        '`npm install` to reconcile the lockfile before merging.',
    );
  }
  return lines;
}

function prBody(applied: AppliedBump[]): string {
  // Single bump: keep the body lean (no package subheadings).
  if (applied.length === 1) return planSection(applied[0]!).join('\n');

  const lines: string[] = [];
  lines.push(
    `Automated security bump of ${applied.length} dependencies in a single PR ` +
      '(grouped Dependabot-style so every fixable advisory lands in one place).',
  );
  for (const a of applied) {
    lines.push('');
    lines.push(`### \`${a.plan.packageName}\` → \`${a.plan.toVersion}\``);
    lines.push('');
    lines.push(...planSection(a));
  }
  return lines.join('\n');
}

/**
 * Open/refresh the single native security bump PR carrying every fixable
 * advisory in `findings`. All bumps are accumulated into one commit on the
 * shared {@link SECURITY_BUMP_BRANCH} and surfaced as one PR.
 *
 * Best-effort per plan during the edit phase: a plan whose manifest is
 * missing/unchanged or whose bump throws is recorded in `skipped` and never
 * blocks the others. If, after accumulation, at least one bump applied, a
 * single commit + PR is opened; if that final commit/PR step fails, every
 * applied bump is reported in `skipped` (the function never throws). Returns
 * what was opened (one entry per package, all sharing the same branch/PR) and
 * what was skipped (with why).
 */
export async function openSecurityBumpPrs(
  findings: DependencyFinding[],
  deps: OpenSecurityBumpPrsDeps,
): Promise<OpenSecurityBumpPrsResult> {
  const plans = planSecurityBumps(findings);
  const opened: SecurityBumpPrResult[] = [];
  const skipped: SecurityBumpPrSkip[] = [];

  // Accumulate every plan's edits into ONE fileset. Manifest/package.json
  // content is threaded through a cache so two plans touching the same lockfile
  // (different packages) both land instead of the second clobbering the first.
  const files: Record<string, string> = {};
  // `undefined` = not read yet; `null` = read and absent; string = current text.
  const fileCache = new Map<string, string | null>();
  const applied: AppliedBump[] = [];

  const readCached = async (relPath: string): Promise<string | null> => {
    const cached = fileCache.get(relPath);
    if (cached !== undefined) return cached;
    const content = await deps.readFile(relPath);
    fileCache.set(relPath, content);
    return content;
  };

  for (const plan of plans) {
    try {
      const lockContent = await readCached(plan.manifestPath);
      if (lockContent === null) {
        skipped.push({
          manifestPath: plan.manifestPath,
          packageName: plan.packageName,
          toVersion: plan.toVersion,
          reason: 'lockfile_missing',
        });
        continue;
      }
      // Resolve the registry dist metadata ONCE per plan (one target version)
      // so the bumped entry is re-pinned with the new resolved/integrity.
      //
      // Registry-aware: query the SAME registry the lockfile already pins this
      // package to (derived from its existing `resolved` URL) so we never
      // rewrite a private-registry/mirror `resolved` to the public npm one. When
      // no registry can be safely derived (entry already lacks `resolved`, a
      // git/url specifier, unparseable lockfile), skip enrichment and let the
      // fields be dropped. A null result (registry unreachable, unpublished
      // version, fetcher not wired) likewise falls back to dropping — the bump
      // still proceeds.
      let dist: NpmDistMetadata | undefined;
      if (deps.fetchDistMetadata) {
        const registryUrl = npmRegistryBaseForPackage(lockContent, plan.packageName);
        if (registryUrl) {
          try {
            dist =
              (await deps.fetchDistMetadata(plan.packageName, plan.toVersion, registryUrl)) ??
              undefined;
          } catch {
            dist = undefined;
          }
        }
      }

      // Apply EVERY vulnerable installed version's bump, threading the content
      // so all copies land in one commit/PR. (A package can be present at
      // several versions at once — a direct dep + transitive copies.)
      // `rootDependencyBumped` is the OR across versions: true if ANY bumped
      // entry was a top-level (direct) install.
      let lockText = lockContent;
      let anyBumped = false;
      let rootDependencyBumped = false;
      for (const fromVersion of plan.fromVersions) {
        const lockBump = applyNpmLockfileBump(lockText, {
          packageName: plan.packageName,
          fromVersion,
          toVersion: plan.toVersion,
          dist,
        });
        if (lockBump === null) continue; // this version already bumped / absent
        lockText = lockBump.content;
        anyBumped = true;
        rootDependencyBumped = rootDependencyBumped || lockBump.rootDependencyBumped;
      }
      if (!anyBumped) {
        // No entry at any expected version — already bumped or absent. Nothing
        // safe to change, so skip rather than carry an empty edit.
        skipped.push({
          manifestPath: plan.manifestPath,
          packageName: plan.packageName,
          toVersion: plan.toVersion,
          reason: 'lockfile_unchanged',
        });
        continue;
      }

      // Persist the accumulated lockfile content so a later plan on the same
      // manifest builds on this edit instead of re-reading the base.
      fileCache.set(plan.manifestPath, lockText);
      files[plan.manifestPath] = lockText;

      // Only bump the sibling package.json when a bumped install entry is the
      // root project's DIRECT dependency. A transitive/nested bump must not
      // rewrite the root range — that range may belong to an unrelated direct
      // dependency that happens to share the package name. Thread package.json
      // through the same cache so multiple direct-dep bumps in one manifest
      // accumulate.
      let bumpedPackageJson = false;
      if (rootDependencyBumped) {
        const pkgJsonPath = path.posix.join(path.posix.dirname(plan.manifestPath), 'package.json');
        const pkgContent = await readCached(pkgJsonPath);
        if (pkgContent !== null) {
          const newPkg = applyPackageJsonRangeBump(pkgContent, {
            packageName: plan.packageName,
            toVersion: plan.toVersion,
          });
          if (newPkg !== null) {
            fileCache.set(pkgJsonPath, newPkg);
            files[pkgJsonPath] = newPkg;
            bumpedPackageJson = true;
          }
        }
      }

      applied.push({ plan, bumpedPackageJson, rootDependencyBumped, lockfilePinned: !!dist });
    } catch (err: unknown) {
      skipped.push({
        manifestPath: plan.manifestPath,
        packageName: plan.packageName,
        toVersion: plan.toVersion,
        reason: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Nothing applied → no commit, no PR. (Either no fixable findings, or every
  // plan was missing/unchanged/errored — all already recorded in `skipped`.)
  if (applied.length === 0) return { opened, skipped };

  const branch = SECURITY_BUMP_BRANCH;
  const title = prTitle(applied);
  try {
    const commit = await deps.commitFiles({ branch, files, message: title });
    const pr = deps.createOrGetOpenPr({
      headBranch: branch,
      headSha: commit.headSha,
      title,
      body: prBody(applied),
    });
    for (const a of applied) {
      opened.push({
        branch,
        manifestPath: a.plan.manifestPath,
        packageName: a.plan.packageName,
        fromVersions: a.plan.fromVersions,
        toVersion: a.plan.toVersion,
        advisoryIds: a.plan.advisoryIds,
        severity: a.plan.severity,
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        prCreated: pr.prCreated,
        branchUpdated: commit.created,
      });
    }
  } catch (err: unknown) {
    // The single commit/PR failed — attribute the failure to every bump that
    // would have ridden it, so the caller sees nothing silently dropped.
    const detail = err instanceof Error ? err.message : String(err);
    for (const a of applied) {
      skipped.push({
        manifestPath: a.plan.manifestPath,
        packageName: a.plan.packageName,
        toVersion: a.plan.toVersion,
        reason: 'error',
        detail,
      });
    }
  }

  return { opened, skipped };
}
