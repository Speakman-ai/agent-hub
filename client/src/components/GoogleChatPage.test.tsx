import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    listGoogleChatSpaces: vi.fn(),
    listGoogleChatMessages: vi.fn(),
    sendGoogleChatMessage: vi.fn(),
    startGoogleOAuth: vi.fn(),
    listGoogleChatMessageLinks: vi.fn(),
    createGoogleChatMessageLink: vi.fn(),
    listGoogleChatDrafts: vi.fn(),
    getGoogleChatSettings: vi.fn(),
    setGoogleChatSettings: vi.fn(),
    approveGoogleChatDraft: vi.fn(),
    editGoogleChatDraft: vi.fn(),
    discardGoogleChatDraft: vi.fn(),
    createTodo: vi.fn(),
    ensureGoogleChatSubscription: vi.fn(),
    listGoogleChatUnread: vi.fn(),
    markGoogleChatSpaceRead: vi.fn(),
  },
}));

const startSessionProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('./StartSessionModal', () => ({
  default: (props: Record<string, unknown>) => {
    startSessionProps.last = props;
    return <div data-testid="start-session-modal">{String(props.seedMessage)}</div>;
  },
}));

const ticketProps = vi.hoisted(() => ({ last: null as null | Record<string, any> }));
vi.mock('./CaptureToTicketModal', () => ({
  default: (props: Record<string, any>) => {
    ticketProps.last = props;
    return <div data-testid="ticket-modal">{props.draft.title}</div>;
  },
}));

import GoogleChatPage, { LINKS_UNKNOWN_WARNING } from './GoogleChatPage';
import { api } from '../utils/api';
import { CHAT_SURFACE_SCOPES } from '../utils/googleSurface';
import { compareRfc3339 } from '@shared/utils/rfc3339';
import { chatPushStore, resetChatPushStore } from '../utils/googleChatPush';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const ALL_SCOPES = [...CHAT_SURFACE_SCOPES];

const SPACE = {
  name: 'spaces/AAA',
  id: 'AAA',
  displayName: 'Acme support',
  spaceType: 'SPACE',
  singleUserBotDm: false,
  spaceThreadingState: 'THREADED_MESSAGES',
  supportsThreadReplies: true,
  lastActiveTime: '2026-10-08T10:00:00Z',
  spaceUri: 'https://chat.google.com/room/AAA',
};

function msg(overrides: Record<string, unknown>) {
  return {
    name: 'spaces/AAA/messages/M',
    id: 'M',
    spaceName: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/T1',
    threadReply: false,
    text: 'hello',
    createTime: '2026-10-08T10:00:00Z',
    lastUpdateTime: null,
    deleted: false,
    attachmentCount: 0,
    sender: { name: 'users/111222333', displayName: null, type: 'HUMAN' },
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.listGoogleChatDrafts.mockResolvedValue({ drafts: [] });
  mockApi.getGoogleChatSettings.mockResolvedValue({ autoSendAgentReplies: false });
  resetChatPushStore();
  startSessionProps.last = null;
  ticketProps.last = null;
});

