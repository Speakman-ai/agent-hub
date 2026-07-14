/**
 * PtyHost — the per-Hub registry of persistent {@link PtySession} shells,
 * keyed by Agent Hub session id.
 *
 * The dedicated terminal WebSocket channel (a separate ticket) resolves an
 * incoming connection to `ensure(sessionId)` and attaches the viewer. The
 * host keeps exactly one live shell per session so a second tab / the agent
 * injector share the same PTY, and evicts a session when its shell exits so
 * the next connection boots a fresh shell rather than attaching to a dead
 * one.
 *
 * How a session obtains its SessionEnv is injected via `createSession`, so
 * the host stays decoupled from adapter selection and from the dev-server
 * runtime's env plumbing.
 */

import type { PtySession, PtySessionAttachResult, PtySessionViewer } from './pty-session.js';

export interface PtyHostDeps {
  /**
   * Build a fresh, not-yet-started session for `sessionId`. Invoked lazily
   * on the first {@link PtyHost.ensure} for a session (or after the prior
   * one exited). Must not open the PTY itself — {@link PtySession.start}
   * does that on first attach.
   */
  createSession: (sessionId: string) => PtySession;
  logger?: { warn: (msg: string) => void };
}

interface Entry {
  session: PtySession;
  unsubscribeExit: () => void;
}

export class PtyHost {
  readonly #createSession: (sessionId: string) => PtySession;
  readonly #logger: { warn: (msg: string) => void };
  readonly #entries = new Map<string, Entry>();

  constructor(deps: PtyHostDeps) {
    this.#createSession = deps.createSession;
    this.#logger = deps.logger ?? { warn: (m) => console.warn(m) };
  }

  /** Live session count. */
  get size(): number {
    return this.#entries.size;
  }

  listSessionIds(): string[] {
    return [...this.#entries.keys()];
  }

  has(sessionId: string): boolean {
    return this.#entries.has(sessionId);
  }

  /** The live session for `sessionId`, if one exists. */
  get(sessionId: string): PtySession | undefined {
    return this.#entries.get(sessionId)?.session;
  }

  /**
   * Get the live session for `sessionId`, creating one if absent. A session
   * whose shell has exited or been disposed is replaced with a fresh one, so
   * the caller always gets a session that can (re)boot a shell.
   */
  ensure(sessionId: string): PtySession {
    const existing = this.#entries.get(sessionId);
    if (
      existing &&
      existing.session.status !== 'exited' &&
      existing.session.status !== 'disposed'
    ) {
      return existing.session;
    }
    if (existing) this.#evict(sessionId);

    const session = this.#createSession(sessionId);
    const unsubscribeExit = session.onExit(() => this.#onSessionExit(sessionId, session));
    this.#entries.set(sessionId, { session, unsubscribeExit });
    return session;
  }

  /** Convenience: ensure the session, then attach a viewer to it. */
  async attach(sessionId: string, viewer: PtySessionViewer): Promise<PtySessionAttachResult> {
    return this.ensure(sessionId).attach(viewer);
  }

  /** Dispose and forget one session's shell. Idempotent. */
  dispose(sessionId: string): void {
    const entry = this.#entries.get(sessionId);
    if (!entry) return;
    this.#evict(sessionId);
    entry.session.dispose();
  }

  /** Dispose every live shell (Hub shutdown). */
  disposeAll(): void {
    for (const sessionId of [...this.#entries.keys()]) {
      this.dispose(sessionId);
    }
  }

  #onSessionExit(sessionId: string, session: PtySession): void {
    // Only evict if this exact session still owns the slot — a replace could
    // have swapped it out already.
    const entry = this.#entries.get(sessionId);
    if (entry?.session !== session) return;
    this.#evict(sessionId);
    // Free the buffer/queue held by the exited shell.
    session.dispose();
  }

  #evict(sessionId: string): void {
    const entry = this.#entries.get(sessionId);
    if (!entry) return;
    try {
      entry.unsubscribeExit();
    } catch (err) {
      this.#logger.warn(
        `PtyHost: unsubscribe for ${sessionId} threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.#entries.delete(sessionId);
  }
}
