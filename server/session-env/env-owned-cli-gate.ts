/**
 * Env-owned backends (Firecracker) keep the live worktree in the guest.
 * Host CLI spawn is no longer refused — chat routes those turns through
 * {@link SessionEnv.spawn} (see `guest-cli-spawn.ts`). This helper remains as
 * a no-op so older call sites / docs that named the gate still compile; it
 * always returns null.
 */

import type { SessionEnvKind } from './session-env.js';

export function envOwnedHostCliRefusal(_adapter: SessionEnvKind): string | null {
  return null;
}
