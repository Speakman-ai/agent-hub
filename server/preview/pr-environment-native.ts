/**
 * Authoritative state of a Hub-hosted PR for PR-environment reconciliation.
 *
 * Runs inside the per-PR queue (`PrEnvironmentService.reconcile`). The PR row
 * is re-read AFTER the async head lookup, so a close or merge that lands
 * while the lookup is in flight wins instead of being overwritten by a
 * stale "open" snapshot.
 */
import type { PullRequestRow } from '../types.js';
import type { PrAuthoritativeState } from './pr-environments.js';

export interface NativePrStateDeps {
  getPr: (projectId: string, number: number) => PullRequestRow | undefined;
  /** Current sha of the head branch in the hosted repo, or null. */
  revParseHead: (projectId: string, branch: string) => Promise<string | null>;
}

const terminal = (row: PullRequestRow): PrAuthoritativeState => ({
  status: row.status === 'merged' ? 'merged' : 'closed',
});

export async function readNativePrState(
  deps: NativePrStateDeps,
  projectId: string,
  number: number,
): Promise<PrAuthoritativeState> {
  const before = deps.getPr(projectId, number);
  if (!before) return null;
  if (before.status !== 'open') return terminal(before);
  let live: string | null = null;
  try {
    live = await deps.revParseHead(projectId, before.head_branch);
  } catch {
    live = null;
  }
  const row = deps.getPr(projectId, number);
  if (!row) return null;
  if (row.status !== 'open') return terminal(row);
  return { status: 'open', headSha: live ?? row.head_sha, headBranch: row.head_branch };
}
