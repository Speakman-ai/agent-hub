import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import CustomerSupportPage, { sortTickets, resolveReplayUrl } from './CustomerSupportPage';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getSupportTickets: vi.fn(),
    getSupportTicket: vi.fn(),
    runSupportTicketInvestigation: vi.fn(),
    retryReleaseNotification: vi.fn(),
    convertSupportTicketToCard: vi.fn(),
    assignCard: vi.fn(),
    setSupportTicketStatus: vi.fn(),
    setSupportTicketType: vi.fn(),
    deleteSupportTicket: vi.fn(),
    markSupportTicketRead: vi.fn().mockResolvedValue({}),
    markSupportTicketUnread: vi.fn().mockResolvedValue({}),
    markAllSupportTicketsRead: vi.fn().mockResolvedValue({ marked: 0, unreadCount: 0 }),
    getSupportUnreadCount: vi.fn().mockResolvedValue({ count: 0 }),
  },
}));

(vi as any).mock('../utils/connection.js', () => ({
  getServerBase: () => 'https://hub.example.com',
}));

function ticket(overrides: any = {}) {
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
    release_state: null,
    fixed_at: null,
    released_to_prod_at: null,
    release_deployment_id: null,
    customer_notified_at: null,
    release_notifications: [],
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
    expect(sorted.map((t: any) => t.id)).toEqual(['crit', 'high', 'med-new', 'med-old', 'low']);
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
    (api.getSupportTickets as any).mockResolvedValue([
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
    // "Bug" also appears as a type-filter chip, so scope to the card badges.
    expect(screen.getAllByText('Bug').length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByTestId('ticket-type-select')
        .some((select: any) => select.value === 'feature_request'),
    ).toBe(true);
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('Likely a null deref in checkout')).toBeInTheDocument();
    const replay = screen.getByRole('button', { name: /watch replay/i });
    expect(replay!).toBeInTheDocument();
    // No legacy raw-JSON link.
    expect(screen.queryByRole('link', { name: /session replay/i })).toBeNull();
  });

  it('does not render a watch-replay control for non-bug tickets', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'q', type: 'question', replay_ref: '/uploads/x.json', subject: 'How?' }),
    ]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('How?')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /watch replay/i })).toBeNull();
  });

  it('shows an empty state when there are no tickets', async () => {
    (api.getSupportTickets as any).mockResolvedValue([]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No support requests')).toBeInTheDocument());
  });

  it('live-inserts a WebSocket ticket in severity order via the imperative handle', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'med', severity: 'medium', subject: 'Existing medium' }),
    ]);
    const ref = createRef();
    render(<CustomerSupportPage ref={ref} projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Existing medium')).toBeInTheDocument());

    act(() => {
      (ref.current! as any).addTicket(
        ticket({ id: 'crit', severity: 'critical', subject: 'New critical' }),
      );
    });

    await waitFor(() => expect(screen.getByText('New critical')).toBeInTheDocument());
    const crit = screen.getByText('New critical');
    const med = screen.getByText('Existing medium');
    // The newly-arrived critical sorts above the existing medium.
    expect(crit.compareDocumentPosition(med) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('deletes a ticket after a two-step confirm, calling the API', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'kill', subject: 'Delete me' }),
    ]);
    (api.deleteSupportTicket as any).mockResolvedValue({ ok: true } as any);

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Delete me')).toBeInTheDocument());

    // First click arms the confirm step — the API is not called yet.
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i } as any) as any);
    expect(api.deleteSupportTicket).not.toHaveBeenCalled();
    expect(screen.getByText('Delete?')).toBeInTheDocument();

    // Confirm fires the delete.
    fireEvent.click(screen.getByRole('button', { name: /confirm/i } as any) as any);
    await waitFor(() => expect(api.deleteSupportTicket).toHaveBeenCalledWith('proj-1', 'kill'));

    // The initiating client removes the row optimistically on success — it must
    // NOT wait on the support_ticket_deleted WebSocket echo (which may be
    // dropped if the socket is disconnected/reconnecting).
    await waitFor(() => expect(screen.queryByText('Delete me')).toBeNull());
  });

  it('removes the ticket from the open detail modal on a successful delete', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'm1', subject: 'Modal delete' }),
    ]);
    (api.getSupportTicket as any).mockResolvedValue(ticket({ id: 'm1', subject: 'Modal delete' }));
    (api.deleteSupportTicket as any).mockResolvedValue({ ok: true } as any);

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Modal delete')).toBeInTheDocument());

    // Open the detail modal and delete from its footer.
    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i } as any) as any);
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );
    const modal = screen.getByTestId('support-ticket-detail-modal');
    fireEvent.click(within(modal as any).getByRole('button', { name: /^delete$/i }));
    fireEvent.click(within(modal as any).getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(api.deleteSupportTicket).toHaveBeenCalledWith('proj-1', 'm1'));
    // Both the modal and the underlying list row disappear without a WS event.
    await waitFor(() => expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull());
    expect(screen.queryByText('Modal delete')).toBeNull();
  });

  it('cancels an armed delete without calling the API', async () => {
    (api.getSupportTickets as any).mockResolvedValue([ticket({ id: 'safe', subject: 'Keep me' })]);

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Keep me')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i } as any) as any);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i } as any) as any);

    expect(api.deleteSupportTicket).not.toHaveBeenCalled();
    // Back to the un-armed Delete button.
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('does not open the detail modal when the Delete action is clicked', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'No accidental open' }),
    ]);

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No accidental open')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i } as any) as any);
    // Arming the confirm must not trigger the full-card open button.
    expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull();
    expect(api.getSupportTicket).not.toHaveBeenCalled();
  });

  it('removes a ticket via the imperative handle', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'gone', subject: 'Bye ticket' }),
    ]);
    const ref = createRef();
    render(<CustomerSupportPage ref={ref} projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Bye ticket')).toBeInTheDocument());

    act(() => (ref.current! as any).removeTicket('gone'));
    await waitFor(() => expect(screen.queryByText('Bye ticket')).toBeNull());
  });
});

