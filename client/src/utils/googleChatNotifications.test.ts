import { describe, expect, it, vi } from 'vitest';
import {
  chatBadgeCount,
  createChatNotifier,
  isChatEventForMe,
  previewText,
  requestOpenChatSpace,
  takePendingOpenChatSpace,
} from './googleChatNotifications';

const SELF = 'users/me';

function space(id: string, lastActiveTime: string | null, displayName = `Room ${id}`) {
  return {
    name: `spaces/${id}`,
    id,
    displayName,
    spaceType: 'SPACE',
    singleUserBotDm: false,
    spaceThreadingState: null,
    supportsThreadReplies: false,
    lastActiveTime,
    spaceUri: null,
    participants: null,
  };
}

function msg(spaceId: string, id: string, createTime: string, sender: string, text = 'hi') {
  return {
    name: `spaces/${spaceId}/messages/${id}`,
    id,
    spaceName: `spaces/${spaceId}`,
    threadName: null,
    threadReply: false,
    text,
    createTime,
    lastUpdateTime: null,
    deleted: false,
    attachmentCount: 0,
    sender: { name: sender, displayName: sender === SELF ? 'Me' : 'Alice', type: 'HUMAN' },
  };
}

function setup(opts: { myUserId?: string | null; viewing?: string | null } = {}) {
  let spaces = [space('A', '2026-10-09T10:00:00Z'), space('B', '2026-10-09T09:00:00Z')];
  let messages: Record<string, any[]> = {};
  const api = {
    listGoogleChatSpaces: vi.fn(async (_opts?: any): Promise<any> => ({ spaces })),
    listGoogleChatMessages: vi.fn(
      async (spaceId: string, _opts?: any): Promise<any> => ({
        messages: messages[spaceId] ?? [],
        selfUserName: SELF,
      }),
    ),
  };
  const onNotify = vi.fn();
  const notifier = createChatNotifier({
    api,
    getMyUserId: () => (opts.myUserId === undefined ? 'u1' : opts.myUserId),
    isViewingSpace: (id) => id === opts.viewing,
    onNotify,
    now: () => Date.parse('2026-10-09T10:30:00Z'),
  });
  return {
    api,
    onNotify,
    notifier,
    setSpaces: (next: any[]) => (spaces = next),
    setMessages: (next: Record<string, any[]>) => (messages = next),
  };
}

describe('createChatNotifier polling', () => {
  it('records where every space stands on the first poll without notifying', async () => {
    const t = setup();
    t.setMessages({ A: [msg('A', 'old', '2026-10-09T10:00:00Z', 'users/alice')] });
    await t.notifier.poll();
    expect(t.onNotify).not.toHaveBeenCalled();
    expect(t.api.listGoogleChatMessages).not.toHaveBeenCalled();
  });

  it('notifies for a new message from someone else in a space that moved', async () => {
    const t = setup();
    await t.notifier.poll();
    t.setSpaces([space('A', '2026-10-09T10:05:00Z'), space('B', '2026-10-09T09:00:00Z')]);
    t.setMessages({
      A: [
        msg('A', 'old', '2026-10-09T10:00:00Z', 'users/alice'),
        msg('A', 'new', '2026-10-09T10:05:00Z', 'users/alice', 'lunch?'),
      ],
    });
    await t.notifier.poll();
    expect(t.api.listGoogleChatMessages).toHaveBeenCalledTimes(1);
    expect(t.api.listGoogleChatMessages.mock.calls[0][0]).toBe('A');
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    expect(t.onNotify.mock.calls[0][0]).toMatchObject({
      spaceId: 'A',
      spaceLabel: 'Room A',
      sender: 'Alice',
      text: 'lunch?',
      count: 1,
      messageName: 'spaces/A/messages/new',
    });
    // Same state again: nothing new.
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(1);
  });

  it("never notifies for the user's own messages", async () => {
    const t = setup();
    await t.notifier.poll();
    t.setSpaces([space('A', '2026-10-09T10:05:00Z')]);
    t.setMessages({ A: [msg('A', 'mine', '2026-10-09T10:05:00Z', SELF)] });
    await t.notifier.poll();
    expect(t.onNotify).not.toHaveBeenCalled();
  });

  it('stays quiet for the conversation the user is looking at', async () => {
    const t = setup({ viewing: 'A' });
    await t.notifier.poll();
    t.setSpaces([space('A', '2026-10-09T10:05:00Z')]);
    t.setMessages({ A: [msg('A', 'new', '2026-10-09T10:05:00Z', 'users/alice')] });
    await t.notifier.poll();
    expect(t.onNotify).not.toHaveBeenCalled();
  });

  it('collapses several new messages in one space into one notice', async () => {
    const t = setup();
    await t.notifier.poll();
    t.setSpaces([space('A', '2026-10-09T10:07:00Z')]);
    t.setMessages({
      A: [
        msg('A', 'n1', '2026-10-09T10:05:00Z', 'users/alice', 'one'),
        msg('A', 'n2', '2026-10-09T10:07:00Z', 'users/alice', 'two'),
      ],
    });
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    expect(t.onNotify.mock.calls[0][0]).toMatchObject({ text: 'two', count: 2 });
  });
});

