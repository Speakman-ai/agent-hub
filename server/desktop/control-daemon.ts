/**
 * Control daemon that runs inside the desktop container (SPEC-5 container
 * backend). It is the container's whole control plane: screenshots via scrot,
 * input via xdotool, and shell commands via bash, all against the Xvfb
 * display the entrypoint started.
 *
 * Protocol: HTTP/1.1 + JSON on DESKTOP_CONTROL_PORT (default 7300).
 *   GET  /healthz       unauthenticated liveness: { ok, display, width, height }
 *   POST /v1/op         { op, ...operands } -> { ok: true, ... } | { ok: false, error }
 * Every /v1 request needs `Authorization: Bearer <DESKTOP_CONTROL_TOKEN>`. The
 * daemon refuses to start without a token: the host publishes the port, so an
 * unauthenticated daemon would hand a shell to anything that can reach it.
 *
 * The op set mirrors the SPEC-6 computer tool (screenshot, click, double_click,
 * type, key, scroll, drag, wait, cursor_position, exec) so the host can map
 * tool calls 1:1 without translating.
 *
 * The image runs this file directly with Node's built-in type stripping, so it
 * must stay a single file that imports only `node:` builtins and uses
 * erasable TypeScript syntax (no enums, no parameter properties).
 */

import { spawn } from 'node:child_process';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CONTROL_PORT = 7300;
export const DEFAULT_SCREEN = { width: 1280, height: 800 } as const;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TYPE_CHARS = 10_000;
const MAX_WAIT_MS = 30_000;
const MAX_SCROLL_CLICKS = 50;
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const MAX_EXEC_TIMEOUT_MS = 10 * 60_000;
export const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;
const INPUT_TIMEOUT_MS = 15_000;
const TYPE_DELAY_MS = 12;
const KEY_DELAY_MS = 50;
const SCROLL_DELAY_MS = 30;
const EXIT_DRAIN_MS = 250;

export interface Screen {
  width: number;
  height: number;
}

export type MouseButton = 'left' | 'middle' | 'right';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export type DesktopOp =
  | { op: 'screenshot' }
  | { op: 'click'; x: number; y: number; button: MouseButton }
  | { op: 'double_click'; x: number; y: number; button: MouseButton }
  | { op: 'type'; text: string }
  | { op: 'key'; combo: string }
  | { op: 'scroll'; x: number; y: number; direction: ScrollDirection; amount: number }
  | { op: 'drag'; x: number; y: number; toX: number; toY: number; button: MouseButton }
  | { op: 'wait'; ms: number }
  | { op: 'cursor_position' }
  | { op: 'exec'; command: string; timeoutMs: number; cwd?: string };

export class OpValidationError extends Error {}

const BUTTON_CODES: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };
const SCROLL_CODES: Record<ScrollDirection, string> = {
  up: '4',
  down: '5',
  left: '6',
  right: '7',
};

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OpValidationError('request body must be a JSON object');
  }
  return input as Record<string, unknown>;
}

function coord(raw: unknown, name: string, max: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new OpValidationError(`${name} must be an integer`);
  }
  if (raw < 0 || raw >= max) {
    throw new OpValidationError(`${name} must be within 0..${max - 1}`);
  }
  return raw;
}

function button(raw: unknown): MouseButton {
  if (raw === undefined) return 'left';
  if (raw === 'left' || raw === 'middle' || raw === 'right') return raw;
  throw new OpValidationError('button must be left, middle or right');
}

function boundedInt(raw: unknown, name: string, fallback: number, min: number, max: number) {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new OpValidationError(`${name} must be an integer within ${min}..${max}`);
  }
  return raw;
}

