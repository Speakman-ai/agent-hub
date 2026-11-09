/**
 * Identity-guarded slots for in-flight `aws sso login --no-browser` spawns,
 * one per token-cache owner. Extracted from `routes/project-aws.ts` so
 * race-guard semantics do not require the whole route stack.
 *
 * Background: an `aws sso login --no-browser` spawn returns the device URL
 * via stdout, then keeps running while the user finishes the device flow in
 * a browser. Each owner (a Hub user, or the shared host HOME) gets at most
 * one such proc: a second login request from the same owner kills their
 * previous proc and registers its replacement. Logins from different users
 * write to different `~/.aws/sso/cache` trees, so they never displace each
 * other.
 *
 * The previous proc's `close`/`error` event fires AFTER its replacement is
 * already in the slot, so a deferred handler may only clear the slot if it
 * still owns it. Otherwise it would wipe the replacement's registration and
 * let a third request bypass the "kill the old one first" guard, leaving two
 * `aws sso login` processes racing on the same token cache.
 *
 * Tests that want clean slots call `__resetActiveAwsSsoLoginForTests()`.
 */

import type { ChildProcess } from 'child_process';

export interface ActiveAwsSsoLogin {
  loginId: string;
  proc: ChildProcess;
  projectId: string;
  profile: string;
}

const HOST_OWNER = '\u0000host';
const active = new Map<string, ActiveAwsSsoLogin>();

/** Slot key for a login owner; null means the shared host HOME. */
function ownerKey(ownerUserId: string | null): string {
  const id = ownerUserId?.trim();
  return id ? `user:${id}` : HOST_OWNER;
}

export function getActiveAwsSsoLogin(ownerUserId: string | null): ActiveAwsSsoLogin | null {
  return active.get(ownerKey(ownerUserId)) ?? null;
}

/** Register a freshly-spawned login as the owner's active proc. */
export function setActiveAwsSsoLogin(ownerUserId: string | null, entry: ActiveAwsSsoLogin): void {
  active.set(ownerKey(ownerUserId), entry);
}

/** Unconditionally clear the owner's slot — call after killing the previous proc. */
export function clearActiveAwsSsoLogin(ownerUserId: string | null): void {
  active.delete(ownerKey(ownerUserId));
}

/**
 * Clear the owner's slot only if the supplied proc is still the registered
 * one. Deferred `close` / `error` / timeout handlers MUST use this.
 */
export function clearActiveAwsSsoLoginIfOwner(
  ownerUserId: string | null,
  proc: ChildProcess,
): boolean {
  const key = ownerKey(ownerUserId);
  if (active.get(key)?.proc === proc) {
    active.delete(key);
    return true;
  }
  return false;
}

/** Reset for tests. */
export function __resetActiveAwsSsoLoginForTests(): void {
  active.clear();
}
