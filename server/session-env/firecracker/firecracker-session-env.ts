/**
 * Firecracker adapter — SessionEnv backed by a per-session microVM.
 *
 * This is the strongest isolation tier: a session gets its own kernel, not a
 * shared one with namespaces drawn around it. Everything the session does —
 * dev server, terminal, tests, its own docker daemon — happens behind a
 * hardware virtualization boundary, which is what makes "each session is its
 * own little computer" literally true rather than an analogy.
 *
 * Shape, and how it differs from the container adapters:
 *
 *   - **Control plane is vsock, not `docker exec`.** Firecracker has no exec
 *     primitive, so an agent inside the guest brokers every process, PTY, and
 *     port query (`vm-agent-protocol.ts`).
 *   - **Ports route by guest IP.** Every VM's tap joins one host bridge, so
 *     the Hub dials the guest address directly and reuses `container-ip`
 *     routing: no host port pool, and a port that appears long after boot
 *     needs no reconfiguration.
 *   - **Storage is block devices.** Firecracker ships no virtio-fs and no 9p,
 *     so the worktree lives on a per-session disk rather than a bind mount.
 *
 * All privileged and platform IO (tap creation, disk preparation, spawning
 * the VMM, connecting vsock) is injected, so the entire lifecycle is testable
 * on a laptop with no KVM — the same rule the rest of the suite follows for
 * docker and the agent CLIs.
 */

import { execFile, spawn as nodeSpawn } from 'child_process';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import type { HostSpawnFn } from '../host-session-env.js';
import {
  SessionEnv,
  SessionEnvClock,
  SessionEnvDisposedError,
  SessionEnvDisposeOpts,
  SessionEnvDialTarget,
  SessionEnvPortMapping,
  SessionEnvProcess,
  SessionEnvPty,
  SessionEnvPtyOpts,
  SessionEnvSpawnOpts,
  SessionEnvWorktreeMount,
  resolveEnvRelativeCwd,
  systemSessionEnvClock,
} from '../session-env.js';
import type { SessionEnvPortRouting } from '../container-routing.js';
import {
  FIRECRACKER_GUEST_WORKSPACE,
  buildCreateTapArgv,
  buildDeleteTapArgv,
  buildFirecrackerArgv,
  buildFirecrackerVmConfig,
  buildJailerArgv,
  planVmNetwork,
  sessionVmId,
  type VmNetworkPlan,
} from './firecracker-vm-args.js';
import {
  awaitStarted,
  deferStream,
  defaultVsockConnect,
  openVmAgentStream,
  type VmAgentStream,
  type VsockConnectFn,
} from './vm-agent-client.js';
import { createVmAgentProcess, createVmAgentPty } from './vm-agent-process.js';
import {
  VM_AGENT_PROTOCOL_VERSION,
  VM_AGENT_VSOCK_PORT,
  type VmAgentPtyRequest,
  type VmAgentRequest,
} from './vm-agent-protocol.js';

