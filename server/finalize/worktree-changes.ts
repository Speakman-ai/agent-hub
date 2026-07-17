/**
 * Worktree change detection for Finalize / push affordances.
 */
import { checkWorktreeChanges, type WorktreeChanges } from '../auto-git.js';
import { isPublishableVerdict, makeNetDiffProbe, type NetDiffProbe } from './net-diff.js';
import type { FinalizeGateBase } from './resolve-base-branch.js';

export type CommittableChangesResult =
  | { ok: true; changes: WorktreeChanges }
  | {
      ok: false;
      error: 'no_worktree' | 'no_committable_changes' | 'base_unresolved';
      message: string;
    };

export function isCommittable(changes: WorktreeChanges): boolean {
  return changes.hasUncommitted || changes.hasUnpushed;
}

export interface CommittableChangesOptions {
  /**
   * The session's resolved gate base (see `resolveFinalizeGateBase`). When it
   * is an authoritative `explicit` base, the net-diff gate must prove a real
   * diff vs that branch and fails closed otherwise; `unresolved` blocks
   * outright; `default` keeps the legacy repo-default auto-detect behavior.
   * Omitted → treated as `default`.
   */
  base?: FinalizeGateBase;
  /** Injectable probe (tests); overrides the `base`-derived probe. */
  probe?: NetDiffProbe;
}

const NO_CHANGES_MESSAGE = 'No committable changes in the session worktree.';

function baseUnresolvedMessage(base: FinalizeGateBase): string {
  const target = base.kind === 'explicit' ? ` (${base.baseBranch})` : '';
  return (
    `Could not verify a net diff against the session's PR base branch${target}. ` +
    'Fetch the base branch and retry — Finalize will not ship an unverified ' +
    '(possibly empty) change set against the wrong base.'
  );
}

export async function getSessionCommittableChanges(
  worktreePath: string | null | undefined,
  opts: CommittableChangesOptions = {},
): Promise<CommittableChangesResult> {
  if (!worktreePath) {
    return {
      ok: false,
      error: 'no_worktree',
      message: 'Session has no worktree.',
    };
  }
  const base: FinalizeGateBase = opts.base ?? { kind: 'default' };
  const changes = await checkWorktreeChanges(worktreePath);
  // A dirty worktree always carries an uncommitted diff — committable regardless
  // of the base branch.
  if (changes.hasUncommitted) return { ok: true, changes };
  if (!changes.hasUnpushed) {
    return { ok: false, error: 'no_committable_changes', message: NO_CHANGES_MESSAGE };
  }
  // Unpushed commits alone are not enough: the net-diff gate must show the
  // branch produces something on its real target. An authoritative base that
  // cannot even be resolved blocks outright — regardless of any injected probe
  // — since we never fall back to the repo default for a stacked session (the
  // empty-stacked-change hole). This must precede the probe so an injected
  // probe cannot bypass the fail-closed contract.
  if (base.kind === 'unresolved') {
    return { ok: false, error: 'base_unresolved', message: baseUnresolvedMessage(base) };
  }
  const explicitBase = base.kind === 'explicit';
  const probe = opts.probe ?? makeNetDiffProbe(explicitBase ? base.baseBranch : null);
  const net = await probe(worktreePath);
  if (isPublishableVerdict(net, { explicitBase })) return { ok: true, changes };
  // Not publishable. Distinguish an authoritative base we could not prove a
  // diff against (`null` under an explicit base → fail closed) from a genuine
  // empty diff, so the operator gets an actionable reason rather than a
  // misleading "no changes".
  if (net === null && explicitBase) {
    return { ok: false, error: 'base_unresolved', message: baseUnresolvedMessage(base) };
  }
  return { ok: false, error: 'no_committable_changes', message: NO_CHANGES_MESSAGE };
}
