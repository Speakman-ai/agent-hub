/**
 * autofix.ts — the single "a scan just finished; should we dispatch a fix
 * session?" decision, shared by every scan trigger.
 *
 * Three call sites reach it and must behave identically:
 *   - `POST /security-audit/scan` (manual Rescan, and the Autofix button)
 *   - the scheduled daily/weekly scanner (`scheduled-scan.ts`)
 *   - the default-branch on-push scan (`on-push.ts`)
 *
 * Before this module the opt-in only fired on the REST route, so a project
 * with `securityAutoPr.enabled` never got an automatic fix from the scans that
 * actually run unattended. The gating rules live here once:
 *
 *   - Hub-hosted only (findings exist only for `gitHost === 'agenthub'`).
 *   - Requested = an explicit Autofix click OR `securityAutoPr.enabled`.
 *   - Never after a dry run — nothing was persisted to act on.
 *   - The opt-in additionally requires NEW or reopened findings this scan, so
 *     repeated scans don't re-dispatch over the same unresolved set. An
 *     explicit click always acts on the current open findings.
 *
 * The unattended paths have no human to own the session, so they fall back to
 * `securityAutoPr.actorUserId` (see actor-user.ts). A missing actor is not
 * fatal: the session is still dispatched, just unowned.
 */

import type { Project } from '../types.js';
import type { FinalizeAutomationLevel } from '../finalize/automation.js';
import type { SecurityAuditStore } from './findings-store.js';
import {
  dispatchSecurityFixSession,
  selectFixableFindings,
  type DispatchSecurityFixDeps,
} from './fix-session.js';
import { isSecurityAutoMergeEnabled, resolveSecurityAutoPrActor } from './actor-user.js';

/** Surfaced when autofix wanted to dispatch but no eligible agent exists. */
export const NO_FIX_AGENT_ERROR =
  'No agent is available to resolve security findings for this project.';

export interface SecurityAutofixDeps extends DispatchSecurityFixDeps {
  store: SecurityAuditStore;
  /** Test seam — defaults to {@link dispatchSecurityFixSession}. */
  dispatch?: typeof dispatchSecurityFixSession;
}

export interface SecurityAutofixSession {
  sessionId: string;
  agentId: string;
  findingCount: number;
  reused: boolean;
}

export interface SecurityAutofixOutcome {
  /** The dispatched (or reused) fix session; null when nothing was dispatched. */
  session: SecurityAutofixSession | null;
  /**
   * Set only when autofix WANTED to dispatch (open findings existed) but
   * couldn't. Distinct from a legit no-op (autofix off, dry run, nothing open),
   * which leaves both fields null so the UI doesn't report a false problem.
   */
  error: string | null;
}

const NO_OP: SecurityAutofixOutcome = { session: null, error: null };

/** Whether the project opted into fixing findings automatically on every scan. */
export function securityAutofixEnabled(project: Project): boolean {
  return project.gitHost === 'agenthub' && project.securityAutoPr?.enabled === true;
}

/**
 * How far Finalize should carry a security fix on its own. `merge` requires
 * BOTH the auto-merge flag and a resolvable actor (see
 * {@link isSecurityAutoMergeEnabled}) — a project that turned auto-merge on and
 * then lost its actor falls back to opening a PR for a human, never to merging
 * with no accountable identity.
 */
export function resolveSecurityFixAutomation(project: Project): FinalizeAutomationLevel {
  return isSecurityAutoMergeEnabled(project) ? 'merge' : 'push';
}

/**
 * Decide and (when warranted) dispatch the fix session for a scan that just
 * completed. Never throws — callers on the push/schedule paths are
 * fire-and-forget and must not be broken by a dispatch problem.
 */
export function maybeDispatchAutofixAfterScan(
  deps: SecurityAutofixDeps,
  args: {
    project: Project;
    scan: { dryRun: boolean; newFindings: number; reopened: number };
    /** A deliberate one-off Autofix click: acts on current open findings. */
    explicit?: boolean;
    /** The human who triggered this scan, when there is one. */
    ownerUserId?: string | null;
  },
): SecurityAutofixOutcome {
  const { project, scan } = args;
  const explicit = args.explicit === true;

  if (project.gitHost !== 'agenthub') return NO_OP;
  if (!explicit && project.securityAutoPr?.enabled !== true) return NO_OP;
  // A dry run persisted nothing, so there is no authoritative open-finding set.
  if (scan.dryRun) return NO_OP;
  if (!explicit && scan.newFindings + scan.reopened <= 0) return NO_OP;

  const open = selectFixableFindings(deps.store.listFindings(project.id, { status: 'open' }));
  if (open.length === 0) return NO_OP;

  const dispatch = deps.dispatch ?? dispatchSecurityFixSession;
  const dispatched = dispatch(deps, {
    project,
    findings: open,
    ownerUserId: args.ownerUserId ?? resolveSecurityAutoPrActor(project),
    automation: resolveSecurityFixAutomation(project),
  });
  if (!dispatched) {
    // Open findings but a null dispatch → no eligible agent on the roster (the
    // only remaining null cause once open.length > 0).
    return { session: null, error: NO_FIX_AGENT_ERROR };
  }
  return {
    session: {
      sessionId: dispatched.sessionId,
      agentId: dispatched.agentId,
      findingCount: dispatched.findingCount,
      reused: dispatched.reused,
    },
    error: null,
  };
}

/**
 * The unattended (scheduled / on-push) wrapper: dispatch and LOG, because there
 * is no HTTP response to carry the outcome. Swallows everything — a failed
 * dispatch must never break the push notify path or abort a scan sweep. A no-op
 * when the caller wired no autofix collaborators (`deps.autofix` unset).
 */
export function maybeAutofixAfterUnattendedScan(args: {
  project: Project;
  result: { dryRun: boolean; summary: { newFindings: unknown[]; reopenedFindings: unknown[] } };
  autofix?: SecurityAutofixDeps;
  dispatchAutofix?: typeof maybeDispatchAutofixAfterScan;
  log: (msg: string) => void;
  /** Log prefix identifying the trigger, e.g. `security-on-push`. */
  tag: string;
}): SecurityAutofixOutcome {
  const { project, result, log, tag } = args;
  if (!args.autofix || !securityAutofixEnabled(project)) return NO_OP;
  const dispatchAutofix = args.dispatchAutofix ?? maybeDispatchAutofixAfterScan;
  try {
    const outcome = dispatchAutofix(args.autofix, {
      project,
      scan: {
        dryRun: result.dryRun,
        newFindings: result.summary.newFindings.length,
        reopened: result.summary.reopenedFindings.length,
      },
    });
    if (outcome.error) {
      log(`[${tag}] autofix skipped for ${project.id}: ${outcome.error}`);
    } else if (outcome.session && !outcome.session.reused) {
      log(
        `[${tag}] ${project.id}: dispatched fix session ${outcome.session.sessionId} over ` +
          `${outcome.session.findingCount} finding(s) at automation ` +
          `${resolveSecurityFixAutomation(project)}`,
      );
    }
    return outcome;
  } catch (err: unknown) {
    log(
      `[${tag}] autofix dispatch failed for ${project.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NO_OP;
  }
}
