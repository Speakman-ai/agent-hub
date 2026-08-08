/**
 * The agent that runs *inside* a session microVM.
 *
 * Firecracker has no exec primitive, so this process is the guest's entire
 * control plane: it spawns commands, allocates PTYs, reports listening ports,
 * and reads/writes files on the Hub's behalf. It is bundled to a single .mjs
 * and baked into the rootfs (see `build-guest-artifacts.sh`).
 *
 * It listens on a **Unix** socket, not vsock: Node has no AF_VSOCK support,
 * so a `socat VSOCK-LISTEN:1024,fork` unit bridges each incoming vsock
 * connection to this socket. `fork` gives one bridge process per connection,
 * which is exactly the protocol's one-stream-per-connection model — a wedged
 * PTY cannot stall an unrelated command.
 *
 * Privilege: the agent runs as root (it is started by systemd and has to
 * mount the workspace and read /proc), but every command it spawns drops to
 * the unprivileged workspace user. A session that could run as root by
 * default would quietly diverge from what the same command does on a
 * developer's laptop.
 */

import { spawn } from 'child_process';
import { createServer, type Server, type Socket } from 'net';
import { readFileSync } from 'fs';
import { readFile, writeFile, chmod } from 'fs/promises';
import { randomUUID } from 'crypto';
import { userInfo } from 'os';
import { pathToFileURL } from 'url';
import {
  VmAgentFrameDecoder,
  encodeFrame,
  encodeJsonFrame,
  decodeJsonPayload,
  type VmAgentControl,
  type VmAgentExecRequest,
  type VmAgentFrame,
  type VmAgentPtyRequest,
  type VmAgentReadFileRequest,
  type VmAgentRequest,
  type VmAgentWriteFileRequest,
  VM_AGENT_PROTOCOL_VERSION,
} from '../vm-agent-protocol.js';
import { parseListeningPorts } from './proc-net-tcp.js';

/**
 * node-pty is loaded on first use rather than imported at the top.
 *
 * It is a native addon, so it is the one dependency that can be absent from
 * an otherwise healthy guest — a rootfs built without it, or built for a
 * different Node ABI. A top-level import turns that into an unhandled
 * ERR_MODULE_NOT_FOUND before the socket is even created, systemd restarts
 * the agent five times in as many seconds, hits the start limit, and gives
 * up. The VM then boots, pings, routes traffic, and answers nothing, with the
 * only evidence inside a guest the Hub can no longer reach.
 *
 * Deferring it means a missing addon costs exactly what it should: terminals
 * fail with a clear message, and every other operation keeps working.
 */
type PtyModule = typeof import('node-pty');
let ptyModule: PtyModule | null = null;
let ptyLoadFailure: string | null = null;

async function loadPty(): Promise<PtyModule> {
  if (ptyModule) return ptyModule;
  if (ptyLoadFailure !== null) throw new Error(ptyLoadFailure);
  try {
    ptyModule = await import('node-pty');
    return ptyModule;
  } catch (err) {
    ptyLoadFailure =
      'node-pty is not available in this guest, so terminals cannot be opened: ' +
      (err instanceof Error ? err.message : String(err));
    throw new Error(ptyLoadFailure);
  }
}

/** Distinguishes a fresh VM from one the Hub reconnected to after a restart. */
const BOOT_ID = randomUUID();

const DEFAULT_SOCKET_PATH = '/run/agent-hub/vm-agent.sock';
const DEFAULT_WORKSPACE_USER = 'runner';

export interface ResolvedUser {
  uid: number;
  gid: number;
  home: string;
  name: string;
}

/**
 * Resolve the unprivileged user once at startup. Failing here is fatal on
 * purpose: silently continuing as root would hand every session a
 * root-by-default environment that behaves differently from a laptop.
 */
export function resolveWorkspaceUser(
  name: string = DEFAULT_WORKSPACE_USER,
  readPasswd: () => string = () => readFileSync('/etc/passwd', 'utf8'),
): ResolvedUser {
  const info = userInfo();
  if (info.username === name) {
    return { uid: info.uid, gid: info.gid, home: info.homedir, name: info.username };
  }
  for (const line of readPasswd().split('\n')) {
    const [entry, , uid, gid, , home] = line.split(':');
    if (entry === name) {
      return {
        uid: Number.parseInt(uid, 10),
        gid: Number.parseInt(gid, 10),
        home: home || `/home/${name}`,
        name,
      };
    }
  }
  throw new Error(`vm-agent: workspace user "${name}" does not exist in this guest`);
}

/**
 * Drop from the agent's root to the workspace user via `setpriv`.
 *
 * `spawn`'s `uid`/`gid` options change only the primary ids — Node never
 * calls `initgroups`, so the child keeps *root's* supplementary groups and
 * silently belongs to none of the workspace user's. In this image that means
 * no `docker` group, and every `docker` command in a session fails with
 * "permission denied ... /var/run/docker.sock" despite `id runner` listing
 * the group. `--init-groups` reads /etc/group and applies the real set.
 */
