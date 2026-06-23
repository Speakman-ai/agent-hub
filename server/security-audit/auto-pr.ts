/**
 * auto-pr.ts — open one native Hub PR per fixable advisory bump.
 *
 * Dependabot-style: for each {@link SecurityBumpPlan} produced from a scan's
 * findings, write the lockfile (+ sibling package.json range) bump onto a
 * deterministic branch in the hosted bare repo and open/refresh a native PR.
 * The deterministic branch name + `createOrGetOpenPullRequest`'s
 * head-branch reuse give two layers of de-dupe against already-open bump PRs.
 *
 * All side-effecting collaborators (file read, branch commit, PR open) are
 * injected so the orchestration is unit-testable without git or the DB.
 */

import path from 'path';
import { createHash } from 'crypto';
import type { DependencyFinding, Severity } from './types.js';
import {
  applyNpmLockfileBump,
  applyPackageJsonRangeBump,
  npmRegistryBaseForPackage,
  planSecurityBumps,
} from './bump.js';
import type { SecurityBumpPlan } from './bump.js';
import type { NpmDistMetadata } from './registry-metadata.js';

export interface SecurityBumpPrResult {
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

/** Slugify a name/version into a git-branch-safe token. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Deterministic branch name for a bump. Same (manifestPath, package, target)
 * → same branch every scan, which is what makes the PR idempotent. The slug
 * portion is a human-readable hint only; uniqueness is guaranteed by a short
 * stable hash of the RAW tuple appended at the end.
 *
 * Why the hash: `slug()` is lossy (it lowercases and collapses `@`, `/`, and
 * runs of non-alphanumerics), so distinct tuples like `@scope/pkg` vs
 * `scope-pkg`, or two manifest directories that normalise alike, would
 * otherwise produce the SAME branch. Two such bumps to the same target version
 * would then collide on one branch and the later `commitFiles` (based on the
 * original base SHA) would overwrite the earlier one. The raw-tuple hash makes
 * the branch collision-safe while the slug keeps it readable.
 */
export function bumpBranchName(plan: SecurityBumpPlan): string {
  const dir = path.posix.dirname(plan.manifestPath);
  const dirSlug = dir && dir !== '.' ? `${slug(dir)}-` : '';
  // Hash the RAW, unambiguous tuple (not the lossy slugs). JSON.stringify gives
  // an injective, separator-safe encoding of the three strings.
  const hash = createHash('sha256')
    .update(JSON.stringify([plan.manifestPath, plan.packageName, plan.toVersion]))
    .digest('hex')
    .slice(0, 12);
  return `agenthub/security/bump-${dirSlug}${slug(plan.packageName)}-${slug(plan.toVersion)}-${hash}`;
}

function prTitle(plan: SecurityBumpPlan): string {
  const dir = path.posix.dirname(plan.manifestPath);
  const where = dir && dir !== '.' ? ` in ${dir}` : '';
  return `security: bump ${plan.packageName} to ${plan.toVersion}${where}`;
}

function prBody(
  plan: SecurityBumpPlan,
  opts: { bumpedPackageJson: boolean; rootDependencyBumped: boolean; lockfilePinned: boolean },
): string {
  const lines: string[] = [];
  const fromList = plan.fromVersions.map((v) => `\`${v}\``).join(', ');
  const plural = plan.fromVersions.length > 1 ? 's' : '';
  lines.push(
    `Automated security bump of \`${plan.packageName}\` from ${fromList} (${plan.fromVersions.length} ` +
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
  if (!opts.rootDependencyBumped) {
    // Transitive: only the nested lockfile entry was bumped; the root manifest
    // range is intentionally left alone.
    lines.push(
      'Transitive dependency — only the lockfile entry was updated; the root `package.json` ' +
        'range was left unchanged.',
    );
  } else {
    lines.push(
      opts.bumpedPackageJson
        ? 'Updated the lockfile version and the matching `package.json` range.'
        : 'Updated the lockfile version (no matching `package.json` range to change).',
    );
  }
  lines.push('');
  if (opts.lockfilePinned) {
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
  return lines.join('\n');
}

/**
 * Open/refresh a native bump PR for every fixable advisory in `findings`.
 * Best-effort per plan: one failing bump is recorded in `skipped` and never
 * blocks the others. Returns what was opened and what was skipped (with why).
 */
export async function openSecurityBumpPrs(
  findings: DependencyFinding[],
  deps: OpenSecurityBumpPrsDeps,
): Promise<OpenSecurityBumpPrsResult> {
  const plans = planSecurityBumps(findings);
  const opened: SecurityBumpPrResult[] = [];
  const skipped: SecurityBumpPrSkip[] = [];

  for (const plan of plans) {
    try {
      const lockContent = await deps.readFile(plan.manifestPath);
      if (lockContent === null) {
        skipped.push({
          manifestPath: plan.manifestPath,
          packageName: plan.packageName,
          toVersion: plan.toVersion,
          reason: 'lockfile_missing',
        });
        continue;
      }
      // Apply EVERY vulnerable installed version's bump, threading the content
      // so all copies land in one commit/PR. (A package can be present at
      // several versions at once — a direct dep + transitive copies.) Skipping
      // per-version into separate plans/branches would let the later commit,
      // based on the same baseSha, overwrite the earlier and leave a copy
      // unbumped. `rootDependencyBumped` is the OR across versions: true if ANY
      // bumped entry was a top-level (direct) install.
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
        // safe to change, so skip rather than open an empty PR.
        skipped.push({
          manifestPath: plan.manifestPath,
          packageName: plan.packageName,
          toVersion: plan.toVersion,
          reason: 'lockfile_unchanged',
        });
        continue;
      }

      const files: Record<string, string> = { [plan.manifestPath]: lockText };

      // Only bump the sibling package.json when a bumped install entry is the
      // root project's DIRECT dependency. A transitive/nested bump must not
      // rewrite the root range — that range may belong to an unrelated direct
      // dependency that happens to share the package name.
      let bumpedPackageJson = false;
      if (rootDependencyBumped) {
        const pkgJsonPath = path.posix.join(path.posix.dirname(plan.manifestPath), 'package.json');
        const pkgContent = await deps.readFile(pkgJsonPath);
        if (pkgContent !== null) {
          const newPkg = applyPackageJsonRangeBump(pkgContent, {
            packageName: plan.packageName,
            toVersion: plan.toVersion,
          });
          if (newPkg !== null) {
            files[pkgJsonPath] = newPkg;
            bumpedPackageJson = true;
          }
        }
      }

      const branch = bumpBranchName(plan);
      const commit = await deps.commitFiles({
        branch,
        files,
        message: prTitle(plan),
      });
      const pr = deps.createOrGetOpenPr({
        headBranch: branch,
        headSha: commit.headSha,
        title: prTitle(plan),
        body: prBody(plan, { bumpedPackageJson, rootDependencyBumped, lockfilePinned: !!dist }),
      });

      opened.push({
        branch,
        manifestPath: plan.manifestPath,
        packageName: plan.packageName,
        fromVersions: plan.fromVersions,
        toVersion: plan.toVersion,
        advisoryIds: plan.advisoryIds,
        severity: plan.severity,
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        prCreated: pr.prCreated,
        branchUpdated: commit.created,
      });
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

  return { opened, skipped };
}