describe('createChatNotifier pagination', () => {
  it('baselines and checks spaces beyond the first page of the space list', async () => {
    const t = setup();
    let cLast = '2026-10-09T09:00:00Z';
    t.api.listGoogleChatSpaces.mockImplementation(async (opts: any = {}) =>
      opts.pageToken === 'spaces-2'
        ? { spaces: [space('C', cLast)], nextPageToken: null }
        : { spaces: [space('A', '2026-10-09T10:00:00Z')], nextPageToken: 'spaces-2' },
    );
    await t.notifier.poll();
    expect(t.onNotify).not.toHaveBeenCalled();

    cLast = '2026-10-09T10:05:00Z';
    t.setMessages({ C: [msg('C', 'new', '2026-10-09T10:05:00Z', 'users/alice', 'page two')] });
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    expect(t.onNotify.mock.calls[0][0]).toMatchObject({ spaceId: 'C', text: 'page two' });
  });

  it('follows nextPageToken after a short message page instead of skipping to lastActiveTime', async () => {
    const t = setup();
    await t.notifier.poll();
    t.setSpaces([space('A', '2026-10-09T10:07:00Z')]);
    const m1 = msg('A', 'm1', '2026-10-09T10:05:00Z', 'users/alice', 'one');
    const m2 = msg('A', 'm2', '2026-10-09T10:07:00Z', 'users/alice', 'two');
    t.api.listGoogleChatMessages.mockImplementation(async (_id: string, opts: any = {}) =>
      opts.pageToken === 'msgs-2'
        ? { messages: [m2], nextPageToken: null, selfUserName: SELF }
        : { messages: [m1], nextPageToken: 'msgs-2', selfUserName: SELF },
    );
    await t.notifier.poll();
    expect(t.api.listGoogleChatMessages).toHaveBeenCalledTimes(2);
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    expect(t.onNotify.mock.calls[0][0]).toMatchObject({ text: 'two', count: 2 });
  });

  it('continues an unfinished range from its saved page token, not from lastActiveTime', async () => {
    const t = setup();
    await t.notifier.poll();
    t.setSpaces([space('A', '2026-10-09T10:20:00Z')]);
    // Every page claims more: the read stops at its page cap unfinished.
    let n = 0;
    t.api.listGoogleChatMessages.mockImplementation(async () => {
      n += 1;
      const time = `2026-10-09T10:0${n}:00Z`;
      return { messages: [msg('A', `m${n}`, time, 'users/alice')], nextPageToken: `p${n + 1}` };
    });
    await t.notifier.poll();
    const pagesRead = n;
    expect(t.onNotify).toHaveBeenCalledTimes(1);

    t.api.listGoogleChatMessages.mockClear();
    t.api.listGoogleChatMessages.mockImplementation(async () => ({
      messages: [msg('A', 'tail', '2026-10-09T10:20:00Z', 'users/alice', 'tail')],
      nextPageToken: null,
    }));
    await t.notifier.poll();
    // Same query as the range started with, continued from the saved token.
    expect(t.api.listGoogleChatMessages.mock.calls[0][1]).toMatchObject({
      since: '2026-10-09T10:00:00Z',
      pageToken: `p${pagesRead + 1}`,
    });
    expect(t.onNotify).toHaveBeenCalledTimes(2);
    expect(t.onNotify.mock.calls[1][0]).toMatchObject({ text: 'tail' });
  });
});