export interface FirecrackerRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Host-side IO the adapter needs. Injected so tests touch no real host. */
export interface FirecrackerHostIo {
  run(argv: string[]): Promise<FirecrackerRunResult>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rmrf(path: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
}

const RUN_TIMEOUT_MS = 300_000;

export const defaultFirecrackerHostIo: FirecrackerHostIo = {
  run: (argv) =>
    new Promise((resolve) => {
      execFile(
        argv[0],
        argv.slice(1),
        { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    }),
  writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true });
  },
  rmrf: (path) => rm(path, { recursive: true, force: true }),
  isDirectory: async (path) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Slot pool. One integer per live VM drives IP, MAC, tap name, and vsock CID. */
export interface FirecrackerSlotPool {
  allocate(): number;
  release(slot: number): void;
}

export interface FirecrackerPaths {
  /** Uncompressed guest kernel shared by every VM. */
  kernelPath: string;
  /** Read-only base rootfs; each VM boots a copy-on-write clone. */
  baseRootfsPath: string;
  /** Per-VM scratch (config, sockets, disks) lives under here. */
  runDir: string;
  /** Jailer chroot base, when the jailer is used. */
  jailerChrootBase?: string;
  /** Privileged helper that clones the rootfs and seeds the workspace disk. */
  diskHelper?: string;
}

export interface PreparedDisks {
  rootfsPath: string;
  workspacePath: string;
}

export interface FirecrackerSessionEnvDeps {
  sessionId: string;
  worktreePath: string;
  slots: FirecrackerSlotPool;
  paths: FirecrackerPaths;
  vcpuCount?: number;
  memSizeMib?: number;
  /** Workspace disk size in MiB. Must exceed the worktree plus build output. */
  workspaceSizeMib?: number;
  /** Run the VMM under the jailer (chroot + uid drop + cgroups). */
  useJailer?: boolean;
  jailerUid?: number;
  jailerGid?: number;
  baseEnv?: Record<string, string>;
  io?: FirecrackerHostIo;
  spawnVmm?: HostSpawnFn;
  /**
   * Kills the VMM's whole process group. Injectable because the default
   * signals a *negative* pid — a test that ran the real thing against a fake
   * pid could take out an unrelated process group on the developer's machine.
   */
  killVmm?: (pid: number) => void;
  connect?: VsockConnectFn;
  prepareDisks?: (ctx: {
    vmDir: string;
    sessionId: string;
    worktreePath: string;
    paths: FirecrackerPaths;
    workspaceSizeMib: number;
  }) => Promise<PreparedDisks>;
  clock?: SessionEnvClock;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  logger?: { warn: (msg: string) => void };
}

const DEFAULT_VCPU = 2;
const DEFAULT_MEM_MIB = 6144;
const DEFAULT_WORKSPACE_MIB = 32_768;
const DEFAULT_DISPOSE_GRACE_MS = 5000;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_READY_POLL_MS = 250;
const DEFAULT_DISK_HELPER = '/usr/local/lib/agent-hub/fc-prepare-disks.sh';

interface LiveEntry {
  kill(signal: NodeJS.Signals): void;
  exited: Promise<void>;
}

export class FirecrackerSessionEnv implements SessionEnv {
  readonly kind = 'firecracker' as const;
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly vmId: string;
  /**
   * The Hub dials the guest address directly, so this is the same routing the
   * container-IP backend uses — no host port pool, no pre-declaration.
   */
  readonly portRouting: SessionEnvPortRouting = 'container-ip';

  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #lastActivityAtMs: number;
  #startPromise: Promise<void> | null = null;
  #started = false;
  #network: VmNetworkPlan | null = null;
  #vmProcess: ReturnType<HostSpawnFn> | null = null;

  private readonly worktreePath: string;
  private readonly slots: FirecrackerSlotPool;
  private readonly paths: FirecrackerPaths;
  private readonly vcpuCount: number;
  private readonly memSizeMib: number;
  private readonly workspaceSizeMib: number;
  private readonly useJailer: boolean;
  private readonly jailerUid: number;
  private readonly jailerGid: number;
  private readonly baseEnv: Record<string, string>;
  private readonly io: FirecrackerHostIo;
  private readonly spawnVmm: HostSpawnFn;
  private readonly killVmm: (pid: number) => void;
  private readonly connect: VsockConnectFn;
  private readonly prepareDisks: NonNullable<FirecrackerSessionEnvDeps['prepareDisks']>;
  private readonly clock: SessionEnvClock;
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;
  private readonly logger: { warn: (msg: string) => void };

  private readonly settledMappings = new Map<number, SessionEnvPortMapping>();
  private readonly live = new Set<LiveEntry>();
  private readonly disposeHooks = new Set<() => void>();

  constructor(deps: FirecrackerSessionEnvDeps) {
    this.sessionId = deps.sessionId;
    this.worktreePath = deps.worktreePath;
    this.slots = deps.slots;
    this.paths = deps.paths;
    this.vmId = sessionVmId(deps.sessionId);
    this.vcpuCount = deps.vcpuCount ?? DEFAULT_VCPU;
    this.memSizeMib = deps.memSizeMib ?? DEFAULT_MEM_MIB;
    this.workspaceSizeMib = deps.workspaceSizeMib ?? DEFAULT_WORKSPACE_MIB;
    this.useJailer = deps.useJailer ?? false;
    this.jailerUid = deps.jailerUid ?? 1000;
    this.jailerGid = deps.jailerGid ?? 1000;
    this.baseEnv = deps.baseEnv ?? {};
    this.io = deps.io ?? defaultFirecrackerHostIo;
    this.spawnVmm = deps.spawnVmm ?? (nodeSpawn as unknown as HostSpawnFn);
    this.killVmm = deps.killVmm ?? ((pid) => process.kill(-pid, 'SIGKILL'));
    this.connect = deps.connect ?? defaultVsockConnect;
    this.prepareDisks = deps.prepareDisks ?? ((ctx) => defaultPrepareDisks(this.io, ctx));
    this.clock = deps.clock ?? systemSessionEnvClock;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.readyPollMs = deps.readyPollMs ?? DEFAULT_READY_POLL_MS;
    this.logger = deps.logger ?? { warn: (msg) => console.warn(msg) };
    this.createdAtMs = this.clock.nowMs();
    this.#lastActivityAtMs = this.createdAtMs;
  }

