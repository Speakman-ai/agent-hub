import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    listGoogleGmailThreads: vi.fn(),
    getGoogleGmailThread: vi.fn(),
    sendGoogleGmailMessage: vi.fn(),
    startGoogleOAuth: vi.fn(),
    getGmailImportance: vi.fn(),
    updateGmailImportanceSettings: vi.fn(),
    startGmailImportanceScan: vi.fn(),
  },
}));

import GmailPage, { GMAIL_SURFACE_SCOPES, buildSendBody, parseRecipients } from './GmailPage';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseRecipients / buildSendBody', () => {
  it('splits, trims, and de-duplicates recipients', () => {
    expect(parseRecipients('a@x.com, b@x.com; a@x.com  c@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
    expect(parseRecipients('')).toEqual([]);
  });

  it('builds a send body with array recipients and trimmed subject', () => {
    expect(
      buildSendBody({ to: 'a@x.com, b@x.com', cc: '', subject: '  Hi  ', body: 'Body' }),
    ).toEqual({ to: ['a@x.com', 'b@x.com'], subject: 'Hi', text: 'Body' });
    // Cc is only present when non-empty.
    expect(buildSendBody({ to: 'a@x.com', cc: 'c@x.com', subject: '', body: 'x' })).toEqual({
      to: ['a@x.com'],
      cc: ['c@x.com'],
      subject: undefined,
      text: 'x',
    });
  });
});

