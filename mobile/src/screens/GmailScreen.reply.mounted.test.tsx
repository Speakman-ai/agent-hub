/**
 * GmailScreen mounted with react-test-renderer: a reply that finishes after its
 * thread was closed must not reopen that thread over the one now on screen.
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

let finishSend: (v: unknown) => void = () => {};
const threadBody = (id: string, subject: string, from: string) => ({
  messages: [
    {
      id: `m-${id}`,
      threadId: id,
      snippet: subject,
      from,
      to: 'me',
      subject,
      messageIdHeader: `<${id}@mail>`,
      bodyText: `${subject} body`,
    },
  ],
});
vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(async () => STATUS),
    listGoogleGmailThreads: vi.fn(async (p: any) => ({
      threads:
        p.account === 'home'
          ? [{ id: 'th', snippet: 'Dinner on Friday?' }]
          : [{ id: 'tw', snippet: 'Quarterly numbers' }],
    })),
    getGoogleGmailThread: vi.fn(async (id: string) =>
      id === 'th'
        ? threadBody('th', 'Dinner', 'Jane <jane@example.com>')
        : threadBody('tw', 'Numbers', 'Boss <boss@work.com>'),
    ),
    sendGoogleGmailMessage: vi.fn(() => new Promise((resolve) => (finishSend = resolve))),
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: GmailScreen } = await import('./GmailScreen');
const { api } = await import('../utils/api');
process.env.NODE_ENV = originalNodeEnv;

const byLabel = (r: any, label: string) =>
  r.root.find((n: any) => typeof n.type === 'string' && n.props.accessibilityLabel === label);
const pressText = (r: any, text: string) =>
  r.root
    .find(
      (n: any) =>
        typeof n.props.onPress === 'function' &&
        n.findAll((c: any) => c.type === 'Text' && c.props.children === text).length > 0,
    )
    .props.onPress();
const hasText = (r: any, text: string) =>
  r.root.findAll((n: any) => n.type === 'Text' && n.props.children === text).length > 0;

describe('GmailScreen reply (mounted)', () => {
  it('does not pull a closed thread back when its reply finishes sending', async () => {
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(GmailScreen, { navigation: {} }));
    });
    await act(async () => byLabel(r, 'Inbox All inboxes').props.onPress());

    // Reply in thread A (home) and close it while the send is in flight.
    await act(async () => pressText(r, 'Dinner on Friday?'));
    await act(async () => byLabel(r, 'Reply').props.onChangeText('Yes!'));
    await act(async () => {
      byLabel(r, 'Send reply').props.onPress();
    });
    expect(api.sendGoogleGmailMessage).toHaveBeenCalledTimes(1);
    await act(async () => pressText(r, 'Close'));

    // Open thread B (work) and start a draft there.
    await act(async () => pressText(r, 'Quarterly numbers'));
    expect(hasText(r, 'Numbers body')).toBe(true);
    expect(byLabel(r, 'Reply').props.value).toBe('');
    await act(async () => byLabel(r, 'Reply').props.onChangeText('for B'));
    const detailCalls = vi.mocked(api.getGoogleGmailThread).mock.calls.length;

    await act(async () => finishSend({}));

    expect(hasText(r, 'Numbers body')).toBe(true);
    expect(hasText(r, 'Dinner body')).toBe(false);
    expect(byLabel(r, 'Reply').props.value).toBe('for B');
    expect(vi.mocked(api.getGoogleGmailThread).mock.calls.length).toBe(detailCalls);
    await act(async () => r.unmount());
  });

  it('stays closed when the modal is dismissed during the detail load', async () => {
    let finish: (v: unknown) => void = () => {};
    vi.mocked(api.getGoogleGmailThread).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)) as any,
    );
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(GmailScreen, { navigation: {} }));
    });
    await act(async () => {
      // Don't await: the detail load is held open on purpose.
      void pressText(r, 'Quarterly numbers');
    });
    expect(r.root.findAll((n: any) => n.type === 'Modal')).toHaveLength(1);
    await act(async () => pressText(r, 'Close'));
    expect(r.root.findAll((n: any) => n.type === 'Modal')).toHaveLength(0);

    await act(async () => finish(threadBody('tw', 'Numbers', 'Boss <boss@work.com>')));
    expect(r.root.findAll((n: any) => n.type === 'Modal')).toHaveLength(0);
    expect(hasText(r, 'Numbers body')).toBe(false);
    await act(async () => r.unmount());
  });
});
