/**
 * Per-session SessionEnv adapter resolution.
 *
 * Firecracker is opt-in via `session_mode = isolated`. Chat / design / consult
 * never boot a microVM, even when `AGENT_HUB_SESSION_ENV_ADAPTER=firecracker`
 * (that leftover "always VM" deploy pin must not hide the mode picker or
 * launch a VM for every session). Isolated sessions always resolve to
 * Firecracker and fail closed when the backend is absent — they never silently
 * fall back to host. Workflow projects always stay on host (no worktree / no
 * VM).
 */
import type { Project } from '../types.js';
import { getProjectMode } from '../project-mode.js';
import { isIsolatedModeActive } from '../session-mode.js';
import type { SessionEnvKind } from './session-env.js';
import { getSessionEnvSelection } from './sysbox-capability.js';
export { isFirecrackerBackendRegistered } from './firecracker/firecracker-backend-status.js';

/**
 * Resolve the SessionEnv kind for one session.
 *
 *   workflow → host
 *   isolated → firecracker (fail closed; never downgrades to host)
 *   else → globalAdapter, except firecracker (opt-in only) falls back to host
 */
export function resolveSessionEnvAdapterForSession(opts: {
  project: Project | null | undefined;
  session: { session_mode?: string | null } | null | undefined;
  /** Override for tests; defaults to {@link getSessionEnvSelection}.adapter. */
  globalAdapter?: SessionEnvKind;
  /**
   * Accepted so tests can assert the isolated path stays registry-independent
   * (it fails closed on firecracker whether or not the backend is registered).
   * This override does not change the resolved kind.
   */
  registeredBackends?: ReadonlySet<SessionEnvKind>;
}): SessionEnvKind {
  if (getProjectMode(opts.project) === 'workflow') return 'host';
  // An isolated session explicitly requested a VM boundary, so it resolves to
  // firecracker even when that backend is not currently registered — e.g. it
  // was unregistered at boot after a Firecracker NAT/bridge reconciliation
  // failure (index.ts) while a persisted `session_mode = isolated` row remains.
  // Returning firecracker makes the session fail closed at launch
  // (createSessionEnv throws for an unregistered kind) instead of silently
  // resuming on the host and dropping the isolation boundary — a silent host
  // resume would also skip host dependency installation, since worktree.ts
  // keys `skipHostInstall` off the isolated row. Opting a session *into*
  // isolated mode is separately gated on firecracker being registered
  // (routes/sessions.ts).
  if (isIsolatedModeActive(opts.session)) return 'firecracker';
  const global = opts.globalAdapter ?? getSessionEnvSelection().adapter;
  // `sessionEnvAdapter=firecracker` used to mean "every session is a VM".
  // Isolated mode replaced that; keep the backend registered (so the picker
  // can offer VM) but do not boot a microVM for chat/design/consult.
  if (global === 'firecracker') return 'host';
  return global;
}
