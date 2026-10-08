import { describe, it, expect } from 'vitest';
import {
  applyLinksResult,
  dispatchWarningFor,
  LINKS_UNKNOWN_WARNING,
  chatLinkChip,
  linksByMessage,
  sendToAgentWarning,
  chatSetupHelpLink,
  chatSenderLabel,
  chatSpaceDeepLink,
  chatSpaceLabel,
  chatThreadContext,
  filterSpaces,
  oldestCreateTime,
  reconcileRange,
  uniqueMessages,
  mergeOlderPage,
  sortChatMessages,
  spaceIdFromThreadName,
  type ChatMessage,
} from './googleChat';

function m(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    name: 'spaces/A/messages/x',
    id: 'x',
    spaceName: 'spaces/A',
    threadName: 'spaces/A/threads/T',
    threadReply: false,
    text: 't',
    createTime: '2026-10-08T10:00:00Z',
    lastUpdateTime: null,
    deleted: false,
    attachmentCount: 0,
    sender: null,
    ...overrides,
  };
}

describe('googleChat helpers', () => {
  it('labels named spaces, DMs, and group chats', () => {
    expect(chatSpaceLabel({ displayName: ' Support ', spaceType: 'SPACE', id: 'A' })).toBe(
      'Support',
    );
    expect(chatSpaceLabel({ displayName: null, spaceType: 'DIRECT_MESSAGE', id: 'A' })).toBe(
      'Direct message · A',
    );
    expect(chatSpaceLabel({ displayName: '', spaceType: 'GROUP_CHAT', id: 'A' })).toBe(
      'Group chat · A',
    );
  });

  it('falls back to a short user id when Chat omits the display name', () => {
    expect(chatSenderLabel({ name: 'users/1234567890', displayName: null, type: 'HUMAN' })).toBe(
      'User 567890',
    );
    expect(chatSenderLabel({ name: 'users/9', displayName: 'Jira', type: 'BOT' })).toBe('Jira');
    expect(chatSenderLabel({ name: 'users/9', displayName: null, type: 'BOT' })).toBe('Chat app');
    expect(chatSenderLabel(null)).toBe('Unknown sender');
  });

  it('only trusts Google-hosted space URIs', () => {
    expect(chatSpaceDeepLink({ spaceUri: 'https://chat.google.com/dm/X', id: 'X' })).toBe(
      'https://chat.google.com/dm/X',
    );
    expect(chatSpaceDeepLink({ spaceUri: 'javascript:alert(1)', id: 'X' })).toBe(
      'https://chat.google.com/room/X',
    );
    expect(chatSpaceDeepLink(null)).toBeNull();
  });

  it('sorts oldest first and builds thread context before the target only', () => {
    const a = m({ name: 'a', createTime: '2026-10-08T10:00:00Z', text: 'first' });
    const b = m({ name: 'b', createTime: '2026-10-08T10:01:00Z', text: 'second' });
    const other = m({ name: 'o', threadName: 'spaces/A/threads/OTHER' });
    const later = m({ name: 'l', createTime: '2026-10-08T11:00:00Z' });
    const deleted = m({ name: 'd', deleted: true, createTime: '2026-10-08T09:00:00Z' });
    expect(sortChatMessages([b, a]).map((x) => x.name)).toEqual(['a', 'b']);
    expect(chatThreadContext([later, b, other, a, deleted], b).map((x) => x.name)).toEqual(['a']);
    expect(chatThreadContext([a, b], m({ threadName: null }))).toEqual([]);
  });

  it('extracts the space id from a thread name', () => {
    expect(spaceIdFromThreadName('spaces/AAA/threads/T1')).toBe('AAA');
    expect(spaceIdFromThreadName('spaces/AAA')).toBeNull();
  });

  it('oldestCreateTime finds the earliest timestamp', () => {
    expect(
      oldestCreateTime([
        m({ createTime: '2026-10-08T10:00:00Z' }),
        m({ createTime: '2026-10-08T08:00:00Z' }),
        m({ createTime: null }),
      ]),
    ).toBe('2026-10-08T08:00:00Z');
    expect(oldestCreateTime([])).toBeNull();
  });

  it('reconcileRange replaces the range: deletions become tombstones, vanished messages drop', () => {
    const since = '2026-10-08T09:00:00Z';
    const older = m({ name: 'old', createTime: '2026-10-08T08:00:00Z', text: 'kept' });
    const a = m({ name: 'a', createTime: '2026-10-08T09:00:00Z', text: 'A original' });
    const b = m({ name: 'b', createTime: '2026-10-08T10:00:00Z', text: 'B' });
    const gone = m({ name: 'gone', createTime: '2026-10-08T09:30:00Z', text: 'purged' });
    const aDeleted = { ...a, text: null, deleted: true };
    const c = m({ name: 'c', createTime: '2026-10-08T11:00:00Z', text: 'C new' });

    const out = reconcileRange([older, a, gone, b], [c, b, aDeleted], since);

    expect(out.map((x) => x.name)).toEqual(['old', 'a', 'b', 'c']);
    expect(out[1]).toMatchObject({ deleted: true, text: null });
  });

  it('mergeOlderPage prepends without overwriting newer copies', () => {
    const a = m({ name: 'a', createTime: '2026-10-08T08:00:00Z', text: 'a' });
    const b = m({ name: 'b', createTime: '2026-10-08T09:00:00Z', text: 'b-current' });
    const bStale = m({ name: 'b', createTime: '2026-10-08T09:00:00Z', text: 'b-stale' });
    expect(mergeOlderPage([b], [a, bStale]).map((x) => x.text)).toEqual(['a', 'b-current']);
  });

  it('filterSpaces matches the visible label, case-insensitively', () => {
    const spaces = [
      { id: 'A', displayName: 'Acme Support', spaceType: 'SPACE' },
      { id: 'B', displayName: null, spaceType: 'DIRECT_MESSAGE' },
      { id: 'C', displayName: 'Billing', spaceType: 'SPACE' },
    ];
    expect(filterSpaces(spaces, '  acme ').map((s) => s.id)).toEqual(['A']);
    expect(filterSpaces(spaces, 'direct').map((s) => s.id)).toEqual(['B']);
    expect(filterSpaces(spaces, '')).toHaveLength(3);
  });

  it('uniqueMessages keeps one copy per name, last wins, sorted', () => {
    const a1 = m({ name: 'a', createTime: '2026-10-08T10:00:00Z', text: 'first' });
    const a2 = m({ name: 'a', createTime: '2026-10-08T10:00:00Z', text: 'second' });
    const b = m({ name: 'b', createTime: '2026-10-08T09:00:00Z' });
    expect(uniqueMessages([a1, b, a2]).map((x) => [x.name, x.text])).toEqual([
      ['b', 't'],
      ['a', 'second'],
    ]);
  });

  it('tells unnamed conversations apart by participants, then by space id', () => {
    const dm = (id: string, participants: string[] | null) => ({
      id,
      displayName: null,
      spaceType: 'DIRECT_MESSAGE',
      participants,
    });
    // Two unnamed DMs never share a label.
    expect(chatSpaceLabel(dm('D1', ['Dana Ruiz']))).toBe('Dana Ruiz');
    expect(chatSpaceLabel(dm('D2', ['Lee Chen']))).toBe('Lee Chen');
    expect(chatSpaceLabel(dm('D1', null))).toBe('Direct message · D1');
    expect(chatSpaceLabel(dm('D2', []))).toBe('Direct message · D2');
    expect(
      chatSpaceLabel({
        id: 'G1',
        displayName: null,
        spaceType: 'GROUP_CHAT',
        participants: ['A', 'B', 'C', 'D', 'E'],
      }),
    ).toBe('A, B, C +2');
    expect(
      chatSpaceLabel({
        id: 'B1',
        displayName: null,
        spaceType: 'DIRECT_MESSAGE',
        singleUserBotDm: true,
      }),
    ).toBe('Chat app DM · B1');
  });

  it('filterSpaces also matches participants and the space id', () => {
    const spaces = [
      {
        id: 'G1',
        displayName: null,
        spaceType: 'GROUP_CHAT',
        participants: ['A', 'B', 'C', 'Zed Q'],
      },
      { id: 'D9', displayName: null, spaceType: 'DIRECT_MESSAGE', participants: null },
    ];
    // "Zed" is past the three names shown in the label, but still searchable.
    expect(filterSpaces(spaces, 'zed').map((s) => s.id)).toEqual(['G1']);
    expect(filterSpaces(spaces, 'd9').map((s) => s.id)).toEqual(['D9']);
  });

  it('chatSetupHelpLink labels setup errors and refuses non-Google URLs', () => {
    expect(
      chatSetupHelpLink({
        code: 'google_chat_api_disabled',
        helpUrl:
          'https://console.developers.google.com/apis/api/chat.googleapis.com/overview?project=1',
      }),
    ).toEqual({
      label: 'Enable the Chat API in Google Cloud',
      url: 'https://console.developers.google.com/apis/api/chat.googleapis.com/overview?project=1',
    });
    expect(
      chatSetupHelpLink({
        code: 'google_chat_workspace_required',
        helpUrl: 'https://support.google.com/chat/answer/7655820',
      })?.label,
    ).toBe('About Google Workspace accounts');
    expect(
      chatSetupHelpLink({ code: 'google_chat_api_disabled', helpUrl: 'https://evil.example/' }),
    ).toBeNull();
    expect(
      chatSetupHelpLink({ code: 'google_chat_forbidden', helpUrl: 'https://support.google.com/x' }),
    ).toBeNull();
    expect(chatSetupHelpLink(null)).toBeNull();
  });
});

