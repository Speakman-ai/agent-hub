import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SupportIssuesOverview, { sortBySeverity } from './SupportIssuesOverview.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getAllSupportTickets: vi.fn(),
  },
}));

function ticket(overrides = {}) {
  return {
    id: overrides.id || 't1',
    project_id: 'proj-1',
    project_name: 'Project One',
    type: 'bug',
    severity: 'medium',
    status: 'new',
    subject: 'Something broke',
    body: 'Details here',
    reporter: null,
    ai_summary: null,
    created_at: '2026-06-14 10:00:00',
    updated_at: '2026-06-14 10:00:00',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sortBySeverity', () => {
  it('orders by severity (critical → low) then newest first', () => {
    const sorted = sortBySeverity([
      ticket({ id: 'low', severity: 'low', created_at: '2026-06-14 12:00:00' }),
      ticket({ id: 'crit', severity: 'critical', created_at: '2026-06-14 09:00:00' }),
      ticket({ id: 'high', severity: 'high', created_at: '2026-06-14 11:00:00' }),
      ticket({ id: 'med-old', severity: 'medium', created_at: '2026-06-14 08:00:00' }),
      ticket({ id: 'med-new', severity: 'medium', created_at: '2026-06-14 13:00:00' }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['crit', 'high', 'med-new', 'med-old', 'low']);
  });
});

describe('SupportIssuesOverview', () => {
  it('renders cross-project issues severity-ordered with project labels', async () => {
    api.getAllSupportTickets.mockResolvedValue({
      tickets: [
        ticket({ id: 'a', severity: 'critical', project_id: 'p1', project_name: 'Alpha' }),
        ticket({ id: 'b', severity: 'low', project_id: 'p2', project_name: 'Beta' }),
      ],
      projects: [
        { id: 'p1', name: 'Alpha', count: 1 },
        { id: 'p2', name: 'Beta', count: 1 },
      ],
    });

    render(<SupportIssuesOverview />);

    await waitFor(() => {
      expect(screen.getAllByTestId('support-issue-row')).toHaveLength(2);
    });

    const rows = screen.getAllByTestId('support-issue-row');
    // Critical first (severity order preserved).
    expect(rows[0]).toHaveAttribute('data-severity', 'critical');
    expect(rows[1]).toHaveAttribute('data-severity', 'low');
    // Project names render as filter chips on each row.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('filters the list client-side by selected project', async () => {
    api.getAllSupportTickets.mockResolvedValue({
      tickets: [
        ticket({ id: 'a', severity: 'critical', project_id: 'p1', project_name: 'Alpha' }),
        ticket({ id: 'b', severity: 'high', project_id: 'p2', project_name: 'Beta' }),
      ],
      projects: [
        { id: 'p1', name: 'Alpha', count: 1 },
        { id: 'p2', name: 'Beta', count: 1 },
      ],
    });

    render(<SupportIssuesOverview />);
    await waitFor(() => expect(screen.getAllByTestId('support-issue-row')).toHaveLength(2));

    fireEvent.change(screen.getByTestId('project-filter'), { target: { value: 'p2' } });

    const rows = screen.getAllByTestId('support-issue-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-project-id', 'p2');
  });

  it('refetches with the status filter applied server-side', async () => {
    api.getAllSupportTickets.mockResolvedValue({ tickets: [], projects: [] });
    render(<SupportIssuesOverview />);

    await waitFor(() => expect(api.getAllSupportTickets).toHaveBeenCalledWith(undefined));

    fireEvent.click(screen.getByText('Closed'));
    await waitFor(() => expect(api.getAllSupportTickets).toHaveBeenCalledWith('closed'));
  });

  it('clicking a project chip opens that project’s support queue', async () => {
    const onOpen = vi.fn();
    api.getAllSupportTickets.mockResolvedValue({
      tickets: [ticket({ id: 'a', project_id: 'p1', project_name: 'Alpha' })],
      projects: [{ id: 'p1', name: 'Alpha', count: 1 }],
    });

    render(<SupportIssuesOverview onOpenProjectSupport={onOpen} />);
    await waitFor(() => expect(screen.getByTestId('issue-project-link')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('issue-project-link'));
    expect(onOpen).toHaveBeenCalledWith('p1');
  });
});