describe('GoogleChatPage', () => {
  it('offers Enable Chat and requests the Chat surface scopes when consent is missing', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      email: 'me@acme.com',
      grantedScopes: ['openid'],
      serverConfigured: true,
    });
    mockApi.startGoogleOAuth.mockResolvedValue({ authorizeUrl: 'about:blank' });

    render(<GoogleChatPage />);

    const button = await screen.findByRole('button', { name: /Enable Chat/i });
    expect(mockApi.listGoogleChatSpaces).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(mockApi.startGoogleOAuth).toHaveBeenCalled());
    expect(mockApi.startGoogleOAuth.mock.calls[0][0].scopes).toEqual(CHAT_SURFACE_SCOPES);
  });

  it('lists messages oldest-first and seeds an agent session with thread context', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      email: 'me@acme.com',
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE], nextPageToken: null });
    // The proxy returns newest first; the pane must flip it.
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [
        msg({
          name: 'spaces/AAA/messages/M2',
          id: 'M2',
          text: 'Please reset the staging DB for tenant 42',
          createTime: '2026-10-08T10:05:00Z',
          threadReply: true,
        }),
        msg({ name: 'spaces/AAA/messages/M1', id: 'M1', text: 'Staging is broken' }),
      ],
      nextPageToken: null,
    });

    render(<GoogleChatPage />);

    await screen.findByText('Please reset the staging DB for tenant 42');
    expect(mockApi.listGoogleChatMessages).toHaveBeenCalledWith('AAA', {
      pageSize: 50,
      order: 'desc',
    });
    const items = screen.getAllByRole('listitem').map((li) => li.textContent || '');
    expect(items[0]).toContain('Staging is broken');
    expect(items[1]).toContain('Please reset the staging DB');

    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[1]);

    const modal = await screen.findByTestId('start-session-modal');
    const seed = modal.textContent || '';
    expect(seed).toContain('**Space:** Acme support');
    expect(seed).toContain('**Chat reference:** spaces/AAA (thread spaces/AAA/threads/T1)');
    expect(seed).toContain('**Link:** https://chat.google.com/room/AAA');
    expect(seed).toContain('> User 222333: Staging is broken');
    expect(seed).toContain('Please reset the staging DB for tenant 42');
    expect(startSessionProps.last?.contextLabel).toBe(
      'Chat: Please reset the staging DB for tenant 42',
    );
  });

  it('shows an agent draft under its thread message and approves it', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [msg({ text: 'Can you help?' })],
    });
    const draft = {
      id: 'd-1',
      sessionId: 's-1',
      spaceId: 'AAA',
      threadName: 'spaces/AAA/threads/T1',
      text: 'Done, staging is reset.',
      revision: 3,
      status: 'pending',
      error: null,
      sentMessageName: null,
      createdAt: '2026-10-08T10:01:00Z',
      updatedAt: '2026-10-08T10:01:00Z',
    };
    mockApi.listGoogleChatDrafts.mockResolvedValue({ drafts: [draft] });
    mockApi.approveGoogleChatDraft.mockResolvedValue({ draft: { ...draft, status: 'sent' } });

    render(<GoogleChatPage />);

    const card = await screen.findByTestId('chat-draft-d-1');
    expect(card.closest('li')?.textContent).toContain('Can you help?');
    expect(card.textContent).toContain('awaiting your approval');
    expect(mockApi.listGoogleChatDrafts).toHaveBeenCalledWith({
      sessionId: undefined,
      spaceId: 'AAA',
    });

    fireEvent.click(screen.getByRole('button', { name: /Approve and send/i }));
    await waitFor(() =>
      expect(mockApi.approveGoogleChatDraft).toHaveBeenCalledWith('d-1', 3, undefined),
    );
    await waitFor(() => expect(screen.queryByTestId('chat-draft-d-1')).toBeNull());
  });

  it('saves the auto-send setting from the toggle', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });
    mockApi.setGoogleChatSettings.mockResolvedValue({ autoSendAgentReplies: true });

    render(<GoogleChatPage />);

    const toggle = (await screen.findByTestId('chat-auto-send-toggle')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockApi.setGoogleChatSettings).toHaveBeenCalledWith({ autoSendAgentReplies: true }),
    );
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it('keeps showing an error after a failed draft load and Refresh recovers it', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });
    mockApi.listGoogleChatDrafts
      .mockReset()
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValue({
        drafts: [
          {
            id: 'd-9',
            sessionId: 's-1',
            spaceId: 'AAA',
            threadName: null,
            text: 'Recovered draft',
            revision: 1,
            status: 'pending',
            error: null,
            sentMessageName: null,
            createdAt: '2026-10-08T10:01:00Z',
            updatedAt: '2026-10-08T10:01:00Z',
          },
        ],
      });

    render(<GoogleChatPage />);
    expect((await screen.findByTestId('chat-drafts-load-error')).textContent).toContain(
      'Network down',
    );
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByTestId('chat-draft-d-9')).toBeTruthy();
    expect(screen.queryByTestId('chat-drafts-load-error')).toBeNull();
  });

  it('saves one auto-send change at a time so the last choice wins', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });
    let finishEnable!: (v: unknown) => void;
    mockApi.setGoogleChatSettings
      .mockReturnValueOnce(new Promise((r) => (finishEnable = r)))
      .mockResolvedValueOnce({ autoSendAgentReplies: false });

    render(<GoogleChatPage />);
    const toggle = (await screen.findByTestId('chat-auto-send-toggle')) as HTMLInputElement;

    fireEvent.click(toggle); // enable: request in flight
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle); // a quick second click must not start an overlapping write
    expect(mockApi.setGoogleChatSettings).toHaveBeenCalledTimes(1);

    await act(async () => finishEnable({ autoSendAgentReplies: true }));
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle); // disable, now that the first write finished
    await waitFor(() => expect(mockApi.setGoogleChatSettings).toHaveBeenCalledTimes(2));
    expect(mockApi.setGoogleChatSettings.mock.calls.map((c) => c[0])).toEqual([
      { autoSendAgentReplies: true },
      { autoSendAgentReplies: false },
    ]);
    await waitFor(() => expect(toggle.checked).toBe(false));
  });

  it('replies in the selected thread through the proxy', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [msg({ text: 'Can you help?' })],
    });
    mockApi.sendGoogleChatMessage.mockResolvedValue({});

    render(<GoogleChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Reply in thread/i }));
    fireEvent.change(screen.getByPlaceholderText('Message Acme support'), {
      target: { value: 'On it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.sendGoogleChatMessage).toHaveBeenCalledWith('AAA', {
        text: 'On it',
        threadName: 'spaces/AAA/threads/T1',
      }),
    );
  });

  it('ignores a slower response for a space the user already left', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    const SPACE_B = { ...SPACE, name: 'spaces/BBB', id: 'BBB', displayName: 'Beta' };
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE, SPACE_B] });
    let resolveA: (v: unknown) => void = () => undefined;
    mockApi.listGoogleChatMessages.mockImplementation((spaceId: string) =>
      spaceId === 'AAA'
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve({
            messages: [
              msg({ name: 'spaces/BBB/messages/B1', spaceName: 'spaces/BBB', text: 'from B' }),
            ],
          }),
    );

    render(<GoogleChatPage />);

    // AAA is auto-selected and its request hangs; switch to BBB, which answers.
    fireEvent.click(await screen.findByTestId('chat-space-BBB'));
    await screen.findByText('from B');

    resolveA({ messages: [msg({ text: 'stale from A' })] });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText('stale from A')).toBeNull();
    expect(screen.getByText('from B')).toBeInTheDocument();
    expect(screen.queryByText(/Loading messages/)).toBeNull();
  });

  it('sends once when Enter is pressed again while a send is in flight', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });
    let finishSend: (v: unknown) => void = () => undefined;
    mockApi.sendGoogleChatMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSend = resolve;
        }),
    );

    render(<GoogleChatPage />);

    const box = await screen.findByPlaceholderText('Message Acme support');
    fireEvent.change(box, { target: { value: 'Looking into it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(mockApi.sendGoogleChatMessage).toHaveBeenCalledTimes(1));
    finishSend({});
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
    expect(mockApi.sendGoogleChatMessage).toHaveBeenCalledTimes(1);
  });

  it('captures a message to a ticket with its source reference', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [
        msg({
          name: 'spaces/AAA/messages/M9',
          text: 'Invoice 1042 shows the wrong total\nCustomer: Acme',
          sender: { name: 'users/1', displayName: 'Dana', type: 'HUMAN' },
        }),
      ],
    });

    render(<GoogleChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Ticket/ }));
    await screen.findByTestId('ticket-modal');
    const draft = ticketProps.last?.draft;
    expect(draft.title).toBe('Invoice 1042 shows the wrong total');
    expect(draft.description).toContain('From Dana in Acme support');
    expect(draft.description).toContain('Customer: Acme');
    expect(draft.description).toContain('Source: https://chat.google.com/room/AAA');
    expect(draft.source).toEqual({
      sourceType: 'chat',
      sourceId: 'spaces/AAA/messages/M9',
      sourceMeta: {
        kind: 'google-chat',
        messageName: 'spaces/AAA/messages/M9',
        spaceName: 'spaces/AAA',
        threadName: 'spaces/AAA/threads/T1',
        from: 'Dana',
        deepLink: 'https://chat.google.com/room/AAA',
      },
    });
  });

  it('adds a message to todos with its chat provenance', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [
        msg({
          name: 'spaces/AAA/messages/M9',
          text: 'Invoice 1042 shows the wrong total\nCustomer: Acme',
          sender: { name: 'users/1', displayName: 'Dana', type: 'HUMAN' },
        }),
      ],
    });
    mockApi.createTodo.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});

    render(<GoogleChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add to todos' }));
    expect((await screen.findByRole('alert')).textContent).toBe('offline');

    fireEvent.click(screen.getByRole('button', { name: 'Add to todos' }));
    const added = await screen.findByRole('button', { name: 'Added to todos' });
    expect((added as HTMLButtonElement).disabled).toBe(true);
    expect(mockApi.createTodo).toHaveBeenCalledTimes(2);
    expect(mockApi.createTodo).toHaveBeenLastCalledWith({
      title: 'Invoice 1042 shows the wrong total',
      notes: 'From Dana in Acme support\n\nInvoice 1042 shows the wrong total\nCustomer: Acme',
      sourceType: 'chat',
      sourceId: 'spaces/AAA/messages/M9',
      sourceMeta: {
        kind: 'google-chat',
        messageName: 'spaces/AAA/messages/M9',
        spaceName: 'spaces/AAA',
        threadName: 'spaces/AAA/threads/T1',
        from: 'Dana',
        deepLink: 'https://chat.google.com/room/AAA',
      },
    });
  });

  function deferred<T = unknown>() {
    let resolve: (v: T) => void = () => undefined;
    let reject: (e: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const SPACE_B = { ...SPACE, name: 'spaces/BBB', id: 'BBB', displayName: 'Beta' };

  function connectedAll() {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
  }

  it('follows space page tokens so conversations past the first page are reachable', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockImplementation(({ pageToken }: { pageToken?: string }) =>
      Promise.resolve(
        pageToken === 'p2'
          ? {
              spaces: [{ ...SPACE_B, lastActiveTime: '2026-10-08T12:00:00Z' }],
              nextPageToken: null,
            }
          : { spaces: [SPACE], nextPageToken: 'p2' },
      ),
    );
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });

    render(<GoogleChatPage />);

    expect(await screen.findByTestId('chat-space-BBB')).toBeInTheDocument();
    expect(screen.getByTestId('chat-space-AAA')).toBeInTheDocument();
    expect(mockApi.listGoogleChatSpaces).toHaveBeenCalledTimes(2);
    expect(mockApi.listGoogleChatSpaces.mock.calls[1][0]).toMatchObject({ pageToken: 'p2' });
    // Combined pages are re-sorted by activity: BBB (page 2) is newer.
    const order = screen.getAllByTestId(/^chat-space-/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['chat-space-BBB', 'chat-space-AAA']);
  });

  it("a send finishing in the old space doesn't strand the new space's load", async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE, SPACE_B] });
    const loadB = deferred();
    mockApi.listGoogleChatMessages.mockImplementation((spaceId: string) =>
      spaceId === 'BBB' ? loadB.promise : Promise.resolve({ messages: [msg({ text: 'from A' })] }),
    );
    const sendA = deferred();
    mockApi.sendGoogleChatMessage.mockReturnValue(sendA.promise);

    render(<GoogleChatPage />);

    await screen.findByText('from A');
    const box = screen.getByPlaceholderText('Message Acme support');
    fireEvent.change(box, { target: { value: 'hello A' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(mockApi.sendGoogleChatMessage).toHaveBeenCalledTimes(1));

    // Switch to B while A's send is pending; B's load is pending too.
    fireEvent.click(screen.getByTestId('chat-space-BBB'));
    await screen.findByText(/Loading messages/);

    // A's send completes first and triggers A's refresh, then B answers.
    sendA.resolve({});
    await waitFor(() =>
      expect(mockApi.listGoogleChatMessages.mock.calls.filter((c) => c[0] === 'AAA').length).toBe(
        2,
      ),
    );
    loadB.resolve({
      messages: [msg({ name: 'spaces/BBB/messages/B1', spaceName: 'spaces/BBB', text: 'from B' })],
    });

    expect(await screen.findByText('from B')).toBeInTheDocument();
    expect(screen.queryByText('from A')).toBeNull();
    expect(screen.queryByText(/Loading messages/)).toBeNull();
  });

  it('keeps text typed while a send is pending', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });
    const sendFirst = deferred();
    mockApi.sendGoogleChatMessage.mockReturnValue(sendFirst.promise);

    render(<GoogleChatPage />);

    const box = (await screen.findByPlaceholderText('Message Acme support')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe(''));

    fireEvent.change(box, { target: { value: 'second, not sent yet' } });
    sendFirst.resolve({});

    await waitFor(() => expect(mockApi.listGoogleChatMessages).toHaveBeenCalledTimes(2));
    expect(box.value).toBe('second, not sent yet');
    expect(mockApi.sendGoogleChatMessage).toHaveBeenCalledWith('AAA', { text: 'first' });
  });

  it('restores the message for retry when a send fails and the box is untouched', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [msg({ text: 'Help?' })] });
    mockApi.sendGoogleChatMessage.mockRejectedValue(new Error('Google Chat rate limit exceeded'));

    render(<GoogleChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Reply in thread/i }));
    const box = screen.getByPlaceholderText('Message Acme support') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'On it' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(await screen.findByText('Google Chat rate limit exceeded')).toBeInTheDocument();
    expect(box.value).toBe('On it');
    expect(screen.getByText(/Replying to/)).toBeInTheDocument();
  });

  const READ_ONLY = [
    'https://www.googleapis.com/auth/chat.spaces.readonly',
    'https://www.googleapis.com/auth/chat.messages.readonly',
  ];
  const CREATE = 'https://www.googleapis.com/auth/chat.messages.create';

  it('read-only grant keeps messages visible and offers Enable sending', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: READ_ONLY,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [msg({ text: 'Need help' })] });
    mockApi.startGoogleOAuth.mockResolvedValue({ authorizeUrl: 'about:blank' });

    render(<GoogleChatPage />);

    expect(await screen.findByText('Need help')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Message Acme support')).toBeNull();
    expect(screen.queryByRole('button', { name: /Reply in thread/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Send to agent/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Enable sending/i }));
    await waitFor(() => expect(mockApi.startGoogleOAuth).toHaveBeenCalledTimes(1));
    expect(mockApi.startGoogleOAuth.mock.calls[0][0].scopes).toEqual([CREATE]);
  });

  it('partial read grant asks only for what is missing', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: [READ_ONLY[0], CREATE],
      serverConfigured: true,
    });
    mockApi.startGoogleOAuth.mockResolvedValue({ authorizeUrl: 'about:blank' });

    render(<GoogleChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Enable Chat/i }));
    await waitFor(() => expect(mockApi.startGoogleOAuth).toHaveBeenCalledTimes(1));
    expect(mockApi.startGoogleOAuth.mock.calls[0][0].scopes).toEqual([
      READ_ONLY[1],
      'https://www.googleapis.com/auth/chat.memberships.readonly',
    ]);
    expect(mockApi.listGoogleChatSpaces).not.toHaveBeenCalled();
  });

  it('a send-scope 403 re-reads consent and switches to Enable sending', async () => {
    mockApi.getGoogleStatus
      .mockResolvedValueOnce({ connected: true, grantedScopes: ALL_SCOPES, serverConfigured: true })
      .mockResolvedValue({ connected: true, grantedScopes: READ_ONLY, serverConfigured: true });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });
    mockApi.sendGoogleChatMessage.mockRejectedValue(
      Object.assign(new Error('Required Google Chat access has not been granted'), {
        status: 403,
        code: 'google_chat_send_scope_required',
      }),
    );

    render(<GoogleChatPage />);

    const box = await screen.findByPlaceholderText('Message Acme support');
    // The push store reads status too; count only reads caused by the send.
    await waitFor(() => expect(mockApi.ensureGoogleChatSubscription).toHaveBeenCalled());
    const readsBefore = mockApi.getGoogleStatus.mock.calls.length;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(await screen.findByRole('button', { name: /Enable sending/i })).toBeInTheDocument();
    expect(mockApi.getGoogleStatus).toHaveBeenCalledTimes(readsBefore + 1);
  });

  it('Enter that confirms an IME composition does not send; plain Enter does', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });
    mockApi.sendGoogleChatMessage.mockResolvedValue({});

    render(<GoogleChatPage />);

    const box = await screen.findByPlaceholderText('Message Acme support');
    fireEvent.change(box, { target: { value: '確認します' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.sendGoogleChatMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(mockApi.sendGoogleChatMessage).toHaveBeenCalledWith('AAA', { text: '確認します' }),
    );
  });

  /**
   * A tiny stand-in for one Chat space: newest-first listing with the proxy's
   * since/before bounds, offset page tokens, and showDeleted tombstones.
   */
  function fakeSpace(initial: ReturnType<typeof msg>[]) {
    const store = initial.map((m) => ({ ...m }));
    const list = (
      _space: string,
      opts: { pageSize?: number; pageToken?: string; since?: string; until?: string },
    ) => {
      // Inclusive, exact bounds, as the proxy sends them; ties keep a stable
      // order like Google's own pagination.
      const rows = store
        .filter((m) => !opts.since || compareRfc3339(m.createTime, opts.since) >= 0)
        .filter((m) => !opts.until || compareRfc3339(m.createTime, opts.until) <= 0)
        .sort((x, y) => compareRfc3339(y.createTime, x.createTime) || (x.name! < y.name! ? 1 : -1));
      const start = opts.pageToken ? Number(opts.pageToken) : 0;
      const size = opts.pageSize ?? 25;
      const page = rows.slice(start, start + size);
      const next = start + size < rows.length ? String(start + size) : null;
      return Promise.resolve({ messages: page.map((m) => ({ ...m })), nextPageToken: next });
    };
    return {
      list,
      remove(name: string) {
        const m = store.find((x) => x.name === name)!;
        Object.assign(m, { deleted: true, text: null });
      },
      add(m: ReturnType<typeof msg>) {
        store.push(m);
      },
    };
  }

  // 60 messages, one per minute: the newest 50 load first, 10 are older.
  function history() {
    return Array.from({ length: 60 }, (_, i) =>
      msg({
        name: `spaces/AAA/messages/M${i}`,
        text: i === 0 ? 'oldest' : i === 59 ? 'newest' : `message ${i}`,
        createTime: new Date(Date.UTC(2026, 9, 8, 9, i)).toISOString(),
      }),
    );
  }

  it('pages back by time and keeps loaded history across refreshes', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    const space = fakeSpace(history());
    mockApi.listGoogleChatMessages.mockImplementation(space.list);

    render(<GoogleChatPage />);

    await screen.findByText('newest');
    expect(screen.queryByText('oldest')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(50);

    fireEvent.click(screen.getByRole('button', { name: /Load older messages/i }));
    await screen.findByText('oldest');
    const olderCall = mockApi.listGoogleChatMessages.mock.calls.find((c) => c[1]?.until);
    expect(olderCall?.[1]).toEqual({
      pageSize: 50,
      order: 'desc',
      until: '2026-10-08T09:10:00.000Z',
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    expect(screen.getByText('Start of conversation')).toBeInTheDocument();

    // Refresh (same path as the 30s poll) re-reads the whole loaded range.
    space.add(
      msg({
        name: 'spaces/AAA/messages/LATE',
        text: 'arrived later',
        createTime: '2026-10-08T11:00:00.000Z',
      }),
    );
    // A message from the older page (outside the newest 50) is deleted in Chat.
    space.remove('spaces/AAA/messages/M5');
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await screen.findByText('arrived later');
    expect(screen.queryByText('message 5')).toBeNull();
    expect(screen.getByText('Message deleted')).toBeInTheDocument();
    const refreshCall = mockApi.listGoogleChatMessages.mock.calls.find((c) => c[1]?.since);
    expect(refreshCall?.[1]).toMatchObject({ since: '2026-10-08T09:00:00.000Z', order: 'desc' });
    expect(screen.getAllByRole('listitem')).toHaveLength(61);
    expect(screen.getByText('oldest')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load older messages/i })).toBeNull();
  });

  it('a message deleted after loading shows as deleted and loses its actions', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    const space = fakeSpace([
      msg({
        name: 'spaces/AAA/messages/A',
        text: 'Please refund order 77',
        createTime: '2026-10-08T10:00:00Z',
      }),
      msg({ name: 'spaces/AAA/messages/B', text: 'Thanks!', createTime: '2026-10-08T10:05:00Z' }),
    ]);
    mockApi.listGoogleChatMessages.mockImplementation(space.list);

    render(<GoogleChatPage />);

    await screen.findByText('Please refund order 77');
    expect(screen.getAllByRole('button', { name: /Send to agent/i })).toHaveLength(2);

    space.remove('spaces/AAA/messages/A');
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));

    await screen.findByText('Message deleted');
    expect(screen.queryByText('Please refund order 77')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Send to agent/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Ticket$/ })).toHaveLength(1);
  });

  it('loads every message that shares the boundary timestamp across pages', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    // 120 messages. M10..M69 all share one timestamp, so the tie spans the
    // newest page boundary and the next one.
    const tie = '2026-10-08T09:30:00.000000Z';
    const all = Array.from({ length: 120 }, (_, i) =>
      msg({
        name: `spaces/AAA/messages/M${String(i).padStart(3, '0')}`,
        text: `message ${i}`,
        createTime:
          i < 10
            ? new Date(Date.UTC(2026, 9, 8, 9, 0, i)).toISOString()
            : i < 70
              ? tie
              : new Date(Date.UTC(2026, 9, 8, 10, 0, i - 70)).toISOString(),
      }),
    );
    mockApi.listGoogleChatMessages.mockImplementation(fakeSpace(all).list);

    render(<GoogleChatPage />);

    await screen.findByText('message 119');
    while (screen.queryByRole('button', { name: /Load older messages/i })) {
      fireEvent.click(screen.getByRole('button', { name: /Load older messages/i }));
      await waitFor(() =>
        expect(
          screen
            .queryByRole('button', { name: /Load older messages/i })
            ?.hasAttribute('disabled') ?? false,
        ).toBe(false),
      );
    }

    await screen.findByText('Start of conversation');
    expect(screen.getAllByRole('listitem')).toHaveLength(120);
    // Every page after the first continues the one anchored query.
    const olderCalls = mockApi.listGoogleChatMessages.mock.calls.filter((c) => c[1]?.until);
    expect(new Set(olderCalls.map((c) => c[1].until)).size).toBe(1);
    expect(olderCalls.slice(1).every((c) => !!c[1].pageToken)).toBe(true);
  });

  it('keeps sub-millisecond precision at the older-history boundary', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    // 50 newest messages, the oldest of them at .123900; one older message in
    // the same millisecond at .123500 that rounding to ms would skip.
    const newest = Array.from({ length: 50 }, (_, i) =>
      msg({
        name: `spaces/AAA/messages/N${String(i).padStart(2, '0')}`,
        text: `recent ${i}`,
        createTime:
          i === 0
            ? '2026-10-08T10:00:00.123900Z'
            : `2026-10-08T10:00:${String(i).padStart(2, '0')}.000000Z`,
      }),
    );
    const hidden = msg({
      name: 'spaces/AAA/messages/SUBMS',
      text: 'same millisecond, slightly older',
      createTime: '2026-10-08T10:00:00.123500Z',
    });
    mockApi.listGoogleChatMessages.mockImplementation(fakeSpace([hidden, ...newest]).list);

    render(<GoogleChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Load older messages/i }));
    await screen.findByText('same millisecond, slightly older');
    const olderCall = mockApi.listGoogleChatMessages.mock.calls.find((c) => c[1]?.until);
    expect(olderCall?.[1].until).toBe('2026-10-08T10:00:00.123900Z');
    expect(screen.getByText('Start of conversation')).toBeInTheDocument();
    // Ordered exactly: the hidden message sits above the .123900 one.
    const items = screen.getAllByRole('listitem').map((li) => li.textContent || '');
    expect(items[0]).toContain('same millisecond, slightly older');
    expect(items[1]).toContain('recent 0');
  });

  it('older messages can be sent to an agent', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    const all = history();
    all[0] = { ...all[0], text: 'Old request: rotate keys' };
    mockApi.listGoogleChatMessages.mockImplementation(fakeSpace(all).list);

    render(<GoogleChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Load older messages/i }));
    await screen.findByText('Old request: rotate keys');
    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[0]);
    expect((await screen.findByTestId('start-session-modal')).textContent).toContain(
      'Old request: rotate keys',
    );
  });

  it('filters a long conversation list by name', async () => {
    connectedAll();
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...SPACE,
      name: `spaces/S${i}`,
      id: `S${i}`,
      displayName: i === 7 ? 'Globex escalations' : `Team ${i}`,
    }));
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: many });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });

    render(<GoogleChatPage />);

    fireEvent.change(await screen.findByLabelText('Filter conversations'), {
      target: { value: 'globex' },
    });
    expect(screen.getAllByTestId(/^chat-space-/).map((el) => el.textContent)).toEqual([
      'Globex escalations',
    ]);
  });

  it('drops an older page requested before two back-to-back capped refreshes', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE] });
    const m = (name: string, text: string, createTime: string) =>
      msg({ name: `spaces/AAA/messages/${name}`, text, createTime });
    // Each refresh reads `capped` and always reports more pages, so it hits the
    // re-read cap and replaces the history with that newest slice.
    let capped = [m('R1', 'replacement one', '2026-10-08T11:00:00Z')];
    const olderPage = deferred<{ messages: unknown[]; nextPageToken: string | null }>();
    mockApi.listGoogleChatMessages.mockImplementation(
      (_space: string, opts: { since?: string; until?: string }) => {
        if (opts.until) return olderPage.promise;
        if (opts.since) return Promise.resolve({ messages: capped, nextPageToken: 'more' });
        return Promise.resolve({
          messages: [m('N1', 'first load', '2026-10-08T10:00:00Z')],
          nextPageToken: 'x',
        });
      },
    );

    render(<GoogleChatPage />);
    await screen.findByText('first load');

    // Capped refresh #1 replaces the history.
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await screen.findByText('replacement one');
    expect(screen.queryByText('first load')).toBeNull();

    // Ask for older messages; the response is held back.
    fireEvent.click(screen.getByRole('button', { name: /Load older messages/i }));
    await waitFor(() =>
      expect(mockApi.listGoogleChatMessages.mock.calls.some((c) => c[1]?.until)).toBe(true),
    );

    // Capped refresh #2 replaces the history again (cursor is null both times).
    capped = [m('R2', 'replacement two', '2026-10-08T12:00:00Z')];
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await screen.findByText('replacement two');

    // The held-back page belongs to the first replacement: it must not merge.
    olderPage.resolve({
      messages: [m('STALE', 'from the obsolete history', '2026-10-08T10:30:00Z')],
      nextPageToken: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('from the obsolete history')).toBeNull();
    const loadOlder = screen.getByRole('button', { name: /Load older messages/i });
    expect(loadOlder).not.toBeDisabled();
    expect(screen.queryByText('Start of conversation')).toBeNull();
  });

  it.each([
    ['a DM', { spaceType: 'DIRECT_MESSAGE', spaceThreadingState: null, displayName: null }],
    [
      'a group chat',
      { spaceType: 'GROUP_CHAT', spaceThreadingState: 'UNTHREADED_MESSAGES', displayName: null },
    ],
    ['an unthreaded space', { spaceType: 'SPACE', spaceThreadingState: 'UNTHREADED_MESSAGES' }],
  ])('%s offers no thread reply and sends ordinary messages', async (_label, kind) => {
    connectedAll();
    const space = { ...SPACE, ...kind, supportsThreadReplies: false };
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [space] });
    // Messages still carry a thread resource name, as the API returns them.
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [
        msg({ name: 'spaces/AAA/messages/M1', text: 'hi', createTime: '2026-10-08T10:00:00Z' }),
        msg({
          name: 'spaces/AAA/messages/M2',
          text: 'can you check my invoice',
          createTime: '2026-10-08T10:01:00Z',
          threadName: 'spaces/AAA/threads/OTHER',
        }),
      ],
    });
    mockApi.sendGoogleChatMessage.mockResolvedValue({});

    render(<GoogleChatPage />);

    await screen.findByText('can you check my invoice');
    expect(screen.queryByRole('button', { name: /Reply in thread/i })).toBeNull();

    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'Looking now' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(mockApi.sendGoogleChatMessage).toHaveBeenCalledWith('AAA', { text: 'Looking now' }),
    );

    // The agent seed points at the conversation, with recent messages as context.
    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[1]);
    const seed = (await screen.findByTestId('start-session-modal')).textContent || '';
    expect(seed).not.toContain('(thread ');
    expect(seed).toContain('Earlier in the conversation:');
    expect(seed).toContain(': hi');
    expect(seed).toContain('post a reply to the requester in that conversation');
  });

  it('shows distinct labels for several unnamed conversations and finds them by participant', async () => {
    connectedAll();
    const unnamed = (id: string, spaceType: string, participants: string[] | null) => ({
      ...SPACE,
      name: `spaces/${id}`,
      id,
      displayName: null,
      spaceType,
      supportsThreadReplies: false,
      participants,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({
      spaces: [
        unnamed('DM1', 'DIRECT_MESSAGE', ['Dana Ruiz']),
        unnamed('DM2', 'DIRECT_MESSAGE', ['Lee Chen']),
        unnamed('DM3', 'DIRECT_MESSAGE', null),
        unnamed('DM4', 'DIRECT_MESSAGE', null),
        unnamed('G1', 'GROUP_CHAT', ['Dana Ruiz', 'Sam Ito']),
        unnamed('G2', 'GROUP_CHAT', null),
        ...Array.from({ length: 4 }, (_, i) => ({
          ...SPACE,
          name: `spaces/N${i}`,
          id: `N${i}`,
          displayName: `Team ${i}`,
        })),
      ],
    });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });

    render(<GoogleChatPage />);

    await screen.findByTestId('chat-space-DM1');
    const labels = screen.getAllByTestId(/^chat-space-/).map((el) => el.textContent);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Dana Ruiz',
        'Lee Chen',
        'Direct message · DM3',
        'Direct message · DM4',
        'Dana Ruiz, Sam Ito',
        'Group chat · G2',
      ]),
    );

    fireEvent.change(screen.getByLabelText('Filter conversations'), { target: { value: 'sam' } });
    expect(screen.getAllByTestId(/^chat-space-/).map((el) => el.textContent)).toEqual([
      'Dana Ruiz, Sam Ito',
    ]);
  });

  it('offers to show participant names when the memberships grant is missing', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: CHAT_SURFACE_SCOPES.slice(0, 3),
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({
      spaces: [
        {
          ...SPACE,
          id: 'DM3',
          name: 'spaces/DM3',
          displayName: null,
          spaceType: 'DIRECT_MESSAGE',
          participants: null,
        },
      ],
    });
    mockApi.listGoogleChatMessages.mockResolvedValue({ messages: [] });
    mockApi.startGoogleOAuth.mockResolvedValue({ authorizeUrl: 'about:blank' });

    render(<GoogleChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Show participant names/i }));
    await waitFor(() => expect(mockApi.startGoogleOAuth).toHaveBeenCalledTimes(1));
    expect(mockApi.startGoogleOAuth.mock.calls[0][0].scopes).toEqual([
      'https://www.googleapis.com/auth/chat.memberships.readonly',
    ]);
  });
  it('shows the setup fix-it link when the Chat app is not configured', async () => {
    connectedAll();
    mockApi.listGoogleChatSpaces.mockRejectedValue(
      Object.assign(new Error('The Google Chat API is on, but no Chat app is configured.'), {
        status: 403,
        code: 'google_chat_app_not_configured',
        helpUrl: 'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat',
      }),
    );

    render(<GoogleChatPage />);

    expect(await screen.findByText(/no Chat app is configured/)).toBeInTheDocument();
    const link = screen.getByTestId('google-chat-setup-help');
    expect(link).toHaveAttribute(
      'href',
      'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat',
    );
    expect(link).toHaveTextContent('Open the Chat API configuration page');
  });
});

