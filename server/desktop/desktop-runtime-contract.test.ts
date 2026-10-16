/**
 * One DesktopRuntime contract, run against both backends.
 *
 * Agents must not be able to tell the container from the Firecracker VM, so
 * every case below runs twice, and each backend runs its real in-guest code
 * path against the same fake display:
 *
 *   - container: ops go through the real control daemon (parseOp/executeOp).
 *   - firecracker: screenshot and input go over a real Unix socket to the real
 *     guest vm-agent (`screenshot` / `input` requests); the live view reads a
 *     frame source standing in for the guest's VNC server.
 *
 * Only the display itself (scrot/xdotool/bash) and the machine lifecycle
 * (container host, microVM) are faked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { connect, type Server } from 'net';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  __resetSecretCryptoForTests,
  __setSecretCryptoKeyFilePathForTests,
} from '../secret-crypto.js';
import {
  executeOp,
  OpValidationError,
  parseOp,
  type DesktopBackend,
  type ExecResult,
} from './control-daemon.js';
import { createContainerDesktopRuntime } from './container-desktop-runtime.js';
import type { DesktopContainerHost, DesktopHostStatus } from './container-desktop-host.js';
import { DesktopOpError, type DesktopControlClient } from './desktop-control-client.js';
import {
  DESKTOP_IDLE_STOP_MS,
  DESKTOP_SCREEN,
  type DesktopComputerKey,
  type DesktopInputEvent,
  type DesktopRuntime,
} from './desktop-runtime.js';
import { DESKTOP_COMPUTERS_SCHEMA } from './desktop-computers-schema.js';
import { createDesktopComputersStore } from './desktop-computers-store.js';
import {
  FirecrackerDesktopRuntime,
  type FirecrackerDesktopVm,
  type FirecrackerDesktopVmSpec,
} from './firecracker-desktop-runtime.js';
import { createFirecrackerSlotPool } from './register-firecracker-desktop-runtime.js';
import type { DesktopFrameSource } from './vnc-frame-source.js';
import {
  createVmAgentServer,
  type GuestDesktop,
} from '../session-env/firecracker/guest/vm-agent.js';
import {
  VmAgentFrameDecoder,
  decodeJsonPayload,
  encodeJsonFrame,
  type VmAgentReply,
  type VmAgentRequest,
} from '../session-env/firecracker/vm-agent-protocol.js';
import type {
  SessionEnvExit,
  SessionEnvProcess,
  SessionEnvSpawnOpts,
} from '../session-env/session-env.js';

const KEY: DesktopComputerKey = { userId: 'u1', agentId: 'a1', projectId: 'p1' };

/** The X display both backends drive: records xdotool argv and shell commands. */
class FakeDisplay {
  png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  readonly xdotool: string[][] = [];
  readonly shell: string[] = [];
  captures = 0;

  run(command: string): ExecResult {
    this.shell.push(command);
    const echo = /^echo (.*)$/.exec(command);
    return {
      exitCode: 0,
      signal: null,
      stdout: echo ? `${echo[1]}\n` : '',
      stderr: '',
      timedOut: false,
      truncated: false,
    };
  }

  /** The container's control-daemon backend. */
  daemonBackend(): DesktopBackend {
    return {
      screenshot: async () => {
        this.captures++;
        return this.png;
      },
      input: async (args) => {
        this.xdotool.push(args);
      },
      cursorPosition: async () => ({ x: 0, y: 0 }),
      exec: async (command) => this.run(command),
    };
  }

  /** The Firecracker guest vm-agent's display. */
  guestDesktop(): GuestDesktop {
    return {
      screenshot: async () => {
        this.captures++;
        return this.png;
      },
      input: async (args) => {
        this.xdotool.push(args);
      },
    };
  }
}

interface Harness {
  name: 'container' | 'firecracker';
  runtime: DesktopRuntime;
  display: FakeDisplay;
  advance(ms: number): void;
  sweepIdle(): Promise<unknown>;
  cleanup(): Promise<void>;
}

// Container backend

