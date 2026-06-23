import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getMessageEvents: vi.fn(),
  },
}));

import { api } from '../utils/api';
import SessionTail from './SessionTail';

const askEvent = {
  type: 'ask_user_question',
  askId: 'ask-test',
  questions: [
    {
      question: 'Pick a color?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'Warm' },
        { label: 'Blue', description: 'Cool' },
      ],
    },
  ],
};

describe('SessionTail — lazy message events fetch', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) — clearAllMocks resets call history
    // but leaves the per-call `*Once` queue intact, so a leftover
    // `mockResolvedValueOnce` from one test gets consumed by the next.
    vi.resetAllMocks();
  });

  it('on fetch failure with content: shows legacy bubble + retry banner, then recovers to ask picker on retry', async () => {
    const onEventsLoaded = vi.fn();
    const message = {
      id: 'msg-events-1',
      role: 'assistant',
      content: 'Assistant reply text (ask fence stripped at persistence).',
      engine: 'claude-code',
      model: 'claude-3-5-sonnet',
      created_at: '2026-04-21T12:00:00Z',
    };

    (api.getMessageEvents as any)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([
        { seq: 1, event: { type: 'assistant_text', text: 'Hello.', partial: false } },
        { seq: 2, event: askEvent },
      ]);

    render(
      <SessionTail
        message={message}
        events={undefined}
        agentColor="#6366f1"
        streaming={false}
        onEventsLoaded={onEventsLoaded}
      />,
    );

    // After the fetch fails, the user must NOT be locked out of their own
    // message content. The legacy bubble (markdown content) renders alongside
    // a small inline banner with a retry button. The dead-end "Could not load
    // the message timeline" block-level error is gone now that there's a
    // safer fallback.
    expect(await screen.findByTestId('session-tail-events-error-banner')).toBeInTheDocument();
    expect(
      screen.getByText('Assistant reply text (ask fence stripped at persistence).'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('session-tail-events-error')).not.toBeInTheDocument();
    expect(onEventsLoaded!).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /retry/i } as any) as any);

    await waitFor(() => {
      expect(onEventsLoaded!).toHaveBeenCalledTimes(1);
      expect(onEventsLoaded!).toHaveBeenCalledWith(
        'msg-events-1',
        expect.arrayContaining([expect.objectContaining({ seq: 2, event: askEvent })]),
      );
    });

    expect(screen.getByText('Pick your answer')).toBeInTheDocument();
    expect(screen.getByText('Pick a color?')).toBeInTheDocument();
  });

  it('on fetch failure with NO content: keeps the block-level error UI; retry shows loading immediately', async () => {
    // Message row exists but persistence captured no body — e.g. a server
    // error created an empty content message. With nothing to fall back to,
    // the existing block-level error remains the right UI.
    const message = {
      id: 'msg-noevents-noContent',
      role: 'assistant',
      content: '',
      engine: 'claude-code',
      model: 'claude-3-5-sonnet',
      created_at: '2026-04-21T12:00:00Z',
    };

    // First call rejects; second call hangs so we can observe the optimistic
    // loading flip after retry without racing the rejection back to 'error'.
    (api.getMessageEvents as any)
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementationOnce(() => new Promise(() => {}));

    render(
      <SessionTail message={message} events={undefined} agentColor="#6366f1" streaming={false} />,
    );

    expect(await screen.findByTestId('session-tail-events-error')).toBeInTheDocument();
    expect(screen.queryByTestId('session-tail-events-error-banner')).not.toBeInTheDocument();

    // Click Retry. The handler optimistically flips state to 'loading' so
    // the user sees immediate feedback even before the network call settles.
    fireEvent.click(screen.getByRole('button', { name: /retry/i } as any) as any);
    expect(await screen.findByTestId('session-tail-events-loading')).toBeInTheDocument();
  });

  it('falls back to legacy bubble when API returns an empty event list', async () => {
    const onEventsLoaded = vi.fn();
    const message = {
      id: 'msg-legacy',
      role: 'assistant',
      content: 'Old message body without stream-json events.',
      engine: 'claude-code',
      model: 'claude-3-5-sonnet',
      created_at: '2026-04-21T12:00:00Z',
    };

    (api.getMessageEvents as any).mockResolvedValueOnce([]);

    render(
      <SessionTail
        message={message}
        events={undefined}
        agentColor="#6366f1"
        streaming={false}
        onEventsLoaded={onEventsLoaded}
      />,
    );

    await waitFor(() => expect(onEventsLoaded!).toHaveBeenCalledWith('msg-legacy', []));
    expect(
      await screen.findByText('Old message body without stream-json events.'),
    ).toBeInTheDocument();
  });
});
