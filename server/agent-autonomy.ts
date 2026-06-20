import type { Agent } from './types.js';

// ─── Autonomous-ticket eligibility ───────────────────────────────────────────
//
// A single source of truth for "may this agent receive an autonomously-
// dispatched kanban ticket?". Pure — no DB / no broadcast — so the autonomous
// dispatcher and the settings UI agree on which agents are locked vs.
// togglable. Mirrored (intentionally tiny) in `client/src/utils/agentAutonomy.js`
// and `mobile/src/utils/settingsAgents.js`; keep the three in sync.

/** Roles that are never autonomously assigned — out-of-band worker roles. */
const OUT_OF_BAND_ROLES = new Set(['docs', 'intake', 'reviewer']);

/**
 * The project's "default Dev" roles. These always accept autonomous tickets
 * (the toggle is locked ON in the UI), so every project keeps at least one
 * guaranteed recipient and the lead-fallback in routing never strands a card.
 */
const DEFAULT_DEV_ROLES = new Set(['dev', 'lead']);

function roleOf(agent: Pick<Agent, 'role'> | null | undefined): string {
  return agent && typeof agent.role === 'string' ? agent.role.trim().toLowerCase() : '';
}

/** Out-of-band role (docs/intake/reviewer) — the Dev toggle is locked OFF. */
export function isAutonomyLockedOff(agent: Pick<Agent, 'role'> | null | undefined): boolean {
  return OUT_OF_BAND_ROLES.has(roleOf(agent));
}

/** Default Dev role (dev/lead) — the Dev toggle is locked ON. */
export function isAutonomyLockedOn(agent: Pick<Agent, 'role'> | null | undefined): boolean {
  return DEFAULT_DEV_ROLES.has(roleOf(agent));
}

/**
 * The Dev toggle cannot be changed for this agent (it is forced ON for default
 * Dev roles and OFF for out-of-band roles). Used to reject contradictory
 * `isDev` writes server-side and to disable the toggle in the UI.
 */
export function isAutonomyLocked(agent: Pick<Agent, 'role'> | null | undefined): boolean {
  return isAutonomyLockedOff(agent) || isAutonomyLockedOn(agent);
}

/**
 * Effective: may this agent receive an autonomously-dispatched ticket?
 *
 *  - out-of-band roles (docs/intake/reviewer) → never
 *  - default Dev roles (dev/lead)             → always (locked on)
 *  - explicit `isDev === false`               → opt-out, never
 *  - otherwise (`isDev === true`, or `undefined` for pre-flag agents) → eligible
 *
 * The `undefined → eligible` fallback preserves the historical "every worker
 * role is assignable" behaviour so flipping this feature on does not silently
 * stop dispatch for agents created before the flag existed. New agents created
 * through the UI persist an explicit `isDev: false`, so they are opt-in.
 */
export function agentAcceptsAutonomousTickets(
  agent: Pick<Agent, 'role' | 'isDev'> | null | undefined,
): boolean {
  if (!agent) return false;
  if (isAutonomyLockedOff(agent)) return false;
  if (isAutonomyLockedOn(agent)) return true;
  return agent.isDev !== false;
}
