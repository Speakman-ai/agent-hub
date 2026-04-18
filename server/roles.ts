/**
 * Role-based permissions — Auth Phase 2.
 *
 * Introduces a three-tier role hierarchy that sits on top of the Phase 1
 * single-user JWT auth:
 *
 *     Owner  ── full control (created at /api/auth/setup; cannot be removed)
 *     Admin  ── elevated operations (manage agents, config, user roles)
 *     User   ── scope TBD; reserved for the future multi-user rollout and
 *               treated as "read-only / no admin ops" today.
 *
 * The single user that exists today always resolves to Owner — both for
 * existing installs (the stored `auth.json` predates this field, so we
 * backfill) and for new installs (setup defaults to Owner). The User role
 * is defined but nothing maps to it yet; that comes with the multi-user
 * Phase 3 work.
 *
 * Checks are strictly hierarchical: Owner satisfies any role requirement,
 * Admin satisfies Admin+User, User satisfies only User. Callers should
 * spell out the minimum role they require rather than comparing strings
 * directly.
 */
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth.js';

export type Role = 'Owner' | 'Admin' | 'User';

export const ROLES: readonly Role[] = ['Owner', 'Admin', 'User'] as const;

/**
 * Hierarchy rank — higher number = more privileged. Owner > Admin > User.
 * Used by `hasAtLeastRole` for permission checks.
 */
const RANK: Record<Role, number> = {
  Owner: 3,
  Admin: 2,
  User: 1,
};

/** Narrow an arbitrary value to a valid Role, returning null otherwise. */
export function parseRole(raw: unknown): Role | null {
  if (typeof raw !== 'string') return null;
  return (ROLES as readonly string[]).includes(raw) ? (raw as Role) : null;
}

/**
 * Coerce a stored value into a Role. Unknown / missing values fall back to
 * Owner — this preserves the invariant that the single pre-Phase-2 user
 * keeps full privileges after the upgrade.
 */
export function coerceRoleOrOwner(raw: unknown): Role {
  return parseRole(raw) ?? 'Owner';
}

/** True iff `actual` is at least as privileged as `minimum`. */
export function hasAtLeastRole(actual: Role | null | undefined, minimum: Role): boolean {
  if (!actual) return false;
  return RANK[actual] >= RANK[minimum];
}

/**
 * Express middleware factory that rejects callers whose role is below
 * `minRole`. Assumes `authMiddleware` has already populated
 * `req.authRole` (either via the JWT sub → user record lookup, or via
 * the apiKey fallback which is treated as Owner).
 *
 * Rejection shapes:
 *   401 {error} — no role present (unauthenticated request slipped
 *                 through; shouldn't happen once the gate is wired in).
 *   403 {error, requiredRole, currentRole} — authenticated but
 *                 insufficient.
 */
export function requireRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = (req as AuthenticatedRequest).authRole;
    if (!role) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!hasAtLeastRole(role, minRole)) {
      res.status(403).json({
        error: `This action requires the ${minRole} role or higher.`,
        requiredRole: minRole,
        currentRole: role,
      });
      return;
    }
    next();
  };
}