describe('GmailPage', () => {
  it('renders a connect route when Google is not linked', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: false,
      grantedScopes: [],
      serverConfigured: true,
    });

    render(<GmailPage />);

    expect(await screen.findByText('Connect Google to use Gmail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
    expect(mockApi.listGoogleGmailThreads).not.toHaveBeenCalled();
  });

  it('shows an inline Enable Gmail affordance when connected but missing consent', async () => {
    // Connected to Google but only the calendar scope was granted → incremental
    // consent. The pane must surface "Enable Gmail" and must NOT list threads.
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: ['https://www.googleapis.com/auth/calendar.events'],
      serverConfigured: true,
    });

    render(<GmailPage />);

    expect(await screen.findByText('Enable Gmail access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enable Gmail/i })).toBeInTheDocument();
    expect(mockApi.listGoogleGmailThreads).not.toHaveBeenCalled();
  });

  it('requests the Gmail surface scopes when enabling consent', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [],
      serverConfigured: true,
    });
    mockApi.startGoogleOAuth.mockResolvedValueOnce({ authorizeUrl: 'https://accounts.google/x' });

    render(<GmailPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Enable Gmail/i }));

    await waitFor(() => {
      expect(mockApi.startGoogleOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: GMAIL_SURFACE_SCOPES }),
      );
    });
  });

  it('pins important threads above the list without repeating them', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
      serverConfigured: true,
    });
    mockApi.listGoogleGmailThreads.mockResolvedValueOnce({
      threads: [
        { id: 't1', snippet: 'Quarterly review', historyId: '9' },
        { id: 't2', snippet: 'Weekly newsletter', historyId: '8' },
      ],
    });
    mockApi.getGmailImportance.mockResolvedValue({
      running: false,
      settings: {
        enabled: true,
        windowDays: 7,
        autoScan: 'off',
        lastScanAt: '2026-10-12T11:00:00.000Z',
        lastScanStatus: 'ok',
        lastScanError: null,
        lastScanEngine: 'claude-code',
        lastScanModel: null,
        lastScanFailover: null,
      },
      threads: [
        {
          threadId: 't1',
          historyId: '9',
          important: true,
          score: 90,
          reason: 'Needs your sign-off today',
          subject: 'Quarterly review',
          from: 'Boss <boss@example.com>',
          snippet: 'Quarterly review',
          lastMessageAt: '2026-10-12T10:00:00.000Z',
          scannedAt: '2026-10-12T11:00:00.000Z',
        },
      ],
    });

    render(<GmailPage />);

    expect(await screen.findByText('Needs your sign-off today')).toBeInTheDocument();
    expect(screen.getByText('Weekly newsletter')).toBeInTheDocument();
    // The pinned thread renders once (subject in the Important section), not again in the list.
    expect(screen.getAllByText('Quarterly review')).toHaveLength(1);
  });

  it('lists threads and sends a composed message through the proxy', async () => {
    mockApi.getGoogleStatus
      .mockResolvedValueOnce({
        connected: true,
        email: 'person@example.com',
        grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
        serverConfigured: true,
      })
      .mockResolvedValueOnce({
        connected: true,
        email: 'person@example.com',
        grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
        serverConfigured: true,
      });
    mockApi.listGoogleGmailThreads
      .mockResolvedValueOnce({
        threads: [{ id: 't1', snippet: 'Quarterly review', historyId: '9' }],
      })
      .mockResolvedValueOnce({ threads: [] });
    mockApi.sendGoogleGmailMessage.mockResolvedValueOnce({ id: 'm1' });

    render(<GmailPage />);

    expect(await screen.findByText('Quarterly review')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Compose/i }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi there' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));

    await waitFor(() => {
      expect(mockApi.sendGoogleGmailMessage).toHaveBeenCalledWith(
        {
          to: ['alice@example.com'],
          subject: 'Hello',
          text: 'Hi there',
        },
        { account: undefined },
      );
    });
  });

  it('opens a thread in a dialog that spans the page width', async () => {
    const status = {
      connected: true,
      email: 'person@example.com',
      grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
      serverConfigured: true,
    };
    mockApi.getGoogleStatus.mockResolvedValue(status);
    mockApi.listGoogleGmailThreads.mockResolvedValue({
      threads: [{ id: 't1', snippet: 'Quarterly review', historyId: '9' }],
    });
    mockApi.getGoogleGmailThread.mockResolvedValueOnce({
      messages: [{ id: 'm1', subject: 'Canceled event', from: 'a@example.com', bodyText: 'Body' }],
    });

    render(<GmailPage />);
    fireEvent.click(await screen.findByText('Quarterly review'));

    const dialog = await screen.findByRole('dialog', { name: 'Canceled event' });
    expect(dialog.className).toContain('w-full');
    expect(dialog.className).not.toMatch(/\bmax-w-/);
  });

  describe('multiple Google accounts', () => {
    const MULTI = {
      connected: true,
      email: 'me@work.com',
      grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
      serverConfigured: true,
      defaultAccountId: 'work',
      accounts: [
        {
          accountId: 'work',
          email: 'me@work.com',
          isDefault: true,
          grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
        },
        {
          accountId: 'home',
          email: 'me@home.com',
          isDefault: false,
          grantedScopes: [GMAIL_MODIFY, GMAIL_SEND],
        },
      ],
    };
    const threadsByAccount: Record<string, any[]> = {
      work: [{ id: 'tw', snippet: 'Quarterly numbers', historyId: '1' }],
      home: [{ id: 'th', snippet: 'Dinner on Friday?', historyId: '1' }],
    };

    beforeEach(() => {
      mockApi.getGoogleStatus.mockResolvedValue(MULTI);
      mockApi.getGmailImportance.mockResolvedValue({
        running: false,
        settings: { enabled: false, windowDays: 7, autoScan: 'off' },
        threads: [],
      });
      mockApi.listGoogleGmailThreads.mockImplementation(async (p: any) => ({
        threads: threadsByAccount[p.account] ?? [],
      }));
    });

    it('starts on the default inbox and switches accounts', async () => {
      render(<GmailPage />);

      expect(await screen.findByText('Quarterly numbers')).toBeInTheDocument();
      expect(screen.queryByText('Dinner on Friday?')).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Inbox'), { target: { value: 'home' } });

      expect(await screen.findByText('Dinner on Friday?')).toBeInTheDocument();
      expect(screen.queryByText('Quarterly numbers')).not.toBeInTheDocument();
      expect(mockApi.listGoogleGmailThreads).toHaveBeenLastCalledWith(
        expect.objectContaining({ account: 'home' }),
      );
    });

    it('shows every inbox in the All inboxes view, labelled by account', async () => {
      render(<GmailPage />);
      expect(await screen.findByText('Quarterly numbers')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Inbox'), { target: { value: '__all_inboxes__' } });

      expect(await screen.findByText('Dinner on Friday?')).toBeInTheDocument();
      expect(screen.getByText('Quarterly numbers')).toBeInTheDocument();
      expect(screen.getByText('me@home.com', { selector: 'span' })).toBeInTheDocument();
    });

    it('reads and replies to a thread through the account that owns it', async () => {
      mockApi.getGoogleGmailThread.mockResolvedValue({
        messages: [
          {
            id: 'm1',
            threadId: 'th',
            labelIds: [],
            snippet: 'Dinner on Friday?',
            from: 'Jane <jane@example.com>',
            to: 'me@home.com',
            cc: null,
            subject: 'Dinner',
            date: null,
            messageIdHeader: '<m1@mail>',
            bodyText: 'Dinner on Friday?',
            bodyHtml: null,
          },
        ],
      });
      mockApi.sendGoogleGmailMessage.mockResolvedValue({});
      render(<GmailPage />);
      expect(await screen.findByText('Quarterly numbers')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Inbox'), { target: { value: '__all_inboxes__' } });
      fireEvent.click(await screen.findByText('Dinner on Friday?'));

      await waitFor(() =>
        expect(mockApi.getGoogleGmailThread).toHaveBeenCalledWith('th', {
          format: 'full',
          account: 'home',
        }),
      );
      fireEvent.change(await screen.findByLabelText('Reply'), { target: { value: 'Yes!' } });
      fireEvent.click(screen.getByRole('button', { name: /Send reply/i }));

      await waitFor(() =>
        expect(mockApi.sendGoogleGmailMessage).toHaveBeenCalledWith(
          {
            to: ['jane@example.com'],
            subject: 'Re: Dinner',
            text: 'Yes!',
            threadId: 'th',
            inReplyTo: '<m1@mail>',
            references: '<m1@mail>',
          },
          { account: 'home' },
        ),
      );
    });

    it('ignores a slower response for an inbox the user already left', async () => {
      const pending: Record<string, Array<(v: any) => void>> = {};
      mockApi.listGoogleGmailThreads.mockImplementation(
        (p: any) => new Promise((resolve) => (pending[p.account] ??= []).push(resolve)),
      );
      render(<GmailPage />);
      await waitFor(() => expect(pending.work).toHaveLength(1));
      pending.work.shift()!({ threads: [{ id: 'w0', snippet: 'Work 0' }] });
      expect(await screen.findByText('Work 0')).toBeInTheDocument();

      // Pick home (left pending), then go back to work, which answers first.
      fireEvent.change(screen.getByLabelText('Inbox'), { target: { value: 'home' } });
      await waitFor(() => expect(pending.home).toHaveLength(1));
      fireEvent.change(screen.getByLabelText('Inbox'), { target: { value: 'work' } });
      await waitFor(() => expect(pending.work).toHaveLength(1));
      pending.work.shift()!({ threads: [{ id: 'w', snippet: 'Work thread' }] });
      expect(await screen.findByText('Work thread')).toBeInTheDocument();
      pending.home.shift()!({ threads: [{ id: 'h', snippet: 'Home thread' }] });

      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByText('Home thread')).not.toBeInTheDocument();
      expect(screen.getByText('Work thread')).toBeInTheDocument();
      expect((screen.getByLabelText('Inbox') as HTMLSelectElement).value).toBe('work');
    });

    const threadBody = (id: string, subject: string, from: string) => ({
      messages: [
        {
          id: `m-${id}`,
          threadId: id,
          labelIds: [],
          snippet: subject,
          from,
          to: 'me',
          cc: null,
          subject,
          date: null,
          messageIdHeader: `<${id}@mail>`,
          bodyText: `${subject} body`,
          bodyHtml: null,
        },
      ],
    });

    it('does not pull a closed thread back when its reply finishes sending', async () => {
      mockApi.getGoogleGmailThread.mockImplementation(async (id: string) =>
        id === 'th'
          ? threadBody('th', 'Dinner', 'Jane <jane@example.com>')
          : threadBody('tw', 'Numbers', 'Boss <boss@work.com>'),
      );
      let finishSend: (v: unknown) => void = () => {};
      mockApi.sendGoogleGmailMessage.mockImplementationOnce(
        () => new Promise((resolve) => (finishSend = resolve)),
      );
      render(<GmailPage />);
      expect(await screen.findByText('Quarterly numbers')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Inbox'), { target: { value: '__all_inboxes__' } });

      // Reply in thread A (home), then close it while the send is in flight.
      fireEvent.click(await screen.findByText('Dinner on Friday?'));
      fireEvent.change(await screen.findByLabelText('Reply'), { target: { value: 'Yes!' } });
      fireEvent.click(screen.getByRole('button', { name: /Send reply/i }));
      await waitFor(() => expect(mockApi.sendGoogleGmailMessage).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: /Close thread/i }));

      // Open thread B (work) and start a draft there.
      fireEvent.click(screen.getByText('Quarterly numbers'));
      expect(await screen.findByText('Numbers body')).toBeInTheDocument();
      const draft = screen.getByLabelText('Reply') as HTMLTextAreaElement;
      expect(draft.value).toBe('');
      fireEvent.change(draft, { target: { value: 'for B' } });
      const detailCalls = mockApi.getGoogleGmailThread.mock.calls.length;

      finishSend({});
      await new Promise((r) => setTimeout(r, 20));

      // B stays open with its draft; A is not reloaded.
      expect(screen.getByText('Numbers body')).toBeInTheDocument();
      expect(screen.queryByText('Dinner body')).not.toBeInTheDocument();
      expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe('for B');
      expect(mockApi.getGoogleGmailThread.mock.calls.length).toBe(detailCalls);
    });

    it('ignores a slow detail load for a thread that was replaced', async () => {
      let finishA: (v: unknown) => void = () => {};
      mockApi.getGoogleGmailThread.mockImplementation((id: string) =>
        id === 'th'
          ? new Promise((resolve) => (finishA = resolve))
          : Promise.resolve(threadBody('tw', 'Numbers', 'Boss <boss@work.com>')),
      );
      render(<GmailPage />);
      expect(await screen.findByText('Quarterly numbers')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Inbox'), { target: { value: '__all_inboxes__' } });

      fireEvent.click(await screen.findByText('Dinner on Friday?'));
      fireEvent.click(screen.getByRole('button', { name: /Close thread/i }));
      fireEvent.click(screen.getByText('Quarterly numbers'));
      expect(await screen.findByText('Numbers body')).toBeInTheDocument();

      finishA(threadBody('th', 'Dinner', 'Jane <jane@example.com>'));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByText('Numbers body')).toBeInTheDocument();
      expect(screen.queryByText('Dinner body')).not.toBeInTheDocument();
    });

    it('stays closed when the modal is dismissed during the detail load', async () => {
      let finishA: (v: unknown) => void = () => {};
      mockApi.getGoogleGmailThread.mockImplementation(
        () => new Promise((resolve) => (finishA = resolve)),
      );
      render(<GmailPage />);
      fireEvent.click(await screen.findByText('Quarterly numbers'));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Close thread/i }));

      finishA(threadBody('tw', 'Numbers', 'Boss <boss@work.com>'));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('stays closed when the modal is dismissed during the refresh after a reply', async () => {
      const waiting: Array<(v: unknown) => void> = [];
      mockApi.getGoogleGmailThread
        .mockImplementationOnce(async () => threadBody('tw', 'Numbers', 'Boss <boss@work.com>'))
        .mockImplementation(() => new Promise((resolve) => waiting.push(resolve)));
      mockApi.sendGoogleGmailMessage.mockResolvedValue({});
      render(<GmailPage />);
      fireEvent.click(await screen.findByText('Quarterly numbers'));
      fireEvent.change(await screen.findByLabelText('Reply'), { target: { value: 'Ok' } });
      fireEvent.click(screen.getByRole('button', { name: /Send reply/i }));
      await waitFor(() => expect(waiting).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: /Close thread/i }));

      waiting[0](threadBody('tw', 'Numbers', 'Boss <boss@work.com>'));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('leaves a reopened compose window alone when an earlier send finishes', async () => {
      let finishSend: (v: unknown) => void = () => {};
      mockApi.sendGoogleGmailMessage.mockImplementationOnce(
        () => new Promise((resolve) => (finishSend = resolve)),
      );
      render(<GmailPage />);
      expect(await screen.findByText('Quarterly numbers')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Compose/i }));
      fireEvent.change(screen.getByPlaceholderText(/alice@example.com/), {
        target: { value: 'a@x.com' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: /Message/i }), {
        target: { value: 'first' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: /Compose/i }));
      fireEvent.change(screen.getByRole('textbox', { name: /Message/i }), {
        target: { value: 'second draft' },
      });

      finishSend({});
      await new Promise((r) => setTimeout(r, 20));
      expect((screen.getByRole('textbox', { name: /Message/i }) as HTMLTextAreaElement).value).toBe(
        'second draft',
      );
    });

    it('composes from the inbox being viewed', async () => {
      mockApi.sendGoogleGmailMessage.mockResolvedValue({});
      render(<GmailPage />);
      expect(await screen.findByText('Quarterly numbers')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Inbox'), { target: { value: 'home' } });
      expect(await screen.findByText('Dinner on Friday?')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Compose/i }));
      expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe('home');
    });
  });
});