  get disposed(): boolean {
    return this.#disposed;
  }
  get lastActivityAtMs(): number {
    return this.#lastActivityAtMs;
  }
  get vmStarted(): boolean {
    return this.#started;
  }
  /** Guest address, once booted. Exposed for diagnostics and tests. */
  get guestIp(): string | null {
    return this.#network?.guestIp ?? null;
  }

  private get vmDir(): string {
    return `${this.paths.runDir}/${this.vmId}`;
  }
  private get vsockPath(): string {
    return `${this.vmDir}/vsock.sock`;
  }

  touch(): void {
    this.#lastActivityAtMs = this.clock.nowMs();
  }

  liveProcessCount(): number {
    return this.live.size;
  }

  onDispose(cb: () => void): () => void {
    this.disposeHooks.add(cb);
    return () => this.disposeHooks.delete(cb);
  }

  // ── VM lifecycle ───────────────────────────────────────────────

  ensureStarted(): Promise<void> {
    this.#assertLive('ensureStarted');
    if (this.#startPromise) return this.#startPromise;
    const starting = this.#doStart();
    this.#startPromise = starting;
    starting.catch(() => {
      // A failed boot must not wedge the env; allow a retry.
      if (this.#startPromise === starting) this.#startPromise = null;
    });
    return starting;
  }

  async #doStart(): Promise<void> {
    if (!(await this.io.isDirectory(this.worktreePath))) {
      throw new Error(
        `Session worktree not found at ${this.worktreePath} (session ${this.sessionId})`,
      );
    }

    const slot = this.slots.allocate();
    const network = planVmNetwork(slot);
    this.#network = network;

    try {
      await this.io.mkdirp(this.vmDir);

      for (const argv of buildCreateTapArgv(network)) {
        const res = await this.io.run(argv);
        if (!res.ok) {
          throw new Error(
            `Failed to create tap ${network.tapName}: ${res.stderr.trim() || res.stdout.trim()}`,
          );
        }
      }

      const disks = await this.prepareDisks({
        vmDir: this.vmDir,
        sessionId: this.sessionId,
        worktreePath: this.worktreePath,
        paths: this.paths,
        workspaceSizeMib: this.workspaceSizeMib,
      });

      const configPath = `${this.vmDir}/vm-config.json`;
      const config = buildFirecrackerVmConfig({
        network,
        kernelPath: this.paths.kernelPath,
        rootfsPath: disks.rootfsPath,
        workspacePath: disks.workspacePath,
        vsockUdsPath: this.vsockPath,
        vcpuCount: this.vcpuCount,
        memSizeMib: this.memSizeMib,
        bootArgsExtra: [`ahvm.session=${this.sessionId}`],
      });
      await this.io.writeFile(configPath, JSON.stringify(config, null, 2));

      const apiSockPath = `${this.vmDir}/api.sock`;
      const argv = this.useJailer
        ? buildJailerArgv({
            vmId: this.vmId,
            uid: this.jailerUid,
            gid: this.jailerGid,
            chrootBaseDir: this.paths.jailerChrootBase ?? '/srv/jailer',
            apiSockPath,
            configPath,
            cgroups: [`memory.max=${this.memSizeMib * 1024 * 1024}`],
          })
        : buildFirecrackerArgv({
            apiSockPath,
            configPath,
            logPath: `${this.vmDir}/firecracker.log`,
          });

      const vmm = this.spawnVmm(argv[0], argv.slice(1), {
        cwd: this.vmDir,
        env: process.env as Record<string, string>,
        // Its own process group, so a stuck VMM and any helper it forks are
        // reaped together at dispose.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.#vmProcess = vmm;
      vmm.stderr?.on('data', (chunk: string | Buffer) => {
        this.logger.warn(`[fc ${this.vmId}] ${chunk.toString().trimEnd()}`);
      });

      await this.#waitForAgent();
      this.#started = true;
      this.touch();
    } catch (err) {
      // A half-booted VM would hold a slot and a tap while never serving a
      // request; unwind everything before surfacing the failure.
      await this.#teardownVm().catch(() => undefined);
      throw err;
    }
  }

  /** Poll the guest agent until it answers a ping. */
  async #waitForAgent(): Promise<void> {
    const deadline = this.clock.nowMs() + this.readyTimeoutMs;
    let lastError = 'no attempt made';
    for (;;) {
      try {
        const stream = await this.#open({
          kind: 'ping',
          protocolVersion: VM_AGENT_PROTOCOL_VERSION,
        });
        stream.close();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (this.clock.nowMs() >= deadline) {
        throw new Error(
          `Guest agent in ${this.vmId} did not answer within ${this.readyTimeoutMs}ms: ${lastError}`,
        );
      }
      await this.clock.sleep(this.readyPollMs);
    }
  }

  #open(request: VmAgentRequest): Promise<VmAgentStream> {
    return openVmAgentStream({
      udsPath: this.vsockPath,
      port: VM_AGENT_VSOCK_PORT,
      request,
      connect: this.connect,
    });
  }

