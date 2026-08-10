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
import { createWriteStream } from 'fs';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import { once } from 'events';
import path from 'path';
import { readLiveProcessIdentity } from './vmm-process-identity.js';
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
  SessionEnvExit,
  SessionEnvWorktreeMount,
  resolveEnvRelativeCwd,
  systemSessionEnvClock,
} from '../session-env.js';
import type { SessionEnvPortRouting } from '../container-routing.js';
import type { SessionWorktreeIo } from '../worktree-io.js';
import { GuestWorktreeIo } from './guest-worktree-io.js';
import { resolveGuestNameservers } from './guest-nameservers.js';
import { ensureFirecrackerGuestNat } from './firecracker-slots.js';
import { translateContainerPathToHost } from '../../preview/host-path-translation.js';
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
  awaitReply,
  awaitStarted,
  deferStream,
  defaultVsockConnect,
  openVmAgentStream,
  type VmAgentStream,
  type VsockConnectFn,
} from './vm-agent-client.js';
import { createVmAgentProcess, createVmAgentPty } from './vm-agent-process.js';
import {
  READ_FILE_CHUNK_BYTES,
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

/** What the adapter needs back from whatever launched the VMM. */
export interface VmmHandle {
  pid?: number;
  stderr?: { on(event: 'data', cb: (chunk: string | Buffer) => void): unknown } | null;
}

export interface VmmLaunchSpec {
  /** Stable per-VM identity, so a launcher can name the thing it started. */
  vmId: string;
  argv: string[];
  cwd: string;
  /**
   * Where Firecracker will create the vsock socket, plus the uid/gid to hand
   * it to once it exists. The VMM runs as root in both exec modes, so without
   * this the Hub cannot connect to the guest it just booted. Optional so a
   * launcher that needs no handoff (a Hub already running as root) can omit it.
   */
  vsockPath?: string;
  ownerUid?: number;
  ownerGid?: number;
}

/**
 * Launching and stopping the VMM are named by `vmId` rather than by pid
 * because the process the Hub can see is not always the process that must
 * die. When the Hub runs in a container the VMM lives in a sibling container,
 * and the local pid belongs to the `docker run` client — signalling it leaves
 * the VM running.
 */
export type SpawnVmmFn = (spec: VmmLaunchSpec) => VmmHandle;
export type StopVmmFn = (spec: {
  vmId: string;
  pid?: number;
  /** Durable pid path written after spawn — required for local-mode reclaim. */
  pidFile?: string;
  /** cmdline/starttime/exe snapshot — required before local SIGKILL. */
  identityFile?: string;
}) => void | Promise<void>;

/** Per-VM pidfile under the session scratch dir (local exec mode). */
export function vmmPidFilePath(vmDir: string): string {
  return `${vmDir}/vmm.pid`;
}

/** Durable process identity — PID alone is reused by Linux after exit. */
export function vmmIdentityFilePath(vmDir: string): string {
  return `${vmDir}/vmm.identity.json`;
}

export interface VmmProcessIdentity {
  pid: number;
  /** Raw `/proc/<pid>/cmdline` (NUL-separated). */
  cmdline: string;
  /** Field 22 of `/proc/<pid>/stat` (starttime). */
  starttime: string;
  /** `realpath(/proc/<pid>/exe)` when available. */
  exe: string;
}

export const defaultSpawnVmm: SpawnVmmFn = ({ argv, cwd }) =>
  (nodeSpawn as unknown as HostSpawnFn)(argv[0], argv.slice(1), {
    cwd,
    env: process.env as Record<string, string>,
    // Its own process group, so a stuck VMM and any helper it forks are
    // reaped together at dispose.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as VmmHandle;

export const defaultStopVmm: StopVmmFn = ({ pid }) => {
  if (pid !== undefined) process.kill(-pid, 'SIGKILL');
};

/** Cap guest exec capture the same way the host pre-commit runner does. */
export const FIRECRACKER_EXEC_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;

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

/**
 * The guest image speaks a different protocol version than this Hub.
 *
 * Distinct from the transient boot errors around it because retrying cannot
 * help: the staged rootfs is what it is until someone rebuilds it. Carries
 * both versions so the operator knows which side to update.
 */
export class VmAgentProtocolMismatchError extends Error {
  constructor(
    readonly vmId: string,
    readonly guestVersion: number,
    readonly hostVersion: number,
  ) {
    super(
      `Guest agent in ${vmId} speaks protocol v${guestVersion} but this Hub speaks ` +
        `v${hostVersion}. Rebuild the guest artifacts (build-guest-artifacts.sh) ` +
        `so the rootfs matches this build.`,
    );
    this.name = 'VmAgentProtocolMismatchError';
  }
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
  /** Override guest DNS discovery. Defaults to the host's own resolvers. */
  resolveNameservers?: () => Promise<string[]>;
  /** Run the VMM under the jailer (chroot + uid drop + cgroups). */
  useJailer?: boolean;
  jailerUid?: number;
  jailerGid?: number;
  baseEnv?: Record<string, string>;
  io?: FirecrackerHostIo;
  spawnVmm?: SpawnVmmFn;
  /**
   * Stops the VMM. Injectable because the local default signals a *negative*
   * pid — a test that ran the real thing against a fake pid could take out an
   * unrelated process group on the developer's machine.
   */
  stopVmm?: StopVmmFn;
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
  #vmProcess: VmmHandle | null = null;

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
  private readonly spawnVmm: SpawnVmmFn;
  private readonly stopVmm: StopVmmFn;
  private readonly connect: VsockConnectFn;
  private readonly prepareDisks: NonNullable<FirecrackerSessionEnvDeps['prepareDisks']>;
  private readonly clock: SessionEnvClock;
  private readonly readyTimeoutMs: number;
  /**
   * Resolvers for the guest. Injectable so tests get a deterministic list
   * instead of whichever DNS the machine running them happens to use.
   */
  private readonly resolveNameservers: () => Promise<string[]>;
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
    // Jailer (or equal) is required for production isolation — see
    // Firecracker prod-host-setup. Opt out only with an explicit false.
    this.useJailer = deps.useJailer ?? true;
    this.jailerUid = deps.jailerUid ?? 1000;
    this.jailerGid = deps.jailerGid ?? 1000;
    this.baseEnv = deps.baseEnv ?? {};
    this.io = deps.io ?? defaultFirecrackerHostIo;
    this.spawnVmm = deps.spawnVmm ?? defaultSpawnVmm;
    this.stopVmm = deps.stopVmm ?? defaultStopVmm;
    this.connect = deps.connect ?? defaultVsockConnect;
    this.prepareDisks = deps.prepareDisks ?? ((ctx) => defaultPrepareDisks(this.io, ctx));
    this.clock = deps.clock ?? systemSessionEnvClock;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.resolveNameservers = deps.resolveNameservers ?? (() => resolveGuestNameservers());
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

  /**
   * The uid/gid the vsock socket must end up owned by — this process. Omitted
   * on platforms without `getuid` (never the VM host, but the type is
   * optional there) so the launcher simply skips the handoff.
   */
  private hubOwner(): { ownerUid?: number; ownerGid?: number } {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    return uid === undefined || gid === undefined ? {} : { ownerUid: uid, ownerGid: gid };
  }

  touch(): void {
    this.#lastActivityAtMs = this.clock.nowMs();
  }

  liveProcessCount(): number {
    // Count guest processes only — a started-but-idle VM must remain reaped.
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

    // Re-apply MASQUERADE/FORWARD even when the boot sweep already did — a
    // Docker restart between Hub boot and this session can drop the rules
    // while leaving the bridge up.
    const natReady = await ensureFirecrackerGuestNat({
      run: (argv) => this.io.run(argv),
    });
    if (!natReady) {
      throw new Error(
        `Firecracker guest NAT is not ready (session ${this.sessionId}); ` +
          `guests would have no outbound network`,
      );
    }

    const slot = this.slots.allocate();
    const network = planVmNetwork(slot);
    this.#network = network;

    try {
      await this.io.mkdirp(this.vmDir);
      // Jailer refuses to start when its chroot base is missing — create it
      // on first use so a host that skipped the setup script still boots.
      if (this.useJailer) {
        await this.io.mkdirp(this.paths.jailerChrootBase ?? '/srv/jailer');
      }
      // A previous VMM for this vm id may still hold api.sock / vsock.sock or
      // the tap even though this process is gone — stop and confirm exit
      // before unlinking or rewriting disks. Fail closed: a stop error means
      // the old VMM may still have the images open.
      const pidFile = vmmPidFilePath(this.vmDir);
      await this.stopVmm({
        vmId: this.vmId,
        pid: this.#vmProcess?.pid,
        pidFile,
        identityFile: vmmIdentityFilePath(this.vmDir),
      });
      // Firecracker *binds* these two paths and refuses to start if either
      // already exists. A vm id is derived from the session id, so a session
      // whose VMM died without unlinking them — a host reboot, an OOM kill —
      // boots straight back onto its own leftovers and fails with
      // FailedToBindSocket every time, permanently.
      await this.io.rmrf(`${this.vmDir}/api.sock`);
      await this.io.rmrf(this.vsockPath);

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
        nameservers: await this.resolveNameservers(),
        bootArgsExtra: [`ahvm.session=${this.sessionId}`],
      });
      await this.io.writeFile(configPath, JSON.stringify(config, null, 2));

      const apiSockPath = `${this.vmDir}/api.sock`;
      // Jailer without `--cgroup`: the docker VMM helper intentionally is not
      // fully `--privileged`, so `/sys/fs/cgroup` is read-only and jailer
      // cannot mkdir under it. Chroot + uid/gid drop still apply; memory is
      // enforced by Firecracker's own balloon / machine-config mem size.
      const argv = this.useJailer
        ? buildJailerArgv({
            vmId: this.vmId,
            uid: this.jailerUid,
            gid: this.jailerGid,
            chrootBaseDir: this.paths.jailerChrootBase ?? '/srv/jailer',
            apiSockPath,
            configPath,
            cgroupVersion: 2,
          })
        : buildFirecrackerArgv({
            apiSockPath,
            configPath,
            logPath: `${this.vmDir}/firecracker.log`,
          });

      const vmm = this.spawnVmm({
        vmId: this.vmId,
        argv,
        cwd: this.vmDir,
        vsockPath: this.vsockPath,
        ...this.hubOwner(),
      });
      this.#vmProcess = vmm;
      // Durable identity for local-mode reclaim after a Hub crash (in-memory
      // pid is gone). Docker mode uses the ah-vmm-* container name instead.
      if (typeof vmm.pid === 'number' && vmm.pid > 0) {
        await this.io.writeFile(pidFile, `${vmm.pid}\n`);
        const identity = readLiveProcessIdentity(vmm.pid);
        if (identity) {
          await this.io.writeFile(vmmIdentityFilePath(this.vmDir), `${JSON.stringify(identity)}\n`);
        }
      }
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

  /**
   * Poll the guest agent until it answers a ping.
   *
   * The reply has to be read, not just the connection opened. Two hops stand
   * between the Hub and the agent — Firecracker's vsock, then the socat bridge
   * in the guest — and the bridge comes up first. Accepting a connection as
   * proof of readiness declared the VM ready while the agent was still
   * starting, and the first real spawn then died on the reset socat sends when
   * nothing is listening behind it. That surfaced as `read ECONNRESET` from a
   * guest that was about to be perfectly healthy.
   */
  async #waitForAgent(): Promise<void> {
    const deadline = this.clock.nowMs() + this.readyTimeoutMs;
    let lastError = 'no attempt made';
    for (;;) {
      try {
        const stream = await this.#open({
          kind: 'ping',
          protocolVersion: VM_AGENT_PROTOCOL_VERSION,
        });
        // Bounded by the boot deadline: a stuck reply must not outlast it.
        const reply = await awaitReply(stream, Math.max(1, deadline - this.clock.nowMs()));
        if (reply.kind !== 'pong') {
          throw new Error(`expected a pong from the guest agent, got "${reply.kind}"`);
        }
        if (reply.protocolVersion !== VM_AGENT_PROTOCOL_VERSION) {
          // Not retryable: a stale guest image never becomes the right one.
          // Failing here beats a confusing decode error on some later request.
          throw new VmAgentProtocolMismatchError(
            this.vmId,
            reply.protocolVersion,
            VM_AGENT_PROTOCOL_VERSION,
          );
        }
        return;
      } catch (err) {
        if (err instanceof VmAgentProtocolMismatchError) throw err;
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

  /** Read one byte range of a guest file. */
  async #readGuestChunk(
    guestPath: string,
    offset: number,
  ): Promise<{ chunk: Buffer; eof: boolean }> {
    const stream = await this.#open({
      kind: 'read-file',
      path: guestPath,
      offset,
      length: READ_FILE_CHUNK_BYTES,
    });
    const reply = await awaitReply(stream);
    if (reply.kind !== 'file') {
      throw new Error(`Unexpected guest reply reading ${guestPath}: ${reply.kind}`);
    }
    return { chunk: Buffer.from(reply.contentBase64, 'base64'), eof: reply.eof };
  }

  /** Read a file by absolute guest path via the agent. */
  async readGuestFile(guestPath: string): Promise<Buffer> {
    await this.ensureStarted();
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const { chunk, eof } = await this.#readGuestChunk(guestPath, offset);
      chunks.push(chunk);
      offset += chunk.length;
      // A zero-length non-eof read would spin forever; treat it as the end,
      // which is what a file truncated underneath us actually means.
      if (eof || chunk.length === 0) break;
    }
    return Buffer.concat(chunks);
  }

  /**
   * Stream a guest file to a host path.
   *
   * Same transport as {@link readGuestFile}, but the bytes go straight to disk
   * — the caller is moving a repo bundle, which has no business sitting in the
   * Hub's heap.
   */
  async downloadGuestFile(guestPath: string, destHostPath: string): Promise<void> {
    await this.ensureStarted();
    await mkdir(path.dirname(destHostPath), { recursive: true });
    const sink = createWriteStream(destHostPath);
    try {
      let offset = 0;
      for (;;) {
        const { chunk, eof } = await this.#readGuestChunk(guestPath, offset);
        if (chunk.length > 0) {
          if (!sink.write(chunk)) await once(sink, 'drain');
          offset += chunk.length;
        }
        if (eof || chunk.length === 0) break;
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }
  }

  /** Write a file by absolute guest path via the agent. */
  async writeGuestFile(guestPath: string, contents: Buffer): Promise<void> {
    await this.ensureStarted();
    const stream = await this.#open({
      kind: 'write-file',
      path: guestPath,
      contentBase64: contents.toString('base64'),
    });
    const reply = await awaitReply(stream);
    if (reply.kind !== 'written') {
      throw new Error(`Unexpected guest reply writing ${guestPath}: ${reply.kind}`);
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
    // No hostPath: `this.worktreePath` seeded the workspace disk at boot and
    // has been stale ever since. Callers that need contents use worktreeIo.
    return { hostPath: null, envPath: FIRECRACKER_GUEST_WORKSPACE, sharing: this.worktreeSharing };
  }

  readonly worktreeSharing = 'env-owned' as const;

  get worktreeIo(): SessionWorktreeIo {
    this.#worktreeIo ??= new GuestWorktreeIo(
      {
        exec: (command, opts) => this.#execCapture(command, opts),
        readFile: (guestPath) => this.readGuestFile(guestPath),
        writeFile: (guestPath, contents) => this.writeGuestFile(guestPath, contents),
        downloadFile: (guestPath, destHostPath) => this.downloadGuestFile(guestPath, destHostPath),
      },
      FIRECRACKER_GUEST_WORKSPACE,
    );
    return this.#worktreeIo;
  }

  #worktreeIo: SessionWorktreeIo | undefined;

  /**
   * Run a command in the guest and collect its output. Distinct from
   * {@link spawn}, which hands back a live stream: worktree IO wants the
   * whole answer, and wants a timeout that fires rather than a probe that
   * wedges the Changes pane behind an unresponsive guest.
   */
  async #execCapture(
    command: string,
    opts: { cwd: string; timeoutMs: number; maxOutputBytes?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    await this.ensureStarted();
    const proc = this.spawn(command, { cwd: opts.cwd, name: 'worktree-io' });
    const maxBytes = opts.maxOutputBytes ?? FIRECRACKER_EXEC_OUTPUT_MAX_BYTES;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overLimit = false;

    const append = (kind: 'stdout' | 'stderr', chunk: string) => {
      const n = Buffer.byteLength(chunk, 'utf8');
      if (kind === 'stdout') {
        stdoutBytes += n;
        if (stdoutBytes <= maxBytes) stdout += chunk;
      } else {
        stderrBytes += n;
        if (stderrBytes <= maxBytes) stderr += chunk;
      }
      if (!overLimit && stdoutBytes + stderrBytes > maxBytes) {
        overLimit = true;
        proc.kill('SIGKILL');
      }
    };
    proc.onStdout((chunk) => append('stdout', chunk));
    proc.onStderr((chunk) => append('stderr', chunk));

    let timer: NodeJS.Timeout | undefined;
    try {
      const exit = await new Promise<SessionEnvExit>((resolve, reject) => {
        timer = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error(`Guest command timed out after ${opts.timeoutMs}ms: ${command}`));
        }, opts.timeoutMs);
        timer.unref?.();
        // Fires synchronously if the process already exited, so a fast
        // command that finished during setup is not waited on forever.
        proc.onExit(resolve);
      });
      if (overLimit) {
        throw new Error(`Guest command exceeded ${maxBytes} bytes of captured output: ${command}`);
      }
      if (exit.error) throw exit.error;
      return { stdout, stderr, exitCode: exit.code };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Teardown ───────────────────────────────────────────────────

  dispose(opts: SessionEnvDisposeOpts = {}): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = this.#doDispose(opts.graceMs ?? DEFAULT_DISPOSE_GRACE_MS);
    return this.#disposePromise;
  }

  async #doDispose(graceMs: number): Promise<void> {
    // Refuse new work while tearing down, but only commit disposed + clear the
    // dispose latch after stopVmm succeeds — a failed stop must leave taps /
    // slots / disks alone and remain retryable.
    this.#disposed = true;
    try {
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
    } catch (err) {
      this.#disposed = false;
      this.#disposePromise = null;
      throw err;
    }
  }

  /**
   * Kill the VMM, drop the tap, release the slot, remove the VM directory.
   * Fail closed: if the VMM cannot be proven stopped, leave disks/taps alone
   * and surface the error — continuing would recreate the corruption path.
   */
  async #teardownVm(): Promise<void> {
    const vmm = this.#vmProcess;
    // Keep #vmProcess until stop succeeds so a retry can still signal it.
    if (vmm || (await this.io.isDirectory(this.vmDir).catch(() => false))) {
      await this.stopVmm({
        vmId: this.vmId,
        pid: vmm?.pid,
        pidFile: vmmPidFilePath(this.vmDir),
        identityFile: vmmIdentityFilePath(this.vmDir),
      });
    }
    this.#vmProcess = null;

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
/**
 * The worktree path as the *privileged helper* sees it.
 *
 * Every other path handed to the helper (the per-VM dir, the base rootfs)
 * lives under the firecracker data dir, which is deliberately bind-mounted at
 * the identical path inside and outside the Hub container so no translation is
 * needed. The worktree is the exception: the Hub knows it as
 * `/home/node/.agent-hub/workspaces/...` while the helper only has the host
 * mount. Passing the container path through produced
 * "fc-prepare-disks: worktree not found".
 *
 * Returns the input unchanged when no translation applies — a Hub installed
 * directly on the host already agrees with the helper.
 */
function hostVisibleWorktreePath(worktreePath: string, roots: TranslationRoots): string {
  return (
    translateContainerPathToHost(worktreePath, {
      hostWorkspacesDir: roots.hostWorkspacesDir,
      containerWorkspacesDir: roots.containerWorkspacesDir,
    }).hostPath ?? worktreePath
  );
}

/**
 * Bind-mount roots for the translation above. `undefined` means "read the
 * ambient env", which is what production does; a test passes them explicitly
 * so it does not depend on how the machine running it is configured.
 */
interface TranslationRoots {
  hostWorkspacesDir?: string | null;
  containerWorkspacesDir?: string | null;
}

export async function defaultPrepareDisks(
  io: FirecrackerHostIo,
  ctx: {
    vmDir: string;
    sessionId: string;
    worktreePath: string;
    paths: FirecrackerPaths;
    workspaceSizeMib: number;
  } & TranslationRoots,
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
    hostVisibleWorktreePath(ctx.worktreePath, ctx),
  ]);
  if (!res.ok) {
    throw new Error(
      `Failed to prepare disks for ${ctx.sessionId}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return { rootfsPath, workspacePath };
}
