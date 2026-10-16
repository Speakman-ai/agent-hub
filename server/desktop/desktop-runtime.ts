/**
 * DesktopRuntime: the seam between the `computer` tool and whatever actually
 * hosts the agent's Linux desktop. Two backends implement it (a container
 * and a Firecracker microVM); callers never branch on which one is active.
 *
 * One long-lived computer exists per (user, agent, project), not per
 * session. Its home directory lives on persistent storage, so stopping the
 * computer (idle or explicit) keeps files and logins; the next
 * `ensureStarted` resumes it.
 */

export type DesktopRuntimeKind = 'container' | 'firecracker';
export type DesktopRuntimeMode = 'auto' | DesktopRuntimeKind;

export const DESKTOP_RUNTIME_MODES: readonly DesktopRuntimeMode[] = [
  'auto',
  'container',
  'firecracker',
];

/** Both backends render the same fixed screen so coordinates mean the same thing. */
export const DESKTOP_SCREEN = { width: 1280, height: 800 } as const;

/** Stop a computer after this long without a tool call. */
export const DESKTOP_IDLE_STOP_MS = 30 * 60 * 1000;

/** X display inside the computer; matches the desktop container image (DISPLAY=:99). */
export const DESKTOP_DISPLAY = ':99';

/** VNC port of the desktop display inside the computer. */
export const DESKTOP_VNC_PORT = 5900;

/** Identity of one persistent computer. */
export interface DesktopComputerKey {
  userId: string;
  agentId: string;
  projectId: string;
}

export type DesktopComputerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface DesktopComputerStatus {
  kind: DesktopRuntimeKind;
  state: DesktopComputerState;
  /** Epoch ms of the last tool call, or null when never used. */
  lastActiveAt: number | null;
  /** Operator-facing explanation when `state` is `error`. */
  error?: string;
}

export interface DesktopExecOptions {
  /** Kill the command after this many ms. */
  timeoutMs?: number;
  cwd?: string;
}

export interface DesktopExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type DesktopMouseButton = 'left' | 'middle' | 'right';

/** Input events, in screen coordinates (origin top-left, see DESKTOP_SCREEN). */
export type DesktopInputEvent =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: DesktopMouseButton }
  | { type: 'double_click'; x: number; y: number; button?: DesktopMouseButton }
  | { type: 'type'; text: string }
  /** xdotool-style combo, e.g. `ctrl+l` or `Return`. */
  | { type: 'key'; combo: string }
  | {
      type: 'scroll';
      x: number;
      y: number;
      direction: 'up' | 'down' | 'left' | 'right';
      amount?: number;
    }
  | { type: 'drag'; fromX: number; fromY: number; toX: number; toY: number };

/** Where a live-view client can reach the computer's display (VNC). */
export interface DesktopDisplayEndpoint {
  host: string;
  port: number;
}

export interface DesktopRuntime {
  readonly kind: DesktopRuntimeKind;
  /** Boot or resume the computer; resolves once input and screenshots work. */
  ensureStarted(key: DesktopComputerKey): Promise<DesktopComputerStatus>;
  /** Stop the computer. Persistent storage is kept. No-op when already stopped. */
  stop(key: DesktopComputerKey): Promise<void>;
  /**
   * Stop the computer and delete its persistent storage. Only called when the
   * owning profile is deleted. No-op when the computer never existed.
   */
  destroy(key: DesktopComputerKey): Promise<void>;
  /** Run a shell command inside the computer as the desktop user. */
  exec(
    key: DesktopComputerKey,
    command: string,
    opts?: DesktopExecOptions,
  ): Promise<DesktopExecResult>;
  /** PNG of the full DESKTOP_SCREEN. */
  screenshot(key: DesktopComputerKey): Promise<Buffer>;
  /**
   * PNG for the live view: null when the computer is not running. Never
   * starts the computer and does not count as activity, so a pane left open
   * can't keep an idle desktop alive.
   */
  viewFrame(key: DesktopComputerKey): Promise<Buffer | null>;
  input(key: DesktopComputerKey, event: DesktopInputEvent): Promise<void>;
  /** Expose the display to the Hub for the live view. */
  mapDisplayPort(key: DesktopComputerKey): Promise<DesktopDisplayEndpoint>;
  status(key: DesktopComputerKey): Promise<DesktopComputerStatus>;
}

export function coerceDesktopRuntimeMode(raw: unknown): DesktopRuntimeMode {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  return (DESKTOP_RUNTIME_MODES as readonly string[]).includes(v)
    ? (v as DesktopRuntimeMode)
    : 'auto';
}