  // ── SessionEnv ops ─────────────────────────────────────────────

  spawn(command: string, opts: SessionEnvSpawnOpts = {}): SessionEnvProcess {
    this.#assertLive('spawn');
    if (!this.#started) {
      throw new Error(
        `Firecracker VM for session ${this.sessionId} is not started — ` +
          'await mountWorktree() (or ensureStarted()) before spawn().',
      );
    }
    const cwd = resolveEnvRelativeCwd(FIRECRACKER_GUEST_WORKSPACE, opts.cwd);
    const name = opts.name ?? command;
    // Synchronous by contract, asynchronous by transport: the handle is wired
    // to a stream that does not exist yet (see `deferStream`).
    const stream = deferStream(
      this.#open({ kind: 'exec', command, cwd, env: { ...this.baseEnv, ...opts.env }, name }),
    );
    const entry: LiveEntry = { kill: () => {}, exited: Promise.resolve() };
    const { process, exited } = createVmAgentProcess({
      stream,
      name,
      onActivity: () => this.touch(),
      onSettled: () => this.live.delete(entry),
      logger: this.logger,
    });
    entry.kill = (signal) => process.kill(signal);
    entry.exited = exited;
    if (!process.exited) this.live.add(entry);
    this.touch();
    return process;
  }

  async openPty(opts: SessionEnvPtyOpts = {}): Promise<SessionEnvPty> {
    this.#assertLive('openPty');
    await this.ensureStarted();
    this.#assertLive('openPty');
    const cwd = resolveEnvRelativeCwd(FIRECRACKER_GUEST_WORKSPACE, opts.cwd);
    const request: VmAgentPtyRequest = {
      kind: 'pty',
      command: opts.command ?? '/bin/bash',
      args: opts.args ?? ['-l'],
      cwd,
      // JSON has no `undefined`; an explicit null is how "unset this" crosses
      // the wire distinguishably from "not mentioned".
      env: normalizePtyEnv({ ...this.baseEnv, ...opts.env }),
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      term: opts.name ?? 'xterm-256color',
    };
    const stream = await this.#open(request);
    const pid = await awaitStarted(stream).catch((err: unknown) => {
      stream.close();
      throw err;
    });
    this.#assertLive('openPty', () => stream.close());

    const entry: LiveEntry = { kill: () => {}, exited: Promise.resolve() };
    const { pty, exited } = createVmAgentPty({
      stream,
      pid,
      onActivity: () => this.touch(),
      onSettled: () => this.live.delete(entry),
    });
    entry.kill = (signal) => pty.kill(signal);
    entry.exited = exited;
    this.live.add(entry);
    this.touch();
    return pty;
  }

  async mapPort(internalPort: number): Promise<SessionEnvPortMapping> {
    this.#assertLive('mapPort');
    const existing = this.settledMappings.get(internalPort);
    if (existing) return existing;
    await this.ensureStarted();
    const host = this.#network?.guestIp;
    if (!host) {
      throw new Error(`VM ${this.vmId} has no guest address for port ${internalPort}`);
    }
    const mapping: SessionEnvPortMapping = {
      internalPort,
      host,
      // Nothing is published on the host, so the guest port is the only port
      // that ever answers; report it rather than a pooled number.
      hostPort: internalPort,
      envPort: internalPort,
      hostUrl: `http://${host}:${internalPort}`,
    };
    this.settledMappings.set(internalPort, mapping);
    return mapping;
  }

  async mapPortsOut(internalPorts?: number[]): Promise<SessionEnvPortMapping[]> {
    if (internalPorts === undefined) return this.listPortMappings();
    const mappings: SessionEnvPortMapping[] = [];
    for (const port of internalPorts) mappings.push(await this.mapPort(port));
    return mappings;
  }

  listPortMappings(): SessionEnvPortMapping[] {
    return [...this.settledMappings.values()];
  }