describe('CustomerSupportPage — deep-linked ticket focus', () => {
  it('opens the initialTicketId detail on arrival by fetching it by id (covers terminal tickets hidden by the Open filter)', async () => {
    // The default "Open" filter list does NOT contain the converted ticket the
    // Deployments release-item link points at, so the page must fetch it by id.
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'open-1', subject: 'An open ticket' }),
    ]);
    (api.getSupportTicket as any).mockResolvedValue(
      ticket({ id: 'conv-1', subject: 'Converted deep link', status: 'converted' }),
    );

    render(<CustomerSupportPage projectId="proj-1" initialTicketId="conv-1" />);

    await waitFor(() => expect(api.getSupportTicket).toHaveBeenCalledWith('proj-1', 'conv-1'));
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId('support-ticket-detail-modal')).getByText('Converted deep link'),
    ).toBeInTheDocument();
  });

  it('does not fetch or open a detail when no initialTicketId is provided', async () => {
    (api.getSupportTickets as any).mockResolvedValue([ticket({ id: 'open-1' })]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(api.getSupportTickets).toHaveBeenCalled());
    expect(api.getSupportTicket).not.toHaveBeenCalled();
    expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull();
  });
});

describe('CustomerSupportPage — ticket detail view', () => {
  it('opens a detail modal via the full-card open button and shows the full AI investigation from the detail endpoint', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({
        id: 'crit',
        subject: 'Critical crash',
        body: 'Short body',
        ai_summary: 'Short summary',
        ai_investigation: null,
      }),
    ]);
    // The dedicated detail endpoint returns the enriched, full investigation.
    (api.getSupportTicket as any).mockResolvedValue(
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

    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i } as any) as any);

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
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({
        id: 'md',
        subject: 'Markdown ticket',
        body: '## Steps\n\n- **User ID**: 1\n- visit [home](https://example.com)',
      }),
    ]);
    (api.getSupportTicket as any).mockResolvedValue(
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
    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i } as any) as any);

    const modal = await screen.findByTestId('support-ticket-detail-modal');

    // Markdown is converted to DOM elements, so the literal markers must not survive as text.
    await waitFor(() => expect(within(modal).queryByText(/## Steps/)).toBeNull());
    expect(within(modal).queryByText(/\*\*User ID\*\*/)).toBeNull();

    // Headings, bold runs, links and inline code render as real elements.
    expect(within(modal).getByRole('heading', { name: 'Steps' })).toBeInTheDocument();
    expect(within(modal).getByText('User ID').tagName).toBe('STRONG');
    const link = within(modal).getByRole('link', { name: 'home' });
    expect(link!.getAttribute('href')).toBe('https://example.com');
    expect(within(modal).getByRole('heading', { name: 'Root cause' })).toBeInTheDocument();
    expect(within(modal).getByText('handler').tagName).toBe('CODE');
  });

  it('queues a ticket investigation with the selected engine and model', async () => {
    const item = ticket({ id: 'model-pick', subject: 'Choose a model' });
    (api.getSupportTickets as any).mockResolvedValue([item]);
    (api.getSupportTicket as any).mockResolvedValue(item);
    (api.runSupportTicketInvestigation as any).mockResolvedValue({ queued: true, ticket: item });

    render(
      <CustomerSupportPage
        projectId="proj-1"
        modelConfig={{
          engineValidModels: {
            'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'],
            'codex-cli': ['gpt-5.5'],
          },
          engineDefaultModels: { 'claude-code': 'claude-opus-4-8', 'codex-cli': 'gpt-5.5' },
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText('Choose a model')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i }) as any);
    const modal = await screen.findByTestId('support-ticket-detail-modal');

    fireEvent.change(within(modal).getByTestId('ticket-investigation-engine'), {
      target: { value: 'codex-cli' },
    });
    fireEvent.change(within(modal).getByTestId('ticket-investigation-model'), {
      target: { value: 'gpt-5.5' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Run' }) as any);

    await waitFor(() =>
      expect(api.runSupportTicketInvestigation).toHaveBeenCalledWith('proj-1', 'model-pick', {
        engine: 'codex-cli',
        model: 'gpt-5.5',
      }),
    );
  });

  it('uses a non-interactive card container with a dedicated open button, not nested interactive controls', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
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
    (api.getSupportTickets as any).mockResolvedValue([ticket({ id: 't1', subject: 'Openable' })]);
    (api.getSupportTicket as any).mockResolvedValue(ticket({ id: 't1', subject: 'Openable' }));

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Openable')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i } as any) as any);
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' } as any) as any);
    await waitFor(() => expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull());
  });

  it('renders an attached screenshot on the card and in the detail modal', async () => {
    const shot = ticket({
      id: 't1',
      subject: 'Visual bug',
      screenshot_ref: '/uploads/support-screenshot-abc.png',
    });
    (api.getSupportTickets as any).mockResolvedValue([shot]);
    (api.getSupportTicket as any).mockResolvedValue(shot);

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Visual bug')).toBeInTheDocument());

    // Card thumbnail resolves the /uploads ref against the server base.
    const thumb = screen.getByTestId('ticket-screenshot-thumb');
    const thumbImg = within(thumb).getByRole('img');
    expect(thumbImg!).toHaveAttribute(
      'src',
      'https://hub.example.com/uploads/support-screenshot-abc.png',
    );

    // Open the modal and assert the larger screenshot renders too.
    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i } as any) as any);
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
    (api.getSupportTickets as any).mockResolvedValue([ticket({ id: 't1', screenshot_ref: null })]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Something broke')).toBeInTheDocument());
    expect(screen.queryByTestId('ticket-screenshot-thumb')).toBeNull();
  });

  it('shows the release-facing state as a compact badge', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({
        id: 't1',
        subject: 'Ready for customer',
        release_state: 'released_to_prod',
        fixed_at: '2026-06-14 10:00:00',
        released_to_prod_at: '2026-06-15 10:00:00',
        release_deployment_id: 'dep-1',
      }),
    ]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Ready for customer')).toBeInTheDocument());
    expect(screen.getByTestId('ticket-release-state')).toHaveTextContent('Released');
  });

  it('propagates same-ticket WebSocket updates into the open detail modal', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Live updates', status: 'new' }),
    ]);
    (api.getSupportTicket as any).mockResolvedValue(
      ticket({ id: 't1', subject: 'Live updates', status: 'new' }),
    );

    const ref = createRef();
    render(<CustomerSupportPage ref={ref} projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Live updates')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i } as any) as any);
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );

    const modal = screen.getByTestId('support-ticket-detail-modal');
    // Before the update the modal offers the Convert action.
    expect(within(modal).getByRole('button', { name: /convert to card/i })).toBeInTheDocument();

    // A same-ticket WebSocket row (e.g. convert landed) arrives via the parent.
    act(() =>
      (ref.current! as any).updateTicket(
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
    // The default "Open" group includes 'new' and returns the ticket; the "Done"
    // group (converted/closed) returns an empty list (the open ticket is hidden).
    (api.getSupportTickets as any).mockImplementation((_projectId: any, status: any) =>
      Promise.resolve(
        status && status.includes('new')
          ? [ticket({ id: 't1', subject: 'Stay open', status: 'new' })]
          : [],
      ),
    );
    (api.getSupportTicket as any).mockResolvedValue(
      ticket({ id: 't1', subject: 'Stay open', status: 'new' }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByTestId('support-ticket-card')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i } as any) as any);
    await waitFor(() =>
      expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument(),
    );

    // Switch to a filter that excludes the open ticket.
    fireEvent.click(screen.getByTestId('status-filter-done' as any) as any);

    // The list card drops out of view, but the modal must stay open — the user
    // keeps their place rather than having it yanked away.
    await waitFor(() => expect(screen.queryByTestId('support-ticket-card')).toBeNull());
    expect(screen.getByTestId('support-ticket-detail-modal')).toBeInTheDocument();
  });

  it('does not open the detail modal when the Convert action is clicked', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'No accidental open', type: 'bug' }),
    ]);
    (api.convertSupportTicketToCard as any).mockResolvedValue(
      ticket({ id: 't1', status: 'converted', converted_card_id: 'card-9' }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No accidental open')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /convert to card/i } as any) as any);

    // Auto-merge left untouched → the field is omitted (use project default).
    await waitFor(() =>
      expect(api.convertSupportTicketToCard).toHaveBeenCalledWith('proj-1', 't1', {}),
    );
    // Clicking an action must not also trigger the full-card open button.
    expect(screen.queryByTestId('support-ticket-detail-modal')).toBeNull();
    expect(api.getSupportTicket).not.toHaveBeenCalled();
  });

  it('shows support ticket notification history and retries failed rows', async () => {
    const notification = {
      id: 'note-1',
      deployment_id: 'dep-1',
      release_item_id: 'ri-1',
      support_ticket_id: 't1',
      notification_type: 'ticket_release',
      recipient_type: 'reporter',
      subject: 'Ticket shipped',
      status: 'error',
      attempts: 3,
      sent_at: null,
      next_attempt_at: null,
      error_summary: 'Email delivery failed.',
      can_retry: true,
      created_at: '2026-06-14 10:00:00',
      updated_at: '2026-06-14 10:00:00',
    };
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Notify me', release_notifications: [notification] }),
    ]);
    (api.getSupportTicket as any).mockResolvedValue(
      ticket({ id: 't1', subject: 'Notify me', release_notifications: [notification] }),
    );
    (api.retryReleaseNotification as any).mockResolvedValue({
      notification: {
        ...notification,
        status: 'pending',
        error_summary: null,
        can_retry: false,
      },
    });
    const onNotify = vi.fn();

    render(<CustomerSupportPage projectId="proj-1" onNotify={onNotify} />);
    await waitFor(() => expect(screen.getByText('Notify me')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /open support ticket/i } as any) as any);

    const modal = await screen.findByTestId('support-ticket-detail-modal');
    expect(within(modal).getByText('Notifications')).toBeInTheDocument();
    expect(within(modal).getByText('Reporter')).toBeInTheDocument();
    expect(within(modal).getByText('Email delivery failed.')).toBeInTheDocument();
    expect(within(modal).getByText('3 attempts')).toBeInTheDocument();

    fireEvent.click(within(modal).getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(api.retryReleaseNotification).toHaveBeenCalledWith('proj-1', 'dep-1', 'note-1'),
    );
    expect(onNotify).toHaveBeenCalledWith('Release notification queued for retry', 'success');
    await waitFor(() =>
      expect(
        within(screen.getByTestId('support-ticket-detail-modal')).queryByText(
          'Email delivery failed.',
        ),
      ).toBeNull(),
    );
  });
});

