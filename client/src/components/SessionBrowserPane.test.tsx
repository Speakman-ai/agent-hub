import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionBrowserPane from './SessionBrowserPane';

vi.mock('../utils/connection', () => ({
  getBrowserWsUrl: (sessionId: string) => `wss://hub.test/api/sessions/${sessionId}/browser/ws`,
}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: any[] = [];
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  closed = 0;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed += 1;
    this.readyState = 3;
    this.onclose?.({});
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(frame: any) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const factory = (url: string) => new FakeSocket(url) as unknown as WebSocket;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1, CLOSED: 3 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountAndOpen() {
  const utils = render(<SessionBrowserPane sessionId="s1" webSocketFactory={factory} />);
  const socket = FakeSocket.instances[0];
  act(() => socket.open());
  return { ...utils, socket };
}

describe('SessionBrowserPane', () => {
  it('connects to the session browser channel, attaches, and shows the waiting placeholder', () => {
    const { socket } = mountAndOpen();
    expect(socket.url).toBe('wss://hub.test/api/sessions/s1/browser/ws');
    expect(socket.sent[0]).toMatchObject({ type: 'attach' });

    act(() => socket.receive({ type: 'state', status: 'waiting', url: null, viewport: null }));
    expect(screen.getByTestId('session-browser-status').textContent).toMatch(
      /Waiting for the agent/,
    );
    expect(screen.getByText(/goes live the moment the agent runs/)).toBeInTheDocument();
    expect(screen.queryByTestId('session-browser-surface')).toBeNull();
    expect(screen.queryByTestId('session-browser-frame')).toBeNull();
  });

  it('renders live frames, mirrors the URL bar, and is labelled as the public-web surface', () => {
    const { socket } = mountAndOpen();
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: 'https://example.com/',
        viewport: { width: 1280, height: 720 },
        surface: 'web',
      }),
    );
    act(() =>
      socket.receive({
        type: 'frame',
        data: 'QUJD',
        width: 640,
        height: 360,
        viewportWidth: 1280,
        viewportHeight: 720,
        url: 'https://example.com/docs',
      }),
    );
    const img = screen.getByTestId('session-browser-frame') as HTMLImageElement;
    expect(img.src).toBe('data:image/jpeg;base64,QUJD');
    expect((screen.getByTestId('session-browser-url') as HTMLInputElement).value).toBe(
      'https://example.com/docs',
    );
    expect(screen.getByTestId('session-browser-surface').textContent).toMatch(/public web/i);
    expect(screen.getByText('Agent browser')).toBeInTheDocument();
  });

  it('labels the live surface as preview when the agent is driving the preview Chromium', () => {
    const { socket } = mountAndOpen();
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: 'http://127.0.0.1:4123/',
        viewport: { width: 1280, height: 720 },
        surface: 'preview',
      }),
    );
    expect(screen.getByTestId('session-browser-surface').textContent).toMatch(/preview/i);
    expect(screen.queryByText('public web')).toBeNull();
  });

  it('drops the browser frame when the pane switches to the desktop, before its first PNG', () => {
    const { socket } = mountAndOpen();
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: 'https://example.com/',
        viewport: { width: 1280, height: 720 },
        surface: 'web',
      }),
    );
    act(() =>
      socket.receive({
        type: 'frame',
        data: 'SlBFRw==',
        width: 1280,
        height: 720,
        viewportWidth: 1280,
        viewportHeight: 720,
        url: 'https://example.com/',
      }),
    );
    expect(screen.getByTestId('session-browser-frame').getAttribute('src')).toBe(
      'data:image/jpeg;base64,SlBFRw==',
    );
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: null,
        viewport: { width: 1280, height: 800 },
        surface: 'desktop',
      }),
    );
    expect(screen.getByTestId('session-browser-surface').textContent).toBe('desktop');
    expect(screen.queryByTestId('session-browser-frame')).toBeNull();
    expect(screen.getByText(/Waiting for the first frame/)).toBeInTheDocument();
  });

  it('keeps the frame across a state update on the same surface', () => {
    const { socket } = mountAndOpen();
    const webState = {
      type: 'state',
      status: 'live',
      url: 'https://example.com/',
      viewport: { width: 1280, height: 720 },
      surface: 'web',
    };
    act(() => socket.receive(webState));
    act(() =>
      socket.receive({
        type: 'frame',
        data: 'SlBFRw==',
        width: 1280,
        height: 720,
        viewportWidth: 1280,
        viewportHeight: 720,
        url: 'https://example.com/',
      }),
    );
    act(() => socket.receive({ ...webState, url: 'https://example.com/next' }));
    expect(screen.getByTestId('session-browser-frame')).toBeInTheDocument();
  });

  it('shows the desktop surface with PNG frames, no URL bar, and takes pointer input', () => {
    const { socket } = mountAndOpen();
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: null,
        viewport: { width: 1280, height: 800 },
        surface: 'desktop',
      }),
    );
    act(() =>
      socket.receive({
        type: 'frame',
        data: 'UE5H',
        mime: 'image/png',
        width: 1280,
        height: 800,
        viewportWidth: 1280,
        viewportHeight: 800,
        url: null,
      }),
    );
    expect(screen.getByTestId('session-browser-surface').textContent).toBe('desktop');
    const img = screen.getByTestId('session-browser-frame') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,UE5H');
    expect(img.getAttribute('alt')).toMatch(/desktop/);
    expect(screen.queryByTestId('session-browser-url')).toBeNull();
    expect(screen.getByText(/use the agent's desktop/)).toBeInTheDocument();

    const viewport = screen.getByTestId('session-browser-viewport');
    fireEvent.keyDown(viewport, { key: 'Enter' });
    expect(socket.sent.at(-1)).toEqual({
      type: 'input',
      input: { kind: 'key', type: 'press', key: 'Enter' },
    });
    act(() =>
      socket.receive({
        type: 'input_result',
        ok: false,
        code: 'agent_busy',
        message: 'The agent is using the desktop right now. Wait for its step to finish.',
      }),
    );
    expect(screen.getByTestId('session-browser-notice').textContent).toMatch(/using the desktop/);
  });

  it('forwards URL-bar submissions as navigate frames and surfaces refusals', () => {
    const { socket } = mountAndOpen();
    act(() =>
      socket.receive({ type: 'state', status: 'live', url: 'about:blank', viewport: null }),
    );
    const input = screen.getByTestId('session-browser-url') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'localhost:3000' } });
    fireEvent.submit(input.closest('form')!);
    expect(socket.sent.at(-1)).toEqual({ type: 'navigate', url: 'https://localhost:3000' });

    act(() =>
      socket.receive({
        type: 'navigated',
        ok: false,
        code: 'refused',
        message: 'Navigation to localhost is not allowed',
      }),
    );
    expect(screen.getByTestId('session-browser-notice').textContent).toMatch(/localhost/);
  });

  it('forwards keyboard input from the viewport and shows agent-busy refusals', () => {
    const { socket } = mountAndOpen();
    act(() =>
      socket.receive({ type: 'state', status: 'live', url: 'about:blank', viewport: null }),
    );
    const viewport = screen.getByTestId('session-browser-viewport');
    fireEvent.keyDown(viewport, { key: 'Enter' });
    expect(socket.sent.at(-1)).toEqual({
      type: 'input',
      input: { kind: 'key', type: 'press', key: 'Enter' },
    });
    // Browser-owned chords are not forwarded.
    const before = socket.sent.length;
    fireEvent.keyDown(viewport, { key: 'l', ctrlKey: true });
    expect(socket.sent.length).toBe(before);

    act(() =>
      socket.receive({
        type: 'input_result',
        ok: false,
        code: 'agent_busy',
        message: 'The agent is driving the browser right now',
      }),
    );
    expect(screen.getByTestId('session-browser-notice').textContent).toMatch(/agent is driving/);
  });

  it('closes the socket on unmount and calls onClose from the header', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <SessionBrowserPane sessionId="s1" onClose={onClose} webSocketFactory={factory} />,
    );
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    fireEvent.click(screen.getByTestId('session-browser-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(socket.closed).toBe(1);
  });

  it('records a demo: Record on a live browser, Stop with countdown, saved notice', () => {
    const { socket } = mountAndOpen();
    expect(screen.queryByTestId('session-browser-record')).toBeNull();
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: 'https://example.com/',
        viewport: { width: 1280, height: 720 },
        surface: 'web',
      }),
    );
    fireEvent.click(screen.getByTestId('session-browser-record'));
    expect(socket.sent.at(-1)).toEqual({ type: 'record_start' });

    const now = Date.now();
    act(() =>
      socket.receive({
        type: 'recording',
        state: {
          active: true,
          startedAt: now,
          endsAt: now + 600_000,
          maxDurationMs: 600_000,
          steps: 2,
        },
      }),
    );
    expect(screen.getByTestId('session-browser-record-remaining').textContent).toMatch(
      /^(10:00|9:59)$/,
    );
    expect(
      screen.getByText(/Recording your clicks.*2 steps.*Password fields are masked/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('session-browser-record-stop'));
    expect(socket.sent.at(-1)).toEqual({ type: 'record_stop' });
    act(() => {
      socket.receive({ type: 'recording', state: { active: false, steps: 0 } });
      socket.receive({
        type: 'recording_saved',
        artifact: { id: 'a', filename: 'browser-demo.json', url: '/x' },
        steps: 2,
        stopReason: 'stopped',
      });
    });
    expect(screen.getByTestId('session-browser-notice').textContent).toBe(
      'Recording saved to Artifacts (2 steps).',
    );
    expect(screen.getByTestId('session-browser-record')).toBeInTheDocument();
    expect(screen.getByTestId('session-browser-make-routine')).toBeInTheDocument();
  });

  it('offers Make routine only after a recording is saved', () => {
    const { socket } = mountAndOpen();
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: 'https://example.com/',
        viewport: { width: 1280, height: 720 },
        surface: 'web',
      }),
    );
    expect(screen.queryByTestId('session-browser-make-routine')).toBeNull();
    act(() =>
      socket.receive({
        type: 'recording_saved',
        artifact: { id: 'art-9', filename: 'browser-demo.json', url: '/x' },
        steps: 3,
        stopReason: 'stopped',
      }),
    );
    expect(screen.getByTestId('session-browser-make-routine')).toBeInTheDocument();
  });

  it('hides Record on the desktop surface', () => {
    const { socket } = mountAndOpen();
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: null,
        viewport: null,
        surface: 'desktop',
      }),
    );
    expect(screen.queryByTestId('session-browser-record')).toBeNull();
  });
});
