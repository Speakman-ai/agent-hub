import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    hubChat: {
      members: vi.fn(),
      channels: vi.fn(),
      messages: vi.fn(),
      post: vi.fn(),
      markRead: vi.fn(),
      edit: vi.fn(),
      searchRefs: vi.fn(),
      resolveRefs: vi.fn(),
    },
  },
}));

import HubChatPage from './HubChatPage';
import { locateChatMarkdownCode } from '../utils/hubChatMarkdown';
import { HUB_CHAT_REF_MAX_LABEL, parseHubChatRefTokens } from '@shared/utils/hubChatRefTokens';
import { api } from '../utils/api';
import type { HubChatChannel, HubChatMessage } from '../utils/hubChat';
import { resetHubChatSessionForTests } from '../utils/hubChatSession';
import { REFRESH_TICK_MS, resetHubChatRefCacheForTests } from '../utils/hubChatRefCache';

const chat = (api as unknown as { hubChat: Record<string, ReturnType<typeof vi.fn>> }).hubChat;

const GENERAL: HubChatChannel = {
  id: 'gen',
  orgId: 'acme',
  kind: 'channel',
  name: 'general',
  topic: null,
  isPrivate: false,
  projectId: null,
  agentId: null,
  dmPeerUserId: null,
  createdByUserId: 'alice',
  archivedAt: null,
  createdAt: '2026-10-13T10:00:00.000Z',
  lastSeq: 1,
  membership: { role: 'member', lastReadSeq: 1, notifyLevel: 'all', mutedUntil: null },
  unreadCount: 0,
  mentionCount: 0,
};

function message(over: Partial<HubChatMessage>): HubChatMessage {
  return {
    id: 'm1',
    channelId: 'gen',
    seq: 1,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: 'hello',
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHubChatSessionForTests();
  resetHubChatRefCacheForTests();
  chat.members.mockResolvedValue({
    members: [
      { userId: 'alice', username: 'alice', role: 'User' },
      { userId: 'bob', username: 'bob', role: 'User' },
    ],
  });
  chat.channels.mockResolvedValue({ channels: [GENERAL], viewerUserId: 'alice' });
  chat.markRead.mockResolvedValue({ lastReadSeq: 1 });
});

describe('composer mentions', () => {
  it('picks a suggestion and sends it as a token', async () => {
    chat.messages.mockResolvedValue({ messages: [], hasMore: false });
    chat.searchRefs.mockResolvedValue({
      suggestions: [
        { kind: 'user', targetId: 'u-bob', label: 'bob', detail: null, projectId: null },
        { kind: 'agent', targetId: 'web-dev', label: 'Web Dev', detail: 'Web', projectId: 'web' },
      ],
    });
    chat.post.mockImplementation((_id: string, body: string) =>
      Promise.resolve({ message: message({ id: 'm2', seq: 2, authorUserId: 'alice', body }) }),
    );
    chat.resolveRefs.mockResolvedValue({ refs: [] });

    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'ping @bo', selectionStart: 8 } });
    await screen.findByTestId('hub-chat-mention-popup');
    expect(chat.searchRefs).toHaveBeenCalledWith('@', 'bo');

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('ping @bob '));
    expect(screen.queryByTestId('hub-chat-mention-popup')).toBeNull();

    fireEvent.change(box, { target: { value: 'ping @bob thanks', selectionStart: 16 } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(chat.post).toHaveBeenCalledWith('gen', 'ping @[bob](user:u-bob) thanks'),
    );
  });
});

