/**
 * Session chat `#` tags on mobile: the session composer only answers `#`
 * (`@` stays agent addressing), and user bubbles show tokens as chips.
 */
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
  ScrollView: nativeHost('ScrollView'),
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
vi.mock('../utils/api', () => ({
  api: {
    hubChat: {
      searchRefs: vi.fn().mockResolvedValue({ suggestions: [] }),
      resolveRefs: vi.fn().mockResolvedValue({ refs: [] }),
    },
  },
}));

const { mentionQueryAt } = await import('./HubChatRefs');
const { default: ChatMessage } = await import('./ChatMessage');

describe('mentionQueryAt with triggers', () => {
  it('answers # and ignores @ when limited to #', () => {
    const at = (text: string) => ({ text, caret: text.length });
    expect(mentionQueryAt('see #web', at('see #web'), [], ['#'])).toMatchObject({
      trigger: '#',
      query: 'web',
    });
    expect(mentionQueryAt('hi @al', at('hi @al'), [], ['#'])).toBeNull();
    expect(mentionQueryAt('hi @al', at('hi @al'), [])).toMatchObject({ trigger: '@' });
  });
});

describe('session user bubble', () => {
  it('renders a ref token as a chip, not raw token text', () => {
    let r: any;
    act(() => {
      r = TestRenderer.create(
        <ChatMessage
          message={{
            id: 1,
            role: 'user',
            content: 'Review @[web\\#42](pr:web#42) please',
            created_at: '2026-10-19T10:00:00Z',
          }}
        />,
      );
    });
    const chips = r.root.findAll(
      (n: any) => n.props?.testID === 'hub-chat-ref' && typeof n.type === 'string',
    );
    expect(chips).toHaveLength(1);
    const text = JSON.stringify(r.toJSON());
    expect(text).not.toContain('pr:web#42');
    expect(text).toContain('web#42');
    r.unmount();
  });
});
