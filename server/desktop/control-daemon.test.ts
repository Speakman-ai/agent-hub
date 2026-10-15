import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';
import {
  createControlServer,
  isAuthorized,
  parseMouseLocation,
  parseOp,
  runCommand,
  screenFromEnv,
  xdotoolArgs,
  inputTimeoutMs,
  OpValidationError,
  type DesktopBackend,
} from './control-daemon.js';

describe('parseOp', () => {
  it('defaults the mouse button to left and accepts on-screen coordinates', () => {
    expect(parseOp({ op: 'click', x: 0, y: 799 })).toEqual({
      op: 'click',
      x: 0,
      y: 799,
      button: 'left',
    });
  });

  it.each([
    [{ op: 'click', x: 1280, y: 0 }, /x must be within 0..1279/],
    [{ op: 'click', x: 10, y: 800 }, /y must be within 0..799/],
    [{ op: 'click', x: 1.5, y: 0 }, /x must be an integer/],
    [{ op: 'click', x: 1, y: 1, button: 'back' }, /button/],
    [{ op: 'type', text: '' }, /non-empty/],
    [{ op: 'key', combo: 'ctrl+l; rm -rf /' }, /combo/],
    [{ op: 'key', combo: '--window 1 Return' }, /combo/],
    [{ op: 'scroll', x: 1, y: 1, direction: 'sideways' }, /direction/],
    [{ op: 'wait', ms: 60_000 }, /ms must be/],
    [{ op: 'exec', command: '  ' }, /command/],
    [{ op: 'exec', command: 'ls', cwd: 'relative' }, /absolute/],
    [{ op: 'exec', command: 'ls', timeoutMs: 0 }, /timeoutMs/],
    [{ op: 'nope' }, /unknown op/],
    [[], /JSON object/],
  ])('rejects %j', (body, message) => {
    expect(() => parseOp(body)).toThrow(OpValidationError);
    expect(() => parseOp(body)).toThrow(message);
  });

  it('honours a custom screen size', () => {
    expect(parseOp({ op: 'click', x: 1500, y: 10 }, { width: 1920, height: 1080 })).toMatchObject({
      x: 1500,
    });
  });

  it('fills exec and scroll defaults', () => {
    expect(parseOp({ op: 'exec', command: 'ls' })).toEqual({
      op: 'exec',
      command: 'ls',
      timeoutMs: 60_000,
    });
    expect(parseOp({ op: 'scroll', x: 5, y: 5, direction: 'down' })).toMatchObject({ amount: 3 });
  });
});

describe('xdotoolArgs', () => {
  it('builds argv without a shell, keeping typed text as one argument after --', () => {
    expect(xdotoolArgs({ op: 'type', text: '$(touch /tmp/x) --help' })).toEqual([
      'type',
      '--delay',
      '12',
      '--',
      '$(touch /tmp/x) --help',
    ]);
  });

  it('maps buttons and scroll directions to X button codes', () => {
    expect(xdotoolArgs({ op: 'click', x: 3, y: 4, button: 'right' })).toEqual([
      'mousemove',
      '3',
      '4',
      'click',
      '3',
    ]);
    expect(xdotoolArgs({ op: 'scroll', x: 1, y: 2, direction: 'up', amount: 2 })).toEqual([
      'mousemove',
      '1',
      '2',
      'click',
      '--repeat',
      '2',
      '--delay',
      '30',
      '4',
    ]);
  });

  it('splits a key sequence into separate keysyms', () => {
    expect(xdotoolArgs({ op: 'key', combo: 'ctrl+l Return' })).toEqual([
      'key',
      '--delay',
      '50',
      '--',
      'ctrl+l',
      'Return',
    ]);
  });

  it('drags with press, move, release', () => {
    expect(xdotoolArgs({ op: 'drag', x: 1, y: 2, toX: 3, toY: 4, button: 'left' }).join(' ')).toBe(
      'mousemove 1 2 mousedown 1 mousemove 3 4 mouseup 1',
    );
  });
});

describe('inputTimeoutMs', () => {
  // Regression: a fixed 15s deadline killed any `type` over ~1,250 chars
  // (12 ms per keystroke) midway, leaving partial text in the focused app.
  it('gives the longest accepted type request more time than xdotool needs', () => {
    const op = parseOp({ op: 'type', text: 'a'.repeat(10_000) });
    if (op.op !== 'type') throw new Error('expected type op');
    const delayIdx = xdotoolArgs(op).indexOf('--delay');
    const perKeyMs = Number(xdotoolArgs(op)[delayIdx + 1]);
    const scheduledMs = op.text.length * perKeyMs;
    expect(inputTimeoutMs(op)).toBeGreaterThanOrEqual(scheduledMs * 1.5);
  });

  it('counts code points, not UTF-16 units, and scales key sequences and scrolls', () => {
    expect(inputTimeoutMs({ op: 'type', text: '😀'.repeat(100) })).toBe(15_000 + 100 * 24);
    expect(inputTimeoutMs({ op: 'key', combo: 'a b c' })).toBe(15_000 + 3 * 100);
    expect(
      inputTimeoutMs({ op: 'scroll', x: 0, y: 0, direction: 'down', amount: 50 }),
    ).toBeGreaterThan(15_000);
    expect(inputTimeoutMs({ op: 'click', x: 0, y: 0, button: 'left' })).toBe(15_000);
  });
});

