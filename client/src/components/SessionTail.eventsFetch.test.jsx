import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../utils/api.js', () => ({
  api: {
    getMessageEvents: vi.fn(),
  },
}));

import { api } from '../utils/api.js';
import SessionTail from './SessionTail.jsx';

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
    vi.clearAllMocks();
  });

  it('does not cache an empty timeline on fetch failure; shows error and retry, then renders ask picker', async () => {
    const onEventsLoaded = vi.fn();
    const message = {
      id: 'msg-events-1',
      role: 'assistant',
      content: 'Assistant reply text (ask fence stripped at persistence).',
      engine: 'claude-code',
      model: 'claude-3-5-sonnet',
      created_at: '2026-04-21T12:00:00Z',
    };

    api.getMessageEvents.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce([
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

    expect(await screen.findByTestId('session-tail-events-loading')).toBeInTheDocument();

    const err = await screen.findByTestId('session-tail-events-error');
    expect(err).toBeInTheDocument();
    expect(onEventsLoaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(onEventsLoaded).toHaveBeenCalledTimes(1);
      expect(onEventsLoaded).toHaveBeenCalledWith(
        'msg-events-1',
        expect.arrayContaining([expect.objectContaining({ seq: 2, event: askEvent })]),
      );
    });

    expect(screen.getByText('Pick your answer')).toBeInTheDocument();
    expect(screen.getByText('Pick a color?')).toBeInTheDocument();
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

    api.getMessageEvents.mockResolvedValueOnce([]);

    render(
      <SessionTail
        message={message}
        events={undefined}
        agentColor="#6366f1"
        streaming={false}
        onEventsLoaded={onEventsLoaded}
      />,
    );

    await waitFor(() => expect(onEventsLoaded).toHaveBeenCalledWith('msg-legacy', []));
    expect(
      await screen.findByText('Old message body without stream-json events.'),
    ).toBeInTheDocument();
  });
});
