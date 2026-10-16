/**
 * The container DesktopRuntime: lifecycle for one long-lived computer per
 * (user, agent, project), on whichever DesktopContainerHost the deployment
 * uses (Hub-host docker or the runner fleet).
 *
 *   - Start is single-flight per computer, so concurrent sessions of the same
 *     user/agent/project share one container.
 *   - Every op resumes a stopped computer first, then refreshes its idle clock.
 *   - A sweep stops computers idle for DESKTOP_IDLE_STOP_MS. Their home stays.
 *   - A Hub-wide cap bounds running computers. A start past the cap fails with
 *     DesktopCapacityError, whose message is written to be shown to the agent.
 *   - `adopt` picks up computers that were running before a Hub restart.
 *
 * One invariant holds the rest together: the persisted record's runner ref
 * says "a container may exist". It is written before the container can
 * exist, and cleared only after the host for the record's own placement
 * confirms the container is gone (for the fleet: the runner finished the
 * job, having saved the home). A request to stop is not a confirmation, and
 * nothing that fails (an inspect, a stop, a cleanup) drops the ref. Such a computer keeps its
 * capacity slot, reads as `error`, and is reconciled again by the next start
 * or sweep. Deletion likewise goes through every placement that may hold
 * the computer's home, and keeps the record until all of them are clean.
 */
import { randomBytes } from 'crypto';
import {
  DESKTOP_IDLE_STOP_MS,
  type DesktopComputerKey,
  type DesktopComputerState,
  type DesktopComputerStatus,
  type DesktopDisplayEndpoint,
  type DesktopExecOptions,
  type DesktopExecResult,
  type DesktopInputEvent,
  type DesktopRuntime,
} from './desktop-runtime.js';
import {
  createDesktopControlClient,
  DesktopUnreachableError,
  execOp,
  inputEventToOp,
  parseExecReply,
  parseScreenshotReply,
  type DesktopControlClient,
} from './desktop-control-client.js';
import { desktopInputArgv } from './desktop-input-commands.js';
import type { DesktopContainerHost, DesktopHostStatus } from './container-desktop-host.js';
import type { DesktopContainerPlacement } from './desktop-runtime-selection.js';
import {
  DesktopComputerDeletingError,
  desktopDeletionGuard,
  type DesktopDeletionGuard,
} from './desktop-deletion-guard.js';
import {
  deleteDesktopComputerRecord,
  clearDesktopHomeBlock,
  getDesktopComputer,
  getDesktopComputerById,
  getOrCreateDesktopComputer,
  setDesktopHomeDecision,
  listActiveDesktopComputers,
  readDesktopControlToken,
  recordDesktopReserved,
  recordDesktopStarted,
  recordDesktopStopped,
  touchDesktopComputer,
  type DesktopComputerRecord,
} from './desktop-containers-store.js';

export const DEFAULT_DESKTOP_MAX_RUNNING = 4;
/** Hub-host docker boots in seconds; the fleet may have to scale a runner up first. */
export const DEFAULT_DESKTOP_START_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_DESKTOP_HEALTH_TIMEOUT_MS = 90_000;
export const DEFAULT_DESKTOP_STOP_CONFIRM_TIMEOUT_MS = 2 * 60_000;
const PERSIST_ACTIVITY_EVERY_MS = 60_000;

/** No free desktop slot. The message is the observation the agent sees. */
export class DesktopCapacityError extends Error {
  readonly code = 'desktop_capacity_full';
  readonly maxRunning: number;
  constructor(maxRunning: number, idleMs: number) {
    super(
      `All ${maxRunning} desktop slots on this Hub are in use, so your computer could not start. ` +
        `A desktop frees its slot after ${Math.round(idleMs / 60_000)} minutes without a computer call, ` +
        'or when it is stopped. Try again later, or ask an operator to raise AGENT_HUB_DESKTOP_MAX_RUNNING.',
    );
    this.name = 'DesktopCapacityError';
    this.maxRunning = maxRunning;
  }
}

