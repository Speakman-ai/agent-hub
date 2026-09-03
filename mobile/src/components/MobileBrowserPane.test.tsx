import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Image: 'Image',
  Pressable: 'Pressable',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('lucide-react-native', () => ({ Globe: 'Globe', RotateCw: 'RotateCw', X: 'X' }));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('../utils/config', () => ({
  getBrowserWsUrl: (id: string) => `wss://hub.test/api/sessions/${id}/browser/ws`,
}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  closed = 0;
  constructor(public url: string) {
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

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: MobileBrowserPane } = await import('./MobileBrowserPane');
process.env.NODE_ENV = originalNodeEnv;
const act = TestRenderer.act;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount() {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<MobileBrowserPane sessionId="s1" onClose={() => {}} />);
  });
  const socket = FakeSocket.instances[0];
  act(() => socket.open());
  return { renderer, socket };
}

describe('MobileBrowserPane', () => {
  it('attaches over the session browser channel and shows the waiting state', async () => {
    const { renderer, socket } = await mount();
    expect(socket.url).toBe('wss://hub.test/api/sessions/s1/browser/ws');
    expect(socket.sent[0]).toMatchObject({ type: 'attach' });
    act(() => socket.receive({ type: 'state', status: 'waiting', url: null, viewport: null }));
    const status = renderer.root.findByProps({ testID: 'mobile-browser-status' });
    expect(String(status.props.children)).toMatch(/Waiting for the agent/);
  });

  it('renders frames as a tappable image and forwards typed text', async () => {
    const { renderer, socket } = await mount();
    act(() =>
      socket.receive({
        type: 'state',
        status: 'live',
        url: 'https://example.com/',
        viewport: { width: 1280, height: 720 },
      }),
    );
    const viewportView = renderer.root
      .findAllByType('View' as any)
      .find((n) => typeof n.props.onLayout === 'function')!;
    act(() =>
      viewportView.props.onLayout({ nativeEvent: { layout: { width: 320, height: 300 } } }),
    );
    act(() =>
      socket.receive({
        type: 'frame',
        data: 'QUJD',
        width: 640,
        height: 360,
        viewportWidth: 1280,
        viewportHeight: 720,
        url: 'https://example.com/',
      }),
    );
    const frame = renderer.root.findByProps({ testID: 'mobile-browser-frame' });
    act(() => frame.props.onPress({ nativeEvent: { locationX: 160, locationY: 90 } }));
    expect(socket.sent.at(-1)).toEqual({
      type: 'input',
      input: { kind: 'mouse', type: 'click', x: 640, y: 360 },
    });

    const typeInput = renderer.root.findByProps({ testID: 'mobile-browser-type' });
    act(() => typeInput.props.onChangeText('hello'));
    act(() => typeInput.props.onSubmitEditing());
    expect(socket.sent.at(-1)).toEqual({ type: 'input', input: { kind: 'text', text: 'hello' } });
  });
});