describe('message link helpers', () => {
  const base = {
    id: 'L',
    messageName: 'spaces/A/messages/M',
    spaceName: 'spaces/A',
    threadName: null,
    sessionId: 's1',
    sessionName: 'First',
    agentId: 'a',
    userId: 'u',
    createdAt: '2026-10-08T10:00:00.000Z',
    repliedAt: null,
    replyMessageName: null,
  };

  it('groups links by message, oldest first', () => {
    const grouped = linksByMessage([
      { ...base, id: 'L2', sessionId: 's2', createdAt: '2026-10-08T11:00:00.000Z' },
      { ...base, id: 'L1' },
      { ...base, id: 'L3', messageName: 'spaces/A/messages/OTHER' },
    ]);
    expect(grouped.get('spaces/A/messages/M')?.map((l) => l.id)).toEqual(['L1', 'L2']);
    expect(grouped.get('spaces/A/messages/OTHER')).toHaveLength(1);
  });

  it('prefers a replied session for the chip, else the newest', () => {
    expect(chatLinkChip(undefined)).toBeNull();
    const second = { ...base, id: 'L2', sessionId: 's2' };
    expect(chatLinkChip([base, second])).toMatchObject({
      label: 'Sent to agent',
      link: { sessionId: 's2' },
      count: 2,
    });
    expect(
      chatLinkChip([{ ...base, repliedAt: '2026-10-08T10:05:00.000Z' }, second]),
    ).toMatchObject({ label: 'Agent replied', link: { sessionId: 's1' } });
  });

  it('builds a warning only when the message already has a session', () => {
    expect(sendToAgentWarning([])).toBeNull();
    expect(sendToAgentWarning([base])).toBe(
      'This message was already sent to "First". Starting another session dispatches it again.',
    );
    const many = sendToAgentWarning([
      { ...base, repliedAt: 'x' },
      { ...base, sessionName: null },
      { ...base, sessionName: 'Third' },
    ]);
    expect(many).toContain('"First", "Untitled session" and 1 more.');
    expect(many).toContain('An agent has already replied.');
  });
});

