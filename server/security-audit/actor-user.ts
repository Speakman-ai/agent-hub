/**
 * actor-user.ts — resolve the Hub user that UNATTENDED security automation
 * acts as.
 *
 * A manual "Autofix" click attributes the bump PR to the clicking user
 * (`createdBy`). But a scheduled / on-push scan has no human in the loop, and
 * `resolveNativePrAuthorUserId` THROWS in auth-enabled deployments rather than
 * guess an owner (mirroring `resolveAutonomousOwnerUserId`, which hard-fails
 * with no owner — there is deliberately no silent org-owner fallback).
 *
 * So unattended auto-PR / auto-merge requires an explicitly configured actor:
 * `project.securityAutoPr.actorUserId`. That single identity authors the bump
 * PR, owns the resolve-PR session, and is the Finalize/merge trigger.
 *
 * Write-time validation (the project PATCH route) enforces that the actor is
 * an Admin/Owner member of the project's org. This read-time resolver is the
 * unattended-path guard: it re-checks the user still exists before we attribute
 * anything to them (they may have been removed since), and returns null when no
 * valid actor is configured — callers then skip unattended PR opening / merge.
 */
import type { Project } from '../types.js';
import { isKnownHubUserId, attributionOptional } from '../native-pr/author-user.js';
import { getMembershipRole } from '../memberships-store.js';
import { hasAtLeastRole } from '../roles.js';

/**
 * Whether `userId` may be configured as the unattended security automation
 * actor for a project in org `orgId`. The actor opens PRs and MERGES them, so
 * it must hold merge rights:
 *
 * - Auth-enabled deployment → require an **Admin/Owner** membership in the org.
 *   A known Hub user who is NOT a member (role lookup returns null) is REJECTED
 *   — being a real account elsewhere is not membership here.
 * - No-auth / local-bundled deployment (`attributionOptional()`) → there are no
 *   membership rows to resolve against, so fall back to the same "known, non-
 *   sentinel id" bar the native-PR author resolver uses.
 *
 * `orgId` is the caller's org context (`req.authOrgId`); undefined only in
 * degenerate states, treated as "no role found".
 */
export function isEligibleSecurityActor(userId: string, orgId: string | undefined): boolean {
  const role = orgId ? getMembershipRole(userId, orgId) : null;
  if (role) return hasAtLeastRole(role, 'Admin');
  // No membership resolved: only relax the requirement in a genuine
  // no-auth/local deployment, never for an auth-enabled non-member.
  return attributionOptional() && isKnownHubUserId(userId);
}

/**
 * The configured unattended-automation actor for a project, or null when none
 * is set / the configured user no longer resolves to a real Hub user.
 *
 * Returning null is the FAIL-SAFE: an unattended scan with no resolvable actor
 * opens no PRs and merges nothing, rather than attributing work to a guessed
 * identity.
 */
export function resolveSecurityAutoPrActor(project: Project): string | null {
  const configured = project.securityAutoPr?.actorUserId?.trim();
  if (!configured) return null;
  if (!isKnownHubUserId(configured)) return null;
  return configured;
}

/**
 * Whether unattended security auto-MERGE should run for this project: the
 * setting is on AND a valid actor is configured. Opening bump PRs unattended
 * uses {@link resolveSecurityAutoPrActor} directly; this adds the auto-merge
 * gate on top.
 */
export function isSecurityAutoMergeEnabled(project: Project): boolean {
  if (project.securityAutoPr?.autoMerge !== true) return false;
  return resolveSecurityAutoPrActor(project) !== null;
}
