/**
 * Firecracker backend for DesktopRuntime: one microVM per (user, agent,
 * project), independent of chat sessions.
 *
 * It reuses the session microVM stack (FirecrackerSessionEnv) with three
 * differences that make the computer persistent:
 *
 *   - The VM id is derived from the computer key, not a session id, and the
 *     session-env manager never sees it, so archiving a session leaves the
 *     computer alone.
 *   - The second drive is an empty data disk that survives stop/resume. The
 *     guest binds the desktop user's home onto it (agent-hub-desktop-home),
 *     so files, downloads and app logins outlive the re-cloned rootfs.
 *   - The network slot is recorded in `desktop_computers` and held for the
 *     life of the row. The Hub reserves those slots in the shared pool at
 *     boot, so a computer keeps its address across restarts and sessions
 *     never take it.
 *
 * Idle computers are stopped by {@link FirecrackerDesktopRuntime.sweepIdle};
 * the next call resumes them. A stop takes a Firecracker snapshot (memory +
 * device state) and records its fingerprint on the row, so the next start
 * resumes the running desktop instead of cold booting it. When the snapshot
 * is missing or no longer matches the guest kernel/rootfs, the VM cold boots.
 * Storage, snapshot included, goes away only through `destroy`.
 *
 * Screenshots and input go to the guest vm-agent's `screenshot` and `input`
 * requests (validated with the container daemon's rules on both sides), not
 * through a shell. The live view reads the guest's VNC server on
 * <guest-ip>:5900 and falls back to a vm-agent screenshot when VNC is down.
 */
import { createHash } from 'crypto';
import type {
  SessionEnvDisposeOpts,
  SessionEnvExit,
  SessionEnvProcess,
  SessionEnvSpawnOpts,
} from '../session-env/session-env.js';
import type { FirecrackerSlotPool } from '../session-env/firecracker/firecracker-session-env.js';
import {
  DESKTOP_DISPLAY,
  DESKTOP_IDLE_STOP_MS,
  DESKTOP_VNC_PORT,
  type DesktopComputerKey,
  type DesktopComputerState,
  type DesktopComputerStatus,
  type DesktopDisplayEndpoint,
  type DesktopExecOptions,
  type DesktopExecResult,
  type DesktopInputEvent,
  type DesktopRuntime,
} from './desktop-runtime.js';
import type { DesktopComputerRecord, DesktopComputersStore } from './desktop-computers-store.js';
import {
  DesktopComputerDeletingError,
  desktopDeletionGuard,
  type DesktopDeletionGuard,
} from './desktop-deletion-guard.js';
import { desktopInputArgv, shellQuote } from './desktop-input-commands.js';
import { connectVncFrameSource, type DesktopFrameSource } from './vnc-frame-source.js';

/** Kernel cmdline flag that turns on the persistent home in the guest. */
export const DESKTOP_GUEST_BOOT_ARG = 'ahvm.desktop=1';

/**
 * Exec cwd, relative to the guest's data-disk mount (/workspace). The guest
 * binds this directory onto the desktop user's home.
 */
export const DESKTOP_GUEST_HOME_REL = 'home';

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const SCREENSHOT_TIMEOUT_MS = 30_000;
/** Slack on top of the input's own xdotool deadline for the vsock round trip. */
const INPUT_REPLY_SLACK_MS = 5_000;
/** After a VNC failure, the live view uses vm-agent screenshots for this long. */
const VNC_RETRY_MS = 30_000;
const EXEC_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** The part of FirecrackerSessionEnv the desktop runtime drives. */
export interface FirecrackerDesktopVm {
  readonly vmId: string;
  readonly guestIp: string | null;
  readonly disposed: boolean;
  ensureStarted(): Promise<void>;
  spawn(command: string, opts?: SessionEnvSpawnOpts): SessionEnvProcess;
  liveProcessCount(): number;
  dispose(opts?: SessionEnvDisposeOpts): Promise<void>;
  /** Full-screen PNG through the vm-agent `screenshot` request. */
  desktopScreenshot(timeoutMs?: number): Promise<Buffer>;
  /** One input event through the vm-agent `input` request. */
  desktopInput(event: DesktopInputEvent, timeoutMs: number): Promise<void>;
  /**
   * Stop the VM, keeping a snapshot to resume from. Returns its fingerprint,
   * or null when the VM stopped without one.
   */
  suspend(): Promise<string | null>;
}

