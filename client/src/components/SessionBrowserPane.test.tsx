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
    expect(screen.getByText('public web')).toBeInTheDocument();
    expect(screen.getByText('Agent browser')).toBeInTheDocument();
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
});
