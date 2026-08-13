/**
 * Process-wide resolver for "the worktree of session X, wherever it lives".
 *
 * A registry rather than a constructor dependency because the callers that
 * need it — the chat-turn hooks in `code-change-tracker.ts`, the auto-commit
 * pipeline in `auto-git.ts` — sit several layers below any scope that holds a
 * `SessionEnvManager`. Threading one down would touch dozens of signatures
 * that otherwise have nothing to do with session environments. `index.ts`
 * installs the real resolver at boot; route handlers, which do get wiring,
 * should prefer `RouteDeps.getSessionWorktreeIo`.
 */
import { HostWorktreeIo, type SessionWorktreeIo } from './session-env/worktree-io.js';

export type SessionWorktreeIoResolver = (sessionId: string) => Promise<SessionWorktreeIo | null>;

let resolver: SessionWorktreeIoResolver | null = null;

/** Install the resolver. Pass null to clear (test teardown). */
export function setSessionWorktreeIoResolver(fn: SessionWorktreeIoResolver | null): void {
  resolver = fn;
}

/**
 * The seam for one session's worktree.
 *
 * Falls back to `hostPath` when no resolver is installed (tests, embedders) or
 * when the session has no env of its own — which is what this code did before
 * the seam existed, and stays correct for every `host-shared` backend. A
 * resolver that throws (a microVM that will not boot) propagates rather than
 * falling back: answering from the stale host seed would report a session that
 * has been committing all day as clean, which is the failure this seam exists
 * to prevent.
 */
export async function sessionWorktreeIoFor(
  sessionId: string,
  hostPath: string,
): Promise<SessionWorktreeIo> {
  const io = resolver ? await resolver(sessionId) : null;
  return io ?? new HostWorktreeIo(hostPath);
}