/** Why a computer whose latest home could not be saved won't start. */
export function homeBlockedMessage(detail: string): string {
  return (
    `This desktop's latest home could not be saved (${detail}), so it was not restarted on an ` +
    "older copy. Delete the agent's saved browser profile to start fresh, or ask an operator " +
    'to recover that home and clear the block.'
  );
}

/** The computer could not be started or brought to a healthy state. */
export class DesktopStartError extends Error {
  readonly code = 'desktop_start_failed';
  constructor(message: string) {
    super(message);
    this.name = 'DesktopStartError';
  }
}

export interface ContainerDesktopRuntimeDeps {
  /** Where new computers start. */
  host: DesktopContainerHost;
  /**
   * The host for another placement, for computers recorded there before a
   * placement switch (stop, reconcile, home deletion). Defaults to refusing.
   */
  hostFor?: (placement: DesktopContainerPlacement) => DesktopContainerHost;
  client?: DesktopControlClient;
  maxRunning?: number;
  idleMs?: number;
  startTimeoutMs?: number;
  healthTimeoutMs?: number;
  /** How long a start waits for the previous container's stop to be confirmed. */
  stopConfirmTimeoutMs?: number;
  pollMs?: number;
  sweepMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Start the idle sweep timer. Tests pass a no-op and call `sweepIdle()`. */
  startTimer?: (fn: () => void, ms: number) => { stop: () => void };
  newToken?: () => string;
  log?: (msg: string) => void;
  /** Refuses starts while the key's profile is being deleted. */
  deletionGuard?: DesktopDeletionGuard;
}

export interface ContainerDesktopRuntime extends DesktopRuntime {
  /** Stop every computer idle past the threshold. Returns the computer ids stopped. */
  sweepIdle(): Promise<string[]>;
  /** Re-attach to computers that were running before a Hub restart. */
  adopt(): Promise<void>;
  /** Stop the computer and delete its persistent home and record. */
  destroy(key: DesktopComputerKey): Promise<void>;
  /**
   * Computers holding a slot: starting, running, or with a container not yet
   * confirmed gone (including records this process has not reconciled).
   */
  runningCount(): number;
  dispose(): void;
}

interface Entry {
  id: string;
  key: DesktopComputerKey;
  /** Placement of `runnerRef` (and of the last start). */
  placement: DesktopContainerPlacement;
  state: DesktopComputerState;
  runnerRef: string | null;
  endpoint: DesktopDisplayEndpoint | null;
  token: string | null;
  lastActiveAt: number | null;
  lastPersistedAt: number;
  inFlight: number;
  /**
   * Every lifecycle transition of this computer (settle, start, stop,
   * reconcile, destroy) runs under this lock, one at a time, and re-reads the
   * entry once it holds it. Nothing acts on state read before it queued.
   */
  lock: Promise<void>;
  /** Transitions queued or running under `lock`. */
  busy: number;
  /**
   * Bumped whenever a container becomes this computer's (each start, each
   * adoption). Refs alone can't tell incarnations apart: the Hub-docker host
   * reuses one container name per computer.
   */
  incarnation: number;
  error?: string;
}

