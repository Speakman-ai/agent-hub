import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Alert: { alert: vi.fn() },
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Image: nativeHost('Image'),
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  Modal: nativeHost('Modal'),
  Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  Pressable: nativeHost('Pressable'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  ToastAndroid: { show: vi.fn() },
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('react-native-markdown-display', () => ({ default: nativeHost('Markdown') }));
vi.mock('./AppIcon', () => ({ default: nativeHost('AppIcon') }));
vi.mock('../utils/config', () => ({ getApiBaseUrl: () => 'http://127.0.0.1:3051' }));
vi.mock('../utils/clipboard', () => ({ copyToClipboard: vi.fn(), canCopy: () => true }));

const { default: ChatMessage } = await import('./ChatMessage');

function render(message: any) {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(<ChatMessage message={message} />);
  });
  return renderer;
}

function hostByTestId(renderer: any, id: string) {
  return renderer.root.findAll((n: any) => n.props?.testID === id && typeof n.type === 'string');
}

describe('ChatMessage system timeline routing', () => {
  it('renders a Finalize run summary as a card instead of the raw-text fallback', () => {
    const r = render({
      id: 7,
      role: 'system',
      content: '### Manual testing\n- [ ] Create a reminder',
      metadata: JSON.stringify({
        kind: 'finalize_run_summary',
        summary: 'Adds calendar sync.',
        finalVerdict: 'approved',
        manualTesting: ['Create a reminder'],
      }),
      created_at: '2026-10-16T20:00:00Z',
    });
    expect(hostByTestId(r, 'finalize-run-summary-block')).toHaveLength(1);
    expect(hostByTestId(r, 'system-message-fallback')).toHaveLength(0);
  });

  it('renders unrecognized system messages as markdown, not plain text', () => {
    const r = render({
      id: 8,
      role: 'system',
      content: '**Bold** note',
      metadata: JSON.stringify({ kind: 'some_future_event' }),
    });
    expect(hostByTestId(r, 'system-message-fallback')).toHaveLength(1);
    const md = r.root.findAll((n: any) => n.type === 'Markdown');
    expect(md).toHaveLength(1);
    expect(md[0].props.children).toBe('**Bold** note');
  });

  it('renders finalize_ci_absent as its own card', () => {
    const r = render({
      id: 10,
      role: 'system',
      content: 'No CI config for this project.',
      metadata: JSON.stringify({ kind: 'finalize_ci_absent', runId: 'r1', round: 1 }),
    });
    expect(hostByTestId(r, 'finalize-ci-absent-block')).toHaveLength(1);
    expect(hostByTestId(r, 'system-message-fallback')).toHaveLength(0);
  });

  it('still renders the PR-created card', () => {
    const r = render({
      id: 9,
      role: 'system',
      content: 'PR opened',
      metadata: JSON.stringify({
        kind: 'pr_created',
        prUrl: 'https://github.com/o/r/pull/3',
        prNumber: 3,
      }),
    });
    expect(hostByTestId(r, 'system-message-fallback')).toHaveLength(0);
    const text = r.root
      .findAll((n: any) => n.type === 'Text')
      .flatMap((n: any) => n.children)
      .join(' ');
    expect(text).toContain('Pull request created from these changes');
  });
});