describe('CustomerSupportPage — convert removes the ticket + optional agent assign', () => {
  it('removes the ticket from the list after a successful convert (no agent)', async () => {
    (api.getSupportTickets as any).mockResolvedValue([ticket({ id: 't1', subject: 'Promote me' })]);
    (api.convertSupportTicketToCard as any).mockResolvedValue({
      card: { id: 'card-1' },
      ticketId: 't1',
      deleted: true,
    });

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Promote me')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /convert to card/i } as any) as any);

    await waitFor(() =>
      expect(api.convertSupportTicketToCard).toHaveBeenCalledWith('proj-1', 't1', {}),
    );
    // The ticket is dropped locally without waiting on the WebSocket echo.
    await waitFor(() => expect(screen.queryByText('Promote me')).toBeNull());
    // With no agent picked, the new card is not assigned.
    expect(api.assignCard).not.toHaveBeenCalled();
  });

  it('offers an agent picker and assigns the new card when an agent is chosen', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Assign on convert' }),
    ]);
    (api.convertSupportTicketToCard as any).mockResolvedValue({
      card: { id: 'card-9' },
      ticketId: 't1',
      deleted: true,
    });
    (api.assignCard as any).mockResolvedValue({ sessionId: 's1', card: { id: 'card-9' } });

    render(
      <CustomerSupportPage projectId="proj-1" agents={[{ id: 'agent-1', name: 'Builder' }]} />,
    );
    await waitFor(() => expect(screen.getByText('Assign on convert')).toBeInTheDocument());

    // Pick an agent, then convert.
    fireEvent.change(screen.getByTestId('convert-assign-agent' as any), {
      target: { value: 'agent-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /convert & assign/i } as any) as any);

    await waitFor(() =>
      expect(api.convertSupportTicketToCard).toHaveBeenCalledWith('proj-1', 't1', {}),
    );
    // The freshly-created card is assigned to the chosen agent (auto-merge
    // untouched → omitted so the server uses the project default).
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('proj-1', 'card-9', 'agent-1', {}),
    );
    await waitFor(() => expect(screen.queryByText('Assign on convert')).toBeNull());
  });

  it('routes the note to /assign (not convert) when an agent is selected', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Note to assignee' }),
    ]);
    (api.convertSupportTicketToCard as any).mockResolvedValue({
      card: { id: 'card-9' },
      ticketId: 't1',
      deleted: true,
    });
    (api.assignCard as any).mockResolvedValue({ sessionId: 's1', card: { id: 'card-9' } });

    render(
      <CustomerSupportPage projectId="proj-1" agents={[{ id: 'agent-1', name: 'Builder' }]} />,
    );
    await waitFor(() => expect(screen.getByText('Note to assignee')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('convert-assign-agent'), { target: { value: 'agent-1' } });
    fireEvent.change(screen.getByTestId('convert-comment'), {
      target: { value: '  start with the API  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /convert & assign/i }));

    // Convert omits the note (no assignee yet) and the untouched auto-merge.
    await waitFor(() =>
      expect(api.convertSupportTicketToCard).toHaveBeenCalledWith('proj-1', 't1', {}),
    );
    // The trimmed note rides the /assign call so it reaches the chosen agent.
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('proj-1', 'card-9', 'agent-1', {
        comment: 'start with the API',
      }),
    );
  });

  it('persists the note as a card note via convert when no agent is selected', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Card note only' }),
    ]);
    (api.convertSupportTicketToCard as any).mockResolvedValue({
      card: { id: 'card-9' },
      ticketId: 't1',
      deleted: true,
    });

    render(
      <CustomerSupportPage projectId="proj-1" agents={[{ id: 'agent-1', name: 'Builder' }]} />,
    );
    await waitFor(() => expect(screen.getByText('Card note only')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('convert-comment'), {
      target: { value: 'context for later' },
    });
    fireEvent.click(screen.getByRole('button', { name: /convert to card/i }));

    await waitFor(() =>
      expect(api.convertSupportTicketToCard).toHaveBeenCalledWith('proj-1', 't1', {
        comment: 'context for later',
      }),
    );
    expect(api.assignCard).not.toHaveBeenCalled();
  });

  it('sends an explicit autoMerge:true once the Auto-merge box is checked', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Force merge' }),
    ]);
    (api.convertSupportTicketToCard as any).mockResolvedValue({
      card: { id: 'card-9' },
      ticketId: 't1',
      deleted: true,
    });

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Force merge')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('convert-auto-merge'));
    fireEvent.click(screen.getByRole('button', { name: /convert to card/i }));

    await waitFor(() =>
      expect(api.convertSupportTicketToCard).toHaveBeenCalledWith('proj-1', 't1', {
        autoMerge: true,
      }),
    );
  });

  it('surfaces a durable warning and keeps the ticket when the agent assignment fails', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Assign fails' }),
    ]);
    (api.convertSupportTicketToCard as any).mockResolvedValue({
      card: { id: 'card-9' },
      ticketId: 't1',
      deleted: true,
    });
    (api.assignCard as any).mockRejectedValue(new Error('Agent not found'));
    const onNotify = vi.fn();

    render(
      <CustomerSupportPage
        projectId="proj-1"
        agents={[{ id: 'agent-1', name: 'Builder' }]}
        onNotify={onNotify}
      />,
    );
    await waitFor(() => expect(screen.getByText('Assign fails')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('convert-assign-agent' as any), {
      target: { value: 'agent-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /convert & assign/i } as any) as any);

    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('proj-1', 'card-9', 'agent-1', {}),
    );
    // A durable warning is raised (it can't be swallowed by the row vanishing).
    await waitFor(() =>
      expect(onNotify!).toHaveBeenCalledWith(
        expect.stringMatching(/assigning the agent failed/i),
        'warning',
      ),
    );
    // The assign failure is NOT treated as a silent success: the ticket is not
    // optimistically removed, and the inline error is visible.
    expect(screen.getByText('Assign fails')).toBeInTheDocument();
    expect(screen.getByText(/assigning the agent failed/i)).toBeInTheDocument();
  });

  it('does not render an agent picker when the project has no agents', async () => {
    (api.getSupportTickets as any).mockResolvedValue([ticket({ id: 't1', subject: 'No agents' })]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No agents')).toBeInTheDocument());
    expect(screen.queryByTestId('convert-assign-agent')).toBeNull();
    // The plain convert action is still available.
    expect(screen.getByRole('button', { name: /convert to card/i })).toBeInTheDocument();
  });
});