describe('GoogleChatPage message links', () => {
  function link(overrides: Record<string, unknown>) {
    return {
      id: 'L1',
      messageName: 'spaces/AAA/messages/M1',
      spaceName: 'spaces/AAA',
      threadName: 'spaces/AAA/threads/T1',
      sessionId: 'sess-1',
      sessionName: 'Reset staging',
      agentId: 'agent-a',
      userId: 'user-1',
      createdAt: '2026-10-08T10:01:00.000Z',
      repliedAt: null,
      replyMessageName: null,
      ...overrides,
    };
  }

  function setup(links: unknown[]) {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      email: 'me@acme.com',
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE], nextPageToken: null });
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [
        msg({
          name: 'spaces/AAA/messages/M2',
          id: 'M2',
          text: 'Unrelated question',
          createTime: '2026-10-08T10:05:00Z',
        }),
        msg({ name: 'spaces/AAA/messages/M1', id: 'M1', text: 'Reset the staging DB' }),
      ],
      nextPageToken: null,
    });
    mockApi.listGoogleChatMessageLinks.mockResolvedValue({ links });
  }

  it('shows a chip that opens the linked session', async () => {
    setup([link({})]);
    const onOpenSession = vi.fn();
    render(<GoogleChatPage onOpenSession={onOpenSession} />);

    const chip = await screen.findByTestId('chat-link-chip');
    expect(mockApi.listGoogleChatMessageLinks).toHaveBeenCalledWith('AAA');
    expect(chip.textContent).toContain('Sent to agent');
    expect(screen.getAllByTestId('chat-link-chip')).toHaveLength(1);
    fireEvent.click(chip);
    expect(onOpenSession).toHaveBeenCalledWith({ sessionId: 'sess-1', agentId: 'agent-a' });
  });

  it('switches the chip to Agent replied once the session posted back', async () => {
    setup([link({ repliedAt: '2026-10-08T10:09:00.000Z' })]);
    render(<GoogleChatPage />);
    expect((await screen.findByTestId('chat-link-chip')).textContent).toContain('Agent replied');
  });

  it('warns before sending an already-dispatched message and links the new session', async () => {
    setup([link({})]);
    mockApi.createGoogleChatMessageLink.mockResolvedValue({ link: link({}), existing: [] });
    const onSessionStarted = vi.fn();
    render(<GoogleChatPage onSessionStarted={onSessionStarted} />);
    await screen.findByTestId('chat-link-chip');

    // Oldest first: M1 (linked) is the first message.
    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[0]);
    await screen.findByTestId('start-session-modal');
    expect(String(startSessionProps.last?.warning)).toContain('already sent to "Reset staging"');

    const onStarted = startSessionProps.last?.onStarted as (s: unknown) => void;
    onStarted({ id: 'sess-2', agent_id: 'agent-b' });
    await waitFor(() =>
      expect(mockApi.createGoogleChatMessageLink).toHaveBeenCalledWith('AAA', {
        messageName: 'spaces/AAA/messages/M1',
        threadName: 'spaces/AAA/threads/T1',
        sessionId: 'sess-2',
      }),
    );
    expect(onSessionStarted).toHaveBeenCalledWith({ id: 'sess-2', agent_id: 'agent-b' });
  });

  it('sends an undispatched message without a warning', async () => {
    setup([link({})]);
    render(<GoogleChatPage />);
    await screen.findByTestId('chat-link-chip');
    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[1]);
    await screen.findByTestId('start-session-modal');
    expect(startSessionProps.last?.warning).toBeNull();
  });

  it('waits for existing links before opening Send to agent when messages load first', async () => {
    setup([]);
    // The pane's own link load hangs; messages are already on screen.
    let resolvePaneLoad: (v: unknown) => void = () => {};
    mockApi.listGoogleChatMessageLinks.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePaneLoad = resolve;
      }),
    );
    let resolveClickLoad: (v: unknown) => void = () => {};
    mockApi.listGoogleChatMessageLinks.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClickLoad = resolve;
      }),
    );
    render(<GoogleChatPage />);
    await screen.findByText('Reset the staging DB');
    expect(screen.queryByTestId('chat-link-chip')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[0]);
    // No dialog until the links are known, and no double dispatch meanwhile.
    expect(screen.queryByTestId('start-session-modal')).toBeNull();
    for (const b of screen.getAllByRole('button', { name: /Send to agent/i })) {
      expect(b).toBeDisabled();
    }

    resolveClickLoad({ links: [link({})] });
    await screen.findByTestId('start-session-modal');
    expect(String(startSessionProps.last?.warning)).toContain('already sent to "Reset staging"');

    // The older pane read finishes last with a stale empty snapshot; it must
    // not wipe the newer result.
    resolvePaneLoad({ links: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(String(startSessionProps.last?.warning)).toContain('already sent to "Reset staging"');
    expect(screen.getByTestId('chat-link-chip')).toBeInTheDocument();
  });

  it('warns that links are unknown when the pre-dispatch check fails after an empty load', async () => {
    setup([]);
    render(<GoogleChatPage />);
    await screen.findByText('Reset the staging DB');
    await waitFor(() => expect(mockApi.listGoogleChatMessageLinks).toHaveBeenCalledTimes(1));
    // Meanwhile someone else dispatched it, and the re-check fails.
    mockApi.listGoogleChatMessageLinks.mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[0]);
    await screen.findByTestId('start-session-modal');
    expect(startSessionProps.last?.warning).toBe(LINKS_UNKNOWN_WARNING);
  });

  it('warns that links are unknown when they cannot be read', async () => {
    setup([]);
    mockApi.listGoogleChatMessageLinks.mockRejectedValue(new Error('boom'));
    render(<GoogleChatPage />);
    await screen.findByText('Reset the staging DB');
    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[0]);
    await screen.findByTestId('start-session-modal');
    expect(startSessionProps.last?.warning).toBe(LINKS_UNKNOWN_WARNING);
  });

  it('updates the dialog warning when links arrive while it is open', async () => {
    setup([]);
    mockApi.listGoogleChatMessageLinks.mockRejectedValue(new Error('boom'));
    render(<GoogleChatPage />);
    await screen.findByText('Reset the staging DB');
    fireEvent.click(screen.getAllByRole('button', { name: /Send to agent/i })[0]);
    await screen.findByTestId('start-session-modal');
    expect(startSessionProps.last?.warning).toBe(LINKS_UNKNOWN_WARNING);

    // A later successful read (the poll) replaces the unknown state.
    mockApi.listGoogleChatMessageLinks.mockResolvedValue({ links: [link({})] });
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() =>
      expect(String(startSessionProps.last?.warning)).toContain('already sent to "Reset staging"'),
    );
  });
});

