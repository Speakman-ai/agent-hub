import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as any[],
  fits: [] as any[],
  serializers: [] as any[],
}));

vi.mock('../utils/connection', () => ({
  getTerminalWsUrl: (sessionId: string) => `wss://hub.test/api/sessions/${sessionId}/terminal/ws`,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    writes: string[] = [];
    resets = 0;
    disposed = false;
    inputDisposed = false;
    dataHandler: ((data: string) => void) | null = null;

    constructor() {
      xtermMocks.terminals.push(this);
    }

    loadAddon(addon: any) {
      addon.activate?.(this);
    }

    open() {}

    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return {
        dispose: () => {
          this.inputDisposed = true;
        },
      };
    }

    fireData(data: string) {
      this.dataHandler?.(data);
    }

    reset() {
      this.resets += 1;
    }

    write(data: string) {
      this.writes.push(data);
    }

    writeln(data: string) {
      this.writes.push(`${data}\r\n`);
    }

    dispose() {
      this.disposed = true;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fits = 0;

    constructor() {
      xtermMocks.fits.push(this);
    }

    activate() {}

    fit() {
      this.fits += 1;
    }
  },
}));

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class MockSerializeAddon {
    constructor() {
      xtermMocks.serializers.push(this);
    }

    activate() {}

    serialize() {
      return 'serialized terminal';
    }
  },
}));

import SessionTerminalPane from './SessionTerminalPane';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closeArgs: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(...args: any[]) {
    this.closeArgs = args;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  disconnected = false;
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe() {}

  disconnect() {
    this.disconnected = true;
  }

  fire() {
    this.callback([], this as any);
  }
}

function decodeBase64(data: string) {
  const binary = atob(data);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function serverData(type: 'attached' | 'output', data: string) {
  return { type, encoding: 'base64', data: btoa(data) };
}

describe('SessionTerminalPane', () => {
  beforeEach(() => {
    xtermMocks.terminals.length = 0;
    xtermMocks.fits.length = 0;
    xtermMocks.serializers.length = 0;
    MockWebSocket.instances = [];
    MockResizeObserver.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('mounts xterm addons, pipes input without local echo, reports resize, and tears down', () => {
    const onClose = vi.fn();
    const view = render(<SessionTerminalPane sessionId="session-1" onClose={onClose} />);
    const terminal = xtermMocks.terminals[0];
    const socket = MockWebSocket.instances[0];

    expect(screen.getByTestId('session-terminal-pane')).toHaveTextContent(
      /shared — agent may type/i,
    );
    expect(xtermMocks.fits).toHaveLength(1);
    expect(xtermMocks.serializers).toHaveLength(1);
    expect(socket.url).toContain('/sessions/session-1/terminal/ws');

    act(() => socket.open());
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'attach', cols: 80, rows: 24 });

    act(() => socket.receive(serverData('attached', '$ prior output\r\n')));
    expect(terminal.resets).toBe(1);
    expect(terminal.writes).toEqual(['$ prior output\r\n']);
    expect(screen.getByTestId('session-terminal-status')).toHaveTextContent('Connected');

    act(() => terminal.fireData('echo ✓'));
    const inputFrame = JSON.parse(socket.sent[1]);
    expect(inputFrame).toMatchObject({ type: 'input', encoding: 'base64' });
    expect(decodeBase64(inputFrame.data)).toBe('echo ✓');
    // Input is not written locally; only PTY output/snapshots echo to xterm.
    expect(terminal.writes).toEqual(['$ prior output\r\n']);

    terminal.cols = 120;
    terminal.rows = 38;
    act(() => MockResizeObserver.instances[0].fire());
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'resize', cols: 120, rows: 38 });

    act(() => socket.receive(serverData('output', 'live')));
    expect(terminal.writes.at(-1)).toBe('live');

    view.unmount();
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'detach' });
    expect(socket.closeArgs).toEqual([1000, 'Terminal pane closed']);
    expect(MockResizeObserver.instances[0].disconnected).toBe(true);
    expect(terminal.inputDisposed).toBe(true);
    expect(terminal.disposed).toBe(true);
  });

  it('reconnects and replaces the buffer with the replayed server snapshot', () => {
    vi.useFakeTimers();
    render(<SessionTerminalPane sessionId="session-2" />);
    const terminal = xtermMocks.terminals[0];
    const firstSocket = MockWebSocket.instances[0];

    act(() => {
      firstSocket.open();
      firstSocket.receive(serverData('attached', 'first snapshot'));
      firstSocket.close();
    });
    expect(screen.getByTestId('session-terminal-status')).toHaveTextContent('Reconnecting');

    act(() => vi.advanceTimersByTime(1_000));
    const secondSocket = MockWebSocket.instances[1];
    expect(secondSocket).toBeDefined();

    act(() => {
      secondSocket.open();
      secondSocket.receive(serverData('attached', 'restored snapshot'));
    });
    expect(terminal.resets).toBe(2);
    expect(terminal.writes.at(-1)).toBe('restored snapshot');
    expect(screen.getByTestId('session-terminal-status')).toHaveTextContent('Connected');
  });
});
