/**
 * Shell commands that drive the desktop from inside a computer reached over
 * `exec` (the Firecracker backend). Validation and xdotool argv come from the
 * container's control daemon, so both backends accept and reject exactly the
 * same input.
 */
import {
  OpValidationError,
  inputTimeoutMs,
  parseOp,
  xdotoolArgs,
  type DesktopOp,
} from './control-daemon.js';
import { DESKTOP_DISPLAY, DESKTOP_SCREEN, type DesktopInputEvent } from './desktop-runtime.js';

export class DesktopInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopInputError';
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type InputOp = Parameters<typeof xdotoolArgs>[0];

function toOp(event: DesktopInputEvent): Record<string, unknown> {
  switch (event.type) {
    case 'drag':
      return { op: 'drag', x: event.fromX, y: event.fromY, toX: event.toX, toY: event.toY };
    case 'move':
      // The daemon has no bare move; validate the point as a click would.
      return { op: 'click', x: event.x, y: event.y };
    default: {
      const { type, ...rest } = event;
      return { op: type, ...rest };
    }
  }
}

function parse(event: DesktopInputEvent): DesktopOp {
  try {
    return parseOp(toOp(event), DESKTOP_SCREEN);
  } catch (err) {
    if (err instanceof OpValidationError) throw new DesktopInputError(err.message);
    throw err;
  }
}

export interface DesktopShellCommand {
  command: string;
  timeoutMs: number;
}

/** One shell command that performs `event` on the desktop, plus its deadline. */
export function buildDesktopInputCommand(event: DesktopInputEvent): DesktopShellCommand {
  const op = parse(event) as InputOp;
  const args =
    event.type === 'move' ? ['mousemove', String(event.x), String(event.y)] : xdotoolArgs(op);
  return {
    command: `DISPLAY=${DESKTOP_DISPLAY} xdotool ${args.map(shellQuote).join(' ')}`,
    timeoutMs: inputTimeoutMs(op),
  };
}

/**
 * Capture the full screen as base64 PNG on stdout. Written through a unique
 * temp file, removed on exit, so screenshots never pile up in the computer.
 */
export function buildDesktopScreenshotCommand(tag: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(tag)) throw new DesktopInputError(`invalid screenshot tag: ${tag}`);
  const file = `/tmp/ah-desktop-shot-${tag}.png`;
  return (
    `trap 'rm -f ${file}' EXIT; ` +
    `DISPLAY=${DESKTOP_DISPLAY} scrot --overwrite --silent ${file} && base64 -w0 ${file}`
  );
}