// xdotool keysym names: letters, digits, underscores, joined with `+` for
// chords and spaces for a sequence ("ctrl+l Return"). Anything else is refused
// so the combo can never smuggle a second xdotool command.
const KEY_COMBO_RE = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*( [A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*)*$/;

/** Validate an untrusted request body into a typed op. Throws OpValidationError. */
export function parseOp(input: unknown, screen: Screen = DEFAULT_SCREEN): DesktopOp {
  const body = asRecord(input);
  const x = () => coord(body.x, 'x', screen.width);
  const y = () => coord(body.y, 'y', screen.height);
  switch (body.op) {
    case 'screenshot':
    case 'cursor_position':
      return { op: body.op };
    case 'click':
    case 'double_click':
      return { op: body.op, x: x(), y: y(), button: button(body.button) };
    case 'type': {
      if (typeof body.text !== 'string' || body.text.length === 0) {
        throw new OpValidationError('text must be a non-empty string');
      }
      if (body.text.length > MAX_TYPE_CHARS) {
        throw new OpValidationError(`text must be at most ${MAX_TYPE_CHARS} characters`);
      }
      return { op: 'type', text: body.text };
    }
    case 'key': {
      if (typeof body.combo !== 'string' || !KEY_COMBO_RE.test(body.combo)) {
        throw new OpValidationError('combo must be xdotool key names like "ctrl+l" or "Return"');
      }
      return { op: 'key', combo: body.combo };
    }
    case 'scroll': {
      const direction = body.direction;
      if (
        direction !== 'up' &&
        direction !== 'down' &&
        direction !== 'left' &&
        direction !== 'right'
      ) {
        throw new OpValidationError('direction must be up, down, left or right');
      }
      return {
        op: 'scroll',
        x: x(),
        y: y(),
        direction,
        amount: boundedInt(body.amount, 'amount', 3, 1, MAX_SCROLL_CLICKS),
      };
    }
    case 'drag':
      return {
        op: 'drag',
        x: x(),
        y: y(),
        toX: coord(body.toX, 'toX', screen.width),
        toY: coord(body.toY, 'toY', screen.height),
        button: button(body.button),
      };
    case 'wait':
      return { op: 'wait', ms: boundedInt(body.ms, 'ms', 1000, 0, MAX_WAIT_MS) };
    case 'exec': {
      if (typeof body.command !== 'string' || body.command.trim() === '') {
        throw new OpValidationError('command must be a non-empty string');
      }
      if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.startsWith('/'))) {
        throw new OpValidationError('cwd must be an absolute path');
      }
      return {
        op: 'exec',
        command: body.command,
        timeoutMs: boundedInt(
          body.timeoutMs,
          'timeoutMs',
          DEFAULT_EXEC_TIMEOUT_MS,
          1,
          MAX_EXEC_TIMEOUT_MS,
        ),
        ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
      };
    }
    default:
      throw new OpValidationError(`unknown op: ${String(body.op)}`);
  }
}

type InputOp = Extract<
  DesktopOp,
  { op: 'click' | 'double_click' | 'type' | 'key' | 'scroll' | 'drag' }
>;

/** xdotool argv for an input op. Exported for tests; never goes through a shell. */
export function xdotoolArgs(op: InputOp): string[] {
  switch (op.op) {
    case 'click':
      return ['mousemove', String(op.x), String(op.y), 'click', BUTTON_CODES[op.button]];
    case 'double_click':
      return [
        'mousemove',
        String(op.x),
        String(op.y),
        'click',
        '--repeat',
        '2',
        '--delay',
        '100',
        BUTTON_CODES[op.button],
      ];
    case 'type':
      return ['type', '--delay', String(TYPE_DELAY_MS), '--', op.text];
    case 'key':
      return ['key', '--delay', String(KEY_DELAY_MS), '--', ...op.combo.split(' ')];
    case 'scroll':
      return [
        'mousemove',
        String(op.x),
        String(op.y),
        'click',
        '--repeat',
        String(op.amount),
        '--delay',
        String(SCROLL_DELAY_MS),
        SCROLL_CODES[op.direction],
      ];
    case 'drag':
      return [
        'mousemove',
        String(op.x),
        String(op.y),
        'mousedown',
        BUTTON_CODES[op.button],
        'mousemove',
        String(op.toX),
        String(op.toY),
        'mouseup',
        BUTTON_CODES[op.button],
      ];
  }
}

