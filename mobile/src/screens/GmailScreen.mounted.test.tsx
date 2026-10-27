/**
 * GmailScreen mounted with react-test-renderer: switching inboxes while an
 * earlier inbox is still loading must not let the slow response win.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem, ListHeaderComponent }: any) => {
    const R = require('react');
    return R.createElement(
      'View',
      null,
      ListHeaderComponent,
      (data || []).map((item: any, index: number) =>
        R.createElement(R.Fragment, { key: index }, renderItem({ item, index })),
      ),
    );
  },
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  Platform: { OS: 'android' },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ setActiveAgentId: () => {}, setActiveSessionId: () => {} }),
}));
vi.mock('../components/GmailImportantSection', () => ({ default: () => null }));
vi.mock('../components/CaptureToTicketModal', () => ({ default: () => null }));
vi.mock('../components/StartSessionModal', () => ({ default: () => null }));

const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const STATUS = {
  connected: true,
  email: 'me@work.com',
  grantedScopes: [GMAIL_MODIFY],
  serverConfigured: true,
  defaultAccountId: 'work',
  accounts: [
    { accountId: 'work', email: 'me@work.com', isDefault: true, grantedScopes: [GMAIL_MODIFY] },
    { accountId: 'home', email: 'me@home.com', isDefault: false, grantedScopes: [GMAIL_MODIFY] },
  ],
};

const pending: Record<string, Array<(v: any) => void>> = {};
vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(async () => STATUS),
    listGoogleGmailThreads: vi.fn(
      (p: any) => new Promise((resolve) => (pending[p.account] ??= []).push(resolve)),
    ),
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: GmailScreen } = await import('./GmailScreen');
process.env.NODE_ENV = originalNodeEnv;

const snippets = (r: any) =>
  r.root
    .findAll((n: any) => n.type === 'Text' && n.props.numberOfLines === 2)
    .map((n: any) => n.props.children);

describe('GmailScreen (mounted)', () => {
  it('ignores a slower response for an inbox the user already left', async () => {
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(GmailScreen, { navigation: {} }));
    });
    await act(async () => pending.work.shift()!({ threads: [{ id: 'w0', snippet: 'Work 0' }] }));
    const chip = (label: string) =>
      r.root.find((n: any) => n.props.accessibilityLabel === `Inbox ${label}`);

    // Pick home (left pending), then go back to work, which answers first.
    await act(async () => chip('me@home.com').props.onPress());
    await act(async () => chip('me@work.com').props.onPress());
    await act(async () =>
      pending.work.shift()!({ threads: [{ id: 'w', snippet: 'Work thread' }] }),
    );
    await act(async () =>
      pending.home.shift()!({ threads: [{ id: 'h', snippet: 'Home thread' }] }),
    );

    expect(snippets(r)).toEqual(['Work thread']);
    expect(chip('me@work.com').props.accessibilityState).toEqual({ selected: true });
    await act(async () => r.unmount());
  });
});
