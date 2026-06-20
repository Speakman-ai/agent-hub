/**
 * on-push.ts — run the dependency security audit when a Hub-hosted repo's
 * DEFAULT BRANCH moves (smart-HTTP push or native PR merge).
 *
 * Opt-in via `Project.securityScan.onPush`. Mirrors push-ci's shape: gate on
 * the flag + hosted repo, serialize per project so two rapid pushes don't race
 * the same scan, and only fire when the *default branch* is among the updated
 * refs (the findings model is default-branch-only — runSecurityScan demotes any
 * other ref to a no-persist dry run anyway, but skipping here avoids a wasted
 * git/OSV round trip on feature-branch pushes).
 *
 * Suppressions are respected (the store reconciles them) and a card is opened
 * ONLY when the scan surfaces genuinely-new findings — runSecurityScan already
 * gates card creation on `newFindings + reopenedFindings > 0`. Best-effort and
 * fire-and-forget: a scan failure is logged and swallowed so a bad scan never
 * breaks the push notify path.
 */

import config from '../config.js';
import type { BroadcastFn, Project, Stmts } from '../types.js';
import { hostedRepoDefaultBranch, hostedRepoExists } from '../git-host/repo-store.js';
import type { AdvisorySource } from './types.js';
import { OsvAdvisorySource } from './osv.js';
import { runSecurityScan } from './run.js';

export interface PushSecurityScanDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  dataDir?: string;
  /** Advisory source. Defaults to OSV over the network. */
  advisorySource?: AdvisorySource;
  /** Test seam — defaults to {@link runSecurityScan}. */
  runScan?: typeof runSecurityScan;
  /** Override for tests to silence console noise. */
  log?: (msg: string) => void;
}

/** True when on-push scanning is opted in for a Hub-hosted project. */
export function securityScanOnPushEnabled(project: Project): boolean {
  return project.gitHost === 'agenthub' && project.securityScan?.onPush === true;
}

/** Per-project serialization so two rapid pushes don't race a scan. */
const queues = new Map<string, Promise<void>>();

function enqueue(projectId: string, work: () => Promise<void>): Promise<void> {
  const prior = queues.get(projectId) ?? Promise.resolve();
  const next = prior.then(work).catch((err: unknown) => {
    console.error(
      `[security-on-push] unexpected failure for ${projectId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  queues.set(projectId, next);
  // Drop the entry once settled if nothing newer queued behind us.
  void next.finally(() => {
    if (queues.get(projectId) === next) queues.delete(projectId);
  });
  return next;
}

/**
 * Default-branch security scan trigger. Called from the smart-HTTP post-receive
 * notify path and the native-PR merge hook. Fire-and-forget safe; returns the
 * chain tail so tests can await it.
 */
export function maybeRunPushSecurityScan(
  project: Project,
  updatedRefs: string[],
  deps: PushSecurityScanDeps,
): Promise<void> {
  if (!securityScanOnPushEnabled(project)) return Promise.resolve();
  const dataDir = deps.dataDir ?? config.dataDir;
  if (!hostedRepoExists(project.id, dataDir)) return Promise.resolve();

  return enqueue(project.id, async () => {
    const log = deps.log ?? ((msg: string) => console.log(msg));
    const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
    if (!updatedRefs.includes(`refs/heads/${defaultBranch}`)) return;
    const runScan = deps.runScan ?? runSecurityScan;
    try {
      const result = await runScan(
        {
          stmts: deps.stmts,
          broadcast: deps.broadcast,
          advisorySource: deps.advisorySource ?? new OsvAdvisorySource(),
          dataDir,
        },
        { project, generateCard: true, createdBy: null },
      );
      if (
        !result.dryRun &&
        result.summary.newFindings.length + result.summary.reopenedFindings.length > 0
      ) {
        log(
          `[security-on-push] ${project.id} ${defaultBranch}: ${result.summary.newFindings.length} new, ` +
            `${result.summary.reopenedFindings.length} reopened${result.cardId ? ` → card ${result.cardId}` : ''}`,
        );
      }
    } catch (err: unknown) {
      log(
        `[security-on-push] scan failed for ${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

/** Test seam: drop queued chains between tests. */
export function __clearPushSecurityScanQueues(): void {
  queues.clear();
}
