import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HubChatChannel, HubChatMessage } from '@shared/utils/hubChat';
import { layoutHubChatMessages } from '@shared/utils/hubChat';

// RN primitives as string hosts so renderToStaticMarkup can serialize rows.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  FlatList: 'FlatList',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
  StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
}));
vi.mock('react-native-markdown-display', () => ({
  default: ({ children }: any) => <span data-markdown>{children}</span>,
  MarkdownIt: () => ({ use: () => ({}) }),
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({}) }));
vi.mock('../utils/api', () => ({ api: { hubChat: {} } }));
vi.mock('../components/HubIcon', () => ({
  default: ({ name }: any) => <span data-name={name} />,
}));

import { ChannelRow, MessageRow, shouldFollowTail } from './HubChatScreen';
import { HubChatRefChip } from '../components/HubChatRefs';

function channel(over: Partial<HubChatChannel> = {}): HubChatChannel {
  return {
    id: 'c1',
    orgId: 'o1',
    kind: 'channel',
    name: 'general',
    topic: null,
    isPrivate: false,
    projectId: null,
    agentId: null,
    dmPeerUserId: null,
    createdByUserId: 'u1',
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    lastSeq: 5,
    membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 5,
    mentionCount: 1,
    ...over,
  };
}

const noop = () => {};

describe('ChannelRow badges (web rail rule)', () => {
  it('badges every unread in an all-level channel', () => {
    const html = renderToStaticMarkup(
      <ChannelRow channel={channel()} label="# general" onPress={noop} />,
    );
    expect(html).toContain('# general');
    expect(html).toContain('>5<');
  });

  it('badges only mentions at notify level mentions', () => {
    const html = renderToStaticMarkup(
      <ChannelRow
        channel={channel({
          membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'mentions', mutedUntil: null },
        })}
        label="# general"
        onPress={noop}
      />,
    );
    expect(html).toContain('>1<');
    expect(html).not.toContain('>5<');
  });

  it('shows no badge while muted', () => {
    const html = renderToStaticMarkup(
      <ChannelRow
        channel={channel({
          membership: {
            role: 'member',
            lastReadSeq: 0,
            notifyLevel: 'all',
            mutedUntil: '2999-01-01T00:00:00Z',
          },
        })}
        label="# general"
        onPress={noop}
      />,
    );
    expect(html).not.toContain('>5<');
    expect(html).not.toContain('unread');
  });
});

describe('MessageRow', () => {
  const msg = (over: Partial<HubChatMessage>): HubChatMessage => ({
    id: 'm1',
    channelId: 'c1',
    seq: 1,
    authorKind: 'user',
    authorUserId: 'u2',
    authorAgentId: null,
    body: 'hello',
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00Z',
    ...over,
  });

  it('shows the author, the Unread line and the body', () => {
    const [row] = layoutHubChatMessages([msg({ seq: 3 })], { viewerUserId: 'u1', lastReadSeq: 2 });
    const html = renderToStaticMarkup(
      <MessageRow row={row} usernames={new Map([['u2', 'bob']])} />,
    );
    expect(html).toContain('bob');
    expect(html).toContain('hub-chat-unread-line');
    expect(html).toContain('hello');
  });

  it('marks the message a search jumped to', () => {
    const [row] = layoutHubChatMessages([msg({})], { viewerUserId: 'u1', lastReadSeq: null });
    const plain = renderToStaticMarkup(<MessageRow row={row} usernames={new Map()} />);
    expect(plain).not.toContain('hub-chat-message-highlighted');
    const html = renderToStaticMarkup(<MessageRow row={row} usernames={new Map()} highlighted />);
    expect(html).toContain('hub-chat-message-highlighted');
  });

  it('renders a deleted message as a placeholder', () => {
    const [row] = layoutHubChatMessages([msg({ deletedAt: '2026-10-13T10:05:00Z' })], {
      viewerUserId: 'u1',
      lastReadSeq: null,
    });
    const html = renderToStaticMarkup(<MessageRow row={row} usernames={new Map()} />);
    expect(html).toContain('Message deleted');
    expect(html).not.toContain('hello');
  });

  it('renders a trigger message as a status card', () => {
    const [row] = layoutHubChatMessages(
      [
        msg({
          authorKind: 'trigger',
          authorUserId: null,
          body: 'Finalize failed',
          payload: {
            type: 'trigger',
            event: 'finalize_run_completed',
            triggerId: 't1',
            projectId: 'web',
            title: 'Finalize failed',
            status: 'failure',
            statusLabel: 'failed',
            detail: 'ci failed',
            refs: [],
          },
        }),
      ],
      { viewerUserId: 'u1', lastReadSeq: null },
    );
    const html = renderToStaticMarkup(<MessageRow row={row} usernames={new Map()} />);
    expect(html).toContain('hub-chat-trigger-card');
    expect(html).toContain('Trigger');
    expect(html).toContain('Finalize run completed');
    expect(html).toContain('ci failed');
  });
});

describe('HubChatRefChip', () => {
  const token = {
    raw: '@[WEB-12](card:c1)',
    index: 0,
    label: 'WEB-12',
    kind: 'card',
    targetId: 'c1',
  } as const;

  it('shows the label and live status for a visible ref', () => {
    const html = renderToStaticMarkup(
      <HubChatRefChip
        token={token}
        resolved={{
          kind: 'card',
          targetId: 'c1',
          visible: true,
          projectId: 'web',
          label: 'WEB-12',
          title: 'Fix login',
          status: 'In Progress',
          agentId: null,
          number: null,
        }}
      />,
    );
    expect(html).toContain('#WEB-12');
    expect(html).toContain('In Progress');
  });

  it('shows only the label to a viewer without access', () => {
    const html = renderToStaticMarkup(
      <HubChatRefChip
        token={token}
        resolved={{
          kind: 'card',
          targetId: 'c1',
          visible: false,
          projectId: null,
          label: null,
          title: null,
          status: null,
          agentId: null,
          number: null,
        }}
      />,
    );
    expect(html).toContain('#WEB-12');
    expect(html).not.toContain('In Progress');
  });
});

describe('shouldFollowTail', () => {
  it('follows only while the reader is at the bottom', () => {
    expect(shouldFollowTail(900, 500, 1400)).toBe(true);
    expect(shouldFollowTail(850, 500, 1400)).toBe(true);
    // Scrolled up to read history (or to tap Load earlier).
    expect(shouldFollowTail(0, 500, 1400)).toBe(false);
  });
});
