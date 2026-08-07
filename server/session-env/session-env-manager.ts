/**
 * SessionEnvManager — one environment per session, owned by the session.
 *
 * Previously the dev-server runtime created the `SessionEnv` as a side effect
 * of starting a preview, and everything else had to borrow it. That made the
 * preview the de-facto owner of the session's whole environment, with two
 * consequences users hit constantly:
 *
 *   - **The terminal depended on the preview.** Opening a shell in a
 *     containerized session required starting a dev server first, because
 *     that was the only code path that created a container. On the sysbox
 *     backend the terminal simply refused with "start the session dev server
 *     first" — a shell, blocked on an unrelated feature.
 *   - **Stopping the preview destroyed the environment.** Disposing the
 *     dev server tore down the container out from under any terminal or
 *     command still using it.
 *
 * Here the session owns the environment and every consumer — preview,
 * terminal, and eventually the agent CLI and tests — asks the manager for the
 * *same* one. That shared identity is the point: a test the agent runs and a
 * request the preview serves hit one filesystem, one set of backing services,
 * one network. Anything less and "it works in the preview but not in the
 * tests" becomes a class of bug the platform creates on its own.
 *
 * Teardown is driven by the session lifecycle (archive/delete) and by the
 * idle reaper, not by any single feature stopping.
 */

import type { SessionEnv, SessionEnvKind } from './session-env.js';
import { createSessionEnv, type CreateSessionEnvOpts } from './select-session-env.js';
import { getSessionEnvSelection } from './sysbox-capability.js';

export interface SessionEnvManagerDeps {
  /**
   * Worktree for a session, or null when it has not been provisioned yet.
   * `ensure` fails loudly in that case rather than creating an env rooted
   * at a path that does not exist.
   */
  resolveWorktree: (sessionId: string) => string | null;
  /** Adapter to build. Defaults to the boot-time capability selection. */
  resolveAdapter?: () => SessionEnvKind;
  /** Seam for tests. Defaults to the real registry. */
  createEnv?: (kind: SessionEnvKind, opts: CreateSessionEnvOpts) => SessionEnv;
  /**
   * Host-port allocator for adapters that publish ports. Container envs
   * under container-IP routing never call this.
   */
  allocateHostPort?: (internalPort: number) => number | Promise<number>;
  /** Idle envs with no live processes are reaped after this long. Default 4h. */
  idleTtlMs?: number;
  /**
   * Resolves once the boot GC sweep has finished. That sweep deletes every
   * labeled session container it finds, on the premise that envs live only in
   * Hub memory so anything labeled must be from a previous run. The HTTP and
   * WebSocket servers accept traffic well before it completes, so without this
   * gate a terminal opened seconds after a restart creates a container the
   * sweep then removes as a leak — the readiness probe polls a container that
   * no longer exists and fails minutes later. Rejections are ignored: a failed
   * sweep must not make every session env unstartable.
   */
  bootSweep?: Promise<unknown>;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

const DEFAULT_IDLE_TTL_MS = 4 * 60 * 60 * 1000;

interface Entry {
  /** In-flight or settled creation. One per session, so `ensure` races collapse. */
  promise: Promise<SessionEnv>;
  env: SessionEnv | null;
}

export class SessionEnvManager {
  private readonly deps: SessionEnvManagerDeps;
  private readonly idleTtlMs: number;
  private readonly logger: NonNullable<SessionEnvManagerDeps['logger']>;
  private readonly entries = new Map<string, Entry>();
  /**
   * Teardowns still in flight, keyed by session.
   *
   * A session's container name is derived from its id, so the old container and
   * its replacement compete for one name. `dispose` drops the map entry as soon
   * as it starts — it has to, or a caller would be handed an env that is already
   * going away — which leaves a window where `ensure` sees nothing and starts
   * building while `docker rm -f` is still running. Docker then either rejects
   * the name as in use or, if the removal lands second, deletes the container
   * the new session is using. Creation waits on this instead.
   */
  private readonly teardowns = new Map<string, Promise<void>>();

  constructor(deps: SessionEnvManagerDeps) {
    this.deps = deps;
    this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
    };
  }

