// Per-agent "Dev" flag — does an agent accept autonomously-dispatched kanban
// tickets? Mirror of server/agent-autonomy.ts (kept intentionally tiny). The
// settings UI uses these to decide whether the Dev toggle is locked (forced
// ON for default Dev roles, OFF for out-of-band roles) and what the editable
// toggle's current value should be. Keep in sync with the server + mobile.

// `skill-builder` is a conversational coach (not a code-shipping recipient), so
// its Dev toggle is locked OFF like docs/reviewer.
const OUT_OF_BAND_ROLES = new Set(['docs', 'reviewer', 'skill-builder', 'hub-assistant']);
const DEFAULT_DEV_ROLES = new Set(['dev', 'lead']);

function roleOf(agent: any) {
  return agent && typeof agent.role === 'string' ? agent.role.trim().toLowerCase() : '';
}

/** Out-of-band role (docs/reviewer) — the Dev toggle is locked OFF. */
export function isAutonomyLockedOff(agent: any) {
  return OUT_OF_BAND_ROLES.has(roleOf(agent));
}

/** Default Dev role (dev/lead) — the Dev toggle is locked ON. */
export function isAutonomyLockedOn(agent: any) {
  return DEFAULT_DEV_ROLES.has(roleOf(agent));
}

/** The Dev toggle cannot be changed for this agent. */
export function isAutonomyLocked(agent: any) {
  return isAutonomyLockedOff(agent) || isAutonomyLockedOn(agent);
}

/**
 * Effective: may this agent receive an autonomously-dispatched ticket?
 *  - out-of-band roles → never
 *  - default Dev roles → always
 *  - explicit isDev === false → opt-out
 *  - otherwise (isDev true, or undefined for pre-flag agents) → eligible
 */
export function agentAcceptsAutonomousTickets(agent: any) {
  if (!agent) return false;
  if (isAutonomyLockedOff(agent)) return false;
  if (isAutonomyLockedOn(agent)) return true;
  return agent.isDev !== false;
}