describe('createChatNotifier same-timestamp boundary', () => {
  it('keeps messages sharing the final timestamp when the page cap cuts between them', async () => {
    const t = setup();
    await t.notifier.poll();
    const T = '2026-10-09T10:05:00Z';
    const all = [1, 2, 3, 4, 5].map((i) => msg('A', `m${i}`, T, 'users/alice', `msg ${i}`));
    t.setSpaces([space('A', T)]);
    // Behaves like the proxy: `since` is inclusive, one message per page.
    t.api.listGoogleChatMessages.mockImplementation(async (_id: string, opts: any = {}) => {
      const range = all.filter((m) => m.createTime >= opts.since);
      const at = Number(opts.pageToken ?? 0);
      const next = at + 1 < range.length ? String(at + 1) : null;
      return { messages: range.slice(at, at + 1), nextPageToken: next, selfUserName: SELF };
    });

    // The page cap stops the read after m4, all at the same timestamp as m5.
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    expect(t.onNotify.mock.calls[0][0]).toMatchObject({ text: 'msg 4', count: 4 });

    // lastActiveTime has not moved; the next poll still finishes the range.
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(2);
    expect(t.onNotify.mock.calls[1][0]).toMatchObject({ text: 'msg 5', count: 1 });

    // Done: nothing more is read or announced.
    t.api.listGoogleChatMessages.mockClear();
    await t.notifier.poll();
    expect(t.api.listGoogleChatMessages).not.toHaveBeenCalled();
    expect(t.onNotify).toHaveBeenCalledTimes(2);
  });

  it('a push for a message at an open cursor timestamp that the poll has not read still notifies', async () => {
    const t = setup();
    await t.notifier.poll();
    const T = '2026-10-09T10:05:00Z';
    const all = [1, 2, 3, 4, 5].map((i) => msg('A', `m${i}`, T, 'users/alice', `msg ${i}`));
    t.setSpaces([space('A', T)]);
    t.api.listGoogleChatMessages.mockImplementation(async (_id: string, opts: any = {}) => {
      const range = all.filter((m) => m.createTime >= opts.since);
      const at = Number(opts.pageToken ?? 0);
      const next = at + 1 < range.length ? String(at + 1) : null;
      return { messages: range.slice(at, at + 1), nextPageToken: next, selfUserName: SELF };
    });
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    t.api.listGoogleChatMessages.mockImplementationOnce(async () => ({
      messages: [all[4]],
      selfUserName: SELF,
    }));
    await t.notifier.handleEvent({
      type: 'google_chat_message',
      ownerUserId: 'u1',
      kind: 'created',
      spaceName: 'spaces/A',
      messageName: all[4].name,
      createTime: T,
      own: false,
    });
    expect(t.onNotify).toHaveBeenCalledTimes(2);
    expect(t.onNotify.mock.calls[1][0]).toMatchObject({ text: 'msg 5' });
    // The poll that finishes the range does not repeat it.
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(2);
  });
});

describe('createChatNotifier forward progress', () => {
  // Behaves like the proxy: `since` is inclusive, `perPage` messages per
  // page, and the page token is an offset into that query's results.
  function pagedServer(all: any[], perPage = 1) {
    return async (_id: string, opts: any = {}) => {
      const range = all.filter((m) => m.createTime >= opts.since);
      const at = Number(opts.pageToken ?? 0);
      const next = at + perPage < range.length ? String(at + perPage) : null;
      return { messages: range.slice(at, at + perPage), nextPageToken: next, selfUserName: SELF };
    };
  }

  it('reaches a later message behind more than twenty one-message pages at one timestamp', async () => {
    const t = setup();
    await t.notifier.poll();
    const T = '2026-10-09T10:05:00Z';
    const same = Array.from({ length: 25 }, (_, i) => msg('A', `s${i + 1}`, T, 'users/alice'));
    const later = msg('A', 'later', '2026-10-09T10:06:00Z', 'users/alice', 'later one');
    t.setSpaces([space('A', later.createTime)]);
    t.api.listGoogleChatMessages.mockImplementation(pagedServer([...same, later]));

    for (let i = 0; i < 10; i++) await t.notifier.poll();

    const notices = t.onNotify.mock.calls.map((c) => c[0]);
    expect(notices.some((n) => n.text === 'later one')).toBe(true);
    // Every message announced exactly once across all polls.
    expect(notices.reduce((sum, n) => sum + n.count, 0)).toBe(26);

    t.api.listGoogleChatMessages.mockClear();
    await t.notifier.poll();
    expect(t.api.listGoogleChatMessages).not.toHaveBeenCalled();
  });

  it('restarts the range after a failed continuation without repeating notices', async () => {
    const t = setup();
    await t.notifier.poll();
    const all = Array.from({ length: 6 }, (_, i) =>
      msg('A', `m${i + 1}`, `2026-10-09T10:0${i + 1}:00Z`, 'users/alice', `msg ${i + 1}`),
    );
    t.setSpaces([space('A', all[5].createTime)]);
    const server = pagedServer(all);
    t.api.listGoogleChatMessages.mockImplementation(server);
    await t.notifier.poll(); // m1..m4, saves the token
    expect(t.onNotify.mock.calls.map((c) => c[0].count)).toEqual([4]);

    // The saved token is rejected once (expired).
    t.api.listGoogleChatMessages.mockImplementationOnce(async () => {
      throw new Error('invalid page token');
    });
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(1);

    // Restart from the cursor: m1..m4 are re-read but not re-announced.
    await t.notifier.poll();
    await t.notifier.poll();
    const notices = t.onNotify.mock.calls.map((c) => c[0]);
    expect(notices.reduce((sum, n) => sum + n.count, 0)).toBe(6);
    expect(notices[notices.length - 1]).toMatchObject({ text: 'msg 6' });
  });
});