describe('helpers', () => {
  it('parses getmouselocation --shell output', () => {
    expect(parseMouseLocation('X=640\nY=400\nSCREEN=0\nWINDOW=123\n')).toEqual({ x: 640, y: 400 });
    expect(() => parseMouseLocation('garbage')).toThrow(/unexpected/);
  });

  it('checks the bearer token', () => {
    expect(isAuthorized('Bearer secret', 'secret')).toBe(true);
    expect(isAuthorized('Bearer secrex', 'secret')).toBe(false);
    expect(isAuthorized('Bearer secret2', 'secret')).toBe(false);
    expect(isAuthorized('secret', 'secret')).toBe(false);
    expect(isAuthorized(undefined, 'secret')).toBe(false);
  });

  it('reads the screen size from env with a 1280x800 default', () => {
    expect(screenFromEnv({})).toEqual({ width: 1280, height: 800 });
    expect(screenFromEnv({ DESKTOP_WIDTH: '1920', DESKTOP_HEIGHT: 'x' })).toEqual({
      width: 1920,
      height: 800,
    });
  });
});

describe('runCommand', () => {
  it('captures output and exit code', async () => {
    const r = await runCommand('bash', ['-c', 'echo out; echo err >&2; exit 3'], {
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('kills the process group on timeout', async () => {
    const started = Date.now();
    const r = await runCommand('bash', ['-c', 'sleep 20 & sleep 20'], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('returns promptly when the command leaves a background job holding stdout', async () => {
    const started = Date.now();
    const r = await runCommand('bash', ['-c', 'sleep 20 & echo launched'], { timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'launched\n' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('caps output', async () => {
    const r = await runCommand('bash', ['-c', 'head -c 5000 /dev/zero'], {
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    expect(r.stdout.length).toBe(100);
    expect(r.truncated).toBe(true);
  });
});

describe('control server', () => {
  let server: Server;
  let base: string;
  const backend: DesktopBackend = {
    screenshot: vi.fn(async () => Buffer.from('png-bytes')),
    input: vi.fn(async () => {}),
    cursorPosition: vi.fn(async () => ({ x: 7, y: 9 })),
    exec: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: 'hi\n',
      stderr: '',
      timedOut: false,
      truncated: false,
    })),
  };

  beforeAll(async () => {
    server = createControlServer({ token: 't0ken', backend, display: ':99' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const op = (body: unknown, token = 't0ken') =>
    fetch(`${base}/v1/op`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('refuses to start without a token', () => {
    expect(() => createControlServer({ token: '', backend })).toThrow(/TOKEN/);
  });

  it('serves an unauthenticated healthz', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toEqual({ ok: true, display: ':99', width: 1280, height: 800 });
  });

  it('rejects a wrong token before touching the backend', async () => {
    const res = await op({ op: 'exec', command: 'id' }, 'wrong');
    expect(res.status).toBe(401);
    expect(backend.exec).not.toHaveBeenCalled();
  });

  it('returns screenshots as base64 PNG with the screen size', async () => {
    const res = await op({ op: 'screenshot' });
    expect(await res.json()).toEqual({
      ok: true,
      width: 1280,
      height: 800,
      png: Buffer.from('png-bytes').toString('base64'),
    });
  });

  it('routes input ops through xdotool argv', async () => {
    const res = await op({ op: 'click', x: 10, y: 20, button: 'middle' });
    expect(res.status).toBe(200);
    expect(backend.input).toHaveBeenCalledWith(['mousemove', '10', '20', 'click', '2'], 15_000);
  });

  it('passes a length-scaled deadline for long type requests', async () => {
    const text = 'x'.repeat(5_000);
    expect((await op({ op: 'type', text })).status).toBe(200);
    expect(backend.input).toHaveBeenLastCalledWith(
      ['type', '--delay', '12', '--', text],
      15_000 + 5_000 * 24,
    );
  });

  it('runs exec and cursor_position', async () => {
    expect(await (await op({ op: 'exec', command: 'echo hi', cwd: '/tmp' })).json()).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: 'hi\n',
    });
    expect(backend.exec).toHaveBeenCalledWith('echo hi', 60_000, '/tmp');
    expect(await (await op({ op: 'cursor_position' })).json()).toEqual({ ok: true, x: 7, y: 9 });
  });

  it('answers 400 for bad input and 500 for backend failures', async () => {
    expect((await op('{not json')).status).toBe(400);
    expect((await op({ op: 'click', x: -1, y: 0 })).status).toBe(400);
    vi.mocked(backend.screenshot).mockRejectedValueOnce(new Error('scrot failed: no display'));
    const res = await op({ op: 'screenshot' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'scrot failed: no display' });
  });
});

describe('desktop image', () => {
  const dockerfile = readFileSync(join(__dirname, 'image', 'Dockerfile'), 'utf8');

  it('runs as an unprivileged user with the control daemon and no docker', () => {
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe('desktop');
    expect(dockerfile).not.toMatch(/docker\.sock|docker-ce|docker\.io/);
    // Desktop packages come from the installer shared with the Firecracker
    // guest; desktop-guest-image.test.ts covers its contents.
    expect(dockerfile).toContain('install-desktop.sh --target container');
    expect(dockerfile).toContain('DESKTOP_WIDTH=1280');
    expect(dockerfile).toContain('DESKTOP_HEIGHT=800');
    expect(dockerfile).toContain('COPY server/desktop/control-daemon.ts');
  });

  it('keeps the daemon runnable by Node type stripping: node: builtins only', () => {
    const source = readFileSync(join(__dirname, 'control-daemon.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^import[^'"]*from '([^']+)';/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s).toMatch(/^node:/);
    expect(source).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
  });
});
