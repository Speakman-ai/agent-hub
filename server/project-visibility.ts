/**
 * Per-project visibility — shared vs. private.
 *
 * Default model (pre-feature): every project is visible to every member of
 * the org. We keep that as the default so existing installs upgrade
 * silently — any project missing `visibility` is treated as `'shared'`.
 *
 * Private projects are visible only to their `ownerUserId`. Org Owners get
 * a narrow exception: they can list private projects they don't own from
 * the Settings → Projects admin endpoint and DELETE them (kill switch),
 * but they cannot read or enter the project itself. That split keeps
 * genuine privacy intact while preserving an escape hatch for abandoned /
 * orphaned projects.
 *
 * Auth contract:
 *   - `userId` is the JWT `uid` claim (`authUserId` on `AuthenticatedRequest`).
 *   - `role` is the membership-derived role (`Owner` | `Admin` | `User`).
 *   - `localBypass` covers Electron / single-tenant dev mode where the
 *     synthetic `local` Owner identity should see everything. We treat
 *     local-bundled mode as "no privacy boundary" since by definition
 *     there's only one user.
 *
 * Two paths cross this gate:
 *   - `canViewProject` — read/enter (list endpoint, project sub-routes).
 *   - `canDeleteProject` — DELETE; Owners may delete any project in their org.
 *
 * Webhook handlers and other unauthenticated entry points must NOT use this
 * gate — they have no `userId`. They bypass intentionally and inherit
 * `project.ownerUserId` for any session they dispatch.
 */

import type { Project } from './types.js';
import type { Role } from './roles.js';

/**
 * Resolved visibility — defaults to `'shared'` when the field is unset.
 * Use this everywhere instead of comparing `project.visibility === 'private'`
 * directly, so the back-compat default lives in exactly one place.
 */
export function getVisibility(project: Project): 'shared' | 'private' {
  return project.visibility === 'private' ? 'private' : 'shared';
}

export interface VisibilityCaller {
  /** JWT `uid`. `null`/`undefined` means "no per-user identity" (e.g. legacy global apiKey, webhook). */
  userId: string | null | undefined;
  /** Membership-derived role in the active org. */
  role?: Role;
  /**
   * Single-tenant local bundled server (Electron / dev box). When true the
   * caller sees every project — there's only one user, so privacy is moot.
   */
  localBypass?: boolean;
  /**
   * Project ids this caller is explicitly assigned to (their
   * `project_members` rows). An assigned member always sees the project,
   * shared or private. Populated by `resolveVisibilityCaller`; left unset
   * for bypass callers (who see everything anyway) and for the pure-unit
   * call sites in tests (which then observe the pre-ACL default).
   */
  assignedProjectIds?: ReadonlySet<string>;
  /**
   * Project ids with an active assignment ACL ("restricted"). A shared
   * project in this set is members-only even when every member row has been
   * removed; a shared project NOT in it has no assignment ACL and stays
   * visible to the whole org. When unset, no project is treated as
   * restricted — preserving the pre-feature "shared = visible to everyone"
   * default for unit call sites.
   */
  restrictedProjectIds?: ReadonlySet<string>;
  /**
   * True when the route-layer resolver tried to load assignment ACLs from
   * orgs.db and failed. Real requests must fail closed in that state: a
   * shared project might be restricted, and treating the missing set as
   * "unrestricted" would leak it to non-members.
   */
  assignmentAclUnavailable?: boolean;
}