describe('createChatNotifier push events', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    type: 'google_chat_message',
    ownerUserId: 'u1',
    kind: 'created',
    spaceName: 'spaces/A',
    messageName: 'spaces/A/messages/new',
    createTime: '2026-10-09T10:05:00Z',
    own: false,
    ...over,
  });

  it('notifies for an event addressed to the signed-in user and does not repeat it on poll', async () => {
    const t = setup();
    await t.notifier.poll();
    t.setMessages({ A: [msg('A', 'new', '2026-10-09T10:05:00Z', 'users/alice', 'ping')] });
    await t.notifier.handleEvent(event());
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    expect(t.onNotify.mock.calls[0][0]).toMatchObject({ spaceId: 'A', text: 'ping' });

    t.setSpaces([space('A', '2026-10-09T10:05:00Z')]);
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(1);
  });

  it("ignores events for another Hub user's chats", async () => {
    const t = setup();
    await t.notifier.poll();
    t.setMessages({ A: [msg('A', 'new', '2026-10-09T10:05:00Z', 'users/alice')] });
    await t.notifier.handleEvent(event({ ownerUserId: 'someone-else' }));
    await t.notifier.handleEvent(event({ ownerUserId: undefined }));
    expect(t.onNotify).not.toHaveBeenCalled();
    expect(t.api.listGoogleChatMessages).not.toHaveBeenCalled();
  });

  it('does not announce a late event for a message from before the notifier started', async () => {
    const t = setup();
    await t.notifier.poll();
    t.setMessages({ A: [msg('A', 'old', '2026-10-09T09:59:00Z', 'users/alice')] });
    await t.notifier.handleEvent(
      event({ messageName: 'spaces/A/messages/old', createTime: '2026-10-09T09:59:00Z' }),
    );
    expect(t.onNotify).not.toHaveBeenCalled();
    expect(t.api.listGoogleChatMessages).not.toHaveBeenCalled();
  });

  it('a later push does not hide an earlier message whose event was lost', async () => {
    const t = setup();
    await t.notifier.poll();
    const m1 = msg('A', 'm1', '2026-10-09T10:02:00Z', 'users/alice', 'first');
    const m2 = msg('A', 'm2', '2026-10-09T10:05:00Z', 'users/alice', 'second');
    // Only M2's event arrives.
    t.setMessages({ A: [m2] });
    await t.notifier.handleEvent(event({ messageName: m2.name, createTime: m2.createTime }));
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    expect(t.onNotify.mock.calls[0][0]).toMatchObject({ text: 'second' });

    // Backup poll recovers M1 and does not repeat M2.
    t.setSpaces([space('A', '2026-10-09T10:05:00Z')]);
    t.setMessages({ A: [m1, m2] });
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(2);
    expect(t.onNotify.mock.calls[1][0]).toMatchObject({ text: 'first', count: 1 });
  });

  it('ignores own, deleted, and non-message events', async () => {
    const t = setup();
    t.setMessages({ A: [msg('A', 'new', '2026-10-09T10:05:00Z', 'users/alice')] });
    await t.notifier.handleEvent(event({ own: true }));
    await t.notifier.handleEvent(event({ kind: 'deleted' }));
    await t.notifier.handleEvent(event({ type: 'google_chat_unread' }));
    expect(t.onNotify).not.toHaveBeenCalled();
  });
});