describe('message chips', () => {
  it('links visible refs, shows live status, and keeps hidden refs label-only', async () => {
    chat.messages.mockResolvedValue({
      messages: [
        message({
          body: 'see @[WEB-3](card:c3) and @[web#7](pr:web#7) not @[VLT-1](card:c9)',
          refs: [
            { kind: 'card', targetId: 'c3', projectId: 'web' },
            { kind: 'pr', targetId: 'web#7', projectId: 'web' },
            { kind: 'card', targetId: 'c9', projectId: 'vault' },
          ],
        }),
      ],
      hasMore: false,
    });
    const hidden = {
      visible: false,
      projectId: null,
      label: null,
      title: null,
      status: null,
      agentId: null,
      number: null,
    };
    chat.resolveRefs.mockResolvedValue({
      refs: [
        {
          kind: 'card',
          targetId: 'c3',
          visible: true,
          projectId: 'web',
          label: 'WEB-3',
          title: 'Fix login',
          status: 'In Progress',
          agentId: null,
          number: null,
        },
        {
          kind: 'pr',
          targetId: 'web#7',
          visible: true,
          projectId: 'web',
          label: 'web#7',
          title: 'Retry',
          status: 'merged',
          agentId: null,
          number: 7,
        },
        { kind: 'card', targetId: 'c9', ...hidden },
      ],
    });
    const onOpenRef = vi.fn();
    render(<HubChatPage onOpenRef={onOpenRef} />);

    await waitFor(() => expect(screen.getAllByTestId('hub-chat-ref')[0].tagName).toBe('A'));
    expect(chat.resolveRefs).toHaveBeenCalledTimes(1);
    expect(chat.resolveRefs).toHaveBeenCalledWith([
      { kind: 'card', targetId: 'c3' },
      { kind: 'pr', targetId: 'web#7' },
      { kind: 'card', targetId: 'c9' },
    ]);
    const [card, pr, secret] = screen.getAllByTestId('hub-chat-ref');
    expect(card.getAttribute('href')).toBe('/projects/web/board?card=c3');
    expect(card.textContent).toContain('In Progress');
    expect(pr.getAttribute('href')).toBe('/projects/web/pulls/7');
    expect(pr.textContent).toContain('merged');
    expect(secret.tagName).toBe('SPAN');
    expect(secret.getAttribute('data-visible')).toBe('false');
    expect(secret.textContent).toBe('#VLT-1');

    fireEvent.click(pr);
    expect(onOpenRef).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pr', projectId: 'web', number: 7 }),
    );
  });

  it('opens a mention-carrying message in the editor as readable text', async () => {
    chat.messages.mockResolvedValue({
      messages: [message({ authorUserId: 'alice', body: 'hey @[bob](user:u-bob)' })],
      hasMore: false,
    });
    chat.resolveRefs.mockResolvedValue({ refs: [] });
    chat.edit.mockImplementation((_id: string, body: string) =>
      Promise.resolve({ message: message({ authorUserId: 'alice', body, editedAt: 'x' }) }),
    );
    render(<HubChatPage />);
    fireEvent.click(await screen.findByLabelText('Edit message'));
    const editor = screen
      .getAllByLabelText('Edit message')
      .find((el) => el.tagName === 'TEXTAREA') as HTMLTextAreaElement;
    expect(editor.value).toBe('hey @bob');
    fireEvent.change(editor, { target: { value: 'hey @bob!' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.edit).toHaveBeenCalledWith('m1', 'hey @[bob](user:u-bob)!'));
  });
});

describe('composer reference queries', () => {
  it('searches project#number when typing #web#7', async () => {
    chat.messages.mockResolvedValue({ messages: [], hasMore: false });
    chat.searchRefs.mockResolvedValue({
      suggestions: [
        { kind: 'pr', targetId: 'web#7', label: 'web#7', detail: 'Retry', projectId: 'web' },
      ],
    });
    chat.post.mockImplementation((_id: string, body: string) =>
      Promise.resolve({ message: message({ id: 'm2', seq: 2, authorUserId: 'alice', body }) }),
    );
    chat.resolveRefs.mockResolvedValue({ refs: [] });
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'see #web#7', selectionStart: 10 } });
    await screen.findByTestId('hub-chat-mention-popup');
    expect(chat.searchRefs).toHaveBeenLastCalledWith('#', 'web#7');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('see #web#7 '));
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.post).toHaveBeenCalledWith('gen', 'see @[web\\#7](pr:web#7) '));
  });

  it('keeps two picked tickets with the same title distinct', async () => {
    chat.messages.mockResolvedValue({ messages: [], hasMore: false });
    chat.searchRefs
      .mockResolvedValueOnce({
        suggestions: [
          { kind: 'ticket', targetId: 't1', label: 'Login', detail: 'Web', projectId: 'web' },
        ],
      })
      .mockResolvedValueOnce({
        suggestions: [
          { kind: 'ticket', targetId: 't2', label: 'Login', detail: 'Api', projectId: 'api' },
        ],
      });
    chat.post.mockImplementation((_id: string, body: string) =>
      Promise.resolve({ message: message({ id: 'm2', seq: 2, authorUserId: 'alice', body }) }),
    );
    chat.resolveRefs.mockResolvedValue({ refs: [] });
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: '#Log', selectionStart: 4 } });
    await screen.findByTestId('hub-chat-mention-popup');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('#Login '));
    // The picker restores the caret on the next frame; let it land first.
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    fireEvent.change(box, { target: { value: '#Login and #Lo', selectionStart: 14 } });
    await waitFor(() => expect(chat.searchRefs).toHaveBeenLastCalledWith('#', 'Lo'));
    await screen.findByTestId('hub-chat-mention-popup');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('#Login and #Login '));

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(chat.post).toHaveBeenCalledWith('gen', '@[Login](ticket:t1) and @[Login](ticket:t2) '),
    );
  });
});