/**
 * Deadline for one input op. xdotool sleeps its --delay between every
 * keystroke or click, so a fixed deadline would kill a long `type` halfway and
 * leave partial text in the focused app. Budget twice the scheduled delay on
 * top of the fixed allowance for process start and X round-trips.
 */
export function inputTimeoutMs(op: InputOp): number {
  switch (op.op) {
    case 'type':
      return INPUT_TIMEOUT_MS + Array.from(op.text).length * TYPE_DELAY_MS * 2;
    case 'key':
      return INPUT_TIMEOUT_MS + op.combo.split(' ').length * KEY_DELAY_MS * 2;
    case 'scroll':
      return INPUT_TIMEOUT_MS + op.amount * SCROLL_DELAY_MS * 2;
    default:
      return INPUT_TIMEOUT_MS;
  }
}

/** Parse `xdotool getmouselocation --shell` output. */
export function parseMouseLocation(stdout: string): { x: number; y: number } {
  const x = /^X=(\d+)$/m.exec(stdout);
  const y = /^Y=(\d+)$/m.exec(stdout);
  if (!x || !y) throw new Error(`unexpected getmouselocation output: ${stdout.trim()}`);
  return { x: Number(x[1]), y: Number(y[1]) };
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

/**
 * Spawn without a shell, capture capped output, and kill the whole process
 * group on timeout so a backgrounded grandchild cannot outlive the deadline
 * while holding the pipes open.
 */
export function runCommand(file: string, args: string[], opts: RunOptions): Promise<ExecResult> {
  const cap = opts.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let used = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (which: 'out' | 'err', chunk: Buffer) => {
      const room = cap - used;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.subarray(0, room).toString('utf8');
      if (chunk.length > room) truncated = true;
      used += Math.min(chunk.length, room);
      if (which === 'out') stdout += text;
      else stderr += text;
    };
    child.stdout.on('data', (c: Buffer) => append('out', c));
    child.stderr.on('data', (c: Buffer) => append('err', c));
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const finish = (exitCode: number | null, signal: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) stderr += (stderr ? '\n' : '') + error.message;
      resolve({ exitCode, signal, stdout, stderr, timedOut, truncated });
    };
    child.on('error', (err) => finish(null, null, err));
    // Background jobs (`chromium &`) are intentional, so only the timeout
    // path kills the group. They also inherit the stdout/stderr pipes, which
    // means 'close' would wait for them; resolve shortly after the shell
    // itself exits and stop reading the pipes instead.
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, EXIT_DRAIN_MS).unref();
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

export interface DesktopBackend {
  screenshot(): Promise<Buffer>;
  input(args: string[], timeoutMs: number): Promise<void>;
  cursorPosition(): Promise<{ x: number; y: number }>;
  exec(command: string, timeoutMs: number, cwd?: string): Promise<ExecResult>;
}

/** Real backend: scrot, xdotool and bash against the container's display. */
export function createX11Backend(env: NodeJS.ProcessEnv = process.env): DesktopBackend {
  const home = env.HOME || '/home/desktop';
  const failIfBad = (what: string, r: ExecResult) => {
    if (r.exitCode !== 0) {
      const detail = r.timedOut ? 'timed out' : r.stderr.trim() || `exit ${r.exitCode}`;
      throw new Error(`${what} failed: ${detail}`);
    }
  };
  return {
    async screenshot() {
      const file = join(tmpdir(), `desktop-shot-${randomUUID()}.png`);
      try {
        const r = await runCommand('scrot', ['--overwrite', '--silent', file], {
          timeoutMs: INPUT_TIMEOUT_MS,
          env,
        });
        failIfBad('scrot', r);
        return await readFile(file);
      } finally {
        await unlink(file).catch(() => {});
      }
    },
    async input(args, timeoutMs) {
      failIfBad('xdotool', await runCommand('xdotool', args, { timeoutMs, env }));
    },
    async cursorPosition() {
      const r = await runCommand('xdotool', ['getmouselocation', '--shell'], {
        timeoutMs: INPUT_TIMEOUT_MS,
        env,
      });
      failIfBad('xdotool getmouselocation', r);
      return parseMouseLocation(r.stdout);
    },
    exec(command, timeoutMs, cwd) {
      return runCommand('bash', ['-lc', command], { timeoutMs, cwd: cwd ?? home, env });
    },
  };
}

