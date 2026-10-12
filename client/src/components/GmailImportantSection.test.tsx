import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getGmailImportance: vi.fn(),
    updateGmailImportanceSettings: vi.fn(),
    startGmailImportanceScan: vi.fn(),
  },
}));

import { useState } from 'react';
import GmailImportantSection from './GmailImportantSection';
import { withoutImportantThreads, type GmailImportantThread } from '@shared/utils/gmailImportance';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function state(settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    running: false,
    threads: [],
    settings: {
      enabled: false,
      windowDays: 7,
      autoScan: 'off',
      lastScanAt: null,
      lastScanStatus: 'idle',
      lastScanError: null,
      lastScanEngine: null,
      lastScanModel: null,
      lastScanFailover: null,
      ...settings,
    },
    ...extra,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GmailImportantSection', () => {
  it('turning the toggle on saves the setting and runs a first scan', async () => {
    mockApi.getGmailImportance.mockResolvedValueOnce(state());
    mockApi.updateGmailImportanceSettings.mockResolvedValueOnce(state({ enabled: true }));
    mockApi.startGmailImportanceScan.mockResolvedValueOnce(
      state({ enabled: true, lastScanStatus: 'running' }, { running: true }),
    );

    render(<GmailImportantSection onOpenThread={vi.fn()} />);
    fireEvent.click(await screen.findByRole('switch', { name: /Show important mail first/i }));

    await waitFor(() =>
      expect(mockApi.updateGmailImportanceSettings).toHaveBeenCalledWith({ enabled: true }),
    );
    await waitFor(() =>
      expect(mockApi.startGmailImportanceScan).toHaveBeenCalledWith({ windowDays: 7 }),
    );
    expect(await screen.findByText('Scanning your inbox…')).toBeInTheDocument();
  });

  it('changes the window and auto-scan cadence, and opens a pinned thread', async () => {
    const onOpenThread = vi.fn();
    const enabled = state(
      { enabled: true, lastScanAt: '2026-10-12T11:00:00.000Z', lastScanStatus: 'ok' },
      {
        threads: [
          {
            threadId: 't9',
            historyId: '1',
            important: true,
            score: 80,
            reason: 'Contract deadline',
            subject: 'Renewal',
            from: '"Dana" <dana@example.com>',
            snippet: null,
            lastMessageAt: '2026-10-12T10:00:00.000Z',
            scannedAt: '2026-10-12T11:00:00.000Z',
          },
        ],
      },
    );
    mockApi.getGmailImportance.mockResolvedValue(enabled);
    mockApi.updateGmailImportanceSettings.mockResolvedValue(enabled);
    mockApi.startGmailImportanceScan.mockResolvedValue(enabled);

    render(<GmailImportantSection onOpenThread={onOpenThread} />);

    fireEvent.click(await screen.findByText('Dana'));
    expect(onOpenThread).toHaveBeenCalledWith('t9');

    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() =>
      expect(mockApi.updateGmailImportanceSettings).toHaveBeenCalledWith({ windowDays: 30 }),
    );

    fireEvent.change(screen.getByLabelText('Automated scan'), { target: { value: 'hourly' } });
    await waitFor(() =>
      expect(mockApi.updateGmailImportanceSettings).toHaveBeenCalledWith({ autoScan: 'hourly' }),
    );
  });

  it('keeps polling after a failed poll and clears the spinner when the scan finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = state({ enabled: true, lastScanStatus: 'running' }, { running: true });
    const done = state({
      enabled: true,
      lastScanStatus: 'ok',
      lastScanAt: new Date().toISOString(),
    });
    mockApi.getGmailImportance
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(done);

    render(<GmailImportantSection onOpenThread={vi.fn()} />);
    expect(await screen.findByText('Scanning your inbox…')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(mockApi.getGmailImportance).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(mockApi.getGmailImportance).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/^Scanned /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scan now/i })).not.toBeDisabled();
  });

  it('picks up an automated scan that starts after an idle load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pinned = {
      threadId: 't5',
      historyId: '1',
      important: true,
      score: 70,
      reason: 'Invoice overdue',
      subject: 'Invoice',
      from: 'Billing <billing@example.com>',
      snippet: null,
      lastMessageAt: '2026-10-12T10:00:00.000Z',
      scannedAt: '2026-10-12T11:00:00.000Z',
    };
    mockApi.getGmailImportance
      .mockResolvedValueOnce(
        state({ enabled: true, lastScanStatus: 'ok', lastScanAt: new Date().toISOString() }),
      )
      .mockResolvedValueOnce(state({ enabled: true, lastScanStatus: 'running' }, { running: true }))
      .mockResolvedValueOnce(
        state(
          { enabled: true, lastScanStatus: 'ok', lastScanAt: new Date().toISOString() },
          { threads: [pinned] },
        ),
      );

    render(<GmailImportantSection onOpenThread={vi.fn()} />);
    expect(await screen.findByText(/^Scanned /)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await screen.findByText('Scanning your inbox…')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await screen.findByText('Invoice overdue')).toBeInTheDocument();
    expect(mockApi.getGmailImportance).toHaveBeenCalledTimes(3);
  });

  it('locks the picker when the server refuses a window change for a scan it started', async () => {
    mockApi.getGmailImportance
      .mockResolvedValueOnce(state({ enabled: true, windowDays: 1, lastScanStatus: 'ok' }))
      .mockResolvedValue(
        state({ enabled: true, windowDays: 1, lastScanStatus: 'running' }, { running: true }),
      );
    mockApi.updateGmailImportanceSettings.mockRejectedValueOnce(
      Object.assign(new Error('A scan is running. Change the window when it finishes.'), {
        status: 409,
      }),
    );
    render(<GmailImportantSection onOpenThread={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '30 days' }));
    expect(
      await screen.findByText('A scan is running. Change the window when it finishes.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Scanning your inbox…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30 days' })).toBeDisabled();
    expect(mockApi.startGmailImportanceScan).not.toHaveBeenCalled();
  });

  it('locks the window picker while a scan is running', async () => {
    mockApi.getGmailImportance.mockResolvedValue(
      state({ enabled: true, windowDays: 1, lastScanStatus: 'running' }, { running: true }),
    );
    render(<GmailImportantSection onOpenThread={vi.fn()} />);
    const thirty = await screen.findByRole('button', { name: '30 days' });
    expect(thirty).toBeDisabled();
    fireEvent.click(thirty);
    expect(mockApi.updateGmailImportanceSettings).not.toHaveBeenCalled();
  });

  it('explains why the toggle stayed off when enabling fails', async () => {
    mockApi.getGmailImportance.mockResolvedValue(state());
    mockApi.updateGmailImportanceSettings.mockRejectedValueOnce(new Error('Server unavailable'));
    render(<GmailImportantSection onOpenThread={vi.fn()} />);
    const toggle = await screen.findByRole('switch', { name: /Show important mail first/i });
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    expect(toggle).not.toBeChecked();
    expect(mockApi.startGmailImportanceScan).not.toHaveBeenCalled();
  });

  it('shows the error when the first load fails', async () => {
    mockApi.getGmailImportance.mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<GmailImportantSection onOpenThread={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });

  it('releases its pins from the regular list when it unmounts and remounts without data', async () => {
    const pin = {
      threadId: 't9',
      historyId: '1',
      important: true,
      score: 80,
      reason: 'Contract deadline',
      subject: 'Renewal',
      from: 'Dana <dana@example.com>',
      snippet: null,
      lastMessageAt: '2026-10-12T10:00:00.000Z',
      scannedAt: '2026-10-12T11:00:00.000Z',
    };
    // Mirrors GmailPage: the parent owns the hidden-thread list and unmounts
    // the section while it reloads.
    function Page({ showSection }: { showSection: boolean }) {
      const [pinned, setPinned] = useState<GmailImportantThread[]>([]);
      const inbox = [
        { id: 't9', snippet: 'Renewal thread' },
        { id: 't1', snippet: 'Lunch thread' },
      ];
      return (
        <div>
          {showSection && (
            <GmailImportantSection onOpenThread={vi.fn()} onPinnedChange={setPinned} />
          )}
          <ul aria-label="inbox">
            {withoutImportantThreads(inbox, pinned).map((t) => (
              <li key={t.id}>{t.snippet}</li>
            ))}
          </ul>
        </div>
      );
    }
    mockApi.getGmailImportance
      .mockResolvedValueOnce(
        state(
          { enabled: true, lastScanStatus: 'ok', lastScanAt: '2026-10-12T11:00:00.000Z' },
          { threads: [pin] },
        ),
      )
      .mockRejectedValueOnce(new Error('Failed to fetch'));

    const { rerender } = render(<Page showSection />);
    expect(await screen.findByText('Contract deadline')).toBeInTheDocument();
    expect(screen.queryByText('Renewal thread')).not.toBeInTheDocument();

    rerender(<Page showSection={false} />);
    expect(screen.getByText('Renewal thread')).toBeInTheDocument();

    rerender(<Page showSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
    expect(screen.getByText('Renewal thread')).toBeInTheDocument();
    expect(screen.getByText('Lunch thread')).toBeInTheDocument();
  });

  it('shows the failover note from the last scan', async () => {
    mockApi.getGmailImportance.mockResolvedValueOnce(
      state({
        enabled: true,
        lastScanAt: '2026-10-12T11:00:00.000Z',
        lastScanStatus: 'ok',
        lastScanFailover: 'Switched engines: claude-code → codex-cli (usage-exhausted)',
      }),
    );
    render(<GmailImportantSection onOpenThread={vi.fn()} />);
    expect(
      await screen.findByText(/Switched engines: claude-code → codex-cli/),
    ).toBeInTheDocument();
  });
});
