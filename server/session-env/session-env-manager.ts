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

import type { SessionEnv, SessionEnvDisposeOpts, SessionEnvKind } from './session-env.js';
import { createSessionEnv, type CreateSessionEnvOpts } from './select-session-env.js';
import { getSessionEnvSelection, whenSessionEnvSelectionReady } from './sysbox-capability.js';
import {
  clearSessionStartupStatus,
  startSessionStartupHooks,
  type SessionStartupRunStatus,
} from './session-startup-hooks.js';

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
  /** Companion to {@link allocateHostPort} — drop the reservation after Docker binds (or start fails). */
  releaseHostPort?: (hostPort: number) => void;
  /**
   * Preview internal ports to declare before the first container start.
   * Under published-ports routing, a terminal-first openPty would otherwise
   * start with an empty `-p` set and lock out later mapPortsOut.
   */
  resolvePublishPorts?: (sessionId: string) => number[] | null;
  /**
   * Project `sessionStartupCommands` for this session (empty = skip).
   * Looked up after mountWorktree; run in the background without blocking ensure.
   */
  resolveStartupCommands?: (sessionId: string) => string[];
  /**
   * Progress callback for background session startup hooks (Progress panel).
   */
  onStartupProgress?: (update: {
    sessionId: string;
    runStatus: SessionStartupRunStatus;
    stepStatus: 'started' | 'completed' | 'failed';
    startedAt: number;
    finishedAt?: number;
    detail?: string;
  }) => void;
  /**
   * Progress for non-host env boot (`Launching session VM`). Fired around
   * create + mountWorktree so the Progress panel covers the blank gap before
   * session startup hooks. Host adapter skips this (no VM/container to boot).
   */
  onEnvLaunchProgress?: (update: {
    sessionId: string;
    status: 'started' | 'completed' | 'failed';
    startedAt: number;
    finishedAt?: number;
  }) => void;
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
  /** Cancels in-flight session startup hooks on dispose. */
  startupAbort?: AbortController;
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
    // A dispose in flight owns the session name — wait for it before deciding
    // whether to reuse (failed stop) or replace (successful stop).
    const pendingTeardown = this.teardowns.get(sessionId);
    if (pendingTeardown) {
      return pendingTeardown.then(
        () => this.ensure(sessionId),
        () => this.ensure(sessionId),
      );
    }
    const existing = this.entries.get(sessionId);
    // A disposed env is not reusable; drop it and build a fresh one.
    // A live env whose prior dispose failed stays here (disposed === false)
    // so we never allocate a second environment against the same resources.
    if (existing && !(existing.env?.disposed ?? false)) return existing.promise;
    if (existing) this.entries.delete(sessionId);

    const entry: Entry = {
      promise: Promise.resolve() as unknown as Promise<SessionEnv>,
      env: null,
    };
    this.entries.set(sessionId, entry);
    entry.promise = this.#create(sessionId, entry);
    entry.promise.catch(() => {
      // A failed creation must not wedge the session when nothing was started.
      // If an env object exists and is still live, retain it — Firecracker may
      // have left taps/slots/VMM ownership after a failed boot teardown.
      if (this.entries.get(sessionId) !== entry) return;
      if (entry.env && !entry.env.disposed && entry.env.retainAfterFailedEnsure()) return;
      this.entries.delete(sessionId);
    });
    return entry.promise;
  }

  async #create(sessionId: string, entry: Entry): Promise<SessionEnv> {
    // Capture before awaiting anything dispose can race with — see
    // dispose-during-bootSweep. A teardown registered *after* we enter must
    // not be awaited here (that deadlocks with teardown awaiting us).
    const priorTeardown = this.teardowns.get(sessionId);
    await whenSessionEnvSelectionReady();
    if (this.entries.get(sessionId) !== entry) {
      throw new Error(`Session ${sessionId} environment creation was superseded during boot`);
    }
    if (this.deps.bootSweep) await this.deps.bootSweep.catch(() => undefined);
    // Only wait on a teardown that was already registered when we entered
    // create. A dispose that starts while we are blocked on bootSweep registers
    // a *new* teardown — awaiting that here would deadlock with #teardown
    // waiting on this same entry.promise.
    if (priorTeardown) await priorTeardown.catch(() => undefined);
    if (this.entries.get(sessionId) !== entry) {
      throw new Error(`Session ${sessionId} environment creation was superseded during boot`);
    }
    const worktreePath = this.deps.resolveWorktree(sessionId);
    if (!worktreePath) {
      throw new Error(
        `Session ${sessionId} has no workspace yet. Wait for workspace provisioning to finish.`,
      );
    }
    const kind = (this.deps.resolveAdapter ?? (() => getSessionEnvSelection().adapter))();
    const create = this.deps.createEnv ?? createSessionEnv;
    const publishPorts = this.deps.resolvePublishPorts?.(sessionId) ?? null;
    const sysboxDeps = {
      ...(this.deps.allocateHostPort ? { allocateHostPort: this.deps.allocateHostPort } : {}),
      ...(this.deps.releaseHostPort ? { releaseHostPort: this.deps.releaseHostPort } : {}),
      ...(publishPorts && publishPorts.length > 0 ? { publishPorts } : {}),
    };
    const hostDeps = this.deps.allocateHostPort
      ? { allocateHostPort: this.deps.allocateHostPort }
      : undefined;

    const launchStartedAt = Date.now();
    const reportLaunch = kind !== 'host';
    if (reportLaunch) {
      this.deps.onEnvLaunchProgress?.({
        sessionId,
        status: 'started',
        startedAt: launchStartedAt,
      });
    }

    try {
      const env = create(kind, {
        sessionId,
        worktreePath,
        ...(hostDeps ? { hostDeps } : {}),
        ...(Object.keys(sysboxDeps).length > 0 ? { sysboxDeps } : {}),
      });
      entry.env = env;
      // Self-eviction: an env disposed directly (reaper, teardown, crash
      // cleanup) must not linger in the map as a live-looking entry.
      env.onDispose(() => {
        if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
      });
      await env.mountWorktree();
      if (reportLaunch) {
        this.deps.onEnvLaunchProgress?.({
          sessionId,
          status: 'completed',
          startedAt: launchStartedAt,
          finishedAt: Date.now(),
        });
      }
      this.logger.log(`[session-env] ${sessionId}: ready on "${kind}" adapter`);

      // Background project startup hooks — never block ensure()/chat. Abort on dispose.
      const commands = this.deps.resolveStartupCommands?.(sessionId) ?? [];
      if (commands.length > 0) {
        const abort = new AbortController();
        entry.startupAbort = abort;
        void startSessionStartupHooks({
          sessionId,
          env,
          commands,
          signal: abort.signal,
          onProgress: (update) => {
            this.deps.onStartupProgress?.({ sessionId, ...update });
          },
        }).then((status) => {
          this.logger.log(
            `[session-env] ${sessionId}: startup hooks ${status.status} (${commands.length} command(s))`,
          );
        });
      }

      return env;
    } catch (err) {
      if (reportLaunch) {
        this.deps.onEnvLaunchProgress?.({
          sessionId,
          status: 'failed',
          startedAt: launchStartedAt,
          finishedAt: Date.now(),
        });
      }
      throw err;
    }
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
  async dispose(sessionId: string, opts: SessionEnvDisposeOpts = {}): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      // Already being torn down by another caller. Reporting "done" while the
      // container is still there would let the caller act on a name it does
      // not own yet.
      await this.teardowns.get(sessionId)?.catch(() => undefined);
      return;
    }
    // Keep the map entry until dispose succeeds. Firecracker (and any adapter
    // that fails closed on stop) must retain ownership of live VM resources —
    // deleting first would let ensure() create a second env against the same
    // taps/disks while stopVmm is still failing.
    let teardown = this.teardowns.get(sessionId);
    if (!teardown) {
      teardown = this.#teardown(sessionId, entry, opts).finally(() => {
        if (this.teardowns.get(sessionId) === teardown) this.teardowns.delete(sessionId);
      });
      this.teardowns.set(sessionId, teardown);
    }
    await teardown;
    if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
  }

  async #teardown(sessionId: string, entry: Entry, opts: SessionEnvDisposeOpts): Promise<void> {
    entry.startupAbort?.abort();
    clearSessionStartupStatus(sessionId);
    let env = entry.env;
    if (!env) {
      // Creation still in flight — wait for it so we dispose a real env
      // rather than leaking the container it is about to start.
      env = await entry.promise.catch(() => null);
    }
    if (!env) return;
    try {
      await env.dispose(opts);
    } catch (err) {
      this.logger.warn(
        `[session-env] ${sessionId}: dispose failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
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
      let detached = false;
      try {
        detached = await env.hasDetachedWorkload();
      } catch (err) {
        // Fail closed: a probe error must not delete a live guest/container.
        this.logger.warn(
          `[session-env] ${sessionId}: workload probe failed (skipping reap): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      if (detached) continue;
      this.logger.log(`[session-env] ${sessionId}: reaping idle environment`);
      await this.dispose(sessionId);
      reaped++;
    }
    return { scanned: ids.length, reaped };
  }
}