function containerHarness(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-contract-'));
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  __resetSecretCryptoForTests();
  __setSecretCryptoKeyFilePathForTests(path.join(dir, 'secret.key'));
  initOrgsDb();
  let clock = 1_000_000;
  const display = new FakeDisplay();
  const statuses = new Map<string, DesktopHostStatus>();
  let n = 0;
  const host: DesktopContainerHost = {
    placement: 'hub-docker',
    allocateRef: () => `ref-${++n}`,
    async start(req) {
      statuses.set(req.runnerRef, {
        state: 'running',
        endpoint: { host: '127.0.0.1', port: 40000 + n },
        detail: null,
      });
      return { homeRef: `vol-${req.computerId}` };
    },
    async status(ref) {
      return statuses.get(ref) ?? { state: 'lost', endpoint: null, detail: 'gone' };
    },
    async stop(ref) {
      statuses.set(ref, { state: 'stopped', endpoint: null, detail: null });
      return { confirmed: true };
    },
    async deleteHome() {},
  };
  // The real daemon's validation and dispatch, minus HTTP.
  const client: DesktopControlClient = {
    healthy: async () => true,
    async op(_endpoint, _token, body) {
      let op;
      try {
        op = parseOp(body, DESKTOP_SCREEN);
      } catch (err) {
        if (err instanceof OpValidationError) throw new DesktopOpError(err.message, 400);
        throw err;
      }
      return executeOp(op, display.daemonBackend(), DESKTOP_SCREEN);
    },
  };
  const runtime = createContainerDesktopRuntime({
    host,
    client,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    startTimer: () => ({ stop: () => {} }),
    newToken: () => 'tok',
    log: () => {},
  });
  return {
    name: 'container',
    runtime,
    display,
    advance: (ms) => {
      clock += ms;
    },
    sweepIdle: () => runtime.sweepIdle(),
    async cleanup() {
      runtime.dispose();
      setOrgsDbPathForTests(null);
      __setSecretCryptoKeyFilePathForTests(null);
      __resetSecretCryptoForTests();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Firecracker backend

/** One request/reply exchange with the real guest vm-agent over its Unix socket. */
function agentRequest(socketPath: string, request: VmAgentRequest): Promise<VmAgentReply> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const decoder = new VmAgentFrameDecoder();
    socket.on('error', reject);
    socket.on('connect', () => socket.write(encodeJsonFrame('request', request)));
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === 'reply') resolve(decodeJsonPayload<VmAgentReply>(frame.payload));
        if (frame.type === 'error') {
          reject(new Error(decodeJsonPayload<{ message: string }>(frame.payload).message));
        }
      }
    });
    socket.on('close', () => reject(new Error('vm-agent closed the stream without replying')));
  });
}