describe('createChatNotifier dedup and scheduling', () => {
  it('does not re-announce on the backup poll after more than 500 pushed messages', async () => {
    const t = setup();
    await t.notifier.poll();
    const pushed = Array.from({ length: 520 }, (_, i) => {
      const ms = String(i).padStart(3, '0');
      return msg('A', `p${i}`, `2026-10-09T10:01:00.${ms}Z`, 'users/alice', `m${i}`);
    });
    for (const m of pushed) {
      t.setMessages({ A: [m] });
      await t.notifier.handleEvent({
        type: 'google_chat_message',
        ownerUserId: 'u1',
        kind: 'created',
        spaceName: 'spaces/A',
        messageName: m.name,
        createTime: m.createTime,
        own: false,
      });
    }
    expect(t.onNotify).toHaveBeenCalledTimes(520);

    // Backup poll reads the whole range in one page: nothing is new.
    t.setSpaces([space('A', pushed[519].createTime)]);
    t.setMessages({ A: pushed });
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(520);
  });

  it('reads a sixth changed space even while the first five stay busy', async () => {
    const t = setup();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    t.setSpaces(ids.map((id) => space(id, '2026-10-09T09:00:00Z')));
    await t.notifier.poll();

    let minute = 0;
    const read: string[] = [];
    t.api.listGoogleChatMessages.mockImplementation(async (id: string) => {
      read.push(id);
      const time = `2026-10-09T10:${String(minute).padStart(2, '0')}:00Z`;
      return { messages: [msg(id, `${id}${minute}`, time, 'users/alice')], selfUserName: SELF };
    });
    for (let round = 0; round < 3; round++) {
      minute += 1;
      // The first five get new activity every poll; F changed once.
      const at = `2026-10-09T10:${String(minute).padStart(2, '0')}:00Z`;
      t.setSpaces(ids.map((id) => space(id, id === 'F' ? '2026-10-09T09:30:00Z' : at)));
      await t.notifier.poll();
    }
    expect(read).toContain('F');
  });

  it('reads a sixth changed space even while reads of the first five keep failing', async () => {
    const t = setup();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    t.setSpaces(ids.map((id) => space(id, '2026-10-09T09:00:00Z')));
    await t.notifier.poll();
    t.setSpaces(ids.map((id) => space(id, '2026-10-09T10:05:00Z')));
    t.api.listGoogleChatMessages.mockImplementation(async (id: string) => {
      if (id !== 'F') throw new Error('boom');
      return {
        messages: [msg('F', 'f1', '2026-10-09T10:05:00Z', 'users/alice', 'from F')],
        selfUserName: SELF,
      };
    });
    await t.notifier.poll();
    await t.notifier.poll();
    expect(t.onNotify).toHaveBeenCalledTimes(1);
    expect(t.onNotify.mock.calls[0][0]).toMatchObject({ spaceId: 'F' });
  });
});

describe('createChatNotifier dispose', () => {
  it('never notifies from a request that resolves after dispose', async () => {
    const t = setup();
    await t.notifier.poll();
    t.setSpaces([space('A', '2026-10-09T10:05:00Z')]);
    let release: (v: any) => void = () => {};
    t.api.listGoogleChatMessages.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const pending = t.notifier.poll();
    await Promise.resolve();
    await Promise.resolve();
    t.notifier.dispose();
    release({
      messages: [msg('A', 'new', '2026-10-09T10:05:00Z', 'users/alice')],
      selfUserName: SELF,
    });
    await pending;
    expect(t.onNotify).not.toHaveBeenCalled();
  });
});

describe('isChatEventForMe', () => {
  it('requires an owner and a matching user when the client knows its id', () => {
    expect(isChatEventForMe({ ownerUserId: 'u1' }, 'u1')).toBe(true);
    expect(isChatEventForMe({ ownerUserId: 'u2' }, 'u1')).toBe(false);
    expect(isChatEventForMe({}, 'u1')).toBe(false);
    expect(isChatEventForMe({}, null)).toBe(false);
    // Single-user local mode: the server's per-owner delivery is the gate.
    expect(isChatEventForMe({ ownerUserId: 'u1' }, null)).toBe(true);
  });
});

describe('previewText', () => {
  it('collapses whitespace, truncates, and labels attachment-only messages', () => {
    expect(previewText({ text: 'a\n\n b', attachmentCount: 0 })).toBe('a b');
    expect(previewText({ text: 'x'.repeat(200), attachmentCount: 0 })).toHaveLength(140);
    expect(previewText({ text: '', attachmentCount: 2 })).toBe('Sent an attachment');
  });
});

describe('requestOpenChatSpace', () => {
  it('leaves a pending request for the pane and announces it', () => {
    const listener = vi.fn();
    window.addEventListener('agenthub-google-chat-open-space', listener);
    requestOpenChatSpace('A');
    window.removeEventListener('agenthub-google-chat-open-space', listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takePendingOpenChatSpace()).toBe('A');
    expect(takePendingOpenChatSpace()).toBeNull();
  });
});

describe('chatBadgeCount', () => {
  it('uses announced messages when push is off', () => {
    expect(chatBadgeCount(false, 0, 3)).toBe(3);
  });

  it('uses the push unread total when push is active, without double counting', () => {
    expect(chatBadgeCount(true, 5, 3)).toBe(5);
  });
});
