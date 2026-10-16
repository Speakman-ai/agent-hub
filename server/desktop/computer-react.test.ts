import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  __resetSecretCryptoForTests,
  __setSecretCryptoKeyFilePathForTests,
} from '../secret-crypto.js';
import { parseReActBlock } from '../chat.js';
import { createControlServer, type DesktopBackend, type ExecResult } from './control-daemon.js';
import { createDesktopControlClient } from './desktop-control-client.js';
import type { DesktopContainerHost } from './container-desktop-host.js';
import {
  createContainerDesktopRuntime,
  type ContainerDesktopRuntime,
} from './container-desktop-runtime.js';
import {
  COMPUTER_REACT_OPS,
  parseComputerReactAction,
  pngDimensions,
  runComputerReActStep,
  splitGatedSteps,
  type ComputerReactContext,
} from './computer-react.js';
import type { DesktopOp } from './control-daemon.js';

const TOKEN = 'test-control-token';

/** Smallest buffer `pngDimensions` accepts: signature + IHDR width/height. */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

interface FakeX11 extends DesktopBackend {
  inputs: string[][];
  failInput: string | null;
  execs: { command: string; timeoutMs: number; cwd?: string }[];
}

function fakeX11(): FakeX11 {
  const backend: FakeX11 = {
    inputs: [],
    failInput: null,
    execs: [],
    async screenshot() {
      return fakePng(1280, 800);
    },
    async input(args) {
      if (backend.failInput) throw new Error(backend.failInput);
      backend.inputs.push(args);
    },
    async cursorPosition() {
      return { x: 1, y: 2 };
    },
    async exec(command, timeoutMs, cwd): Promise<ExecResult> {
      backend.execs.push({ command, timeoutMs, ...(cwd ? { cwd } : {}) });
      if (command.includes('getmouselocation')) {
        return ok('X=321\nY=123\nSCREEN=0\nWINDOW=4\n');
      }
      if (command === 'false') {
        return { ...ok(''), exitCode: 1, stderr: 'nope\n' };
      }
      return ok(`ran: ${command}\n`);
    },
  };
  return backend;
}

function ok(stdout: string): ExecResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false };
}

let dir: string;
let server: Server;
let x11: FakeX11;
let runtime: ContainerDesktopRuntime;
let starts: number;

const CTX: ComputerReactContext = {
  sessionId: 'sess-1',
  ownerUserId: 'u1',
  agentId: 'a1',
  projectId: 'p1',
};

function parse(raw: Record<string, unknown>): DesktopOp {
  const r = parseComputerReactAction(raw);
  if (!r.ok) throw new Error(r.detail);
  return r.op;
}

function run(raw: Record<string, unknown>, ctx: ComputerReactContext = CTX) {
  return runComputerReActStep(parse(raw), ctx, {
    resolveRuntime: () => runtime,
    dataDir: dir,
    sleep: async () => {},
  });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'computer-react-'));
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  __resetSecretCryptoForTests();
  __setSecretCryptoKeyFilePathForTests(path.join(dir, 'secret.key'));
  initOrgsDb();

  x11 = fakeX11();
  server = createControlServer({ token: TOKEN, backend: x11 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  starts = 0;
  let n = 0;
  const host: DesktopContainerHost = {
    placement: 'hub-docker',
    allocateRef: () => `ref-${++n}`,
    async start(req) {
      starts++;
      return { homeRef: `vol-${req.computerId}` };
    },
    async status() {
      return { state: 'running', endpoint: { host: '127.0.0.1', port }, detail: null };
    },
    async stop() {
      return { confirmed: true };
    },
    async deleteHome() {},
  };
  runtime = createContainerDesktopRuntime({
    host,
    client: createDesktopControlClient(),
    newToken: () => TOKEN,
    sleep: async () => {},
    startTimer: () => ({ stop: () => {} }),
    log: () => {},
  });
});