export const SETPRIV_BIN = '/usr/bin/setpriv';

export interface ChildLaunch {
  file: string;
  args: string[];
}

/**
 * Build the argv for a child process, dropping to `user` when the agent is
 * running as root.
 *
 * When the agent is *not* root there is nothing to drop: `setpriv --reuid`
 * would fail outright, and the child already has exactly the identity and
 * groups it should. That is the case under test and when the agent is run
 * unprivileged, so the choice is behavioural, not a test accommodation.
 */
export function buildChildLaunch(
  user: ResolvedUser,
  command: string,
  args: string[],
  currentUid: number | undefined = process.getuid?.(),
): ChildLaunch {
  if (currentUid !== 0 || currentUid === user.uid) return { file: command, args };
  return {
    file: SETPRIV_BIN,
    args: [
      `--reuid=${String(user.uid)}`,
      `--regid=${String(user.gid)}`,
      '--init-groups',
      // Without this the child keeps the agent's bounding set; a session
      // process has no business inheriting root capabilities.
      '--inh-caps=-all',
      '--',
      command,
      ...args,
    ],
  };
}

export function buildChildEnv(
  workspaceUser: ResolvedUser,
  overrides: Record<string, string | null | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: workspaceUser.home,
    USER: workspaceUser.name,
    LOGNAME: workspaceUser.name,
    SHELL: '/bin/bash',
  };
  for (const [key, value] of Object.entries(overrides)) {
    // `null` is the wire form of "unset"; an absent key means "leave alone",
    // so the two must not collapse into each other here.
    if (value === null) delete env[key];
    else if (value !== undefined) env[key] = value;
  }
  return env;
}

