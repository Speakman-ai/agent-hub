/**
 * Atomic account provisioning — the single write path for creating a user
 * together with their org membership and any pre-selected project-member
 * assignments.
 *
 * Both account-creation entry points funnel through here so they cannot
 * diverge again: `POST /api/auth/users` (Owner-created) and
 * `POST /api/auth/invites/:token/accept` (invite redemption). Before this
 * helper existed the invite path was transactional but the direct-create
 * path was not, so a failed `addProjectMember` partway through the loop
 * could strand a half-created account — the `users` and `memberships`
 * rows committed while only a prefix of the selected projects got
 * assigned. Wrapping every write in one better-sqlite3 transaction makes
 * the whole operation all-or-nothing: any thrown error rolls back the
 * user, the membership, and every project assignment together.
 *
 * All three tables (`users`, `memberships`, `project_members`) live in the
 * same orgs.db handle, so a single `getOrgsDb().transaction()` spans them.
 * Password hashing is async and MUST happen before calling this — the
 * transaction body is synchronous (better-sqlite3 forbids awaiting inside
 * a transaction).
 */
import { getOrgsDb } from './orgs.js';
import { createUser, type UserRow } from './users-store.js';
import { createMembership } from './memberships-store.js';
import { addProjectMember } from './project-members-store.js';
import type { Role } from './roles.js';

export interface ProvisionUserOpts {
  username: string;
  passwordHash: string;
  orgId: string;
  role: Role;
  /**
   * Project ids to assign the new user to (the per-project visibility ACL).
   * Assumed already authorized + deduped by the caller; existence is
   * re-checked here at write time via `projectExists`. Empty / omitted for
   * accounts with no pre-assignment.
   */
  projectIds?: readonly string[];
  /** `added_by` for the project_members audit rows (actor/issuer user id, or null). */
  assignedBy?: string | null;
  /**
   * REQUIRED when `projectIds` is non-empty. Referential-integrity guard,
   * evaluated INSIDE the transaction for each id: return true iff the project
   * currently exists in the target org. Ids that fail are skipped, so a
   * project-member / restriction row is NEVER written for a nonexistent
   * project — this closes the invite issuance→redemption TOCTOU window (a
   * project deleted after the invite was minted) and fails closed if a caller
   * ever reaches this path without a validator. Throwing (rather than
   * silently accepting) when it is missing guarantees no unvalidated ACL row
   * is ever committed.
   */
  projectExists?: (projectId: string) => boolean;
  /**
   * Optional extra work to run inside the same transaction, immediately after
   * the user row is created (so it can use the new user id) and before the
   * membership + project writes. Throwing from here rolls the entire
   * provisioning back. The invite path uses this to run the atomic
   * `markInviteAccepted` race check so a lost race un-creates the user.
   */
  afterCreateUser?: (userId: string) => void;
}

/**
 * Create a user, their active-org membership, and their pre-selected
 * project-member rows in one atomic transaction. Returns the created user
 * plus the project ids that were actually assigned (nonexistent ids are
 * filtered out by `projectExists` at write time). Rethrows any error from the
 * writes (or from `afterCreateUser`) after the transaction has rolled back,
 * so the caller never observes a partial account.
 */
export function provisionUser(opts: ProvisionUserOpts): {
  user: UserRow;
  assignedProjectIds: string[];
} {
  const requestedProjectIds = opts.projectIds ?? [];
  // Fail closed: refuse to write ACL rows we cannot validate. index.ts always
  // injects `projectExists`; reaching here without it is a misconfiguration.
  if (requestedProjectIds.length > 0 && !opts.projectExists) {
    throw new Error('provisionUser: projectExists is required when projectIds is non-empty');
  }
  return getOrgsDb().transaction(() => {
    const user = createUser({ username: opts.username, passwordHash: opts.passwordHash });
    opts.afterCreateUser?.(user.id);
    createMembership(user.id, opts.orgId, opts.role);
    const assignedProjectIds: string[] = [];
    for (const projectId of requestedProjectIds) {
      // Write-time existence re-check (inside the transaction): skip ids whose
      // project no longer exists so we never create a dangling ACL row.
      if (!opts.projectExists!(projectId)) continue;
      addProjectMember(projectId, user.id, opts.assignedBy ?? null);
      assignedProjectIds.push(projectId);
    }
    return { user, assignedProjectIds };
  })();
}