describe('chip status refresh', () => {
  const cardRef = (status: string) => ({
    kind: 'card',
    targetId: 'c3',
    visible: true,
    projectId: 'web',
    label: 'WEB-3',
    title: 'Fix login',
    status,
    agentId: null,
    number: null,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    chat.messages.mockResolvedValue({
      messages: [message({ body: 'see @[WEB-3](card:c3)' })],
      hasMore: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-resolves a mounted chip once its status goes stale', async () => {
    chat.resolveRefs.mockResolvedValueOnce({ refs: [cardRef('In Progress')] });
    render(<HubChatPage />);
    await waitFor(() =>
      expect(screen.getByTestId('hub-chat-ref').textContent).toContain('In Progress'),
    );
    expect(chat.resolveRefs).toHaveBeenCalledTimes(1);

    // Still fresh: a tick does not refetch.
    chat.resolveRefs.mockResolvedValue({ refs: [cardRef('Done')] });
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_TICK_MS);
    });
    expect(chat.resolveRefs).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(screen.getByTestId('hub-chat-ref').textContent).toContain('Done'));
    expect(chat.resolveRefs).toHaveBeenCalledTimes(2);
  });

  it('retries a lookup that failed', async () => {
    chat.resolveRefs.mockRejectedValueOnce(new Error('offline'));
    render(<HubChatPage />);
    await waitFor(() => expect(chat.resolveRefs).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('hub-chat-ref').getAttribute('data-visible')).toBe('false');

    chat.resolveRefs.mockResolvedValue({ refs: [cardRef('In Progress')] });
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_TICK_MS);
    });
    await waitFor(() =>
      expect(screen.getByTestId('hub-chat-ref').getAttribute('data-visible')).toBe('true'),
    );
  });
});