class Connection {
  #decoder = new VmAgentFrameDecoder();
  #request: VmAgentRequest | null = null;
  #onControl: ((control: VmAgentControl) => void) | null = null;
  #onStdin: ((chunk: Buffer) => void) | null = null;
  #onStdinEof: (() => void) | null = null;
  #closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly workspaceUser: ResolvedUser,
  ) {
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', () => this.#cleanup());
    socket.on('close', () => this.#cleanup());
  }

  #cleanup(): void {
    if (this.#closed) return;
    this.#closed = true;
    // The host hung up. Anything still running for this stream is orphaned
    // output nobody will read, so let handlers tear their child down.
    this.#onControl?.({ kind: 'signal', signal: 'SIGKILL' });
  }

  #onData(chunk: Buffer): void {
    let frames: VmAgentFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    for (const frame of frames) this.#handleFrame(frame);
  }

  #handleFrame(frame: VmAgentFrame): void {
    switch (frame.type) {
      case 'request':
        if (this.#request) {
          this.fail('vm-agent received a second request on one connection');
          return;
        }
        this.#request = decodeJsonPayload<VmAgentRequest>(frame.payload);
        void this.#dispatch(this.#request);
        return;
      case 'stdin':
        this.#onStdin?.(frame.payload);
        return;
      case 'control': {
        const control = decodeJsonPayload<VmAgentControl>(frame.payload);
        if (control.kind === 'stdin-eof') this.#onStdinEof?.();
        else this.#onControl?.(control);
        return;
      }
      default:
        // Guest→host kinds have no meaning arriving here.
        return;
    }
  }

  send(type: VmAgentFrame['type'], payload: Buffer): void {
    if (this.#closed) return;
    this.socket.write(encodeFrame(type, payload));
  }

  sendJson(type: VmAgentFrame['type'], value: unknown): void {
    if (this.#closed) return;
    this.socket.write(encodeJsonFrame(type, value));
  }

  fail(message: string, code?: string): void {
    this.sendJson('error', { message, code });
    this.socket.end();
  }

  finish(): void {
    this.socket.end();
  }

  async #dispatch(request: VmAgentRequest): Promise<void> {
    try {
      switch (request.kind) {
        case 'ping':
          this.sendJson('reply', {
            kind: 'pong',
            protocolVersion: VM_AGENT_PROTOCOL_VERSION,
            bootId: BOOT_ID,
          });
          this.finish();
          return;
        case 'exec':
          this.#exec(request);
          return;
        case 'pty':
          await this.#pty(request);
          return;
        case 'list-ports':
          await this.#listPorts();
          return;
        case 'read-file':
          await this.#readFile(request);
          return;
        case 'write-file':
          await this.#writeFile(request);
          return;
        default: {
          const exhaustive: never = request;
          this.fail(`vm-agent received an unknown request kind: ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  #exec(request: VmAgentExecRequest): void {
    const launch = buildChildLaunch(this.workspaceUser, '/bin/sh', ['-c', request.command]);
    const child = spawn(launch.file, launch.args, {
      cwd: request.cwd,
      env: buildChildEnv(this.workspaceUser, request.env),
      // Its own process group, so a signal reaches the whole job tree rather
      // than just the shell that forked it.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.fail(`${request.name ?? request.command}: ${err.message}`, err.code);
    });
    if (child.pid !== undefined) this.sendJson('started', { pid: child.pid });

    child.stdout?.on('data', (chunk: Buffer) => this.send('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.send('stderr', chunk));

    this.#onStdin = (chunk) => child.stdin?.write(chunk);
    this.#onStdinEof = () => child.stdin?.end();
    this.#onControl = (control) => {
      if (control.kind !== 'signal' || child.pid === undefined) return;
      try {
        process.kill(-child.pid, control.signal as NodeJS.Signals);
      } catch {
        // Already reaped.
      }
    };

    child.on('close', (code, signal) => {
      this.sendJson('exit', { code, signal });
      this.finish();
    });
  }

  async #pty(request: VmAgentPtyRequest): Promise<void> {
    const pty = await loadPty();
    const env = buildChildEnv(this.workspaceUser, { ...request.env, TERM: request.term });
    const launch = buildChildLaunch(this.workspaceUser, request.command, request.args);
    const term = pty.spawn(launch.file, launch.args, {
      name: request.term,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env,
    });

    this.sendJson('started', { pid: term.pid });
    term.onData((data: string) => this.send('stdout', Buffer.from(data, 'utf8')));

    this.#onStdin = (chunk) => term.write(chunk.toString('utf8'));
    this.#onStdinEof = () => term.write('\x04');
    this.#onControl = (control) => {
      if (control.kind === 'resize') {
        try {
          term.resize(control.cols, control.rows);
        } catch {
          // The shell exited between the resize and its delivery.
        }
        return;
      }
      if (control.kind === 'signal') {
        try {
          term.kill(control.signal);
        } catch {
          // Already gone.
        }
      }
    };

    term.onExit(({ exitCode, signal }) => {
      this.sendJson('exit', { code: exitCode, signal: signal ? String(signal) : null });
      this.finish();
    });
  }

  async #listPorts(): Promise<void> {
    const [tcp4, tcp6] = await Promise.all([
      readFile('/proc/net/tcp', 'utf8').catch(() => ''),
      readFile('/proc/net/tcp6', 'utf8').catch(() => ''),
    ]);
    this.sendJson('reply', {
      kind: 'ports',
      ports: parseListeningPorts(tcp4, tcp6).map((l) => ({
        port: l.port,
        address: l.address,
      })),
    });
    this.finish();
  }

  async #readFile(request: VmAgentReadFileRequest): Promise<void> {
    const contents = await readFile(request.path);
    this.sendJson('reply', { kind: 'file', contentBase64: contents.toString('base64') });
    this.finish();
  }

  async #writeFile(request: VmAgentWriteFileRequest): Promise<void> {
    await writeFile(request.path, Buffer.from(request.contentBase64, 'base64'));
    if (request.mode) await chmod(request.path, Number.parseInt(request.mode, 8));
    this.sendJson('reply', { kind: 'written' });
    this.finish();
  }
}

export interface VmAgentServerOpts {
  socketPath?: string;
  workspaceUser: ResolvedUser;
}

/**
 * Create (but do not listen on) the agent server. Split from startup so the
 * dispatch logic can be exercised over a real socket in tests — the framing
 * and process plumbing are the parts most likely to be subtly wrong, and they
 * are unreachable if the module can only be started as a daemon.
 */
export function createVmAgentServer(opts: VmAgentServerOpts): Server {
  return createServer((socket) => {
    socket.setNoDelay(true);
    new Connection(socket, opts.workspaceUser);
  });
}

export function startVmAgent(opts: VmAgentServerOpts): Server {
  const socketPath = opts.socketPath ?? DEFAULT_SOCKET_PATH;
  const server = createVmAgentServer(opts);

  server.on('error', (err) => {
    console.error(`vm-agent: server error: ${err.message}`);
    process.exitCode = 1;
  });

  server.listen(socketPath, () => {
    // Keep the socket private to the agent's own uid: anything in the guest
    // that could connect here would be able to run commands as the workspace
    // user without the Hub ever asking.
    void chmod(socketPath, 0o600).catch(() => undefined);
    console.log(
      `vm-agent listening on ${socketPath} (protocol v${VM_AGENT_PROTOCOL_VERSION}, boot ${BOOT_ID})`,
    );
  });
  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startVmAgent({
    socketPath: process.env.VM_AGENT_SOCKET,
    workspaceUser: resolveWorkspaceUser(process.env.VM_AGENT_USER),
  });
}