describe('CustomerSupportPage — change ticket status', () => {
  it('changes a ticket status via the inline status select', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Status me', status: 'new' }),
    ]);
    (api.setSupportTicketStatus as any).mockResolvedValue(
      ticket({ id: 't1', subject: 'Status me', status: 'investigating' }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Status me')).toBeInTheDocument());

    const select = screen.getByTestId('ticket-status-select');
    expect((select as any).value).toBe('new');
    fireEvent.change(select, { target: { value: 'investigating' } } as any);

    await waitFor(() =>
      expect(api.setSupportTicketStatus).toHaveBeenCalledWith(
        'proj-1',
        't1',
        'investigating',
        undefined,
      ),
    );
    // The optimistic + server-confirmed update leaves the row showing the new state.
    await waitFor(() =>
      expect((screen.getByTestId('ticket-status-select') as any).value).toBe('investigating'),
    );
  });

  it('offers the manual lifecycle states (Done/Duplicate/Won’t do) but not Converted', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Options', status: 'new' }),
    ]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Options')).toBeInTheDocument());

    const values = Array.from((screen.getByTestId('ticket-status-select') as any).options).map(
      (o: any) => (o as any).value,
    );
    expect(values!).toEqual(['new', 'investigating', 'closed', 'duplicate', 'wont_do']);
  });

  it('captures a required reason before marking a ticket Won’t do', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Decline me', status: 'new' }),
    ]);
    (api.setSupportTicketStatus as any).mockResolvedValue(
      ticket({
        id: 't1',
        subject: 'Decline me',
        status: 'wont_do',
        wont_do_reason: 'out of scope',
      }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Decline me')).toBeInTheDocument());

    // Selecting "Won't do" opens the inline reason form instead of committing.
    fireEvent.change(screen.getByTestId('ticket-status-select' as any), {
      target: { value: 'wont_do' },
    });
    expect(screen.getByTestId('wont-do-reason-form')).toBeInTheDocument();
    expect(api.setSupportTicketStatus).not.toHaveBeenCalled();

    // Supplying a reason and saving commits the status with the reason.
    fireEvent.change(screen.getByTestId('wont-do-reason-input' as any), {
      target: { value: 'out of scope' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i } as any) as any);

    await waitFor(() =>
      expect(api.setSupportTicketStatus).toHaveBeenCalledWith(
        'proj-1',
        't1',
        'wont_do',
        'out of scope',
      ),
    );
    // Under the default "Open" group, a now-"won't do" ticket leaves the view,
    // and the inline reason form closes with it.
    await waitFor(() => expect(screen.queryByTestId('wont-do-reason-form')).toBeNull());
    expect(screen.queryByText('Decline me')).toBeNull();
  });
});