  async resolveDialTarget(internalPort: number): Promise<SessionEnvDialTarget> {
    this.#assertLive('resolveDialTarget');
    const mapping = await this.mapPort(internalPort);
    return { host: mapping.host, port: mapping.internalPort, url: mapping.hostUrl };
  }

  async mountWorktree(): Promise<SessionEnvWorktreeMount> {
    this.#assertLive('mountWorktree');
    await this.ensureStarted();
    this.#assertLive('mountWorktree');
    return { hostPath: this.worktreePath, envPath: FIRECRACKER_GUEST_WORKSPACE };
  }

  // ── Teardown ───────────────────────────────────────────────────

  dispose(opts: SessionEnvDisposeOpts = {}): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = this.#doDispose(opts.graceMs ?? DEFAULT_DISPOSE_GRACE_MS);
    return this.#disposePromise;
  }

  async #doDispose(graceMs: number): Promise<void> {
    this.#disposed = true;
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);

    const entries = [...this.live];
    for (const entry of entries) {
      try {
        entry.kill('SIGTERM');
      } catch {
        // Raced its own exit.
      }
    }
    if (entries.length > 0) {
      await Promise.race([Promise.all(entries.map((e) => e.exited)), this.clock.sleep(graceMs)]);
      // No SIGKILL pass: killing the VMM destroys the kernel those processes
      // run under, which is stronger than any per-process signal.
    }

    await this.#teardownVm();

    this.settledMappings.clear();
    for (const hook of this.disposeHooks) {
      try {
        hook();
      } catch (err) {
        this.logger.warn(`SessionEnv[${this.sessionId}] dispose hook threw: ${String(err)}`);
      }
    }
    this.disposeHooks.clear();
  }

  /** Kill the VMM, drop the tap, release the slot, remove the VM directory. */
  async #teardownVm(): Promise<void> {
    const vmm = this.#vmProcess;
    this.#vmProcess = null;
    if (vmm?.pid) {
      try {
        this.killVmm(vmm.pid);
      } catch {
        // Already gone.
      }
    }

    const network = this.#network;
    this.#network = null;
    if (network) {
      const res = await this.io.run(buildDeleteTapArgv(network));
      if (!res.ok) {
        this.logger.warn(
          `SessionEnv[${this.sessionId}] failed to delete tap ${network.tapName}: ${res.stderr.trim()}`,
        );
      }
      // Released last: a slot handed out again before its tap is gone would
      // collide on the interface name.
      this.slots.release(network.slot);
    }

    this.#started = false;
    await this.io.rmrf(this.vmDir).catch((err: unknown) => {
      this.logger.warn(
        `SessionEnv[${this.sessionId}] failed to remove ${this.vmDir}: ${String(err)}`,
      );
    });
  }

  #assertLive(op: string, cleanup?: () => void): void {
    if (this.#disposed) {
      try {
        cleanup?.();
      } catch {
        // Best-effort cleanup of a resource created during a dispose race.
      }
      throw new SessionEnvDisposedError(this.sessionId, op);
    }
  }
}

/** `undefined` means "unset" in the SessionEnv contract; JSON needs a null. */
function normalizePtyEnv(env: Record<string, string | undefined>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(env)) out[key] = value ?? null;
  return out;
}

/**
 * Default disk preparation: delegate to a privileged host helper.
 *
 * Cloning a rootfs and seeding an ext4 image needs loop devices and mount,
 * which the Hub process should not hold. Keeping it in one auditable script
 * (installed by the host setup) means the capability is granted once, in a
 * place a reviewer can read, instead of spread across the runtime.
 */
async function defaultPrepareDisks(
  io: FirecrackerHostIo,
  ctx: {
    vmDir: string;
    sessionId: string;
    worktreePath: string;
    paths: FirecrackerPaths;
    workspaceSizeMib: number;
  },
): Promise<PreparedDisks> {
  const helper = ctx.paths.diskHelper ?? DEFAULT_DISK_HELPER;
  const rootfsPath = `${ctx.vmDir}/rootfs.ext4`;
  const workspacePath = `${ctx.vmDir}/workspace.ext4`;
  const res = await io.run([
    helper,
    '--base-rootfs',
    ctx.paths.baseRootfsPath,
    '--rootfs-out',
    rootfsPath,
    '--workspace-out',
    workspacePath,
    '--workspace-size-mib',
    String(ctx.workspaceSizeMib),
    '--worktree',
    ctx.worktreePath,
  ]);
  if (!res.ok) {
    throw new Error(
      `Failed to prepare disks for ${ctx.sessionId}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return { rootfsPath, workspacePath };
}
