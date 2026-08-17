/**
 * Per-session SessionEnv adapter resolution.
 *
 * Global `AGENT_HUB_SESSION_ENV_ADAPTER` (via {@link getSessionEnvSelection})
 * remains the default, but an opt-in `session_mode = isolated` session forces
 * Firecracker when that backend is registered — even if the deployment default
 * is `host`. Workflow projects always stay on host (no worktree / no VM).
 */
import type { Project } from '../types.js';
import { getProjectMode } from '../project-mode.js';
import { isIsolatedModeActive } from '../session-mode.js';
import type { SessionEnvKind } from './session-env.js';
import { registeredSessionEnvBackends } from './select-session-env.js';
import { getSessionEnvSelection } from './sysbox-capability.js';
export { isFirecrackerBackendRegistered } from './firecracker/firecracker-backend-status.js';

/**
 * Resolve the SessionEnv kind for one session.
 *
 *   workflow → host
 *   isolated + firecracker registered → firecracker
 *   else → globalAdapter (defaults to live selection)
 */
export function resolveSessionEnvAdapterForSession(opts: {
  project: Project | null | undefined;
  session: { session_mode?: string | null } | null | undefined;
  /** Override for tests; defaults to {@link getSessionEnvSelection}.adapter. */
  globalAdapter?: SessionEnvKind;
  /** Override for tests; defaults to the live registry. */
  registeredBackends?: ReadonlySet<SessionEnvKind>;
}): SessionEnvKind {
  if (getProjectMode(opts.project) === 'workflow') return 'host';
  const registered = opts.registeredBackends ?? registeredSessionEnvBackends();
  if (isIsolatedModeActive(opts.session) && registered.has('firecracker')) {
    return 'firecracker';
  }
  return opts.globalAdapter ?? getSessionEnvSelection().adapter;
}
