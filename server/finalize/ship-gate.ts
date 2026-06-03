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

export interface EvaluateFinalizeShipGateArgs {
  session: SessionRow;
  projectId: string;
  headSha: string | null;
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
 * Decide whether a session may open a PR via `gh pr create` directly.
 */
export async function evaluateFinalizeShipGate(
  deps: EvaluateFinalizeShipGateDeps,
  args: EvaluateFinalizeShipGateArgs,
): Promise<FinalizeShipGateResult> {
  const { session, projectId, headSha } = args;
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

  const idempotencyKey = computeIdempotencyKey({
    projectId,
    branch: session.worktree_branch,
    headSha,
  });
  const existing = deps.stmts.getFinalizeRunByIdempotencyKey.get(idempotencyKey) as
    | FinalizeRunRow
    | undefined;

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
