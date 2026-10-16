import type {
  DesktopComputerState,
  DesktopInputEvent,
  DesktopRuntime,
} from '../desktop/desktop-runtime.js';

/** In-memory DesktopRuntime for live-view tests. Records what was called. */
export interface FakeDesktopRuntime extends DesktopRuntime {
  state: DesktopComputerState;
  png: Buffer;
  inputs: DesktopInputEvent[];
  /** Input calls entered (counted before `inputDelay` is awaited). */
  inputCalls: number;
  viewFrames: number;
  /** Calls that would start or wake the computer (must stay 0 for viewers). */
  wakeCalls: number;
  inputDelay: Promise<void> | null;
  execDelay: Promise<void> | null;
  /** viewFrame yields nothing while the computer still runs (mid lifecycle transition). */
  captureBusy: boolean;
}

export function createFakeDesktopRuntime(): FakeDesktopRuntime {
  const rt: FakeDesktopRuntime = {
    kind: 'container',
    state: 'stopped',
    png: Buffer.from('PNG-1'),
    inputs: [],
    inputCalls: 0,
    viewFrames: 0,
    wakeCalls: 0,
    inputDelay: null,
    execDelay: null,
    captureBusy: false,
    async ensureStarted() {
      rt.wakeCalls += 1;
      rt.state = 'running';
      return { kind: 'container', state: 'running', lastActiveAt: null };
    },
    async stop() {
      rt.state = 'stopped';
    },
    async destroy() {
      rt.state = 'stopped';
    },
    async exec() {
      rt.wakeCalls += 1;
      if (rt.execDelay) await rt.execDelay;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    async screenshot() {
      rt.wakeCalls += 1;
      return rt.png;
    },
    async viewFrame() {
      rt.viewFrames += 1;
      return rt.state === 'running' && !rt.captureBusy ? rt.png : null;
    },
    async input(_key, event) {
      rt.inputCalls += 1;
      if (rt.inputDelay) await rt.inputDelay;
      rt.inputs.push(event);
    },
    async mapDisplayPort() {
      throw new Error('no VNC in the fake');
    },
    async status() {
      return { kind: 'container', state: rt.state, lastActiveAt: null };
    },
  };
  return rt;
}
