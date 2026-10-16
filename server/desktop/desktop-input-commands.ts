/**
 * xdotool argv for DesktopRuntime input events, outside the container's
 * control daemon. The Firecracker backend validates with it on the Hub before
 * booting, and the guest vm-agent validates again and runs it. Validation and
 * argv come from the control daemon, so both backends accept and reject
 * exactly the same input.
 *
 * Imported by the guest bundle: keep it free of Hub-only dependencies.
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

export interface DesktopInputArgv {
  /** xdotool arguments; never passed through a shell. */
  args: string[];
  timeoutMs: number;
}

/** Validate `event` (throws DesktopInputError) and build the xdotool argv for it. */
export function desktopInputArgv(event: DesktopInputEvent): DesktopInputArgv {
  const op = parse(event) as InputOp;
  return {
    args: event.type === 'move' ? ['mousemove', String(event.x), String(event.y)] : xdotoolArgs(op),
    timeoutMs: inputTimeoutMs(op),
  };
}

/** Same as {@link desktopInputArgv}, as one shell command line. */
export function buildDesktopInputCommand(event: DesktopInputEvent): {
  command: string;
  timeoutMs: number;
} {
  const { args, timeoutMs } = desktopInputArgv(event);
  return {
    command: `DISPLAY=${DESKTOP_DISPLAY} xdotool ${args.map(shellQuote).join(' ')}`,
    timeoutMs,
  };
}
