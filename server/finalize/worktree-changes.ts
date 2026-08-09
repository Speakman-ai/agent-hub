/**
 * Worktree change detection for Finalize / push affordances.
 */
import { checkWorktreeChanges, type WorktreeChanges } from '../auto-git.js';
import { isPublishableVerdict, makeNetDiffProbe, type NetDiffProbe } from './net-diff.js';
import type { FinalizeGateBase } from './resolve-base-branch.js';
import type { SessionWorktreeIo } from '../session-env/worktree-io.js';

export type CommittableChangesResult =
  | { ok: true; changes: WorktreeChanges }
  | {
      ok: false;
      error:
        | 'no_worktree'
        | 'no_committable_changes'
        | 'base_unresolved'
        | 'no_pushable_commits'
        | 'worktree_not_on_host';
      message: string;
    };

export interface CommittableChangesOptions {
  /**
   * The session's resolved gate base (see `resolveFinalizeGateBase`). When it
   * is an authoritative `explicit` base, the net-diff gate must prove a real
   * diff vs that branch and fails closed otherwise; `unresolved` blocks
   * outright; `default` keeps the legacy repo-default auto-detect behavior.
   * Omitted → treated as `default`.
   */
  base?: FinalizeGateBase;
  /**
   * Push-time semantics: the caller is about to push HEAD, so the only question
   * that matters is whether HEAD produces a net diff on the base.
   *
   * Neither mode counts uncommitted work — Finalize ships commits, never the
   * working tree. What this flag adds is the `hasUnpushed` skip and fail-closed
   * arbitration: `hasUnpushed` is measured against the branch's *upstream*, so
   * it goes false the moment the branch is pushed even though HEAD still
   * carries a real diff vs base, and a push must not be refused on that.
   *
   * This mode is fail-closed end to end: it must *prove* a net diff, so an
   * undeterminable probe blocks (`base_unresolved`) instead of taking the
   * default base's fail-open path. Pushing without proof is the failure this
   * flag exists to stop.
   */
  requirePushableHead?: boolean;
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

/**
 * Refusal text when the branch has nothing to ship. Names the uncommitted case
 * explicitly: "no commits against the base" reads like lost work to an operator
 * staring at a Changes badge counting their edited files, when the actual
 * problem is that those files were never committed.
 */
function noPushableCommitsMessage(changes: WorktreeChanges): string {
  const base =
    'This branch has no committed changes against its base branch, so nothing ' +
    'would ship and pushing it would open an empty pull request.';
  if (!changes.hasUncommitted) return base;
  return (
    `${base} The worktree does have uncommitted changes — Finalize reviews and ` +
    'pushes commits, not the working tree, so commit them and run Finalize again.'
  );
}

export async function getSessionCommittableChanges(
  io: SessionWorktreeIo | null | undefined,
  opts: CommittableChangesOptions = {},
): Promise<CommittableChangesResult> {
  if (!io) {
    return {
      ok: false,
      error: 'no_worktree',
      message: 'Session has no worktree.',
    };
  }
  // Detection below is worktree-agnostic, but everything this gate opens the
  // door to — rebase, the CI step runner, push — still drives git against a
  // host path. Under `env-owned` sharing that path is the boot-time seed, so
  // letting a run start would rebase and push a branch that has none of the
  // session's work: a silent, irreversible drop. Refuse until those phases go
  // through the worktree seam too.
  if (io.sharing === 'env-owned') {
    return {
      ok: false,
      error: 'worktree_not_on_host',
      message:
        'This session runs in a microVM, where the worktree lives inside the ' +
        'guest. Finalize still commits and pushes from the host copy, which ' +
        'holds only the state the VM booted from — running it would ship an ' +
        'empty or stale branch. Commit and push from inside the session ' +
        'instead.',
    };
  }
  const base: FinalizeGateBase = opts.base ?? { kind: 'default' };
  const changes = await checkWorktreeChanges(io);
  if (!opts.requirePushableHead) {
    // Dirtiness is NOT committable work. Finalize reviews, tests, and pushes
    // commits; it never commits the working tree. Treating an uncommitted
    // worktree as shippable is what let a commit-less session start a full
    // review + CI cycle and park at "no commits on this branch, so nothing
    // would ship" while the Changes badge advertised the edited files. Refuse
    // up front instead, and say which of the two states this is.
    if (!changes.hasUnpushed) {
      return changes.hasUncommitted
        ? { ok: false, error: 'no_pushable_commits', message: noPushableCommitsMessage(changes) }
        : { ok: false, error: 'no_committable_changes', message: NO_CHANGES_MESSAGE };
    }
  }
  // Under `requirePushableHead` the `hasUnpushed` shortcut above is skipped on
  // purpose: it is measured against the branch's upstream, so it goes false the
  // moment the branch is pushed even though HEAD still carries a real diff vs
  // base. Only the probe answers the push-time question.
  //
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
  const net = await probe(io);
  // The ship gate must PROVE a net diff, so an undeterminable probe blocks here
  // whatever the base kind. `isPublishableVerdict` lets `null` through against a
  // default base, which is right for deciding whether to *offer* Finalize (a
  // detection miss must never strand real work behind a disabled button) and
  // wrong for the push itself: failing open on a transient git error recreates
  // exactly the zero-diff PR this gate exists to prevent. Blocking costs
  // nothing real — a base ref we cannot resolve would also break the rebase and
  // leave the PR pointing at a base that does not exist, so such a run was never
  // going to ship correctly anyway.
  if (opts.requirePushableHead && net === null) {
    return { ok: false, error: 'base_unresolved', message: baseUnresolvedMessage(base) };
  }
  if (isPublishableVerdict(net, { explicitBase })) return { ok: true, changes };
  // Not publishable. Distinguish an authoritative base we could not prove a
  // diff against (`null` under an explicit base → fail closed) from a genuine
  // empty diff, so the operator gets an actionable reason rather than a
  // misleading "no changes".
  if (net === null && explicitBase) {
    return { ok: false, error: 'base_unresolved', message: baseUnresolvedMessage(base) };
  }
  // Local work exists (commits, and possibly uncommitted edits) but none of it
  // lands on the base. `no_committable_changes` is reserved for the literally
  // empty session, so the operator can tell "nothing here" from "nothing that
  // would ship".
  return { ok: false, error: 'no_pushable_commits', message: noPushableCommitsMessage(changes) };
}
