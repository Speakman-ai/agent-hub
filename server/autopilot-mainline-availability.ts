import { AUTOPILOT_MAINLINE_AVAILABLE } from '../shared/utils/sessionAutopilot.js';

/**
 * Whether this server accepts a `mainline` Autopilot start. The session wire
 * row exposes the same answer as `can_autopilot_mainline`, so the setup forms
 * offer the option exactly when the start API would accept it.
 * `AGENT_HUB_AUTOPILOT_MAINLINE=1` opts a dev server in early to exercise the
 * landing path as it is built.
 */
export function autopilotMainlineStartEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return AUTOPILOT_MAINLINE_AVAILABLE || env.AGENT_HUB_AUTOPILOT_MAINLINE === '1';
}