export interface FirecrackerDesktopVmSpec {
  vmId: string;
  slot: number;
  /** Always-the-same-slot pool for this VM; release is a no-op. */
  slots: FirecrackerSlotPool;
  bootArgsExtra: string[];
  /** Snapshot fingerprint to resume from, or null to cold boot. */
  restoreSnapshot: string | null;
}

export interface FirecrackerDesktopRuntimeDeps {
  store: DesktopComputersStore;
  /** The host-wide pool shared with session VMs. */
  slots: FirecrackerSlotPool;
  createVm(spec: FirecrackerDesktopVmSpec): FirecrackerDesktopVm;
  now?: () => number;
  idleStopMs?: number;
  logger?: { warn: (msg: string) => void };
  /** Profile-deletion state. Starts are refused while a deletion is pending or once one began after the start arrived. */
  deletionGuard?: DesktopDeletionGuard;
  /** Live-view frame source for a guest display. Defaults to the VNC client. */
  openDisplay?: (endpoint: DesktopDisplayEndpoint) => Promise<DesktopFrameSource>;
}

/** Jailer VM ids are alphanumeric-with-dashes, max 64; the `ahdt-` prefix keeps them apart from session VMs (`ahvm-`). */
export function desktopVmId(key: DesktopComputerKey): string {
  const digest = createHash('sha256')
    .update(`${key.userId}\0${key.agentId}\0${key.projectId}`)
    .digest('hex');
  return `ahdt-${digest.slice(0, 40)}`;
}

function keyString(key: DesktopComputerKey): string {
  return JSON.stringify([key.userId, key.agentId, key.projectId]);
}

function assertKey(key: DesktopComputerKey): void {
  for (const field of ['userId', 'agentId', 'projectId'] as const) {
    if (typeof key[field] !== 'string' || key[field].trim() === '') {
      throw new Error(`Desktop computer key needs a non-empty ${field}`);
    }
  }
}

function fixedSlotPool(slot: number): FirecrackerSlotPool {
  return {
    allocate: () => slot,
    // The slot belongs to the computer row, not to one boot of the VM.
    release: () => undefined,
  };
}

interface Entry {
  key: DesktopComputerKey;
  record: DesktopComputerRecord;
  vm: FirecrackerDesktopVm | null;
  state: DesktopComputerState;
  lastActiveAt: number | null;
  error?: string;
  /** Live-view connection to the running VM's display. */
  display: DesktopFrameSource | null;
  /** Epoch ms before which the live view skips VNC after a failure. */
  vncRetryAt: number;
}

export class FirecrackerDesktopRuntime implements DesktopRuntime {
  readonly kind = 'firecracker' as const;

  readonly #store: DesktopComputersStore;
  readonly #slots: FirecrackerSlotPool;
  readonly #createVm: FirecrackerDesktopRuntimeDeps['createVm'];
  readonly #now: () => number;
  readonly #idleStopMs: number;
  readonly #logger: { warn: (msg: string) => void };
  readonly #deletion: DesktopDeletionGuard;
  readonly #entries = new Map<string, Entry>();
  /** Serializes start/stop/destroy per computer. */
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #openDisplay: NonNullable<FirecrackerDesktopRuntimeDeps['openDisplay']>;

  constructor(deps: FirecrackerDesktopRuntimeDeps) {
    this.#store = deps.store;
    this.#slots = deps.slots;
    this.#createVm = deps.createVm;
    this.#now = deps.now ?? Date.now;
    this.#idleStopMs = deps.idleStopMs ?? DESKTOP_IDLE_STOP_MS;
    this.#logger = deps.logger ?? { warn: (msg) => console.warn(msg) };
    this.#deletion = deps.deletionGuard ?? desktopDeletionGuard;
    this.#openDisplay = deps.openDisplay ?? ((endpoint) => connectVncFrameSource(endpoint));
  }

