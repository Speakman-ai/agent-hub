import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    listSessionPollers: vi.fn(),
    startSessionPoller: vi.fn(),
    stopSessionPoller: vi.fn(),
  },
}));

import { api } from '../utils/api';
import SessionPollerCard from './SessionPollerCard';
import { SESSION_POLLER_WS_EVENT, checkPollerForm } from '../utils/sessionPollers';

const proposal = {
  pollerId: 'dev-tickets',
  task: 'Check dev for new tickets',
  intervalMinutes: 30,
  durationMinutes: null,
  until: 'tomorrow 09:00',
  notifyEachRun: false,
  notifyOnComplete: true,
};

const active = {
  id: 'p-1',
  sessionId: 's-1',
  pollerId: 'dev-tickets',
  task: 'Check dev for new tickets',
  intervalMinutes: 30,
  durationMinutes: 1120,
  notifyEachRun: false,
  notifyOnComplete: true,
  status: 'active',
  runCount: 0,
  startedAt: '2026-11-10T14:20:00.000Z',
  endsAt: '2026-11-11T09:00:00.000Z',
  nextRunAt: '2026-11-10T14:20:00.000Z',
  lastRunAt: null,
  finishedAt: null,
};

describe('SessionPollerCard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    // 14:20 local; "tomorrow 09:00" is 18h40m away.
    vi.setSystemTime(new Date(2026, 10, 10, 14, 20));
    (api.listSessionPollers as any).mockResolvedValue({ pollers: [] });
    (api.startSessionPoller as any).mockResolvedValue({ poller: active, created: true });
    (api.stopSessionPoller as any).mockResolvedValue({
      poller: { ...active, status: 'cancelled', nextRunAt: null },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pre-fills the schedule, resolving "until" against local time', async () => {
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    expect((screen.getByLabelText('Interval in minutes') as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText('Duration in minutes') as HTMLInputElement).value).toBe('1120');
    expect((screen.getByLabelText('Notify me after every run') as HTMLInputElement).checked).toBe(
      false,
    );
    expect((screen.getByLabelText('Notify me when it finishes') as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.getByText('About 38 checks, first one now')).toBeTruthy();
  });

  it('starts the poller with the edited values and then shows its status', async () => {
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    await waitFor(() => expect(api.listSessionPollers).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Interval in minutes'), { target: { value: '15' } });
    fireEvent.click(screen.getByLabelText('Notify me after every run'));
    await waitFor(() =>
      expect((screen.getByText('Start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(api.startSessionPoller).toHaveBeenCalled());
    expect((api.startSessionPoller as any).mock.calls[0]).toEqual([
      's-1',
      {
        pollerId: 'dev-tickets',
        task: 'Check dev for new tickets',
        intervalMinutes: 15,
        durationMinutes: 1120,
        notifyEachRun: true,
        notifyOnComplete: true,
      },
    ]);
    await screen.findByText('Running · 0 runs so far');

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SESSION_POLLER_WS_EVENT, {
          detail: { sessionId: 's-1', poller: { ...active, runCount: 1 } },
        }),
      );
    });
    expect(screen.getByText('Running · 1 run so far')).toBeTruthy();

    fireEvent.click(screen.getByText('Stop'));
    await screen.findByText('Stopped after 0 runs');
    expect(api.stopSessionPoller).toHaveBeenCalledWith('s-1', 'p-1');
  });

  it('keeps the named end time when Start is clicked later', async () => {
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    await waitFor(() => expect(api.listSessionPollers).toHaveBeenCalled());
    // The card sat open for an hour: 9am tomorrow is now 17h40m away, not 18h40m.
    vi.setSystemTime(new Date(2026, 10, 10, 15, 20));
    await waitFor(() =>
      expect((screen.getByText('Start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(api.startSessionPoller).toHaveBeenCalled());
    expect((api.startSessionPoller as any).mock.calls[0][1].durationMinutes).toBe(1060);
  });

  it('submits an edited duration as typed', async () => {
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    await waitFor(() => expect(api.listSessionPollers).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Duration in minutes'), { target: { value: '90' } });
    vi.setSystemTime(new Date(2026, 10, 10, 15, 20));
    await waitFor(() =>
      expect((screen.getByText('Start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(api.startSessionPoller).toHaveBeenCalled());
    expect((api.startSessionPoller as any).mock.calls[0][1].durationMinutes).toBe(90);
  });

  it('refuses to start once the named end time has passed', async () => {
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    await waitFor(() => expect(api.listSessionPollers).toHaveBeenCalled());
    vi.setSystemTime(new Date(2026, 10, 11, 9, 30));
    await waitFor(() =>
      expect((screen.getByText('Start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText('Start'));
    await screen.findByText('That end time has passed. Set a duration to start.');
    expect(api.startSessionPoller).not.toHaveBeenCalled();
  });

  it('anchors "tomorrow" to the proposal when the session is reopened after midnight', async () => {
    // Proposed Tuesday 14:20 local, reopened Wednesday 01:00.
    const proposedAt = new Date(2026, 10, 10, 14, 20).toISOString();
    vi.setSystemTime(new Date(2026, 10, 11, 1, 0));
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} proposedAt={proposedAt} />);
    expect((screen.getByLabelText('Duration in minutes') as HTMLInputElement).value).toBe('480');
    await waitFor(() =>
      expect((screen.getByText('Start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(api.startSessionPoller).toHaveBeenCalled());
    expect((api.startSessionPoller as any).mock.calls[0][1].durationMinutes).toBe(480);
  });

  it('asks for a duration when reopened after the requested end time', async () => {
    const proposedAt = new Date(2026, 10, 10, 14, 20).toISOString();
    vi.setSystemTime(new Date(2026, 10, 11, 10, 0));
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} proposedAt={proposedAt} />);
    expect((screen.getByLabelText('Duration in minutes') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/The requested end .* has passed\. Set a duration\./)).toBeTruthy();
    expect((screen.getByText('Start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Duration in minutes'), { target: { value: '60' } });
    await waitFor(() =>
      expect((screen.getByText('Start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(api.startSessionPoller).toHaveBeenCalled());
    expect((api.startSessionPoller as any).mock.calls[0][1].durationMinutes).toBe(60);
  });

  it('recovers a terminal state whose WS event was missed when the tab regains focus', async () => {
    (api.listSessionPollers as any).mockResolvedValueOnce({ pollers: [active] });
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    await screen.findByText('Running · 0 runs so far');
    // The poller finished while the socket was down: no event arrives.
    (api.listSessionPollers as any).mockResolvedValue({
      pollers: [{ ...active, status: 'completed', runCount: 38, nextRunAt: null }],
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByText('Finished after 38 runs');
    expect(screen.queryByText('Stop')).toBeNull();
  });

  it('shows the existing poller instead of the form after a reload', async () => {
    (api.listSessionPollers as any).mockResolvedValue({
      pollers: [{ ...active, status: 'completed', runCount: 38 }],
    });
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    await screen.findByText('Finished after 38 runs');
    expect(screen.queryByText('Start')).toBeNull();
  });
});

describe('checkPollerForm', () => {
  it('requires whole positive minutes and a task', () => {
    expect(checkPollerForm({ task: 'x', interval: '30', duration: '60' }).errors).toEqual({});
    const bad = checkPollerForm({ task: ' ', interval: '0', duration: '1.5' });
    expect(Object.keys(bad.errors).sort()).toEqual(['duration', 'interval', 'task']);
    expect(checkPollerForm({ task: 'x', interval: '5', duration: '20000' }).errors.duration).toBe(
      'At most 7 days',
    );
  });
});

describe('SessionPollerCard reconciliation timer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 14, 20));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads an active poller periodically and stops once it is finished', async () => {
    (api.listSessionPollers as any).mockResolvedValueOnce({ pollers: [active] });
    render(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Running · 0 runs so far')).toBeTruthy();

    (api.listSessionPollers as any).mockResolvedValue({
      pollers: [{ ...active, status: 'cancelled', runCount: 3, nextRunAt: null }],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText('Stopped after 3 runs')).toBeTruthy();

    const calls = (api.listSessionPollers as any).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect((api.listSessionPollers as any).mock.calls.length).toBe(calls);
  });
});