describe('link read ordering', () => {
  const l = {
    id: 'L',
    messageName: 'spaces/A/messages/M',
    spaceName: 'spaces/A',
    threadName: null,
    sessionId: 's1',
    sessionName: 'First',
    agentId: 'a',
    userId: 'u',
    createdAt: '2026-10-08T10:00:00.000Z',
    repliedAt: null,
    replyMessageName: null,
  };

  it('drops a response older than the newest one applied', () => {
    const newer = applyLinksResult(undefined, 2, [l]);
    expect(applyLinksResult(newer, 1, [])).toBe(newer);
    expect(applyLinksResult(newer, 1, null)).toBe(newer);
  });

  it('keeps the last good links for chips but flags a newer failed read', () => {
    const ok = applyLinksResult(undefined, 1, []);
    const failed = applyLinksResult(ok, 2, null);
    expect(failed).toEqual({ links: [], seq: 2, failed: true });
    expect(applyLinksResult(failed, 3, [l])).toEqual({ links: [l], seq: 3, failed: false });
  });

  it('warns about uncertainty unless the newest read succeeded', () => {
    expect(dispatchWarningFor(undefined, l.messageName)).toBe(LINKS_UNKNOWN_WARNING);
    expect(dispatchWarningFor({ links: [], seq: 2, failed: true }, l.messageName)).toBe(
      LINKS_UNKNOWN_WARNING,
    );
    expect(dispatchWarningFor({ links: [], seq: 1, failed: false }, l.messageName)).toBeNull();
    expect(dispatchWarningFor({ links: [l], seq: 1, failed: false }, l.messageName)).toContain(
      '"First"',
    );
  });
});
