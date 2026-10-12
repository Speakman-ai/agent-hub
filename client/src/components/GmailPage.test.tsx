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
      expect(mockApi.sendGoogleGmailMessage).toHaveBeenCalledWith({
        to: ['alice@example.com'],
        subject: 'Hello',
        text: 'Hi there',
      });
    });
  });
});
