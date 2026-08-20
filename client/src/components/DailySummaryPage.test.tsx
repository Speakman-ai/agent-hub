import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DailySummaryPage from './DailySummaryPage';
import { api, type DailySummaryWire } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: {
    getDailySummary: vi.fn(),
    generateDailySummary: vi.fn(),
  },
}));

vi.mock('./MarkdownRenderer', () => ({
  markdownComponentsCompact: {},
  MarkdownContent: ({
    content,
    components,
  }: {
    content: string;
    components?: { a?: (props: { href?: string; children?: ReactNode }) => ReactNode };
  }) => {
    const A = components?.a;
    const matches = [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
    if (!A || matches.length === 0) return <div>{content}</div>;
    return (
      <div>
        {matches.map((m, i) => (
          <span key={i}>{A({ href: m[2], children: m[1] })}</span>
        ))}
      </div>
    );
  },
}));

const empty: DailySummaryWire = {
  date: '2026-08-19',
  timeZone: 'UTC',
  report: null,
};

const filled: DailySummaryWire = {
  date: '2026-08-19',
  timeZone: 'UTC',
  report: {
    date: '2026-08-19',
    timeZone: 'UTC',
    markdown: '## Today\n- wrote [Today card](/projects/agent-hub/board?card=card-1)',
    engine: 'claude-code',
    model: 'claude-opus-4-6',
    generatedAt: '2026-08-19T18:00:00.000Z',
  },
};

describe('DailySummaryPage', () => {
  beforeEach(() => {
    vi.mocked(api.getDailySummary).mockReset();
    vi.mocked(api.generateDailySummary).mockReset();
  });

  it('loads without generating and shows Generate when nothing is stored for today', async () => {
    vi.mocked(api.getDailySummary).mockResolvedValue(empty);
    render(<DailySummaryPage />);
    await waitFor(() => expect(screen.getByTestId('daily-summary-empty')).toBeInTheDocument());
    expect(screen.getByTestId('daily-summary-generate')).toHaveTextContent('Generate');
    expect(api.generateDailySummary).not.toHaveBeenCalled();
  });

  it('shows Regenerate when a report already exists for today', async () => {
    vi.mocked(api.getDailySummary).mockResolvedValue(filled);
    render(<DailySummaryPage />);
    await waitFor(() => expect(screen.getByText('Today card')).toBeInTheDocument());
    expect(screen.getByTestId('daily-summary-generate')).toHaveTextContent('Regenerate');
    expect(api.generateDailySummary).not.toHaveBeenCalled();
  });

  it('opens a ticket link from the report', async () => {
    const onOpenCard = vi.fn();
    vi.mocked(api.getDailySummary).mockResolvedValue(filled);
    render(<DailySummaryPage onOpenCard={onOpenCard} />);
    await waitFor(() => expect(screen.getByTestId('daily-summary-link')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('daily-summary-link'));
    expect(onOpenCard).toHaveBeenCalledWith('agent-hub', 'card-1');
  });

  it('Generate posts and then flips the button to Regenerate', async () => {
    vi.mocked(api.getDailySummary).mockResolvedValue(empty);
    vi.mocked(api.generateDailySummary).mockResolvedValue(filled);
    render(<DailySummaryPage />);
    await waitFor(() => expect(screen.getByTestId('daily-summary-empty')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('daily-summary-generate'));
    await waitFor(() => expect(screen.getByText('Today card')).toBeInTheDocument());
    expect(api.generateDailySummary).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('daily-summary-generate')).toHaveTextContent('Regenerate');
  });
});