/** Run one validated op against a backend and build the JSON reply body. */
export async function executeOp(
  op: DesktopOp,
  backend: DesktopBackend,
  screen: Screen = DEFAULT_SCREEN,
): Promise<Record<string, unknown>> {
  switch (op.op) {
    case 'screenshot': {
      const png = await backend.screenshot();
      return { ok: true, width: screen.width, height: screen.height, png: png.toString('base64') };
    }
    case 'cursor_position':
      return { ok: true, ...(await backend.cursorPosition()) };
    case 'wait':
      await new Promise((r) => setTimeout(r, op.ms));
      return { ok: true };
    case 'exec':
      return { ok: true, ...(await backend.exec(op.command, op.timeoutMs, op.cwd)) };
    default:
      await backend.input(xdotoolArgs(op), inputTimeoutMs(op));
      return { ok: true };
  }
}

/** Constant-time bearer check. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new OpValidationError('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface ControlServerOptions {
  token: string;
  backend: DesktopBackend;
  screen?: Screen;
  display?: string;
}

export function createControlServer(opts: ControlServerOptions): Server {
  if (!opts.token) throw new Error('DESKTOP_CONTROL_TOKEN is required');
  const screen = opts.screen ?? DEFAULT_SCREEN;
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        send(res, 200, { ok: true, display: opts.display ?? null, ...screen });
        return;
      }
      if (req.url !== '/v1/op') {
        send(res, 404, { ok: false, error: 'not found' });
        return;
      }
      if (!isAuthorized(req.headers.authorization, opts.token)) {
        send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch (err) {
        if (err instanceof OpValidationError) throw err;
        throw new OpValidationError('request body must be valid JSON');
      }
      const op = parseOp(parsed, screen);
      send(res, 200, await executeOp(op, opts.backend, screen));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(res, err instanceof OpValidationError ? 400 : 500, { ok: false, error: message });
    }
  });
}

export function screenFromEnv(env: NodeJS.ProcessEnv): Screen {
  const w = Number(env.DESKTOP_WIDTH);
  const h = Number(env.DESKTOP_HEIGHT);
  return {
    width: Number.isInteger(w) && w > 0 ? w : DEFAULT_SCREEN.width,
    height: Number.isInteger(h) && h > 0 ? h : DEFAULT_SCREEN.height,
  };
}

function main(): void {
  const token = process.env.DESKTOP_CONTROL_TOKEN ?? '';
  if (!token) {
    console.error('desktop-control: DESKTOP_CONTROL_TOKEN is not set; refusing to start');
    process.exit(2);
  }
  const port = Number(process.env.DESKTOP_CONTROL_PORT) || DEFAULT_CONTROL_PORT;
  // The token was only needed to start the server. Keep it out of the env that
  // `exec` hands to agent commands so a shell cannot read it back.
  const childEnv = { ...process.env };
  delete childEnv.DESKTOP_CONTROL_TOKEN;
  const server = createControlServer({
    token,
    backend: createX11Backend(childEnv),
    screen: screenFromEnv(process.env),
    display: process.env.DISPLAY,
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`desktop-control: listening on :${port} (DISPLAY=${process.env.DISPLAY})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * Whether this module is the process entry point. The guest vm-agent bundles
 * this file (for parseOp and runCommand), and inside a bundle `import.meta.url`
 * is the bundle's own URL, so the URL match alone would start a second daemon
 * in the vm-agent. The file name has to say control-daemon too.
 */
export function isControlDaemonEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1 || moduleUrl !== pathToFileURL(argv1).href) return false;
  return /(^|\/)control-daemon\.[cm]?[jt]s$/.test(argv1);
}

if (isControlDaemonEntry(process.argv[1], import.meta.url)) {
  main();
}