class ShellProc implements SessionEnvProcess {
  readonly pid = 1;
  readonly name = 'desktop-exec';
  exited = false;
  exitResult: SessionEnvExit | null = null;
  #out: ((c: string) => void)[] = [];
  #exit: ((r: SessionEnvExit) => void)[] = [];
  constructor(result: ExecResult) {
    setImmediate(() => {
      for (const cb of this.#out) cb(result.stdout);
      this.exited = true;
      this.exitResult = { code: result.exitCode, signal: null };
      for (const cb of this.#exit) cb(this.exitResult);
    });
  }
  onStdout(cb: (c: string) => void) {
    this.#out.push(cb);
    return () => undefined;
  }
  onStderr() {
    return () => undefined;
  }
  onExit(cb: (r: SessionEnvExit) => void) {
    this.#exit.push(cb);
    return () => undefined;
  }
  kill() {}
}

class AgentBackedVm implements FirecrackerDesktopVm {
  disposed = false;
  guestIp: string | null = null;
  constructor(
    readonly spec: FirecrackerDesktopVmSpec,
    private readonly socketPath: string,
    private readonly display: FakeDisplay,
  ) {}
  get vmId() {
    return this.spec.vmId;
  }
  async ensureStarted() {
    this.guestIp = `172.30.0.${this.spec.slot}`;
  }
  spawn(command: string, _opts?: SessionEnvSpawnOpts): SessionEnvProcess {
    return new ShellProc(this.display.run(command));
  }
  liveProcessCount() {
    return 0;
  }
  async dispose() {
    this.disposed = true;
  }
  async suspend() {
    this.disposed = true;
    return null;
  }
  async desktopScreenshot() {
    const reply = await agentRequest(this.socketPath, { kind: 'screenshot' });
    if (reply.kind !== 'screenshot') throw new Error(`unexpected reply ${reply.kind}`);
    return Buffer.from(reply.pngBase64, 'base64');
  }
  async desktopInput(event: DesktopInputEvent) {
    const reply = await agentRequest(this.socketPath, { kind: 'input', event });
    if (reply.kind !== 'input-done') throw new Error(`unexpected reply ${reply.kind}`);
  }
}

async function firecrackerHarness(): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-contract-fc-'));
  const socketPath = path.join(dir, 'agent.sock');
  const display = new FakeDisplay();
  const me = os.userInfo();
  const server: Server = createVmAgentServer({
    workspaceUser: { uid: me.uid, gid: me.gid, home: me.homedir, name: me.username },
    setClock: () => Promise.reject(new Error('not in this test')),
    desktop: display.guestDesktop(),
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const db = new Database(':memory:');
  db.exec(DESKTOP_COMPUTERS_SCHEMA);
  const store = createDesktopComputersStore(() => db);
  let clock = 1_000_000;
  const runtime = new FirecrackerDesktopRuntime({
    store,
    slots: createFirecrackerSlotPool(store),
    now: () => clock,
    logger: { warn: () => undefined },
    createVm: (spec) => new AgentBackedVm(spec, socketPath, display),
    // Stands in for x11vnc: the same framebuffer scrot would capture.
    openDisplay: async () => {
      const source: DesktopFrameSource = {
        closed: false,
        capture: async () => {
          display.captures++;
          return display.png;
        },
        close() {
          (source as { closed: boolean }).closed = true;
        },
      };
      return source;
    },
  });
  return {
    name: 'firecracker',
    runtime,
    display,
    advance: (ms) => {
      clock += ms;
    },
    sweepIdle: () => runtime.sweepIdle(),
    async cleanup() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The contract

describe.each([
  ['container', async () => containerHarness()],
  ['firecracker', firecrackerHarness],
] as const)('DesktopRuntime contract: %s', (_name, make) => {
  let h: Harness;
  beforeEach(async () => {
    h = await make();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('reports a computer that was never used as stopped', async () => {
    const st = await h.runtime.status(KEY);
    expect(st).toMatchObject({ kind: h.name, state: 'stopped', lastActiveAt: null });
  });

  it('starts on first use and reports running', async () => {
    const st = await h.runtime.ensureStarted(KEY);
    expect(st).toMatchObject({ kind: h.name, state: 'running' });
    expect(st.lastActiveAt).not.toBeNull();
  });

  it('screenshot returns the display as PNG, starting the computer if needed', async () => {
    await expect(h.runtime.screenshot(KEY)).resolves.toEqual(h.display.png);
    expect((await h.runtime.status(KEY)).state).toBe('running');
  });

  it('viewFrame never starts a computer', async () => {
    await expect(h.runtime.viewFrame(KEY)).resolves.toBeNull();
    expect((await h.runtime.status(KEY)).state).toBe('stopped');
    expect(h.display.captures).toBe(0);
  });

  it('viewFrame shows the running display without counting as activity', async () => {
    await h.runtime.ensureStarted(KEY);
    const before = (await h.runtime.status(KEY)).lastActiveAt;
    h.advance(60_000);
    await expect(h.runtime.viewFrame(KEY)).resolves.toEqual(h.display.png);
    expect((await h.runtime.status(KEY)).lastActiveAt).toBe(before);
  });

  it('turns input events into the same xdotool argv', async () => {
    const events: DesktopInputEvent[] = [
      { type: 'click', x: 10, y: 20 },
      { type: 'click', x: 1279, y: 799, button: 'right' },
      { type: 'double_click', x: 5, y: 6, button: 'middle' },
      { type: 'type', text: "it's $(rm -rf ~)" },
      { type: 'key', combo: 'ctrl+l Return' },
      { type: 'scroll', x: 100, y: 200, direction: 'down', amount: 4 },
      { type: 'drag', fromX: 1, fromY: 2, toX: 300, toY: 400 },
    ];
    for (const event of events) await h.runtime.input(KEY, event);
    expect(h.display.xdotool).toEqual([
      ['mousemove', '10', '20', 'click', '1'],
      ['mousemove', '1279', '799', 'click', '3'],
      ['mousemove', '5', '6', 'click', '--repeat', '2', '--delay', '100', '2'],
      ['type', '--delay', '12', '--', "it's $(rm -rf ~)"],
      ['key', '--delay', '50', '--', 'ctrl+l', 'Return'],
      ['mousemove', '100', '200', 'click', '--repeat', '4', '--delay', '30', '5'],
      ['mousemove', '1', '2', 'mousedown', '1', 'mousemove', '300', '400', 'mouseup', '1'],
    ]);
  });

  it('accepts a pointer move', async () => {
    await expect(h.runtime.input(KEY, { type: 'move', x: 640, y: 400 })).resolves.toBeUndefined();
  });

  it.each([
    [{ type: 'click', x: 1280, y: 0 }],
    [{ type: 'move', x: 0, y: 800 }],
    [{ type: 'click', x: 1.5, y: 0 }],
    [{ type: 'key', combo: 'ctrl+l; xdotool type pwned' }],
    [{ type: 'type', text: '' }],
    [{ type: 'scroll', x: 1, y: 1, direction: 'sideways' }],
  ])('refuses %j before starting the computer', async (event) => {
    await expect(h.runtime.input(KEY, event as DesktopInputEvent)).rejects.toThrow(/must be/);
    expect((await h.runtime.status(KEY)).state).toBe('stopped');
    expect(h.display.xdotool).toHaveLength(0);
  });

  it('runs exec inside the computer and returns its output', async () => {
    const res = await h.runtime.exec(KEY, 'echo hello');
    expect(res).toMatchObject({ exitCode: 0, stdout: 'hello\n', timedOut: false });
  });

  it('stop keeps the computer resumable', async () => {
    await h.runtime.ensureStarted(KEY);
    await h.runtime.stop(KEY);
    expect((await h.runtime.status(KEY)).state).toBe('stopped');
    await expect(h.runtime.viewFrame(KEY)).resolves.toBeNull();
    await expect(h.runtime.screenshot(KEY)).resolves.toEqual(h.display.png);
    expect((await h.runtime.status(KEY)).state).toBe('running');
  });

  it('stops after 30 idle minutes and not before', async () => {
    await h.runtime.ensureStarted(KEY);
    h.advance(DESKTOP_IDLE_STOP_MS - 1_000);
    await h.sweepIdle();
    expect((await h.runtime.status(KEY)).state).toBe('running');
    h.advance(1_000);
    await h.sweepIdle();
    expect((await h.runtime.status(KEY)).state).toBe('stopped');
  });
});
