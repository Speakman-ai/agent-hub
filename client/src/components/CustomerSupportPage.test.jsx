import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import CustomerSupportPage, { sortTickets, resolveReplayUrl } from './CustomerSupportPage.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getSupportTickets: vi.fn(),
    getSupportTicket: vi.fn(),
    convertSupportTicketToCard: vi.fn(),
    deleteSupportTicket: vi.fn(),
  },
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
  it('renders tickets ordered by severity with type, severity, AI summary and watch-replay control', async () => {
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

    // Type + severity badges, AI summary, and a bug "Watch replay" button render
    // (the replay now opens a sandboxed in-app player rather than a raw JSON link).
    expect(screen.getByText('Bug')).toBeInTheDocument();
    expect(screen.getByText('Feature request')).toBeInTheDocument();
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('Likely a null deref in checkout')).toBeInTheDocument();
    const replay = screen.getByRole('button', { name: /watch replay/i });
    expect(replay).toBeInTheDocument();
    // No legacy raw-JSON link.
    expect(screen.queryByRole('link', { name: /session replay/i })).toBeNull();
  });

  it('does not render a watch-replay control for non-bug tickets', async () => {
    api.getSupportTickets.mockResolvedValue([
      ticket({ id: 'q', type: 'question', replay_ref: '/uploads/x.json', subject: 'How?' }),
    ]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('How?')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /watch replay/i })).toBeNull();
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

  it('deletes a ticket after a two-step confirm, calling the API', async () => {
    api.getSupportTickets.mockResolvedValue([ticket({ id: 'kill', subject: 'Delete me' })]);
    api.deleteSupportTicket.mockResolvedValue({ ok: true });

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Delete me')).toBeInTheDocument());

    // First click arms the confirm step — the API is not called yet.
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(api.deleteSupportTicket).not.toHaveBeenCalled();
    expect(screen.getByText('Delete?')).toBeInTheDocument();

    // Confirm fires the delete.
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(api.deleteSupportTicket).toHaveBeenCalledWith('proj-1', 'kill'));

    // The initiating client removes the row optimistically on success — it must
    // NOT wait on the support_ticket_deleted WebSocket echo (which may be
    // dropped if the socket is disconnected/reconnecting).
    await waitFor(() => expect(screen.queryByText('Delete me')).toBeNull());
  });

  it('removes the ticket from the open detail modal on a successful delete', async () => {
    api.getSupportTickets.mockResolvedValue([ticket({ id: 'm1', subject: 'Modal delete' })]);
    api.getSupportTicket.mockResolvedValue(ticket({ id: 'm1', subject: 'Modal delete' }));
    api.deleteSupportTicket.mockResolvedValue({ ok: true });

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Modal delete')).toBeInTheDocument());

    // Open the detail modal and delete from its footer.
    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i }));
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );
    const modal = screen.getByTestId('support-ticket-detail-modal');
    fireEvent.click(within(modal).getByRole('button', { name: /^delete$/i }));
    fireEvent.click(within(modal).getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(api.deleteSupportTicket).toHaveBeenCalledWith('proj-1', 'm1'));
    // Both the modal and the underlying list row disappear without a WS event.
    await waitFor(() => expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull());
    expect(screen.queryByText('Modal delete')).toBeNull();
  });

  it('cancels an armed delete without calling the API', async () => {
    api.getSupportTickets.mockResolvedValue([ticket({ id: 'safe', subject: 'Keep me' })]);

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Keep me')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(api.deleteSupportTicket).not.toHaveBeenCalled();
    // Back to the un-armed Delete button.
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('does not open the detail modal when the Delete action is clicked', async () => {
    api.getSupportTickets.mockResolvedValue([ticket({ id: 't1', subject: 'No accidental open' })]);

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No accidental open')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    // Arming the confirm must not trigger the full-card open button.
    expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull();
    expect(api.getSupportTicket).not.toHaveBeenCalled();
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

describe('CustomerSupportPage — ticket detail view', () => {
  it('opens a detail modal via the full-card open button and shows the full AI investigation from the detail endpoint', async () => {
    api.getSupportTickets.mockResolvedValue([
      ticket({
        id: 'crit',
        subject: 'Critical crash',
        body: 'Short body',
        ai_summary: 'Short summary',
        ai_investigation: null,
      }),
    ]);
    // The dedicated detail endpoint returns the enriched, full investigation.
    api.getSupportTicket.mockResolvedValue(
      ticket({
        id: 'crit',
        subject: 'Critical crash',
        body: 'Short body',
        ai_summary: 'Short summary',
        ai_investigation: 'Full multi-paragraph investigation with root cause analysis.',
        ai_investigated_at: '2026-06-14 11:00:00',
      }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Critical crash')).toBeInTheDocument());

    expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i }));

    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );
    expect(api.getSupportTicket).toHaveBeenCalledWith('proj-1', 'crit');
    // The full investigation (not the truncated summary) renders once fetched.
    await waitFor(() =>
      expect(
        screen.getByText('Full multi-paragraph investigation with root cause analysis.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('renders the ticket Description and AI investigation as formatted markdown, not raw source', async () => {
    // The modal reads `body` from the live list prop and backfills the AI
    // investigation from the dedicated detail fetch — exercise both paths.
    api.getSupportTickets.mockResolvedValue([
      ticket({
        id: 'md',
        subject: 'Markdown ticket',
        body: '## Steps\n\n- **User ID**: 1\n- visit [home](https://example.com)',
      }),
    ]);
    api.getSupportTicket.mockResolvedValue(
      ticket({
        id: 'md',
        subject: 'Markdown ticket',
        body: '## Steps\n\n- **User ID**: 1\n- visit [home](https://example.com)',
        ai_investigation: '### Root cause\n\nA **null** reference in `handler`.',
        ai_investigated_at: '2026-06-14 11:00:00',
      }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Markdown ticket')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i }));

    const modal = await screen.findByTestId('support-ticket-detail-modal');

    // Markdown is converted to DOM elements, so the literal markers must not survive as text.
    await waitFor(() => expect(within(modal).queryByText(/## Steps/)).toBeNull());
    expect(within(modal).queryByText(/\*\*User ID\*\*/)).toBeNull();

    // Headings, bold runs, links and inline code render as real elements.
    expect(within(modal).getByRole('heading', { name: 'Steps' })).toBeInTheDocument();
    expect(within(modal).getByText('User ID').tagName).toBe('STRONG');
    const link = within(modal).getByRole('link', { name: 'home' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(within(modal).getByRole('heading', { name: 'Root cause' })).toBeInTheDocument();
    expect(within(modal).getByText('handler').tagName).toBe('CODE');
  });

  it('uses a non-interactive card container with a dedicated open button, not nested interactive controls', async () => {
    api.getSupportTickets.mockResolvedValue([
      ticket({ id: 't1', subject: 'A11y', type: 'bug', replay_ref: '/uploads/replay-x.json' }),
    ]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('A11y')).toBeInTheDocument());

    // The card container itself must not be an interactive control.
    const card = screen.getByTestId('support-ticket-card');
    expect(card.getAttribute('role')).not.toBe('button');
    expect(card.tagName).toBe('DIV');

    // A dedicated full-card open button exists...
    const openBtn = screen.getByRole('button', { name: /open support ticket/i });
    expect(openBtn.tagName).toBe('BUTTON');
    // ...and it nests no interactive controls (no button-inside-a-button).
    expect(openBtn.querySelector('button, a, [role="button"]')).toBeNull();
    // The real actions (Watch replay / Convert) are siblings, not descendants
    // of the open button.
    expect(openBtn.contains(screen.getByTestId('watch-replay-button'))).toBe(false);
    expect(openBtn.contains(screen.getByRole('button', { name: /convert to card/i }))).toBe(false);
  });

  it('closes the detail modal via the close button', async () => {
    api.getSupportTickets.mockResolvedValue([ticket({ id: 't1', subject: 'Openable' })]);
    api.getSupportTicket.mockResolvedValue(ticket({ id: 't1', subject: 'Openable' }));

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Openable')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i }));
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull());
  });

  it('renders an attached screenshot on the card and in the detail modal', async () => {
    const shot = ticket({
      id: 't1',
      subject: 'Visual bug',
      screenshot_ref: '/uploads/support-screenshot-abc.png',
    });
    api.getSupportTickets.mockResolvedValue([shot]);
    api.getSupportTicket.mockResolvedValue(shot);

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Visual bug')).toBeInTheDocument());

    // Card thumbnail resolves the /uploads ref against the server base.
    const thumb = screen.getByTestId('ticket-screenshot-thumb');
    const thumbImg = within(thumb).getByRole('img');
    expect(thumbImg).toHaveAttribute(
      'src',
      'https://hub.example.com/uploads/support-screenshot-abc.png',
    );

    // Open the modal and assert the larger screenshot renders too.
    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i }));
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );
    const modal = screen.getByTestId('support-ticket-detail-modal');
    const detail = within(modal).getByTestId('detail-screenshot');
    expect(within(detail).getByRole('img')).toHaveAttribute(
      'src',
      'https://hub.example.com/uploads/support-screenshot-abc.png',
    );
  });

  it('shows no screenshot affordance when screenshot_ref is null', async () => {
    api.getSupportTickets.mockResolvedValue([ticket({ id: 't1', screenshot_ref: null })]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Something broke')).toBeInTheDocument());
    expect(screen.queryByTestId('ticket-screenshot-thumb')).toBeNull();
  });

  it('propagates same-ticket WebSocket updates into the open detail modal', async () => {
    api.getSupportTickets.mockResolvedValue([
      ticket({ id: 't1', subject: 'Live updates', status: 'new' }),
    ]);
    api.getSupportTicket.mockResolvedValue(
      ticket({ id: 't1', subject: 'Live updates', status: 'new' }),
    );

    const ref = createRef();
    render(<CustomerSupportPage ref={ref} projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Live updates')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i }));
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );

    const modal = screen.getByTestId('support-ticket-detail-modal');
    // Before the update the modal offers the Convert action.
    expect(within(modal).getByRole('button', { name: /convert to card/i })).toBeInTheDocument();

    // A same-ticket WebSocket row (e.g. convert landed) arrives via the parent.
    act(() =>
      ref.current.updateTicket(
        ticket({
          id: 't1',
          subject: 'Live updates',
          status: 'converted',
          converted_card_id: 'card-9',
        }),
      ),
    );

    // The OPEN modal reflects the new state, not the stale copy.
    await waitFor(() => expect(within(modal).getByText(/converted to card/i)).toBeInTheDocument());
    expect(within(modal).queryByRole('button', { name: /convert to card/i })).toBeNull();
  });

  it('keeps the detail modal open when a status filter would drop the ticket from the list', async () => {
    // 'all'/'new' return the ticket; the narrower 'converted' filter returns an
    // empty list (the open 'new' ticket is no longer in view).
    api.getSupportTickets.mockImplementation((_projectId, status) =>
      Promise.resolve(
        status === 'converted' ? [] : [ticket({ id: 't1', subject: 'Stay open', status: 'new' })],
      ),
    );
    api.getSupportTicket.mockResolvedValue(
      ticket({ id: 't1', subject: 'Stay open', status: 'new' }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByTestId('support-ticket-card')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i }));
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );

    // Switch to a filter that excludes the open ticket.
    fireEvent.click(screen.getByRole('button', { name: 'Converted' }));

    // The list card drops out of view, but the modal must stay open — the user
    // keeps their place rather than having it yanked away.
    await waitFor(() => expect(screen.queryByTestId('support-ticket-card')).toBeNull());
    expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument();
  });

  it('does not open the detail modal when the Convert action is clicked', async () => {
    api.getSupportTickets.mockResolvedValue([
      ticket({ id: 't1', subject: 'No accidental open', type: 'bug' }),
    ]);
    api.convertSupportTicketToCard.mockResolvedValue(
      ticket({ id: 't1', status: 'converted', converted_card_id: 'card-9' }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No accidental open')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /convert to card/i }));

    await waitFor(() =>
      expect(api.convertSupportTicketToCard).toHaveBeenCalledWith('proj-1', 't1'),
    );
    // Clicking an action must not also trigger the full-card open button.
    expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull();
    expect(api.getSupportTicket).not.toHaveBeenCalled();
  });
});
