/**
 * ship-gate.ts — gate direct `gh pr create` when Finalize is configured.
 *
 * Card-linked sessions whose worktree contains `.agent-hub/ci.yaml` must
 * ship through **Finalize Code Changes** instead of the legacy
 * create-ticket-and-pr / ship-pr skill path.
 */
import { access } from 'fs/promises';
import path from 'path';
import type { FinalizeRunRow, SessionRow, Stmts } from '../types.js';
import { computeIdempotencyKey, DEFAULT_CI_CONFIG_RELATIVE_PATH } from './finalize-keys.js';

const TERMINAL_STATUSES = new Set([
  'pushed',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
]);

/**
 * Defensive ceiling on the attempt walk that finds the newest full-mode run
 * for a head. Mirrors `MAX_FINALIZE_ATTEMPTS` in trigger-run.ts — attempts are
 * created contiguously so the walk normally stops at the first gap.
 */
const SHIP_GATE_MAX_ATTEMPTS = 200;

const IN_FLIGHT_STATUSES = new Set([
  'queued',
  'rebasing',
  'reviewing',
  'running',
  'dispatching',
  'pushing',
]);

export type FinalizeShipGateCode =
  | 'allowed'
  | 'existing_pr'
  | 'no_finalize_config'
  | 'no_card'
  | 'no_worktree'
  | 'in_flight'
  | 'failed'
  | 'must_use_finalize';

export interface FinalizeShipGateResult {
  allowed: boolean;
  code: FinalizeShipGateCode;
  message: string;
  run_id?: string | null;
  failure_reason?: string | null;
}

/**
 * Which spawn-guarded command is asking. `git_push` may attach commits to an
 * already-open PR; `gh_pr_create` must never run when a PR already exists (it
 * would open a duplicate). Defaults to the stricter `gh_pr_create` so legacy
 * callers that don't pass an action keep today's behavior.
 */
export type FinalizeShipGateAction = 'git_push' | 'gh_pr_create';

export interface EvaluateFinalizeShipGateArgs {
  session: SessionRow;
  projectId: string;
  headSha: string | null;
  /** What the caller wants to do; defaults to `gh_pr_create` (stricter). */
  action?: FinalizeShipGateAction;
  /** Resolved PR URL for this session's branch, if one is already open. */
  existingPrUrl?: string | null;
}

export interface EvaluateFinalizeShipGateDeps {
  stmts: Pick<Stmts, 'getActiveFinalizeRunForSession' | 'getFinalizeRunByIdempotencyKey'>;
  ciConfigExists?: (worktreePath: string) => Promise<boolean>;
}