  /**
   * The session's environment, creating it on first use. Idempotent and
   * safe under concurrent callers — the preview and the terminal starting
   * at the same moment must not produce two containers for one session.
   */
  ensure(sessionId: string): Promise<SessionEnv> {
    const existing = this.entries.get(sessionId);
    // A disposed env is not reusable; drop it and build a fresh one.
    if (existing && !(existing.env?.disposed ?? false)) return existing.promise;
    if (existing) this.entries.delete(sessionId);

    const entry: Entry = {
      promise: Promise.resolve() as unknown as Promise<SessionEnv>,
      env: null,
    };
    entry.promise = this.#create(sessionId, entry);
    this.entries.set(sessionId, entry);
    entry.promise.catch(() => {
      // A failed creation must not wedge the session — allow a retry.
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
    });
    return entry.promise;
  }

  async #create(sessionId: string, entry: Entry): Promise<SessionEnv> {
    if (this.deps.bootSweep) await this.deps.bootSweep.catch(() => undefined);
    // A failed teardown must not wedge the session: the name may well be free
    // anyway, and refusing to build leaves the session with no environment at
    // all. Waiting is what matters, not the outcome.
    const teardown = this.teardowns.get(sessionId);
    if (teardown) await teardown.catch(() => undefined);
    const worktreePath = this.deps.resolveWorktree(sessionId);
    if (!worktreePath) {
      throw new Error(
        `Session ${sessionId} has no workspace yet. Wait for workspace provisioning to finish.`,
      );
    }
    const kind = (this.deps.resolveAdapter ?? (() => getSessionEnvSelection().adapter))();
    const create = this.deps.createEnv ?? createSessionEnv;
    const hostDeps = this.deps.allocateHostPort
      ? { allocateHostPort: this.deps.allocateHostPort }
      : undefined;
    const env = create(kind, {
      sessionId,
      worktreePath,
      ...(hostDeps ? { hostDeps, sysboxDeps: hostDeps } : {}),
    });
    entry.env = env;
    // Self-eviction: an env disposed directly (reaper, teardown, crash
    // cleanup) must not linger in the map as a live-looking entry.
    env.onDispose(() => {
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
    });
    await env.mountWorktree();
    this.logger.log(`[session-env] ${sessionId}: ready on "${kind}" adapter`);
    return env;
  }

  /** The session's env if one is live, without creating it. */
  get(sessionId: string): SessionEnv | null {
    const env = this.entries.get(sessionId)?.env ?? null;
    return env && !env.disposed ? env : null;
  }

  /** Sessions with a live (or in-flight) env. */
  listSessions(): string[] {
    return [...this.entries.keys()];
  }

  /** Tear down one session's env. Idempotent. */
  async dispose(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      // Already being torn down by another caller. Reporting "done" while the
      // container is still there would let the caller act on a name it does
      // not own yet.
      await this.teardowns.get(sessionId)?.catch(() => undefined);
      return;
    }
    this.entries.delete(sessionId);
    const teardown = this.#teardown(sessionId, entry);
    this.teardowns.set(sessionId, teardown);
    try {
      await teardown;
    } finally {
      if (this.teardowns.get(sessionId) === teardown) this.teardowns.delete(sessionId);
    }
  }

  async #teardown(sessionId: string, entry: Entry): Promise<void> {
    let env = entry.env;
    if (!env) {
      // Creation still in flight — wait for it so we dispose a real env
      // rather than leaking the container it is about to start.
      env = await entry.promise.catch(() => null);
    }
    if (!env) return;
    try {
      await env.dispose();
    } catch (err) {
      this.logger.warn(
        `[session-env] ${sessionId}: dispose failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Tear down every env (Hub shutdown). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.dispose(id)));
  }

  /**
   * Dispose envs idle past the TTL with nothing running inside them. A
   * container holding a database and an image cache is not free, and a
   * session nobody has touched in hours should not keep one.
   */
  async reap(nowMs: number): Promise<{ scanned: number; reaped: number }> {
    let reaped = 0;
    const ids = [...this.entries.keys()];
    for (const sessionId of ids) {
      const env = this.entries.get(sessionId)?.env;
      if (!env || env.disposed) continue;
      if (env.liveProcessCount() > 0) continue;
      if (nowMs - env.lastActivityAtMs < this.idleTtlMs) continue;
      this.logger.log(`[session-env] ${sessionId}: reaping idle environment`);
      await this.dispose(sessionId);
      reaped++;
    }
    return { scanned: ids.length, reaped };
  }
}