describe('stale suggestions', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const user = (id: string, label: string) => ({
    kind: 'user',
    targetId: id,
    label,
    detail: null,
    projectId: null,
  });

  beforeEach(() => {
    chat.messages.mockResolvedValue({ messages: [], hasMore: false });
    chat.resolveRefs.mockResolvedValue({ refs: [] });
  });

  it('does not pick an older list into a newer query', async () => {
    const forAl = deferred<{ suggestions: unknown[] }>();
    chat.searchRefs
      .mockResolvedValueOnce({ suggestions: [user('u-bob', 'bob')] })
      .mockReturnValueOnce(forAl.promise);
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: '@bo', selectionStart: 3 } });
    await screen.findByTestId('hub-chat-mention-popup');

    // The query changes; its results have not arrived yet.
    fireEvent.change(box, { target: { value: '@al', selectionStart: 3 } });
    expect(screen.queryByTestId('hub-chat-mention-popup')).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).not.toContain('@bob');
    await waitFor(() => expect(chat.searchRefs).toHaveBeenLastCalledWith('@', 'al'));

    // Once the matching results land they are the ones offered.
    await act(async () => forAl.resolve({ suggestions: [user('u-alice', 'alice')] }));
    await screen.findByTestId('hub-chat-mention-popup');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('@alice '));
  });

  it('ignores a late response for a query the user already left', async () => {
    const forBo = deferred<{ suggestions: unknown[] }>();
    chat.searchRefs.mockReturnValueOnce(forBo.promise).mockResolvedValueOnce({ suggestions: [] });
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@bo', selectionStart: 3 } });
    await waitFor(() => expect(chat.searchRefs).toHaveBeenCalledWith('@', 'bo'));
    fireEvent.change(box, { target: { value: '#WEB', selectionStart: 4 } });
    await waitFor(() => expect(chat.searchRefs).toHaveBeenLastCalledWith('#', 'WEB'));
    await act(async () => forBo.resolve({ suggestions: [user('u-bob', 'bob')] }));
    expect(screen.queryByTestId('hub-chat-mention-popup')).toBeNull();
  });

  it('sends a parseable token for a suggestion with a very long label', async () => {
    const subject = 'Safari login loop '.repeat(20).trim();
    chat.searchRefs.mockResolvedValue({
      suggestions: [
        { kind: 'ticket', targetId: 't-long', label: subject, detail: null, projectId: 'web' },
      ],
    });
    chat.post.mockImplementation((_id: string, body: string) =>
      Promise.resolve({ message: message({ id: 'm2', seq: 2, authorUserId: 'alice', body }) }),
    );
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '#saf', selectionStart: 4 } });
    await screen.findByTestId('hub-chat-mention-popup');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value.startsWith('#Safari')).toBe(true));
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.post).toHaveBeenCalled());
    const sent = chat.post.mock.calls[0][1] as string;
    const tokens = parseHubChatRefTokens(sent, locateChatMarkdownCode);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: 'ticket', targetId: 't-long' });
    expect(tokens[0].label.length).toBeLessThanOrEqual(HUB_CHAT_REF_MAX_LABEL);
  });
});

describe('literal code in messages', () => {
  it('renders an indented-code token as code, with no chip or lookup', async () => {
    chat.messages.mockResolvedValue({
      messages: [message({ body: 'example:\n\n    @[bob](user:u-bob)' })],
      hasMore: false,
    });
    chat.resolveRefs.mockResolvedValue({ refs: [] });
    render(<HubChatPage />);
    const code = await screen.findByText('@[bob](user:u-bob)');
    expect(code.closest('pre')).not.toBeNull();
    expect(screen.queryByTestId('hub-chat-ref')).toBeNull();
    expect(chat.resolveRefs).not.toHaveBeenCalled();
  });
});

describe('editing emphasised mentions', () => {
  it('saves an unchanged _@mention_ with its token intact', async () => {
    chat.messages.mockResolvedValue({
      messages: [message({ authorUserId: 'alice', body: 'thanks _@[bob](user:u-bob)_' })],
      hasMore: false,
    });
    chat.resolveRefs.mockResolvedValue({ refs: [] });
    chat.edit.mockImplementation((_id: string, body: string) =>
      Promise.resolve({ message: message({ authorUserId: 'alice', body, editedAt: 'x' }) }),
    );
    render(<HubChatPage />);
    fireEvent.click(await screen.findByLabelText('Edit message'));
    const editor = screen
      .getAllByLabelText('Edit message')
      .find((el) => el.tagName === 'TEXTAREA') as HTMLTextAreaElement;
    expect(editor.value).toBe('thanks _@bob_');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() =>
      expect(chat.edit).toHaveBeenCalledWith('m1', 'thanks _@[bob](user:u-bob)_'),
    );
  });
});

describe('IME composition', () => {
  it('lets Enter confirm a composition instead of picking a suggestion', async () => {
    chat.messages.mockResolvedValue({ messages: [], hasMore: false });
    chat.resolveRefs.mockResolvedValue({ refs: [] });
    chat.searchRefs.mockResolvedValue({
      suggestions: [
        { kind: 'user', targetId: 'u-bob', label: 'bob', detail: null, projectId: null },
      ],
    });
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@ぼ', selectionStart: 2 } });
    await screen.findByTestId('hub-chat-mention-popup');

    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(box, { key: 'Tab', keyCode: 229 });
    expect(box.value).toBe('@ぼ');
    expect(chat.post).not.toHaveBeenCalled();
    expect(screen.getByTestId('hub-chat-mention-popup')).toBeTruthy();

    // Once composition ends, Enter picks as usual.
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('@bob '));
  });

  it('does not swallow a composing Enter while results are pending', async () => {
    chat.messages.mockResolvedValue({ messages: [], hasMore: false });
    chat.searchRefs.mockReturnValue(new Promise(() => {}));
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@ぼ', selectionStart: 2 } });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'isComposing', { value: true });
    box.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(chat.post).not.toHaveBeenCalled();
  });
});

