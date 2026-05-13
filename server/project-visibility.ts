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
}

/**
 * May this caller read/enter this project?
 *
 * Shared projects → yes for everyone in the org.
 * Private projects → only the owner (and the local-bundled synthetic owner).
 * Org Owners do NOT get a read bypass — they can list-and-delete from the
 * admin endpoint, but they cannot read the contents of a private project
 * they don't own.
 */
export function canViewProject(project: Project, caller: VisibilityCaller): boolean {
  if (getVisibility(project) === 'shared') return true;
  if (caller.localBypass) return true;
  if (!caller.userId) return false;
  return project.ownerUserId === caller.userId;
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