afterEach(async () => {
  runtime.dispose();
  await new Promise<void>((r) => server.close(() => r()));
  setOrgsDbPathForTests(null);
  __setSecretCryptoKeyFilePathForTests(null);
  __resetSecretCryptoForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseComputerReactAction', () => {
  it('accepts every SPEC-6 op', () => {
    expect([...COMPUTER_REACT_OPS].sort()).toEqual(
      [
        'click',
        'cursor_position',
        'double_click',
        'drag',
        'exec',
        'key',
        'screenshot',
        'scroll',
        'type',
        'wait',
      ].sort(),
    );
  });

  it('accepts key and timeout_ms aliases', () => {
    expect(parse({ op: 'key', key: 'ctrl+l' })).toEqual({ op: 'key', combo: 'ctrl+l' });
    expect(parse({ op: 'exec', command: 'ls', timeout_ms: 5000 })).toMatchObject({
      timeoutMs: 5000,
    });
  });

  it.each([
    [{ op: 'click', x: 1280, y: 10 }, /x must be within 0..1279/],
    [{ op: 'key', combo: 'ctrl+l; rm -rf /' }, /combo/],
    [{ op: 'teleport' }, /requires op/],
    [{ op: 'wait', ms: 120_000 }, /ms must be/],
  ])('rejects %j', (raw, msg) => {
    const r = parseComputerReactAction(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(msg);
  });

  it('is wired into the ReAct block parser', () => {
    const okBlock = parseReActBlock(
      '<agenthub:react>{"actions":[{"tool":"computer","op":"double_click","x":5,"y":6}]}</agenthub:react>',
    );
    expect(okBlock).toEqual({
      actions: [
        {
          tool: 'computer',
          op: 'double_click',
          computer: { op: 'double_click', x: 5, y: 6, button: 'left' },
        },
      ],
    });
    const bad = parseReActBlock(
      '<agenthub:react>{"actions":[{"tool":"computer","op":"click","x":-1,"y":0}]}</agenthub:react>',
    );
    expect(bad).toMatchObject({ error: 'malformed' });
  });
});

describe('runComputerReActStep against a fake control daemon', () => {
  it('saves screenshots to disk and reports the path and dimensions', async () => {
    const r = await run({ op: 'screenshot' });
    expect(r.hostExit).toBe(0);
    expect(r.screenshotPath).toBeDefined();
    expect(r.screenshotPath!.startsWith(path.join(dir, 'browser-screenshots', 'sess-1'))).toBe(
      true,
    );
    expect(r.screenshotPath!.endsWith('.png')).toBe(true);
    expect(pngDimensions(readFileSync(r.screenshotPath!))).toEqual({ width: 1280, height: 800 });
    expect(r.markdown).toContain(`\`${r.screenshotPath}\``);
    expect(r.markdown).toContain('1280x800');
    expect(r.markdown).toContain('Surface: desktop');
    expect(starts).toBe(1);
  });

  it('maps input ops onto xdotool through the daemon', async () => {
    await run({ op: 'click', x: 10, y: 20 });
    await run({ op: 'double_click', x: 11, y: 21, button: 'right' });
    await run({ op: 'type', text: 'hello' });
    await run({ op: 'key', combo: 'ctrl+l Return' });
    await run({ op: 'scroll', x: 5, y: 6, direction: 'down', amount: 2 });
    const drag = await run({ op: 'drag', x: 1, y: 2, toX: 300, toY: 400 });
    expect(drag.hostExit).toBe(0);
    expect(drag.markdown).toContain('drag (1, 2) → (300, 400)');
    expect(x11.inputs).toEqual([
      ['mousemove', '10', '20', 'click', '1'],
      ['mousemove', '11', '21', 'click', '--repeat', '2', '--delay', '100', '3'],
      ['type', '--delay', '12', '--', 'hello'],
      ['key', '--delay', '50', '--', 'ctrl+l', 'Return'],
      ['mousemove', '5', '6', 'click', '--repeat', '2', '--delay', '30', '5'],
      ['mousemove', '1', '2', 'mousedown', '1', 'mousemove', '300', '400', 'mouseup', '1'],
    ]);
    // One computer, booted once, reused for every op.
    expect(starts).toBe(1);
  });

  it('reads the cursor position', async () => {
    const r = await run({ op: 'cursor_position' });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('Cursor is at (321, 123).');
    expect(x11.execs[0]!.command).toBe('DISPLAY=:99 xdotool getmouselocation --shell');
  });

  it('runs exec and reports output and exit code', async () => {
    const r = await run({ op: 'exec', command: 'ls -la', cwd: '/home/desktop', timeoutMs: 9000 });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('Command exited 0.');
    expect(r.markdown).toContain('ran: ls -la');
    expect(x11.execs).toEqual([{ command: 'ls -la', timeoutMs: 9000, cwd: '/home/desktop' }]);

    const failed = await run({ op: 'exec', command: 'false' });
    expect(failed.hostExit).toBe(1);
    expect(failed.markdown).toContain('Command exited 1.');
    expect(failed.markdown).toContain('nope');
  });

  it('waits on the host without booting the desktop', async () => {
    const r = await run({ op: 'wait', ms: 500 });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('Waited 500 ms.');
    expect(starts).toBe(0);
  });

  it('surfaces daemon failures as a failed observation instead of throwing', async () => {
    x11.failInput = 'xdotool: cannot open display';
    const r = await run({ op: 'click', x: 1, y: 1 });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('cannot open display');
  });

  it('refuses without an owning user and never starts a desktop', async () => {
    const r = await run({ op: 'screenshot' }, { ...CTX, ownerUserId: null });
    expect(r.hostExit).toBe(2);
    expect(starts).toBe(0);
  });

  it('reports an unavailable runtime', async () => {
    const r = await runComputerReActStep(parse({ op: 'screenshot' }), CTX, {
      resolveRuntime: () => {
        throw new Error('desktopRuntime is set to firecracker, but the backend is not registered');
      },
      dataDir: dir,
    });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('not registered');
  });
});

describe('splitGatedSteps', () => {
  it('splits key sequences into chords and typed text after each newline', () => {
    expect(splitGatedSteps({ op: 'key', combo: 'alt+Tab  Return' })).toEqual([
      { op: 'key', combo: 'alt+Tab' },
      { op: 'key', combo: 'Return' },
    ]);
    expect(splitGatedSteps({ op: 'type', text: 'a\nb\n' })).toEqual([
      { op: 'type', text: 'a\n' },
      { op: 'type', text: 'b\n' },
    ]);
    expect(splitGatedSteps({ op: 'key', combo: 'ctrl+l' })).toBeNull();
    expect(splitGatedSteps({ op: 'type', text: 'hello' })).toBeNull();
    expect(splitGatedSteps({ op: 'click', x: 1, y: 1, button: 'left' })).toBeNull();
  });
});