describe('CustomerSupportPage — reclassify ticket type', () => {
  it('changes a ticket type via the reclassify dropdown', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 't1', subject: 'Classify me', type: 'question' }),
    ]);
    (api.setSupportTicketType as any).mockResolvedValue(
      ticket({ id: 't1', subject: 'Classify me', type: 'feature_request' }),
    );

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Classify me')).toBeInTheDocument());

    const select = screen.getByTestId('ticket-type-select');
    expect((select as any).value).toBe('question');
    fireEvent.change(select, { target: { value: 'feature_request' } } as any);

    await waitFor(() =>
      expect(api.setSupportTicketType).toHaveBeenCalledWith('proj-1', 't1', 'feature_request'),
    );
    await waitFor(() =>
      expect((screen.getByTestId('ticket-type-select') as any).value).toBe('feature_request'),
    );
  });
});

describe('CustomerSupportPage — filters', () => {
  it('refetches with a type filter when a type chip is selected', async () => {
    (api.getSupportTickets as any).mockResolvedValue([ticket({ id: 't1', subject: 'Filterable' })]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Filterable')).toBeInTheDocument());

    // Initial load uses the default Open status group and no type filter.
    expect(api.getSupportTickets).toHaveBeenCalledWith('proj-1', 'new,investigating', undefined);

    fireEvent.click(screen.getByTestId('type-filter-bug' as any) as any);
    await waitFor(() =>
      expect(api.getSupportTickets).toHaveBeenCalledWith('proj-1', 'new,investigating', 'bug'),
    );
  });

  it('requests the Done group (converted + closed) when the Done filter is selected', async () => {
    (api.getSupportTickets as any).mockResolvedValue([]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('No support requests')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('status-filter-done' as any) as any);
    await waitFor(() =>
      expect(api.getSupportTickets).toHaveBeenCalledWith('proj-1', 'converted,closed', undefined),
    );
  });
});

describe('CustomerSupportPage — read/unread', () => {
  it('shows the unread accent for unread tickets and not for read ones', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'u', subject: 'Unread one', read_at: null }),
      ticket({ id: 'r', subject: 'Read one', read_at: '2026-06-14 11:00:00' }),
    ]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Unread one')).toBeInTheDocument());

    const cards = screen.getAllByTestId('support-ticket-card');
    const unreadCard = cards.find((c: any) => within(c).queryByText('Unread one'));
    const readCard = cards.find((c: any) => within(c).queryByText('Read one'));
    expect(unreadCard!.getAttribute('data-unread')).toBe('true');
    expect(readCard!.getAttribute('data-unread')).toBe('false');
    expect(within(unreadCard as any).getByTestId('unread-dot')).toBeInTheDocument();
    expect(within(readCard as any).queryByTestId('unread-dot')).toBeNull();
  });

  it('marks a ticket read on open, clearing its unread accent', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'open-me', subject: 'Open me', read_at: null }),
    ]);
    (api.getSupportTicket as any).mockResolvedValue(ticket({ id: 'open-me', subject: 'Open me' }));

    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Open me')).toBeInTheDocument());
    expect(screen.getByTestId('unread-dot')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /open support ticket: open me/i } as any) as any,
    );

    await waitFor(() =>
      expect(api.markSupportTicketRead).toHaveBeenCalledWith('proj-1', 'open-me'),
    );
    // The optimistic local flip clears the dot without waiting on the WebSocket.
    await waitFor(() => expect(screen.queryByTestId('unread-dot')).toBeNull());
  });

  it('marks all read via the header action and hides it once nothing is unread', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'a', subject: 'Aaa', read_at: null }),
      ticket({ id: 'b', subject: 'Bbb', read_at: null }),
    ]);
    render(<CustomerSupportPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Aaa')).toBeInTheDocument());
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('mark-all-read' as any) as any);

    await waitFor(() => expect(api.markAllSupportTicketsRead).toHaveBeenCalledWith('proj-1'));
    await waitFor(() => expect(screen.queryByTestId('unread-dot')).toBeNull());
    // With nothing unread, the button disappears.
    expect(screen.queryByTestId('mark-all-read')).toBeNull();
  });

  it('clears local unread state when the markAllRead handle fires (cross-client)', async () => {
    (api.getSupportTickets as any).mockResolvedValue([
      ticket({ id: 'x', subject: 'Xyz', read_at: null }),
    ]);
    const ref = createRef();
    render(<CustomerSupportPage ref={ref} projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('Xyz')).toBeInTheDocument());
    expect(screen.getByTestId('unread-dot')).toBeInTheDocument();

    act(() => {
      (ref.current! as any).markAllRead();
    });
    await waitFor(() => expect(screen.queryByTestId('unread-dot')).toBeNull());
  });
});