async function defaultCiConfigExists(worktreePath: string): Promise<boolean> {
  try {
    await access(path.join(worktreePath, DEFAULT_CI_CONFIG_RELATIVE_PATH));
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the newest full-mode Finalize run for a head SHA across manual re-run
 * attempts.
 *
 * Each explicit user re-run bumps the kickoff `attempt`, opening its own
 * idempotency-keyed row so the Finalize timeline stays append-only. Attempts
 * are created contiguously from 1, so we walk attempt keys and return the
 * HIGHEST attempt that has a row. The newest attempt is authoritative: an
 * earlier attempt that reached `ready_to_push` does NOT win when a later
 * attempt superseded it (a re-run that failed or is still in flight). The
 * caller evaluates status only after this selection.
 *
 * Stops at the first attempt with no row. The cap and the same-row guard are
 * defensive backstops (the latter against a lookup that ignores the attempt
 * segment and returns the same row for every key).
 */
export function findLatestFinalizeRunForHead(
  lookup: (idempotencyKey: string) => FinalizeRunRow | undefined,
  args: { projectId: string; branch: string; headSha: string },
): FinalizeRunRow | undefined {
  let latest: FinalizeRunRow | undefined;
  for (let attempt = 1; attempt <= SHIP_GATE_MAX_ATTEMPTS; attempt++) {
    const idempotencyKey = computeIdempotencyKey({
      projectId: args.projectId,
      branch: args.branch,
      headSha: args.headSha,
      attempt,
    });
    const row = lookup(idempotencyKey);
    if (!row) break;
    if (latest && row.id === latest.id) break;
    latest = row;
  }
  return latest;
}

/**
 * Decide whether a session may open a PR via `gh pr create` directly.
 */
export async function evaluateFinalizeShipGate(
  deps: EvaluateFinalizeShipGateDeps,
  args: EvaluateFinalizeShipGateArgs,
): Promise<FinalizeShipGateResult> {
  const { session, projectId, headSha } = args;
  const action: FinalizeShipGateAction = args.action ?? 'gh_pr_create';
  const existingPrUrl =
    typeof args.existingPrUrl === 'string' && args.existingPrUrl.trim()
      ? args.existingPrUrl.trim()
      : null;
  const ciExists = deps.ciConfigExists ?? defaultCiConfigExists;

  if (!session.worktree_path || !session.worktree_branch) {
    return {
      allowed: true,
      code: 'no_worktree',
      message: 'Session has no worktree; legacy ship path allowed.',
    };
  }

  const hasCi = await ciExists(session.worktree_path);
  if (!hasCi) {
    return {
      allowed: true,
      code: 'no_finalize_config',
      message: 'No .agent-hub/ci.yaml in worktree; legacy ship path allowed.',
    };
  }

  // An open PR already exists for this branch (linked card or session title).
  // The Finalize gate exists to force the *first* push through local CI before
  // a PR opens; once a PR exists, every push re-triggers GitHub's PR checks, so
  // attaching commits is safe and matches the "commit & push to the existing
  // branch" guidance in the spawn prompt. Allow `git push`; still block
  // `gh pr create` so we never open a duplicate PR.
  if (existingPrUrl) {
    if (action === 'git_push') {
      return {
        allowed: true,
        code: 'existing_pr',
        message: `A pull request is already open for this branch (${existingPrUrl}); pushing attaches your commits and re-runs its checks.`,
      };
    }
    return {
      allowed: false,
      code: 'existing_pr',
      message: `A pull request is already open for this branch (${existingPrUrl}). Push to the branch to update it — do not run \`gh pr create\` (it would open a duplicate).`,
    };
  }

  if (!headSha) {
    return {
      allowed: false,
      code: 'must_use_finalize',
      message:
        'This project uses Finalize Code Changes. Click **Finalize Code Changes** on the session (do not run `gh pr create` directly).',
    };
  }

  const active = deps.stmts.getActiveFinalizeRunForSession.get(session.id) as
    | FinalizeRunRow
    | undefined;
  if (active && IN_FLIGHT_STATUSES.has(active.status)) {
    return {
      allowed: false,
      code: 'in_flight',
      message: `A Finalize run is in flight (${active.status}, phase ${active.phase ?? 'n/a'}). Wait for it to finish or cancel it before opening a PR directly.`,
      run_id: active.id,
      failure_reason: active.failure_reason,
    };
  }

  // Select the NEWEST full-mode run for this head, then evaluate its status.
  // A head can carry multiple runs once a user re-runs Finalize (each kickoff
  // `attempt` bump opens its own idempotency-keyed row). The newest attempt is
  // authoritative — gating on an earlier attempt would misreport the re-run's
  // state, including the case the gate must never get wrong: attempt 1 reached
  // `ready_to_push`, then a re-run (attempt 2) failed or is still in flight, so
  // shipping must be gated on attempt 2, not the stale success.
  const existing = findLatestFinalizeRunForHead(
    (key) => deps.stmts.getFinalizeRunByIdempotencyKey.get(key) as FinalizeRunRow | undefined,
    { projectId, branch: session.worktree_branch, headSha },
  );

  if (!existing) {
    return {
      allowed: false,
      code: 'must_use_finalize',
      message:
        'This project uses Finalize Code Changes. Click **Finalize Code Changes** on the session to rebase, review, run tests, and open the PR.',
    };
  }

  if (existing.status === 'ready_to_push') {
    return {
      allowed: false,
      code: 'must_use_finalize',
      message:
        'Checks passed — click **Push to GitHub** on the session to open the PR (do not run `gh pr create` directly).',
      run_id: existing.id,
    };
  }

  if (existing.status === 'pushed') {
    return {
      allowed: true,
      code: 'allowed',
      message: 'Finalize already pushed a PR for this commit.',
      run_id: existing.id,
    };
  }

  if (!TERMINAL_STATUSES.has(existing.status)) {
    return {
      allowed: false,
      code: 'in_flight',
      message: `Finalize run ${existing.id} is still active (${existing.status}). Wait for it to finish.`,
      run_id: existing.id,
    };
  }

  const reason = existing.failure_reason ?? existing.status;
  return {
    allowed: false,
    code: 'failed',
    message: `Finalize failed (${reason}). Fix the issues, commit if needed, and click **Finalize Code Changes** again — do not run \`gh pr create\` directly.`,
    run_id: existing.id,
    failure_reason: existing.failure_reason,
  };
}
