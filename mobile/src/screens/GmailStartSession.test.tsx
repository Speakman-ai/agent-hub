import React from 'react';
import * as TestRenderer from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// react-test-renderer's `act` (and React.act) aren't available in this vitest
// build, so drive `create` directly. The thread → picker handoff is driven by
// explicit state/callback calls (no passive effects), so a macrotask flush for
// the async thread load is all we need.
const RTR: any = TestRenderer;
const create: any = RTR.create ?? RTR.default?.create;
const flush = () => new Promise((r) => setTimeout(r, 0));

// RN primitives as host tags so react-test-renderer builds a tree we can
// traverse by props. Modal renders a host node that ALWAYS stays in the tree
// (so its onDismiss/visible props are inspectable) but only renders its
// children while `visible` — mirroring a native modal that is mounted but
// dismissing. Platform.OS is 'ios' so the handoff waits for onDismiss, which is
// exactly the dismissal-completion race under test.
vi.mock('react-native', () => {
  const react = require('react');
  return {
    ActivityIndicator: 'ActivityIndicator',
    Alert: { alert: vi.fn() },
    FlatList: 'FlatList',
    Linking: { openURL: vi.fn() },
    Modal: ({ visible, children, ...rest }: any) =>
      react.createElement('Modal', { visible, ...rest }, visible ? children : null),
    Platform: { OS: 'ios' },
    ScrollView: 'ScrollView',
    StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
    Text: 'Text',
    TextInput: 'TextInput',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
  };
});
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));

const setActiveAgentId = vi.fn();
const setActiveSessionId = vi.fn();
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ setActiveAgentId, setActiveSessionId }),
}));

const getGoogleStatus = vi.fn();
const listGoogleGmailThreads = vi.fn();
const getGoogleGmailThread = vi.fn();
vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: (...a: any[]) => getGoogleStatus(...a),
    listGoogleGmailThreads: (...a: any[]) => listGoogleGmailThreads(...a),
    getGoogleGmailThread: (...a: any[]) => getGoogleGmailThread(...a),
  },
}));

// Stub the picker so this test stays focused on GmailScreen's modal
// orchestration (the picker's own project/agent flow is covered elsewhere).
vi.mock('../components/StartSessionModal', () => ({
  default: (props: any) => require('react').createElement('StartSessionModalStub', props),
}));
vi.mock('../components/CaptureToTicketModal', () => ({ default: () => null }));

import GmailScreen, { GmailContent, buildThreadSessionSeed } from './GmailScreen';

const SESSION_LABEL = 'Start session with this email as context';
const PICKER = 'StartSessionModalStub';

const sessionButtons = (root: any) =>
  root.findAll((i: any) => i.props?.accessibilityLabel === SESSION_LABEL);
// The thread Modal is the only Modal that wires an onDismiss handoff.
const threadModals = (root: any) =>
  root.findAll((i: any) => i.type === 'Modal' && typeof i.props?.onDismiss === 'function');
const pickers = (root: any) => root.findAllByType(PICKER);

describe('GmailScreen — start session from email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
      serverConfigured: true,
    });
    listGoogleGmailThreads.mockResolvedValue({
      threads: [{ id: 't1', snippet: 'Quarterly review', historyId: '9' }],
    });
    getGoogleGmailThread.mockResolvedValue({
      messages: [
        { id: 'm1', subject: 'Q3 planning', from: 'a@x.com', snippet: 'hi', bodyText: 'b' },
      ],
    });
  });

  it('keeps the picker closed until the thread modal finishes dismissing, then navigates', async () => {
    const navigate = vi.fn();
    const tr: any = create(<GmailScreen navigation={{ navigate }} />);
    await flush(); // async thread load
    const root = tr.root;

    // Open the email detail: thread modal visible, no picker yet.
    await root.findByType(GmailContent).props.onOpenThread({ id: 't1' });
    await flush();
    expect(threadModals(root)[0].props.visible).toBe(true);
    expect(sessionButtons(root).length).toBe(1);
    expect(pickers(root).length).toBe(0);

    // Tap "Session": the thread modal starts dismissing (visible=false), but the
    // picker must NOT present yet — it waits for the native dismissal callback.
    sessionButtons(root)[0].props.onPress();
    await flush();
    const dismissing = threadModals(root)[0];
    expect(dismissing.props.visible).toBe(false); // dismissal in progress
    expect(pickers(root).length).toBe(0); // picker still withheld — no overlap

    // Native dismissal completes → now the picker presents and the thread modal
    // is gone.
    dismissing.props.onDismiss();
    await flush();
    expect(threadModals(root).length).toBe(0); // thread modal fully torn down
    const picker = root.findByType(PICKER);
    expect(picker.props.seedMessage).toBe(
      buildThreadSessionSeed({ id: 't1', subject: 'Q3 planning' }, [
        { id: 'm1', subject: 'Q3 planning', from: 'a@x.com', snippet: 'hi', bodyText: 'b' },
      ])!.seed,
    );

    // Completing the picker navigates to the new chat.
    picker.props.onStarted({ id: 'sess-1', agent_id: 'agent-1' });
    await flush();
    expect(setActiveAgentId).toHaveBeenCalledWith('agent-1');
    expect(setActiveSessionId).toHaveBeenCalledWith('sess-1');
    expect(navigate).toHaveBeenCalledWith('Chat');
  });
});