describe('GoogleChatPage multi-select', () => {
  function setup(links: unknown[] = []) {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE], nextPageToken: null });
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [
        msg({
          name: 'spaces/AAA/messages/M3',
          text: 'Third, unrelated',
          createTime: '2026-10-08T10:10:00Z',
          threadName: 'spaces/AAA/threads/T2',
        }),
        msg({
          name: 'spaces/AAA/messages/M2',
          text: 'It started after the deploy',
          createTime: '2026-10-08T10:05:00Z',
          threadReply: true,
          sender: { name: 'users/2', displayName: 'Lee', type: 'HUMAN' },
        }),
        msg({
          name: 'spaces/AAA/messages/M1',
          text: 'Invoices show the wrong total',
          sender: { name: 'users/1', displayName: 'Dana', type: 'HUMAN' },
        }),
      ],
      nextPageToken: null,
    });
    mockApi.listGoogleChatMessageLinks.mockResolvedValue({ links });
  }

  it('sends the ticked messages to one session and links each of them', async () => {
    setup();
    mockApi.createGoogleChatMessageLink.mockResolvedValue({ link: {}, existing: [] });
    render(<GoogleChatPage />);
    await screen.findByText('Invoices show the wrong total');
    expect(screen.queryByTestId('chat-selection-bar')).toBeNull();

    const boxes = screen.getAllByTestId('chat-message-select');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(screen.getByTestId('chat-selection-bar').textContent).toContain('2 selected');

    fireEvent.click(screen.getByRole('button', { name: /Send selected to agent/ }));
    const seed = (await screen.findByTestId('start-session-modal')).textContent || '';
    expect(seed).toContain("Here are 2 Google Chat messages I'd like you to work on.");
    expect(seed).toContain('**Chat reference:** spaces/AAA (thread spaces/AAA/threads/T1)');
    expect(seed.indexOf('Invoices show the wrong total')).toBeLessThan(
      seed.indexOf('It started after the deploy'),
    );
    expect(seed).not.toContain('Third, unrelated');
    expect(startSessionProps.last?.contextLabel).toBe('Chat: 2 messages in Acme support');
    expect(startSessionProps.last?.warning).toBeNull();

    const onStarted = startSessionProps.last?.onStarted as (s: unknown) => void;
    act(() => onStarted({ id: 'sess-9', agent_id: 'a' }));
    await waitFor(() => expect(mockApi.createGoogleChatMessageLink).toHaveBeenCalledTimes(2));
    expect(mockApi.createGoogleChatMessageLink).toHaveBeenCalledWith('AAA', {
      messageName: 'spaces/AAA/messages/M1',
      threadName: 'spaces/AAA/threads/T1',
      sessionId: 'sess-9',
    });
    expect(mockApi.createGoogleChatMessageLink).toHaveBeenCalledWith('AAA', {
      messageName: 'spaces/AAA/messages/M2',
      threadName: 'spaces/AAA/threads/T1',
      sessionId: 'sess-9',
    });
    await waitFor(() => expect(screen.queryByTestId('chat-selection-bar')).toBeNull());
  });

  it('warns when some ticked messages were already sent and drops the thread for mixed threads', async () => {
    setup([
      {
        id: 'L1',
        messageName: 'spaces/AAA/messages/M1',
        spaceName: 'spaces/AAA',
        threadName: 'spaces/AAA/threads/T1',
        sessionId: 's1',
        sessionName: 'Old',
        agentId: 'a',
        userId: 'u',
        createdAt: '2026-10-08T10:01:00.000Z',
        repliedAt: null,
        replyMessageName: null,
      },
    ]);
    render(<GoogleChatPage />);
    await screen.findByTestId('chat-link-chip');
    const boxes = screen.getAllByTestId('chat-message-select');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2]);
    fireEvent.click(screen.getByRole('button', { name: /Send selected to agent/ }));
    const seed = (await screen.findByTestId('start-session-modal')).textContent || '';
    expect(seed).toContain('**Chat reference:** spaces/AAA\n');
    expect(String(startSessionProps.last?.warning)).toContain(
      '1 of the 2 selected messages was already sent',
    );
  });

  it('makes one ticket from the ticked messages', async () => {
    setup();
    render(<GoogleChatPage />);
    await screen.findByText('Invoices show the wrong total');
    const boxes = screen.getAllByTestId('chat-message-select');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /Ticket from selected/ }));
    await screen.findByTestId('ticket-modal');
    const draft = ticketProps.last?.draft;
    expect(draft.title).toBe('Invoices show the wrong total');
    expect(draft.description).toContain('2 messages in Acme support');
    expect(draft.description).toContain('Dana');
    expect(draft.description).toContain('It started after the deploy');
    expect(draft.source.sourceId).toBe('spaces/AAA/messages/M1');
    expect(draft.source.sourceMeta.messageNames).toEqual([
      'spaces/AAA/messages/M1',
      'spaces/AAA/messages/M2',
    ]);
  });

  it('clears the selection with Clear selection', async () => {
    setup();
    render(<GoogleChatPage />);
    await screen.findByText('Invoices show the wrong total');
    fireEvent.click(screen.getAllByTestId('chat-message-select')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByTestId('chat-selection-bar')).toBeNull();
    expect((screen.getAllByTestId('chat-message-select')[0] as HTMLInputElement).checked).toBe(
      false,
    );
  });
});

