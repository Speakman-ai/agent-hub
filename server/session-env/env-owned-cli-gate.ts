/**
 * Host-side agent CLI turns write the session worktree on the Hub host.
 * Under env-owned backends (Firecracker) the guest holds the authoritative
 * tree — spawning the CLI on the host creates a second, divergent copy.
 * Refuse those turns until guest-side CLI spawn exists.
 */

import type { SessionEnvKind } from './session-env.js';
import { worktreeSharingForKind } from './session-env.js';

export function envOwnedHostCliRefusal(adapter: SessionEnvKind): string | null {
  if (worktreeSharingForKind(adapter) !== 'env-owned') return null;
  return (
    `Agent CLI turns are not supported while this deployment uses ${adapter} ` +
    `session environments (env-owned worktree). Preview, terminal, and Finalize ` +
    `run in the guest; a host-side CLI spawn would write a second tree. ` +
    `Set AGENT_HUB_SESSION_ENV_ADAPTER=auto (or sysbox/host) until guest CLI spawn lands.`
  );
}
