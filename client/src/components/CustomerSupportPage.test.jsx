import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import CustomerSupportPage, { sortTickets, resolveReplayUrl } from './CustomerSupportPage.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: { getSupportTickets: vi.fn() },
}));

vi.mock('../utils/connection.js', () => ({
  getServerBase: () => 'https://hub.example.com',
}));

function ticket(overrides = {}) {
  return {
    id: overrides.id || 't1',
    project_id: 'proj-1',
    type: 'bug',
    severity: 'medium',
    status: 'new',
    subject: 'Something broke',
    body: 'Details here',
    reporter: null,
    ai_summary: null,
    ai_investigation: null,
    ai_investigated_at: null,
    replay_ref: null,
    converted_card_id: null,
    created_at: '2026-06-14 10:00:00',
    updated_at: '2026-06-14 10:00:00',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sortTickets', () => {
  it('orders by severity (critical → low) then newest first', () => {
    const sorted = sortTickets([
      ticket({ id: 'low', severity: 'low', created_at: '2026-06-14 12:00:00' }),
      ticket({ id: 'crit', severity: 'critical', created_at: '2026-06-14 09:00:00' }),
      ticket({ id: 'high', severity: 'high', created_at: '2026-06-14 11:00:00' }),
      ticket({ id: 'med-old', severity: 'medium', created_at: '2026-06-14 08:00:00' }),
      ticket({ id: 'med-new', severity: 'medium', created_at: '2026-06-14 13:00:00' }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['crit', 'high', 'med-new', 'med-old', 'low']);
  });
});

describe('resolveReplayUrl', () => {
  it('passes absolute URLs through and prefixes server-relative paths', () => {
    expect(resolveReplayUrl('https://x.test/r.json')).toBe('https://x.test/r.json');
    expect(resolveReplayUrl('/uploads/r.json')).toBe('https://hub.example.com/uploads/r.json');
    expect(resolveReplayUrl(null)).toBe(null);
  });
});

describe('CustomerSupportPage', () => {
  it('renders tickets ordered by severity with type, severity, AI summary and replay link', async () => {
    api.getSupportTickets.mockResolvedValue([
      ticket({
        id: 'crit',
        severity: 'critical',
        type: 'bug',
        subject: 'Critical crash',
        ai_summary: 'Likely a null deref in checkout',
        replay_ref: '/uploads/replay-crit.json',
        created_at: '2026-06-14 09:00:00',
      }),
      ticket({
        id: 'feat',
        severity: 'low',
        type: 'feature_request',
        subject: 'Dark mode please',
        created_at: '2026-06-14 10:00:00',
      }),
    ]);

    render(<CustomerSupportPage projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText('Critical crash')).toBeInTheDocument());

    // Severity-ordered: critical card appears before the low feature request.
    const crit = screen.getByText('Critical crash');
    const feat = screen.getByText('Dark mode please');
    expect(crit.compareDocumentPosition(feat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Type + severity badges, AI summary, and bug replay link all render.
    expect(screen.getByText('Bug')).toBeInTheDocument();
    expect(screen.getByText('Feature request')).toBeInTheDocument();
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('Likely a null deref in checkout')).toBeInTheDocument();
    const replay = screen.getByRole('link', { name: /view session replay/i });
    expect(replay).toHaveAttribute('href', 'https://hub.example.com/uploads/replay-crit.json');
  });

  it('does not render a replay link for non-bug tickets', async () => {
    api.getSupportTickets.mockResolvedValue([
      ticket({ id: 'q', type: 'question', replay_ref: '/uploads/x.json', subject: 'How?' }),
    ]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('How?')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /view session replay/i })).toBeNull();
  });

  it('shows an empty state when there are no tickets', async () => {
    api.getSupportTickets.mockResolvedValue([]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No support requests')).toBeInTheDocument());
  });

  it('live-inserts a WebSocket ticket in severity order via the imperative handle', async () => {
    api.getSupportTickets.mockResolvedValue([
      ticket({ id: 'med', severity: 'medium', subject: 'Existing medium' }),
    ]);
    const ref = createRef();
    render(<CustomerSupportPage ref={ref} projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Existing medium')).toBeInTheDocument());

    act(() => {
      ref.current.addTicket(ticket({ id: 'crit', severity: 'critical', subject: 'New critical' }));
    });

    await waitFor(() => expect(screen.getByText('New critical')).toBeInTheDocument());
    const crit = screen.getByText('New critical');
    const med = screen.getByText('Existing medium');
    // The newly-arrived critical sorts above the existing medium.
    expect(crit.compareDocumentPosition(med) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('removes a ticket via the imperative handle', async () => {
    api.getSupportTickets.mockResolvedValue([ticket({ id: 'gone', subject: 'Bye ticket' })]);
    const ref = createRef();
    render(<CustomerSupportPage ref={ref} projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Bye ticket')).toBeInTheDocument());

    act(() => ref.current.removeTicket('gone'));
    await waitFor(() => expect(screen.queryByText('Bye ticket')).toBeNull());
  });
});
