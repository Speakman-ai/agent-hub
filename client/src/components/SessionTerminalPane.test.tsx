import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as any[],
  fits: [] as any[],
  serializers: [] as any[],
}));

vi.mock('../utils/connection', () => ({
  getTerminalWsUrl: (sessionId: string) => `wss://hub.test/api/sessions/${sessionId}/terminal/ws`,
}));

const apiMocks = vi.hoisted(() => ({
  getBackgroundShellLogs: vi.fn().mockResolvedValue({ logs: ['snapshot line'] }),
  stopBackgroundShell: vi.fn().mockResolvedValue({}),
}));

vi.mock('../utils/api', () => ({
  api: {
    getBackgroundShellLogs: apiMocks.getBackgroundShellLogs,
    stopBackgroundShell: apiMocks.stopBackgroundShell,
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    writes: string[] = [];
    resets = 0;
    disposed = false;
    inputDisposed = false;
    focused = 0;
    pasted: string[] = [];
    dataHandler: ((data: string) => void) | null = null;

    constructor() {
      xtermMocks.terminals.push(this);
    }

    focus() {
      this.focused += 1;
    }

    // Real xterm applies bracketed-paste wrapping / newline transformation and
    // then emits through onData — the same path a keystroke takes.
    paste(data: string) {
      this.pasted.push(data);
      this.dataHandler?.(data);
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
import { resetTerminalCommandBus, sendCommandToTerminal } from '../utils/terminalCommandBus';

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
    apiMocks.getBackgroundShellLogs.mockClear();
    apiMocks.stopBackgroundShell.mockClear();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetTerminalCommandBus();
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

  describe('"Run in terminal" hand-off', () => {
    it('pastes a command sent while attached, without pressing Enter', () => {
      render(<SessionTerminalPane sessionId="session-3" />);
      const terminal = xtermMocks.terminals[0];
      const socket = MockWebSocket.instances[0];

      act(() => {
        socket.open();
        socket.receive(serverData('attached', '$ '));
      });
      const sentBefore = socket.sent.length;

      act(() => {
        sendCommandToTerminal('session-3', 'npm test');
      });

      expect(terminal.pasted).toEqual(['npm test']);
      expect(terminal.focused).toBeGreaterThan(0);
      const frame = JSON.parse(socket.sent[sentBefore]);
      expect(frame).toMatchObject({ type: 'input', encoding: 'base64' });
      // No trailing newline: the user reviews the line and runs it themselves.
      expect(decodeBase64(frame.data)).toBe('npm test');
    });

    it('replays a command sent before the socket attached', () => {
      // The click that opens the pane fires before the pane mounts, so the bus
      // holds the command; input sent pre-attach would otherwise be dropped.
      act(() => {
        sendCommandToTerminal('session-4', 'git status');
      });

      render(<SessionTerminalPane sessionId="session-4" />);
      const terminal = xtermMocks.terminals[0];
      const socket = MockWebSocket.instances[0];
      expect(terminal.pasted).toEqual([]);

      act(() => {
        socket.open();
        socket.receive(serverData('attached', '$ '));
      });

      expect(terminal.pasted).toEqual(['git status']);
    });

    it('ignores commands aimed at a different session', () => {
      render(<SessionTerminalPane sessionId="session-5" />);
      const terminal = xtermMocks.terminals[0];
      const socket = MockWebSocket.instances[0];

      act(() => {
        socket.open();
        socket.receive(serverData('attached', '$ '));
        sendCommandToTerminal('session-other', 'rm -rf /');
      });

      expect(terminal.pasted).toEqual([]);
    });

    it('stops listening once unmounted', () => {
      const view = render(<SessionTerminalPane sessionId="session-6" />);
      const terminal = xtermMocks.terminals[0];
      const socket = MockWebSocket.instances[0];

      act(() => {
        socket.open();
        socket.receive(serverData('attached', '$ '));
      });
      view.unmount();

      act(() => {
        sendCommandToTerminal('session-6', 'npm run build');
      });

      expect(terminal.pasted).toEqual([]);
    });
  });

  describe('background-shell job tabs', () => {
    const job = {
      id: 'job-1',
      session_id: 'session-1',
      command: 'npm test',
      label: 'tests',
      status: 'running' as const,
      exit_code: null,
      watch: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };

    it('keeps the interactive Shell tab and adds a Stop-capable job tab', async () => {
      const onStopJob = vi.fn().mockResolvedValue(undefined);
      const onActiveTabChange = vi.fn();
      render(
        <SessionTerminalPane
          sessionId="session-1"
          jobs={[job]}
          logsById={{ 'job-1': 'hello from ci\n' }}
          activeTabId="job-1"
          onActiveTabChange={onActiveTabChange}
          onStopJob={onStopJob}
        />,
      );

      expect(screen.getByTestId('session-terminal-tabs')).toBeInTheDocument();
      expect(screen.getByTestId('session-terminal-tab-pty')).toHaveTextContent('Shell');
      expect(screen.getByTestId('session-terminal-tab-job-1')).toHaveTextContent('tests');
      expect(xtermMocks.terminals).toHaveLength(2);
      expect(xtermMocks.terminals.flatMap((t) => t.writes).join('')).toContain('hello from ci');
      expect(apiMocks.getBackgroundShellLogs).not.toHaveBeenCalled();

      await act(async () => {
        screen.getByTestId('session-terminal-stop-job-1').click();
      });
      expect(onStopJob).toHaveBeenCalledWith('job-1');

      await act(async () => {
        screen.getByTestId('session-terminal-tab-pty').click();
      });
      expect(onActiveTabChange).toHaveBeenCalledWith('pty');
    });

    it('fetches a log snapshot when the job tab has no live text yet', async () => {
      const onLogSnapshot = vi.fn();
      render(
        <SessionTerminalPane
          sessionId="session-1"
          jobs={[job]}
          activeTabId="job-1"
          onLogSnapshot={onLogSnapshot}
        />,
      );

      await waitFor(() => {
        expect(apiMocks.getBackgroundShellLogs).toHaveBeenCalledWith('session-1', 'job-1', 500);
        expect(onLogSnapshot).toHaveBeenCalledWith('job-1', 'snapshot line\n');
      });
    });
  });
});