  async ensureStarted(key: DesktopComputerKey): Promise<DesktopComputerStatus> {
    assertKey(key);
    if (this.#deletion.isPending(key)) throw new DesktopComputerDeletingError();
    const admittedAt = this.#deletion.generation(key);
    return this.#withLock(key, async () => {
      // Re-checked under the lock: a start queued behind a profile delete's
      // teardown may only get here after the pending mark is cleared, so a
      // changed generation is what refuses it.
      if (this.#deletion.isPending(key) || this.#deletion.generation(key) !== admittedAt) {
        throw new DesktopComputerDeletingError();
      }
      const entry = this.#loadOrCreateEntry(key);
      this.#touch(entry);
      if (entry.vm && !entry.vm.disposed && entry.state === 'running') {
        return this.#statusOf(entry);
      }
      let snapshot: string | null = null;
      if (!entry.vm || entry.vm.disposed) {
        snapshot = this.#readSnapshot(key);
        entry.vm = this.#newVm(entry.record, snapshot);
      }
      const vm = entry.vm;
      entry.state = 'starting';
      entry.error = undefined;
      try {
        await vm.ensureStarted();
      } catch (err) {
        entry.state = 'error';
        entry.error = err instanceof Error ? err.message : String(err);
        // A fresh VM object on the next call: a failed boot may leave the env
        // refusing retries until it is disposed.
        await vm.dispose().catch((disposeErr: unknown) => {
          this.#logger.warn(
            `[desktop] dispose after failed boot of ${vm.vmId} failed: ${String(disposeErr)}`,
          );
        });
        if (vm.disposed) entry.vm = null;
        throw err;
      }
      // Restored or cold booted, the stash is gone either way.
      if (snapshot !== null) this.#writeSnapshot(key, null);
      entry.state = 'running';
      this.#touch(entry);
      return this.#statusOf(entry);
    });
  }

  async stop(key: DesktopComputerKey): Promise<void> {
    assertKey(key);
    return this.#withLock(key, () => this.#stopLocked(key));
  }

  async destroy(key: DesktopComputerKey): Promise<void> {
    assertKey(key);
    return this.#withLock(key, async () => {
      const id = keyString(key);
      const entry = this.#entries.get(id);
      const record = entry?.record ?? this.#store.get(key, this.kind);
      if (!record) {
        this.#entries.delete(id);
        return;
      }
      // A stopped computer has no VM object; build one just to run the
      // teardown, which removes the jail tree and the persistent disk.
      // That teardown also removes a stashed snapshot, which sits beside the disks.
      const vm = entry?.vm && !entry.vm.disposed ? entry.vm : this.#newVm(record, null);
      if (entry) {
        entry.state = 'stopping';
        this.#closeDisplay(entry);
      }
      try {
        await vm.dispose({ forgetWorkspace: true });
      } catch (err) {
        if (entry) {
          entry.state = 'error';
          entry.error = err instanceof Error ? err.message : String(err);
        }
        throw err;
      }
      this.#store.delete(key, this.kind);
      if (record.slot !== null) this.#slots.release(record.slot);
      this.#entries.delete(id);
    });
  }

  async exec(
    key: DesktopComputerKey,
    command: string,
    opts: DesktopExecOptions = {},
  ): Promise<DesktopExecResult> {
    const vm = await this.#runningVm(key);
    const full = opts.cwd ? `cd -- ${shellQuote(opts.cwd)} && ${command}` : command;
    return this.#capture(vm, full, opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
  }

  async screenshot(key: DesktopComputerKey): Promise<Buffer> {
    const vm = await this.#runningVm(key);
    try {
      return await vm.desktopScreenshot(SCREENSHOT_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`Desktop screenshot failed: ${errorMessage(err)}`);
    }
  }

  async viewFrame(key: DesktopComputerKey): Promise<Buffer | null> {
    assertKey(key);
    const entry = this.#entries.get(keyString(key));
    const vm = entry?.vm;
    if (!entry || !vm || vm.disposed || entry.state !== 'running') return null;
    if (vm.guestIp && this.#now() >= entry.vncRetryAt) {
      try {
        if (!entry.display || entry.display.closed) {
          entry.display = await this.#openDisplay({ host: vm.guestIp, port: DESKTOP_VNC_PORT });
          // A stop may have landed while connecting; don't keep its socket.
          if (entry.vm !== vm || entry.state !== 'running') {
            this.#closeDisplay(entry);
            return null;
          }
        }
        return await entry.display.capture();
      } catch (err) {
        this.#closeDisplay(entry);
        entry.vncRetryAt = this.#now() + VNC_RETRY_MS;
        this.#logger.warn(
          `[desktop] VNC live view of ${vm.vmId} failed, using screenshots for now: ${errorMessage(err)}`,
        );
      }
    }
    return vm.desktopScreenshot(SCREENSHOT_TIMEOUT_MS);
  }

  async input(key: DesktopComputerKey, event: DesktopInputEvent): Promise<void> {
    // Validate before booting: a bad coordinate should not cost a VM start.
    const { timeoutMs } = desktopInputArgv(event);
    const vm = await this.#runningVm(key);
    try {
      await vm.desktopInput(event, timeoutMs + INPUT_REPLY_SLACK_MS);
    } catch (err) {
      throw new Error(`Desktop input (${event.type}) failed: ${errorMessage(err)}`);
    }
  }

  async mapDisplayPort(key: DesktopComputerKey): Promise<DesktopDisplayEndpoint> {
    const vm = await this.#runningVm(key);
    const host = vm.guestIp;
    if (!host) throw new Error(`Desktop VM ${vm.vmId} has no guest address`);
    return { host, port: DESKTOP_VNC_PORT };
  }

  async status(key: DesktopComputerKey): Promise<DesktopComputerStatus> {
    assertKey(key);
    const entry = this.#entries.get(keyString(key));
    if (entry) return this.#statusOf(entry);
    const record = this.#store.get(key, this.kind);
    return { kind: this.kind, state: 'stopped', lastActiveAt: record?.lastActiveAt ?? null };
  }

  /**
   * Stop every running computer idle for at least the idle window. A computer
   * with a guest process still running (a long `exec`) is not idle.
   */
  async sweepIdle(): Promise<DesktopComputerKey[]> {
    const now = this.#now();
    const stopped: DesktopComputerKey[] = [];
    for (const entry of [...this.#entries.values()]) {
      if (entry.state !== 'running' || !entry.vm) continue;
      if (entry.lastActiveAt !== null && now - entry.lastActiveAt < this.#idleStopMs) continue;
      if (entry.vm.liveProcessCount() > 0) continue;
      try {
        await this.#withLock(entry.key, async () => {
          // Re-check under the lock: a call may have landed while waiting.
          const current = this.#entries.get(keyString(entry.key));
          if (!current || current.state !== 'running') return;
          if (
            current.lastActiveAt !== null &&
            this.#now() - current.lastActiveAt < this.#idleStopMs
          )
            return;
          await this.#stopLocked(entry.key);
          stopped.push(entry.key);
        });
      } catch (err) {
        this.#logger.warn(
          `[desktop] idle stop of ${entry.record.vmId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return stopped;
  }

  /** Run {@link sweepIdle} on an interval. Returns a function that cancels it. */
  startIdleSweeper(intervalMs = DEFAULT_SWEEP_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      void this.sweepIdle();
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #stopLocked(key: DesktopComputerKey): Promise<void> {
    const entry = this.#entries.get(keyString(key));
    if (!entry?.vm) {
      if (entry) entry.state = 'stopped';
      return;
    }
    const vm = entry.vm;
    entry.state = 'stopping';
    this.#closeDisplay(entry);
    let snapshot: string | null;
    try {
      snapshot = await vm.suspend();
    } catch (err) {
      entry.state = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    this.#writeSnapshot(key, snapshot);
    entry.vm = null;
    entry.state = 'stopped';
    entry.error = undefined;
  }

  async #runningVm(key: DesktopComputerKey): Promise<FirecrackerDesktopVm> {
    await this.ensureStarted(key);
    const entry = this.#entries.get(keyString(key));
    if (!entry?.vm || entry.state !== 'running') {
      throw new Error('Desktop computer stopped before the call could run');
    }
    this.#touch(entry);
    return entry.vm;
  }

  #loadOrCreateEntry(key: DesktopComputerKey): Entry {
    const id = keyString(key);
    const existing = this.#entries.get(id);
    if (existing) return existing;
    const record = this.#store.get(key, this.kind) ?? this.#createRecord(key);
    const entry: Entry = {
      key: { userId: key.userId, agentId: key.agentId, projectId: key.projectId },
      record,
      vm: null,
      state: 'stopped',
      lastActiveAt: record.lastActiveAt,
      display: null,
      vncRetryAt: 0,
    };
    this.#entries.set(id, entry);
    return entry;
  }

  #createRecord(key: DesktopComputerKey): DesktopComputerRecord {
    const slot = this.#slots.allocate();
    try {
      return this.#store.create({
        userId: key.userId,
        agentId: key.agentId,
        projectId: key.projectId,
        kind: this.kind,
        vmId: desktopVmId(key),
        slot,
        lastActiveAt: null,
      });
    } catch (err) {
      this.#slots.release(slot);
      throw err;
    }
  }

  #readSnapshot(key: DesktopComputerKey): string | null {
    try {
      return this.#store.getSnapshot(key, this.kind);
    } catch (err) {
      this.#logger.warn(`[desktop] failed to read snapshot state: ${String(err)}`);
      return null;
    }
  }

  #writeSnapshot(key: DesktopComputerKey, fingerprint: string | null): void {
    try {
      this.#store.setSnapshot(key, this.kind, fingerprint);
    } catch (err) {
      // Losing the pointer only costs a cold boot next time.
      this.#logger.warn(`[desktop] failed to record snapshot state: ${String(err)}`);
    }
  }

  #newVm(record: DesktopComputerRecord, restoreSnapshot: string | null): FirecrackerDesktopVm {
    if (record.slot === null) {
      throw new Error(`Desktop computer ${record.vmId} has no network slot`);
    }
    return this.#createVm({
      vmId: record.vmId,
      slot: record.slot,
      slots: fixedSlotPool(record.slot),
      bootArgsExtra: [DESKTOP_GUEST_BOOT_ARG],
      restoreSnapshot,
    });
  }

  #closeDisplay(entry: Entry): void {
    entry.display?.close();
    entry.display = null;
  }

  #touch(entry: Entry): void {
    const now = this.#now();
    entry.lastActiveAt = now;
    entry.record.lastActiveAt = now;
    try {
      this.#store.touch(entry.key, this.kind, now);
    } catch (err) {
      this.#logger.warn(`[desktop] failed to record activity: ${String(err)}`);
    }
  }

  #statusOf(entry: Entry): DesktopComputerStatus {
    return {
      kind: this.kind,
      state: entry.state,
      lastActiveAt: entry.lastActiveAt,
      ...(entry.state === 'error' && entry.error ? { error: entry.error } : {}),
    };
  }

  #withLock<T>(key: DesktopComputerKey, fn: () => Promise<T>): Promise<T> {
    const id = keyString(key);
    const prev = this.#locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.#locks.set(id, settled);
    void settled.then(() => {
      if (this.#locks.get(id) === settled) this.#locks.delete(id);
    });
    return next;
  }

  #capture(
    vm: FirecrackerDesktopVm,
    command: string,
    timeoutMs: number,
  ): Promise<DesktopExecResult> {
    const proc = vm.spawn(command, {
      cwd: DESKTOP_GUEST_HOME_REL,
      env: { DISPLAY: DESKTOP_DISPLAY },
      name: 'desktop-exec',
    });
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let timedOut = false;
      let overLimit = false;
      const append = (which: 'stdout' | 'stderr', chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > EXEC_OUTPUT_MAX_BYTES) {
          if (!overLimit) {
            overLimit = true;
            proc.kill('SIGKILL');
          }
          return;
        }
        if (which === 'stdout') stdout += chunk;
        else stderr += chunk;
      };
      proc.onStdout((c) => append('stdout', c));
      proc.onStderr((c) => append('stderr', c));
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
      proc.onExit((exit: SessionEnvExit) => {
        clearTimeout(timer);
        if (exit.error) stderr += `${stderr ? '\n' : ''}${exit.error.message}`;
        if (overLimit) {
          stderr += `${stderr ? '\n' : ''}output exceeded ${EXEC_OUTPUT_MAX_BYTES} bytes; command killed`;
        }
        resolve({
          exitCode: exit.code ?? (exit.error || exit.signal ? -1 : 0),
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
