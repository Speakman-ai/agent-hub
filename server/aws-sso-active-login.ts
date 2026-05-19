/**
 * Identity-guarded slot for the single in-flight `aws sso login --no-browser`
 * spawn. Extracted from `routes/project-aws.ts` so the race-guard semantics
 * can be unit-tested without standing up the whole route stack.
 *
 * Background: an `aws sso login --no-browser` spawn returns the device URL
 * via stdout, then keeps running while the user finishes the device flow in
 * a browser. We allow at most one such proc per server: a second login
 * request kills the previous proc and registers its replacement. The
 * previous proc's `close`/`error` event then fires AFTER its replacement is
 * already in the slot — naively resetting the slot from that deferred
 * handler would wipe the replacement's registration and let a third
 * request bypass the "kill the old one first" guard, leaving two `aws
 * sso login` processes racing on `~/.aws/sso/cache`.
 *
 * The fix is to guard the reset on identity: a deferred handler may only
 * clear the slot if it still owns it.
 *
 * State is intentionally module-scoped — there is one server, one slot.
 * Tests that want a clean slot call `__resetActiveAwsSsoLoginForTests()`.
 */

import type { ChildProcess } from 'child_process';

export interface ActiveAwsSsoLogin {
  loginId: string;
  proc: ChildProcess;
  projectId: string;
  profile: string;
}

let active: ActiveAwsSsoLogin | null = null;

export function getActiveAwsSsoLogin(): ActiveAwsSsoLogin | null {
  return active;
}

/** Register a freshly-spawned login as the new active proc. */
export function setActiveAwsSsoLogin(entry: ActiveAwsSsoLogin): void {
  active = entry;
}

/** Unconditionally clear the slot — call after killing the previous proc. */
export function clearActiveAwsSsoLogin(): void {
  active = null;
}

/**
 * Clear the slot only if the supplied proc is still the registered one.
 * Deferred `close` / `error` / timeout handlers MUST use this — using
 * the unconditional clear from a deferred handler would wipe a successor
 * registration and break the kill-the-old-one-first contract.
 */
export function clearActiveAwsSsoLoginIfOwner(proc: ChildProcess): boolean {
  if (active && active.proc === proc) {
    active = null;
    return true;
  }
  return false;
}

/** Reset for tests. */
export function __resetActiveAwsSsoLoginForTests(): void {
  active = null;
}
