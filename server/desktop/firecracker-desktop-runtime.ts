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
 * the next call resumes them. Storage goes away only through `destroy`.
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
import {
  buildDesktopInputCommand,
  buildDesktopScreenshotCommand,
  shellQuote,
} from './desktop-input-commands.js';

/** Kernel cmdline flag that turns on the persistent home in the guest. */
export const DESKTOP_GUEST_BOOT_ARG = 'ahvm.desktop=1';

/**
 * Exec cwd, relative to the guest's data-disk mount (/workspace). The guest
 * binds this directory onto the desktop user's home.
 */
export const DESKTOP_GUEST_HOME_REL = 'home';

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const SCREENSHOT_TIMEOUT_MS = 30_000;
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
}

export interface FirecrackerDesktopVmSpec {
  vmId: string;
  slot: number;
  /** Always-the-same-slot pool for this VM; release is a no-op. */
  slots: FirecrackerSlotPool;
  bootArgsExtra: string[];
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
  #shotCounter = 0;

  constructor(deps: FirecrackerDesktopRuntimeDeps) {
    this.#store = deps.store;
    this.#slots = deps.slots;
    this.#createVm = deps.createVm;
    this.#now = deps.now ?? Date.now;
    this.#idleStopMs = deps.idleStopMs ?? DESKTOP_IDLE_STOP_MS;
    this.#logger = deps.logger ?? { warn: (msg) => console.warn(msg) };
    this.#deletion = deps.deletionGuard ?? desktopDeletionGuard;
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
      if (!entry.vm || entry.vm.disposed) entry.vm = this.#newVm(entry.record);
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
      const vm = entry?.vm && !entry.vm.disposed ? entry.vm : this.#newVm(record);
      if (entry) entry.state = 'stopping';
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
    const tag = `${process.pid}-${++this.#shotCounter}`;
    const res = await this.#capture(vm, buildDesktopScreenshotCommand(tag), SCREENSHOT_TIMEOUT_MS);
    if (res.timedOut || res.exitCode !== 0) {
      throw new Error(`Desktop screenshot failed: ${describeFailure(res)}`);
    }
    const png = Buffer.from(res.stdout.trim(), 'base64');
    if (png.length === 0) throw new Error('Desktop screenshot returned no image');
    return png;
  }

  async input(key: DesktopComputerKey, event: DesktopInputEvent): Promise<void> {
    // Validate before booting: a bad coordinate should not cost a VM start.
    const { command, timeoutMs } = buildDesktopInputCommand(event);
    const vm = await this.#runningVm(key);
    const res = await this.#capture(vm, command, timeoutMs);
    if (res.timedOut || res.exitCode !== 0) {
      throw new Error(`Desktop input (${event.type}) failed: ${describeFailure(res)}`);
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
    try {
      await vm.dispose({ forgetWorkspace: false });
    } catch (err) {
      entry.state = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
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

  #newVm(record: DesktopComputerRecord): FirecrackerDesktopVm {
    if (record.slot === null) {
      throw new Error(`Desktop computer ${record.vmId} has no network slot`);
    }
    return this.#createVm({
      vmId: record.vmId,
      slot: record.slot,
      slots: fixedSlotPool(record.slot),
      bootArgsExtra: [DESKTOP_GUEST_BOOT_ARG],
    });
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

function describeFailure(res: DesktopExecResult): string {
  if (res.timedOut) return 'timed out';
  const detail = res.stderr.trim() || res.stdout.trim().slice(0, 200);
  return `exit ${res.exitCode}${detail ? `: ${detail}` : ''}`;
}