/**
 * May this caller read/enter this project?
 *
 * Resolution order:
 *   1. Local-bundled / break-glass bypass → always yes.
 *   2. The project's own `ownerUserId` → always yes (their project).
 *   3. An explicitly assigned member (`project_members`) → always yes,
 *      whether the project is shared or private. This is the assignment
 *      ACL an Owner manages via `/api/projects/:id/members`.
 *   4. Private projects → otherwise no. Org Owners do NOT get a read
 *      bypass — they can list-and-delete from the admin endpoint, but not
 *      read the contents of a private project they don't own.
 *   5. Shared projects:
 *        - Org Owners → yes (they manage everything).
 *        - If the project has an active assignment ACL ("restricted"):
 *          members-only — a non-member is denied, even if the current member
 *          list is empty after user/member deletion.
 *        - If the project has NO assignment ACL: visible to the whole org.
 *          This is the back-compat default so existing installs upgrade with
 *          no visibility change and no data backfill.
 *
 * `assignedProjectIds` / `restrictedProjectIds` are populated by
 * `resolveVisibilityCaller`. When they're unset (pure unit call sites) the
 * function collapses to the pre-feature "shared = visible to everyone,
 * private = owner-only" behavior. When `assignmentAclUnavailable` is set,
 * real request callers fail closed after owner / explicit Owner checks.
 */
export function canViewProject(project: Project, caller: VisibilityCaller): boolean {
  if (caller.localBypass) return true;
  if (caller.userId && project.ownerUserId === caller.userId) return true;
  if (caller.userId && caller.assignedProjectIds?.has(project.id)) return true;
  if (getVisibility(project) === 'private') return false;
  // Shared project from here down.
  if (caller.role === 'Owner') return true;
  if (caller.assignmentAclUnavailable) return false;
  // Restricted → members-only; the non-member falls through to denial.
  // No assignment ACL → open to the org.
  return !caller.restrictedProjectIds?.has(project.id);
}

/**
 * May this caller DELETE this project?
 *
 * - Always yes if the caller can view it (owners delete their own projects).
 * - Otherwise yes for org Owners — this is the kill switch for abandoned
 *   private projects.
 *
 * Local bundled server inherits the view path (every project visible →
 * deletable by the synthetic Owner).
 */
export function canDeleteProject(project: Project, caller: VisibilityCaller): boolean {
  if (canViewProject(project, caller)) return true;
  return caller.role === 'Owner';
}

/**
 * Filter a list of projects to only those `canViewProject` accepts.
 * Wrapper to keep call sites readable.
 */
export function filterVisibleProjects<T extends Project>(
  projects: readonly T[],
  caller: VisibilityCaller,
): T[] {
  return projects.filter((p) => canViewProject(p, caller));
}

/**
 * Direction of a visibility transition for `canChangeVisibility`.
 *
 * - `shared->private` ("claim"): the project is currently visible to every
 *   org member; flipping it private hides it from everyone except the new
 *   owner. That's destructive for collaborators, so we restrict it to org
 *   Owners. The route layer is responsible for choosing/validating the
 *   `ownerUserId` to stamp (typically the caller).
 *
 * - `private->shared` ("publish"): exposes a previously-private project to
 *   the entire org. Allowed for the current `ownerUserId` (their project,
 *   their call) OR for any org Owner (kill-switch parallel — Owners can
 *   already delete private projects; allowing them to publish is strictly
 *   less destructive). The route layer clears `ownerUserId` on success.
 *
 * - `noop`: same visibility on both sides; always allowed at the auth
 *   layer (the route may still re-validate the body).
 *
 * `localBypass` collapses every transition to "allowed" because single-
 * tenant local mode has no privacy boundary.
 */
export type VisibilityTransition = 'shared->private' | 'private->shared' | 'noop';

export function classifyVisibilityTransition(
  from: 'shared' | 'private',
  to: 'shared' | 'private',
): VisibilityTransition {
  if (from === to) return 'noop';
  return from === 'shared' ? 'shared->private' : 'private->shared';
}

/**
 * May this caller flip a project between shared and private?
 *
 * See `VisibilityTransition` for the per-direction policy. Returns
 * `false` for callers with no `userId` (real multi-user deployments
 * require an authenticated identity to attribute the change) unless
 * `localBypass` is set.
 */
export function canChangeVisibility(
  project: Project,
  transition: VisibilityTransition,
  caller: VisibilityCaller,
): boolean {
  if (caller.localBypass) return true;
  if (!caller.userId) return false;
  if (transition === 'noop') return true;
  if (transition === 'shared->private') {
    return caller.role === 'Owner';
  }
  // private -> shared
  if (caller.role === 'Owner') return true;
  return project.ownerUserId === caller.userId;
}
