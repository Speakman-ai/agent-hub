import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SessionTimelineSidebar, {
  readTimelinePaneOpen,
  writeTimelinePaneOpen,
} from './SessionTimelineSidebar';

function meta(kind: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ kind, ...extra });
}

describe('SessionTimelineSidebar storage helpers', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults closed and round-trips the open flag', () => {
    expect(readTimelinePaneOpen('s1')).toBe(false);
    writeTimelinePaneOpen('s1', true);
    expect(readTimelinePaneOpen('s1')).toBe(true);
    writeTimelinePaneOpen('s1', false);
    expect(readTimelinePaneOpen('s1')).toBe(false);
  });
});

describe('<SessionTimelineSidebar />', () => {
  it('renders an empty state when there are no markers', () => {
    render(<SessionTimelineSidebar sessionId="s1" messages={[]} />);
    expect(screen.getByTestId('session-timeline-sidebar')).toBeInTheDocument();
    expect(
      screen.getByText(/change summary, finalize checks, and review comment/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('session-timeline-count')).not.toBeInTheDocument();
  });

  it('lists change-summary, checks, and review-comment markers in order', () => {
    render(
      <SessionTimelineSidebar
        sessionId="s1"
        messages={[
          { id: 'asst', role: 'assistant' },
          {
            id: 'sum',
            role: 'system',
            created_at: '2026-08-18T12:00:00Z',
            metadata: meta('turn_change_summary', {
              summary: 'Adds a timeline rail.',
              filesChanged: 1,
            }),
          },
          {
            id: 'chk',
            role: 'system',
            metadata: meta('finalize_checks_round', {
              round: 1,
              steps: [{ name: 'unit', state: 'passed' }],
            }),
          },
          {
            id: 'rev',
            role: 'system',
            metadata: meta('finalize_review_round', {
              round: 1,
              verdict: 'changes_requested',
              threads: [
                {
                  id: 'th1',
                  file_path: 'a.ts',
                  line_start: 4,
                  body: 'Name the storage key after the pane.',
                },
              ],
            }),
          },
        ]}
      />,
    );

    const rows = screen.getAllByTestId('session-timeline-marker');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('data-timeline-kind', 'change_summary');
    expect(rows[1]).toHaveAttribute('data-timeline-kind', 'test_run');
    expect(rows[2]).toHaveAttribute('data-timeline-kind', 'review_comment');
    expect(screen.getByTestId('session-timeline-count')).toHaveTextContent('3');
    expect(screen.getByText('Adds a timeline rail.')).toBeInTheDocument();
    expect(screen.getByText('Checks · round 1')).toBeInTheDocument();
    expect(screen.getByText('Name the storage key after the pane.')).toBeInTheDocument();
  });

  it('notifies the parent when a marker is clicked and when closed', () => {
    const onSelectAnchor = vi.fn();
    const onClose = vi.fn();
    render(
      <SessionTimelineSidebar
        sessionId="s1"
        messages={[
          {
            id: 'sum',
            role: 'system',
            metadata: meta('turn_change_summary', { summary: 'Jump here' }),
          },
        ]}
        onSelectAnchor={onSelectAnchor}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('session-timeline-marker'));
    expect(onSelectAnchor).toHaveBeenCalledWith('change-summary:sum', 'sum');

    fireEvent.click(screen.getByTestId('session-timeline-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
