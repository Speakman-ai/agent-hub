/**
 * Hub-side client for the control daemon inside a desktop container (see
 * control-daemon.ts for the protocol). Maps the DesktopRuntime input events
 * onto daemon ops.
 */
import type {
  DesktopDisplayEndpoint,
  DesktopExecOptions,
  DesktopExecResult,
  DesktopInputEvent,
} from './desktop-runtime.js';

export const DESKTOP_CONTROL_PORT = 7300;

const DEFAULT_OP_TIMEOUT_MS = 60_000;
/** Slack on top of an exec's own deadline for the HTTP round trip. */
const EXEC_SLACK_MS = 15_000;

/** The daemon answered and refused the op (bad operands, xdotool failure). */
export class DesktopOpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DesktopOpError';
    this.status = status;
  }
}

/** The daemon could not be reached at all (container stopped, network). */
export class DesktopUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopUnreachableError';
  }
}

export interface DesktopControlClient {
  healthy(endpoint: DesktopDisplayEndpoint): Promise<boolean>;
  op(
    endpoint: DesktopDisplayEndpoint,
    token: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

function baseUrl(e: DesktopDisplayEndpoint): string {
  const host = e.host.includes(':') ? `[${e.host}]` : e.host;
  return `http://${host}:${e.port}`;
}

export function createDesktopControlClient(
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): DesktopControlClient {
  return {
    async healthy(endpoint) {
      try {
        const res = await fetchImpl(`${baseUrl(endpoint)}/healthz`, {
          signal: AbortSignal.timeout(3_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    async op(endpoint, token, body, timeoutMs = DEFAULT_OP_TIMEOUT_MS) {
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl(endpoint)}/v1/op`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DesktopUnreachableError(
          `desktop control daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = (await res.json()) as Record<string, unknown>;
      } catch {
        throw new DesktopOpError(`desktop control daemon sent a non-JSON reply`, res.status);
      }
      if (!res.ok || parsed.ok !== true) {
        throw new DesktopOpError(
          typeof parsed.error === 'string' ? parsed.error : `desktop op failed (${res.status})`,
          res.status,
        );
      }
      return parsed;
    },
  };
}

/** Daemon request body (and HTTP deadline) for one input event. */
export function inputEventToOp(event: DesktopInputEvent): {
  body: Record<string, unknown>;
  timeoutMs?: number;
} {
  switch (event.type) {
    case 'move':
      // The daemon has no move op; xdotool via exec with integer operands only.
      if (!Number.isInteger(event.x) || !Number.isInteger(event.y)) {
        throw new DesktopOpError('x and y must be integers', 400);
      }
      return {
        body: {
          op: 'exec',
          command: `xdotool mousemove --sync ${event.x} ${event.y}`,
          timeoutMs: 10_000,
        },
      };
    case 'click':
    case 'double_click':
      return {
        body: { op: event.type, x: event.x, y: event.y, button: event.button ?? 'left' },
      };
    case 'type':
      // The daemon stretches its own deadline with text length; match it.
      return { body: { op: 'type', text: event.text }, timeoutMs: 60_000 + event.text.length * 30 };
    case 'key':
      return { body: { op: 'key', combo: event.combo } };
    case 'scroll':
      return {
        body: {
          op: 'scroll',
          x: event.x,
          y: event.y,
          direction: event.direction,
          ...(event.amount !== undefined ? { amount: event.amount } : {}),
        },
      };
    case 'drag':
      return {
        body: { op: 'drag', x: event.fromX, y: event.fromY, toX: event.toX, toY: event.toY },
      };
  }
}

export function execOp(
  command: string,
  opts: DesktopExecOptions = {},
): { body: Record<string, unknown>; timeoutMs: number } {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    body: { op: 'exec', command, timeoutMs, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
    timeoutMs: timeoutMs + EXEC_SLACK_MS,
  };
}

export function parseExecReply(reply: Record<string, unknown>): DesktopExecResult {
  return {
    exitCode: typeof reply.exitCode === 'number' ? reply.exitCode : -1,
    stdout: typeof reply.stdout === 'string' ? reply.stdout : '',
    stderr: typeof reply.stderr === 'string' ? reply.stderr : '',
    timedOut: reply.timedOut === true,
  };
}

export function parseScreenshotReply(reply: Record<string, unknown>): Buffer {
  if (typeof reply.png !== 'string' || !reply.png) {
    throw new DesktopOpError('desktop screenshot reply carried no image', 502);
  }
  return Buffer.from(reply.png, 'base64');
}
