import { AUTOPILOT_MAINLINE_AVAILABLE } from '../shared/utils/sessionAutopilot.js';

/**
 * Whether this server accepts a `mainline` Autopilot start. The session wire
 * row exposes the same answer as `can_autopilot_mainline`, so the setup forms
 * offer the option exactly when the start API would accept it.
 * `AGENT_HUB_AUTOPILOT_MAINLINE=0` turns it off on this server; `1` turns it
 * on even if the shipped default is off.
 */
export function autopilotMainlineStartEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.AGENT_HUB_AUTOPILOT_MAINLINE;
  if (flag === '0') return false;
  return AUTOPILOT_MAINLINE_AVAILABLE || flag === '1';
}