describe('escaped tokens in messages', () => {
  it('renders no chip and makes no lookup for an escaped token', async () => {
    chat.messages.mockResolvedValue({
      messages: [message({ body: 'literal \\@[bob](user:u-bob)' })],
      hasMore: false,
    });
    chat.resolveRefs.mockResolvedValue({ refs: [] });
    render(<HubChatPage />);
    await screen.findByTestId('hub-chat-body');
    expect(screen.queryByTestId('hub-chat-ref')).toBeNull();
    expect(chat.resolveRefs).not.toHaveBeenCalled();
  });
});

describe('refs next to Markdown that could change their node type', () => {
  it('renders a chip after "!" instead of an image', async () => {
    chat.messages.mockResolvedValue({
      messages: [message({ body: 'wow!@[WEB-3](card:c3) and !@[bob](user:u-bob)' })],
      hasMore: false,
    });
    chat.resolveRefs.mockResolvedValue({
      refs: [
        {
          kind: 'card',
          targetId: 'c3',
          visible: true,
          projectId: 'web',
          label: 'WEB-3',
          title: 'Fix login',
          status: 'In Progress',
          agentId: null,
          number: null,
        },
        {
          kind: 'user',
          targetId: 'u-bob',
          visible: true,
          projectId: null,
          label: 'bob',
          title: null,
          status: null,
          agentId: null,
          number: null,
        },
      ],
    });
    const onOpenRef = vi.fn();
    render(<HubChatPage onOpenRef={onOpenRef} />);
    await waitFor(() => expect(screen.getAllByTestId('hub-chat-ref')[0].tagName).toBe('A'));
    const body = screen.getByTestId('hub-chat-body');
    expect(body.querySelector('img')).toBeNull();
    const [card, bob] = screen.getAllByTestId('hub-chat-ref');
    expect(card.getAttribute('href')).toBe('/projects/web/board?card=c3');
    expect(bob.textContent).toContain('@bob');
    // The chip carries the trigger; no stray "@" is left in the text.
    expect(body.textContent).toBe('wow!#WEB-3In Progress and !@bob');
    fireEvent.click(card);
    expect(onOpenRef).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'card', targetId: 'c3' }),
    );
  });
});

describe('joining a mention to a word by deleting', () => {
  it('sends plain text once deleting a space makes @bob into @bobby', async () => {
    chat.messages.mockResolvedValue({ messages: [], hasMore: false });
    chat.resolveRefs.mockResolvedValue({ refs: [] });
    chat.searchRefs
      .mockResolvedValueOnce({
        suggestions: [
          { kind: 'user', targetId: 'u-bob', label: 'bob', detail: null, projectId: null },
        ],
      })
      .mockResolvedValue({ suggestions: [] });
    chat.post.mockImplementation((_id: string, body: string) =>
      Promise.resolve({ message: message({ id: 'm2', seq: 2, authorUserId: 'alice', body }) }),
    );
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@bo', selectionStart: 3 } });
    await screen.findByTestId('hub-chat-mention-popup');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('@bob '));
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    fireEvent.change(box, { target: { value: '@bob by', selectionStart: 7 } });
    fireEvent.change(box, { target: { value: '@bobby', selectionStart: 4 } });
    // Caret to the end; nobody is called "bobby", so Enter sends.
    box.setSelectionRange(6, 6);
    fireEvent.select(box);
    await waitFor(() => expect(chat.searchRefs).toHaveBeenLastCalledWith('@', 'bobby'));
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.post).toHaveBeenCalledWith('gen', '@bobby'));
  });
});