describe('GoogleChatPage push updates', () => {
  const OTHER = {
    ...SPACE,
    name: 'spaces/BBB',
    id: 'BBB',
    displayName: 'Globex',
    lastActiveTime: '2026-10-08T09:00:00Z',
  };

  const ACTIVE = {
    state: 'ACTIVE',
    expireTime: '2099-01-01T00:00:00Z',
    suspensionReason: null,
    lastError: null,
  };

  /**
   * `push`: the server reports an ACTIVE subscription. Unless `fresh`, the
   * store already knows it before the pane renders (an earlier bootstrap).
   */
  function setup(opts: {
    push: boolean;
    fresh?: boolean;
    unread?: Array<Record<string, unknown>>;
  }) {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      email: 'me@acme.com',
      grantedScopes: ALL_SCOPES,
      serverConfigured: true,
    });
    mockApi.ensureGoogleChatSubscription.mockResolvedValue({
      configured: opts.push,
      subscription: opts.push ? ACTIVE : null,
      version: 1,
    });
    mockApi.listGoogleChatUnread.mockResolvedValue({ spaces: opts.unread ?? [], version: 10 });
    mockApi.listGoogleChatSpaces.mockResolvedValue({ spaces: [SPACE, OTHER], nextPageToken: null });
    mockApi.listGoogleChatMessages.mockResolvedValue({
      messages: [
        msg({
          name: 'spaces/AAA/messages/M2',
          id: 'M2',
          text: 'latest',
          createTime: '2026-10-08T10:05:00Z',
        }),
      ],
      nextPageToken: null,
    });
    mockApi.listGoogleChatMessageLinks.mockResolvedValue({ links: [] });
    mockApi.markGoogleChatSpaceRead.mockImplementation(async (spaceId: string) => ({
      spaceName: `spaces/${spaceId}`,
      count: 0,
      lastMessageTime: null,
      version: 11,
    }));
    chatPushStore().setConnected(true);
    if (opts.push && !opts.fresh) {
      chatPushStore().applyEvent({
        type: 'google_chat_events_status',
        subscription: ACTIVE,
        version: 1,
      });
    }
    for (const u of opts.unread ?? []) {
      chatPushStore().applyEvent({ type: 'google_chat_unread', ...u });
    }
  }

  const pushMessage = (
    spaceName: string,
    createTime = '2026-10-08T10:06:00Z',
    kind: 'created' | 'updated' | 'deleted' = 'created',
  ) =>
    window.dispatchEvent(
      new CustomEvent('google_chat_message', {
        detail: {
          type: 'google_chat_message',
          kind,
          spaceName,
          messageName: `${spaceName}/messages/new`,
          createTime,
        },
      }),
    );

  it('only re-reads slowly while push is active, and re-reads the open space on a new message', async () => {
    setup({ push: true });
    const intervals = vi.spyOn(window, 'setInterval');
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    expect(intervals.mock.calls.some(([, ms]) => ms === 30_000)).toBe(false);
    // Push can drop an event; a slow re-read still corrects the view.
    expect(intervals.mock.calls.some(([, ms]) => ms === 5 * 60_000)).toBe(true);
    const before = mockApi.listGoogleChatMessages.mock.calls.length;

    pushMessage('spaces/AAA');
    await waitFor(() =>
      expect(mockApi.listGoogleChatMessages.mock.calls.length).toBeGreaterThan(before),
    );
    // A refresh re-reads the loaded range, not the first page.
    expect(mockApi.listGoogleChatMessages.mock.calls.at(-1)?.[1]).toMatchObject({
      since: '2026-10-08T10:05:00Z',
    });
    intervals.mockRestore();
  });

  it('subscribes once Chat read access shows up in the pane', async () => {
    setup({ push: true, fresh: true });
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    await waitFor(() => expect(mockApi.ensureGoogleChatSubscription).toHaveBeenCalledTimes(1));
  });

  it('resumes polling when the socket drops after push was set up', async () => {
    setup({ push: true });
    const intervals = vi.spyOn(window, 'setInterval');
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    expect(intervals.mock.calls.some(([, ms]) => ms === 30_000)).toBe(false);
    act(() => chatPushStore().setConnected(false));
    await waitFor(() => expect(intervals.mock.calls.some(([, ms]) => ms === 30_000)).toBe(true));
    intervals.mockRestore();
  });

  it('keeps polling when push is not active', async () => {
    setup({ push: false });
    const intervals = vi.spyOn(window, 'setInterval');
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    expect(intervals.mock.calls.some(([, ms]) => ms === 30_000)).toBe(true);
    intervals.mockRestore();
  });

  it('moves a conversation with a new message to the top and leaves the open one alone', async () => {
    setup({ push: true });
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    const before = mockApi.listGoogleChatMessages.mock.calls.length;
    pushMessage('spaces/BBB', '2026-10-08T11:00:00Z');
    await waitFor(() => {
      const ids = screen.getAllByTestId(/^chat-space-[A-Z]+$/).map((el) => el.dataset.testid);
      expect(ids).toEqual(['chat-space-BBB', 'chat-space-AAA']);
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(mockApi.listGoogleChatMessages.mock.calls.length).toBe(before);
  });

  it('reloads the list for a message in a conversation it has not seen', async () => {
    setup({ push: true });
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    const before = mockApi.listGoogleChatSpaces.mock.calls.length;
    pushMessage('spaces/NEWDM');
    await waitFor(() =>
      expect(mockApi.listGoogleChatSpaces.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('shows unread counts per conversation and marks the open one read up to what loaded', async () => {
    setup({
      push: true,
      unread: [
        { spaceName: 'spaces/BBB', count: 3, lastMessageTime: '2026-10-08T09:00:00Z', version: 9 },
        { spaceName: 'spaces/AAA', count: 1, lastMessageTime: '2026-10-08T10:05:00Z', version: 10 },
      ],
    });
    render(<GoogleChatPage />);
    await screen.findByText('latest');

    expect(screen.getByTestId('chat-space-unread-BBB').textContent).toBe('3');
    await waitFor(() =>
      expect(mockApi.markGoogleChatSpaceRead).toHaveBeenCalledWith('AAA', '2026-10-08T10:05:00Z'),
    );
    await waitFor(() => expect(screen.queryByTestId('chat-space-unread-AAA')).toBeNull());
    expect(mockApi.markGoogleChatSpaceRead).not.toHaveBeenCalledWith('BBB', expect.anything());
  });

  it.each(['updated', 'deleted'] as const)(
    'refreshes the open space when a message is %s, with no new message after it',
    async (kind) => {
      setup({ push: true });
      render(<GoogleChatPage />);
      await screen.findByText('latest');
      const before = mockApi.listGoogleChatMessages.mock.calls.length;
      mockApi.listGoogleChatMessages.mockResolvedValue({
        messages: [
          msg({
            name: 'spaces/AAA/messages/M2',
            id: 'M2',
            text: kind === 'updated' ? 'latest (edited)' : null,
            deleted: kind === 'deleted',
            createTime: '2026-10-08T10:05:00Z',
          }),
        ],
        nextPageToken: null,
      });
      pushMessage('spaces/AAA', '2026-10-08T10:05:00Z', kind);
      await waitFor(() =>
        expect(mockApi.listGoogleChatMessages.mock.calls.length).toBeGreaterThan(before),
      );
      if (kind === 'updated') await screen.findByText('latest (edited)');
      else await waitFor(() => expect(screen.queryByText('latest')).toBeNull());
    },
  );

  it('does not reorder or reload the list for an edit elsewhere', async () => {
    setup({ push: true });
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    const spacesBefore = mockApi.listGoogleChatSpaces.mock.calls.length;
    pushMessage('spaces/BBB', '2026-10-08T11:00:00Z', 'updated');
    pushMessage('spaces/UNKNOWN', '2026-10-08T11:00:00Z', 'deleted');
    await new Promise((r) => setTimeout(r, 400));
    const ids = screen.getAllByTestId(/^chat-space-[A-Z]+$/).map((el) => el.dataset.testid);
    expect(ids).toEqual(['chat-space-AAA', 'chat-space-BBB']);
    expect(mockApi.listGoogleChatSpaces.mock.calls.length).toBe(spacesBefore);
  });

  it('stops re-sending a mark-read that keeps failing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup({
        push: true,
        unread: [
          {
            spaceName: 'spaces/AAA',
            count: 1,
            lastMessageTime: '2026-10-08T10:05:00Z',
            version: 10,
          },
        ],
      });
      mockApi.markGoogleChatSpaceRead.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('500')), 50)),
      );
      render(<GoogleChatPage />);
      await screen.findByText('latest');
      // Small steps so React renders and re-runs effects between them, as a
      // browser would.
      for (let i = 0; i < 300; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      expect(mockApi.markGoogleChatSpaceRead).toHaveBeenCalledTimes(3);
      // The badge reflects the server, which still has the message unread.
      expect(screen.getByTestId('chat-space-unread-AAA').textContent).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an exhausted mark-read after a reconnect, with no other change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup({
        push: true,
        unread: [
          {
            spaceName: 'spaces/AAA',
            count: 1,
            lastMessageTime: '2026-10-08T10:05:00Z',
            version: 10,
          },
        ],
      });
      mockApi.markGoogleChatSpaceRead.mockRejectedValue(new Error('offline'));
      render(<GoogleChatPage />);
      await screen.findByText('latest');
      for (let i = 0; i < 30; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      expect(mockApi.markGoogleChatSpaceRead).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId('chat-space-unread-AAA').textContent).toBe('1');

      // Connectivity comes back; nothing the pane watches changes.
      mockApi.markGoogleChatSpaceRead.mockResolvedValue({
        spaceName: 'spaces/AAA',
        count: 0,
        lastMessageTime: null,
        version: 11,
      });
      await act(async () => {
        chatPushStore().setConnected(false);
        chatPushStore().setConnected(true);
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await waitFor(() => expect(screen.queryByTestId('chat-space-unread-AAA')).toBeNull());
      expect(mockApi.markGoogleChatSpaceRead).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resubscribes when Chat access comes back after the server cleared it', async () => {
    setup({ push: true, fresh: true });
    const first = render(<GoogleChatPage />);
    await screen.findByText('latest');
    await waitFor(() => expect(mockApi.ensureGoogleChatSubscription).toHaveBeenCalledTimes(1));

    // Revoked: maintenance cleanup broadcasts that the subscription is gone.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('google_chat_events_status', {
          detail: { type: 'google_chat_events_status', subscription: null, version: 50 },
        }),
      );
    });
    first.unmount();

    // Regranted: the pane loads again and sees Chat read access. No reconnect.
    mockApi.ensureGoogleChatSubscription.mockResolvedValue({
      configured: true,
      subscription: ACTIVE,
      version: 51,
    });
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    await waitFor(() => expect(mockApi.ensureGoogleChatSubscription).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(chatPushStore().getState().pushActive).toBe(true));
  });

  it('records what was viewed even before any unread event, then switching away keeps it', async () => {
    // No badge anywhere: the message is on screen before its push event.
    setup({ push: true });
    render(<GoogleChatPage />);
    await screen.findByText('latest');
    await waitFor(() =>
      expect(mockApi.markGoogleChatSpaceRead).toHaveBeenCalledWith('AAA', '2026-10-08T10:05:00Z'),
    );

    fireEvent.click(screen.getByTestId('chat-space-BBB'));
    // The late event for the viewed message arrives; the server, holding the
    // read marker, reports nothing unread for AAA.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('google_chat_message', {
          detail: {
            type: 'google_chat_message',
            kind: 'created',
            spaceName: 'spaces/AAA',
            messageName: 'spaces/AAA/messages/M2',
            createTime: '2026-10-08T10:05:00Z',
            unread: { count: 0, lastMessageTime: null, version: 12 },
          },
        }),
      );
    });
    expect(screen.queryByTestId('chat-space-unread-AAA')).toBeNull();
    // The boundary was sent once, not re-sent on the switch.
    expect(mockApi.markGoogleChatSpaceRead.mock.calls.filter(([id]) => id === 'AAA')).toHaveLength(
      1,
    );
  });

  it('keeps every activity update from a burst of events delivered before a render', async () => {
    const THIRD = {
      ...SPACE,
      name: 'spaces/CCC',
      id: 'CCC',
      displayName: 'Initech',
      lastActiveTime: '2026-10-08T08:00:00Z',
    };
    setup({ push: true });
    mockApi.listGoogleChatSpaces.mockResolvedValue({
      spaces: [SPACE, OTHER, THIRD],
      nextPageToken: null,
    });
    render(<GoogleChatPage />);
    await screen.findByText('latest');

    const created = (spaceName: string, createTime: string) =>
      new CustomEvent('google_chat_message', {
        detail: { type: 'google_chat_message', kind: 'created', spaceName, createTime },
      });
    // One synchronous burst: no render happens between these.
    act(() => {
      window.dispatchEvent(created('spaces/BBB', '2026-10-08T11:00:00Z'));
      window.dispatchEvent(created('spaces/CCC', '2026-10-08T12:00:00Z'));
      window.dispatchEvent(created('spaces/BBB', '2026-10-08T11:30:00Z'));
      // Older than what BBB just got: must not move it back.
      window.dispatchEvent(created('spaces/BBB', '2026-10-08T10:30:00Z'));
    });
    const ids = screen.getAllByTestId(/^chat-space-[A-Z]+$/).map((el) => el.dataset.testid);
    expect(ids).toEqual(['chat-space-CCC', 'chat-space-BBB', 'chat-space-AAA']);
    expect(mockApi.listGoogleChatSpaces).toHaveBeenCalledTimes(1);
  });
});