const keyString = (k: DesktopComputerKey) => `${k.userId}\u0000${k.agentId}\u0000${k.projectId}`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createContainerDesktopRuntime(
  deps: ContainerDesktopRuntimeDeps,
): ContainerDesktopRuntime {
  const { host } = deps;
  const client = deps.client ?? createDesktopControlClient();
  const maxRunning = Math.max(1, deps.maxRunning ?? DEFAULT_DESKTOP_MAX_RUNNING);
  const idleMs = deps.idleMs ?? DESKTOP_IDLE_STOP_MS;
  const startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_DESKTOP_START_TIMEOUT_MS;
  const healthTimeoutMs = deps.healthTimeoutMs ?? DEFAULT_DESKTOP_HEALTH_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 1_000;
  const stopConfirmTimeoutMs = deps.stopConfirmTimeoutMs ?? DEFAULT_DESKTOP_STOP_CONFIRM_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newToken = deps.newToken ?? (() => randomBytes(32).toString('hex'));
  const log = deps.log ?? ((m: string) => console.log(`[desktop] ${m}`));
  const startTimer =
    deps.startTimer ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return { stop: () => clearInterval(t) };
    });

  const deletion = deps.deletionGuard ?? desktopDeletionGuard;
  const hostFor =
    deps.hostFor ??
    ((p: DesktopContainerPlacement) => {
      throw new Error(`no desktop host for placement ${p} on this Hub`);
    });
  const entries = new Map<string, Entry>();

  function hostOf(e: Entry): DesktopContainerHost {
    return e.placement === host.placement ? host : hostFor(e.placement);
  }

  // The entry starts from the record, runner ref included: a container the
  // record says may exist is unconfirmed until reconciled, never "stopped".
  function entryFrom(rec: DesktopComputerRecord, key: DesktopComputerKey): Entry {
    return {
      id: rec.id,
      key,
      placement: rec.placement,
      state: rec.runnerRef ? 'error' : 'stopped',
      runnerRef: rec.runnerRef,
      endpoint: null,
      token: null,
      lastActiveAt: rec.lastActiveAt,
      lastPersistedAt: 0,
      inFlight: 0,
      lock: Promise.resolve(),
      busy: 0,
      incarnation: 0,
      ...(rec.runnerRef ? { error: 'not reconciled since the Hub started' } : {}),
    };
  }

  function entryForRecord(rec: DesktopComputerRecord): Entry {
    const key = { userId: rec.userId, agentId: rec.agentId, projectId: rec.projectId };
    const k = keyString(key);
    let e = entries.get(k);
    if (!e) {
      e = entryFrom(rec, key);
      entries.set(k, e);
    }
    return e;
  }

  function entryFor(key: DesktopComputerKey): Entry {
    return entryForRecord(getOrCreateDesktopComputer(key, host.placement));
  }

  // A computer holds a slot from reservation until its container is confirmed
  // gone: a stop in progress, or one that failed, still has a live runner ref.
  function holdsSlot(e: Entry): boolean {
    return e.state === 'starting' || e.runnerRef !== null;
  }

  /** Run `fn` as this computer's next lifecycle transition (see Entry.lock). */
  function locked<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    e.busy++;
    const run = e.lock.then(fn);
    e.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      e.busy--;
    });
  }

  // Persisted live refs count too, so a record this process never loaded
  // (or failed to reconcile) can't be overbooked.
  function runningCount(): number {
    const active = listActiveDesktopComputers();
    // A blocked computer's runner is parked on a kept home: its container was
    // removed before the block was reported, so it holds no desktop slot (the
    // job, and so ownership of that home, stays).
    const parked = new Set(active.filter((r) => r.homeBlocked).map((r) => r.id));
    const ids = new Set<string>();
    for (const e of entries.values()) if (holdsSlot(e) && !parked.has(e.id)) ids.add(e.id);
    for (const rec of active) {
      if (parked.has(rec.id)) continue;
      const e = entries.get(
        keyString({ userId: rec.userId, agentId: rec.agentId, projectId: rec.projectId }),
      );
      // An entry that already confirmed cleanup wins over a stale read.
      if (!e || holdsSlot(e)) ids.add(rec.id);
    }
    return ids.size;
  }

  function touch(e: Entry): void {
    const t = now();
    e.lastActiveAt = t;
    if (t - e.lastPersistedAt >= PERSIST_ACTIVITY_EVERY_MS) {
      e.lastPersistedAt = t;
      try {
        touchDesktopComputer(e.id, t);
      } catch (err) {
        log(`could not persist activity for ${e.id}: ${message(err)}`);
      }
    }
  }

  function toStatus(e: Entry): DesktopComputerStatus {
    return {
      kind: 'container',
      state: e.state,
      lastActiveAt: e.lastActiveAt,
      ...(e.state === 'error' && e.error ? { error: e.error } : {}),
    };
  }

  function markStopped(e: Entry): void {
    e.state = 'stopped';
    e.runnerRef = null;
    e.endpoint = null;
    e.token = null;
    recordDesktopStopped({ id: e.id, now: now() });
  }

  /**
   * Ask the host to stop the container behind `ref`; let go of the ref only
   * when the host confirms it is gone. Unconfirmed (a fleet runner still
   * removing it and saving the home): the entry stays `stopping` with its ref
   * and slot, and later calls ask again. Throws, keeping both, when the host
   * can't be asked. Returns whether the stop is confirmed.
   */
  async function release(e: Entry, ref: string): Promise<boolean> {
    const { confirmed } = await hostOf(e).stop(ref, e.id);
    if (confirmed) {
      markStopped(e);
      // A parked runner told to discard its kept home has done so: the
      // computer resumes from its previous snapshot from now on.
      const rec = getDesktopComputerById(e.id);
      if (rec?.homeBlocked && rec.homeDecision === 'discard') clearDesktopHomeBlock(e.id);
      return true;
    }
    e.state = 'stopping';
    e.endpoint = null;
    e.error = undefined;
    return false;
  }

  /**
   * Settle a runner ref this process doesn't know to be healthy: adopt it
   * when it is a healthy container on the current placement, otherwise ask
   * for it to stop (see `release`). Throws, keeping the ref and the slot,
   * when the host can't be asked. Caller holds the lock.
   */
  async function reconcile(e: Entry): Promise<void> {
    const ref = e.runnerRef;
    if (!ref) return;
    try {
      const st = await hostOf(e).status(ref);
      const token = readDesktopControlToken(e.id);
      if (e.placement === host.placement && st.state === 'running' && st.endpoint && token) {
        e.incarnation++;
        e.state = 'running';
        e.endpoint = st.endpoint;
        e.token = token;
        e.error = undefined;
        // Unknown activity counts from now, so an adopted computer gets a full idle window.
        e.lastActiveAt ??= now();
        log(`adopted running computer ${e.id}`);
        return;
      }
      // A start interrupted by a restart, a dead container, one on a
      // placement this Hub no longer starts on, or a stop still in progress.
      if (await release(e, ref)) {
        log(`computer ${e.id} reconciled: container on ${e.placement} is gone`);
      }
    } catch (err) {
      e.state = 'error';
      e.error = `could not reconcile its container: ${message(err)}`;
      throw err;
    }
  }

  /**
   * Reconcile until the old container is confirmed gone, or give up with a
   * clear error. Caller holds the lock, so no other transition (a second
   * resume included) can start a replacement in between.
   */
  async function settlePrevious(e: Entry): Promise<void> {
    const deadline = now() + stopConfirmTimeoutMs;
    for (;;) {
      await reconcile(e);
      if (!e.runnerRef || e.state === 'running') return;
      if (now() >= deadline) {
        throw new DesktopStartError(
          'Your previous desktop is still shutting down on its runner (it saves your home before ' +
            'it lets go). Try again in a few minutes.',
        );
      }
      await sleep(pollMs);
    }
  }

  async function waitRunning(e: Entry, runnerRef: string): Promise<DesktopDisplayEndpoint> {
    const deadline = now() + startTimeoutMs;
    let last: DesktopHostStatus | null = null;
    for (;;) {
      last = await host.status(runnerRef);
      if (last.state === 'running' && last.endpoint) break;
      if (last.state === 'lost' || last.state === 'stopped') {
        throw new DesktopStartError(
          `The desktop container stopped while starting${last.detail ? `: ${last.detail}` : ''}.`,
        );
      }
      if (now() >= deadline) {
        const mins = Math.round(startTimeoutMs / 60_000);
        throw new DesktopStartError(
          last.state === 'pending'
            ? `No runner picked up the desktop within ${mins} minutes. The runner fleet may be at capacity.`
            : `The desktop container did not start within ${mins} minutes.`,
        );
      }
      await sleep(pollMs);
    }
    const endpoint = last.endpoint;
    const healthDeadline = now() + healthTimeoutMs;
    while (!(await client.healthy(endpoint))) {
      if (now() >= healthDeadline) {
        throw new DesktopStartError(
          `The desktop started but its control daemon did not answer within ${Math.round(
            healthTimeoutMs / 1000,
          )} seconds.`,
        );
      }
      await sleep(pollMs);
    }
    return endpoint;
  }

  async function doStart(e: Entry, admittedAt: number): Promise<void> {
    if (deletion.isPending(e.key) || deletion.generation(e.key) !== admittedAt) {
      e.state = 'stopped';
      throw new DesktopComputerDeletingError();
    }
    const rec = getOrCreateDesktopComputer(e.key, host.placement);
    let homeRef = rec.homeRef;
    if (rec.placement !== host.placement && homeRef) {
      log(
        `computer ${e.id} last ran on ${rec.placement}; its home there is not reachable from ${host.placement}, starting with a fresh home`,
      );
      homeRef = null;
    }
    const token = newToken();
    // Ownership is written before the resource can exist, for every host: a
    // create that fails, or a Hub that dies at any point after this line,
    // still leaves a record pointing at whatever was created. The token goes
    // with it so a restarted Hub can adopt a container that came up.
    const runnerRef = host.allocateRef(e.id);
    try {
      recordDesktopReserved({
        id: e.id,
        placement: host.placement,
        runnerRef,
        controlToken: token,
      });
    } catch (err) {
      e.state = 'error';
      e.error = message(err);
      throw new DesktopStartError(message(err));
    }
    e.placement = host.placement;
    e.runnerRef = runnerRef;
    e.token = token;
    e.incarnation++;
    try {
      const started = await host.start({
        computerId: e.id,
        key: e.key,
        controlToken: token,
        homeRef,
        runnerRef,
      });
      recordDesktopStarted({
        id: e.id,
        placement: host.placement,
        runnerRef,
        controlToken: token,
        homeRef: started.homeRef,
        now: now(),
      });
      e.endpoint = await waitRunning(e, runnerRef);
      e.state = 'running';
      e.error = undefined;
      touch(e);
      log(`computer ${e.id} running (${host.placement})`);
    } catch (err) {
      let cleanup = '';
      const ref = e.runnerRef;
      if (ref) {
        try {
          if (!(await release(e, ref))) cleanup = ' Its container is still shutting down.';
        } catch (stopErr) {
          cleanup = ` Cleaning up the failed container also failed: ${message(stopErr)}`;
        }
      }
      e.endpoint = null;
      // The ref (and slot) stay whenever cleanup is not confirmed.
      e.state = 'error';
      e.error = message(err) + cleanup;
      throw err instanceof DesktopStartError ? err : new DesktopStartError(message(err));
    }
  }

  function refuseIfBlocked(e: Entry): void {
    const blocked = getDesktopComputerById(e.id)?.homeBlocked;
    if (!blocked) return;
    e.error = homeBlockedMessage(blocked);
    if (!e.runnerRef) e.state = 'error';
    throw new DesktopStartError(e.error);
  }

  async function ensureStarted(key: DesktopComputerKey): Promise<DesktopComputerStatus> {
    // Checked before the record is created, so a start racing a profile
    // delete can't bring the row back.
    if (deletion.isPending(key)) throw new DesktopComputerDeletingError();
    const admittedAt = deletion.generation(key);
    const e = entryFor(key);
    if (e.state === 'running' && e.busy === 0) return toStatus(e);
    // Concurrent resumes queue here; each sees what the previous one left
    // (running, or a ref it must settle), never a snapshot from before.
    return locked(e, async () => {
      if (e.state === 'running') return toStatus(e);
      refuseIfBlocked(e);
      // A container left over from a failed start or stop must be gone before
      // a new one starts; if it can't be stopped the error surfaces here.
      if (e.runnerRef) {
        await settlePrevious(e);
        if ((e.state as DesktopComputerState) === 'running') return toStatus(e);
      }
      if (deletion.isPending(key) || deletion.generation(key) !== admittedAt) {
        throw new DesktopComputerDeletingError();
      }
      refuseIfBlocked(e);
      // Checked and reserved in one synchronous step, so concurrent starts of
      // different computers can't overshoot the cap.
      if (runningCount() >= maxRunning) throw new DesktopCapacityError(maxRunning, idleMs);
      e.state = 'starting';
      e.error = undefined;
      await doStart(e, admittedAt);
      return toStatus(e);
    });
  }

  /**
   * Stop the container behind the entry's ref. With `onlyIncarnation`, only
   * if that container is still the current one (recovery for a container
   * that died must not stop a replacement another caller started meanwhile,
   * even one that reuses the same ref). Caller holds the lock.
   */
  async function stopLocked(e: Entry, reason: string, onlyIncarnation?: number): Promise<void> {
    const ref = e.runnerRef;
    if (!ref || (onlyIncarnation !== undefined && e.incarnation !== onlyIncarnation)) return;
    e.state = 'stopping';
    try {
      log(
        (await release(e, ref))
          ? `computer ${e.id} stopped (${reason})`
          : `computer ${e.id} stop requested (${reason}); waiting for its runner to confirm`,
      );
    } catch (err) {
      e.state = 'error';
      e.error = `stop failed: ${message(err)}`;
      throw err;
    }
  }

  function stopEntry(e: Entry, reason: string, onlyIncarnation?: number): Promise<void> {
    return locked(e, () => stopLocked(e, reason, onlyIncarnation));
  }

  async function withComputer<T>(
    key: DesktopComputerKey,
    fn: (endpoint: DesktopDisplayEndpoint, token: string) => Promise<T>,
  ): Promise<T> {
    if (deletion.isPending(key)) throw new DesktopComputerDeletingError();
    const e = entryFor(key);
    // Counted before the start, so an idle sweep can't stop the computer
    // between this op's start and its call.
    e.inFlight++;
    try {
      for (let attempt = 0; ; attempt++) {
        await ensureStarted(key);
        const endpoint = e.endpoint;
        const token = e.token;
        const ref = e.runnerRef;
        const incarnation = e.incarnation;
        if (!endpoint || !token || !ref) throw new DesktopStartError('The desktop is not running.');
        touch(e);
        try {
          return await fn(endpoint, token);
        } catch (err) {
          if (!(err instanceof DesktopUnreachableError) || attempt > 0) throw err;
          // The container may have died under us; if so, resume and retry once.
          const st = await hostOf(e)
            .status(ref)
            .catch(() => null);
          if (st?.state === 'running') throw err;
          log(`computer ${e.id} went away (${st?.detail ?? 'unknown'}); restarting`);
          // Only the container this call used: if another caller already
          // replaced it (same ref or not), that replacement is left alone.
          await stopEntry(e, 'lost', incarnation);
        }
      }
    } finally {
      e.inFlight--;
      touch(e);
    }
  }

  let sweeping = false;
  async function sweepIdle(): Promise<string[]> {
    if (sweeping) return [];
    sweeping = true;
    const stopped: string[] = [];
    try {
      // Retry computers whose container could not be confirmed gone (a failed
      // stop, inspect or cleanup), including persisted ones not loaded yet.
      for (const rec of listActiveDesktopComputers()) entryForRecord(rec);
      const unsettled = (e: Entry) =>
        (e.state === 'error' || e.state === 'stopping') && e.runnerRef !== null;
      for (const e of entries.values()) {
        if (!unsettled(e) || e.busy > 0 || e.inFlight > 0) continue;
        await locked(e, async () => {
          if (unsettled(e) && e.inFlight === 0) await reconcile(e);
        }).catch((err: unknown) => log(`reconcile of ${e.id} failed again: ${message(err)}`));
      }
      const idle = (e: Entry) =>
        e.state === 'running' &&
        e.inFlight === 0 &&
        (e.lastActiveAt === null || now() - e.lastActiveAt >= idleMs);
      for (const e of entries.values()) {
        if (!idle(e) || e.busy > 0) continue;
        try {
          // Re-checked under the lock: an op or a resume may have come in.
          const didStop = await locked(e, async () => {
            if (!idle(e)) return false;
            await stopLocked(e, 'idle');
            return true;
          });
          if (didStop) stopped.push(e.id);
        } catch (err) {
          log(`idle stop of ${e.id} failed: ${message(err)}`);
        }
      }
    } finally {
      sweeping = false;
    }
    return stopped;
  }

  const timer = startTimer(() => void sweepIdle(), deps.sweepMs ?? 60_000);

  const runtime: ContainerDesktopRuntime = {
    kind: 'container',
    ensureStarted,
    async stop(key) {
      // The record, not the cache, says whether a container may exist: a
      // computer not loaded yet (before adoption reached it) still stops.
      const rec = getDesktopComputer(key);
      if (rec) await stopEntry(entryForRecord(rec), 'requested');
    },
    async exec(key, command, opts?: DesktopExecOptions): Promise<DesktopExecResult> {
      const { body, timeoutMs } = execOp(command, opts);
      return withComputer(key, async (endpoint, token) =>
        parseExecReply(await client.op(endpoint, token, body, timeoutMs)),
      );
    },
    async screenshot(key) {
      return withComputer(key, async (endpoint, token) =>
        parseScreenshotReply(await client.op(endpoint, token, { op: 'screenshot' })),
      );
    },
    async viewFrame(key) {
      const e = entries.get(keyString(key));
      if (!e || e.state !== 'running' || e.busy > 0) return null;
      const { endpoint, token } = e;
      if (!endpoint || !token) return null;
      return parseScreenshotReply(await client.op(endpoint, token, { op: 'screenshot' }));
    },
    async input(key, event: DesktopInputEvent) {
      // The Firecracker guest's rules, before any start: a bad coordinate
      // must not cost a boot, and both backends refuse the same events.
      desktopInputArgv(event);
      const { body, timeoutMs } = inputEventToOp(event);
      await withComputer(key, (endpoint, token) => client.op(endpoint, token, body, timeoutMs));
    },
    async mapDisplayPort() {
      throw new Error(
        'The container desktop has no VNC display server; use screenshot for the live view.',
      );
    },
    async status(key) {
      const e = entries.get(keyString(key));
      if (e) return toStatus(e);
      const rec = getDesktopComputer(key);
      if (!rec) return { kind: 'container', state: 'stopped', lastActiveAt: null };
      const st = toStatus(entryForRecord(rec));
      if (st.state === 'stopped' && rec.homeBlocked) {
        return { ...st, state: 'error', error: homeBlockedMessage(rec.homeBlocked) };
      }
      return st;
    },
    sweepIdle,
    async adopt() {
      for (const rec of listActiveDesktopComputers()) {
        const e = entryForRecord(rec);
        // On failure the entry keeps its runner ref (and slot) and the sweep
        // retries it.
        await locked(e, async () => {
          if (e.state !== 'running' && e.runnerRef) await reconcile(e);
        }).catch((err: unknown) => log(`could not reconcile ${rec.id} on boot: ${message(err)}`));
      }
    },
    async destroy(key) {
      const first = getDesktopComputer(key);
      if (!first) return;
      const e = entryForRecord(first);
      await locked(e, async () => {
        const rec = getDesktopComputerById(e.id);
        if (!rec) return;
        // A runner parked on a refused home holds the user's data: ask it to
        // remove that copy. Deletion completes only once it confirms.
        if (rec.homeBlocked && e.runnerRef) setDesktopHomeDecision(rec.id, 'discard');
        await stopLocked(e, 'profile deleted');
        if (e.runnerRef) {
          // Deleting the home under a runner still saving (or removing) it would race it.
          throw new Error(
            rec.homeBlocked
              ? "the desktop's kept home is being removed from its runner; retry the delete in a minute"
              : 'the desktop is still shutting down on its runner; retry the delete in a few minutes',
          );
        }
        // Every placement that may hold a home, through its own host. The
        // record stays (and so the way to retry) until all of them are clean.
        const placements = new Set<DesktopContainerPlacement>([
          rec.placement,
          ...rec.homePlacements,
        ]);
        const failures: string[] = [];
        for (const p of placements) {
          try {
            await (p === host.placement ? host : hostFor(p)).deleteHome(rec.id);
          } catch (err) {
            failures.push(`${p}: ${message(err)}`);
          }
        }
        if (failures.length) {
          throw new Error(`could not delete the desktop home (${failures.join('; ')})`);
        }
        deleteDesktopComputerRecord(rec.id);
        entries.delete(keyString(key));
        log(`computer ${rec.id} deleted with its home`);
      });
    },
    runningCount,
    dispose() {
      timer.stop();
    },
  };
  return runtime;
}
