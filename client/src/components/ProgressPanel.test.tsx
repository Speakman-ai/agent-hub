import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProgressPanel, { mergeProgressEvent, formatElapsed, computeSummary } from './ProgressPanel';

/**
 * ProgressPanel — Cursor-style timed checklist component tests.
 * Covers the rendering contract and the pure-function reducer helpers.
 */

describe('mergeProgressEvent', () => {
  it('appends a started step as a new entry', () => {
    const next = mergeProgressEvent([], {
      step: 'Gather PR context',
      status: 'started',
      startedAt: 1000,
    });
    expect(next!).toHaveLength(1);
    expect(next[0]).toMatchObject({
      step: 'Gather PR context',
      status: 'started',
      startedAt: 1000,
    });
    expect(next[0].finishedAt).toBeUndefined();
  });

  it('closes the most recent started row on completed', () => {
    const s1 = mergeProgressEvent([], { step: 'A', status: 'started', startedAt: 1 });
    const s2 = mergeProgressEvent(s1, {
      step: 'A',
      status: 'completed',
      startedAt: 1,
      finishedAt: 5,
    });
    expect(s2!).toHaveLength(1);
    expect(s2[0].status).toBe('completed');
    expect(s2[0].finishedAt).toBe(5);
  });

  it('closes only the most recent started row when a step is re-emitted', () => {
    let steps = mergeProgressEvent([], { step: 'A', status: 'started', startedAt: 1 });
    steps = mergeProgressEvent(steps, {
      step: 'A',
      status: 'completed',
      startedAt: 1,
      finishedAt: 2,
    });
    steps = mergeProgressEvent(steps, { step: 'A', status: 'started', startedAt: 10 });
    steps = mergeProgressEvent(steps, {
      step: 'A',
      status: 'completed',
      startedAt: 10,
      finishedAt: 15,
    });
    expect(steps!).toHaveLength(2);
    expect(steps[0].finishedAt).toBe(2);
    expect(steps[1].finishedAt).toBe(15);
  });

  it('appends a failed-without-started event as a standalone entry', () => {
    const next = mergeProgressEvent([], {
      step: 'Post formal review',
      status: 'failed',
      startedAt: 100,
      finishedAt: 200,
    });
    expect(next!).toHaveLength(1);
    expect(next[0].status).toBe('failed');
    expect(next[0].finishedAt).toBe(200);
  });

  it('attaches failure detail when closing a started step', () => {
    const s1 = mergeProgressEvent([], { step: 'Session setup', status: 'started', startedAt: 1 });
    const s2 = mergeProgressEvent(s1, {
      step: 'Session setup',
      status: 'failed',
      startedAt: 1,
      finishedAt: 5,
      detail: '$ pip install -r requirements.txt (exit 1)\nModuleNotFoundError',
    });
    expect(s2!).toHaveLength(1);
    expect(s2[0].status).toBe('failed');
    expect(s2[0].detail).toContain('ModuleNotFoundError');
  });
});

describe('formatElapsed', () => {
  it('formats seconds when under a minute', () => {
    expect(formatElapsed({ startedAt: 0, status: 'completed', finishedAt: 30_000 })).toBe('30s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed({ startedAt: 0, status: 'completed', finishedAt: 125_000 })).toBe('2m 5s');
  });

  it('uses now for in-flight steps', () => {
    expect(formatElapsed({ startedAt: 0, status: 'started' }, 5000)).toBe('5s');
  });

  it('returns empty string for missing step', () => {
    expect(formatElapsed(null)).toBe('');
  });
});

describe('computeSummary', () => {
  it('shows running count when any step is in progress', () => {
    expect(
      computeSummary([
        { step: 'A', status: 'completed', startedAt: 0, finishedAt: 1 },
        { step: 'B', status: 'started', startedAt: 1 },
      ]),
    ).toBe('1/2 done · 1 running');
  });

  it('shows failed count when a step has failed and nothing is running', () => {
    expect(
      computeSummary([
        { step: 'A', status: 'completed', startedAt: 0, finishedAt: 1 },
        { step: 'B', status: 'failed', startedAt: 1, finishedAt: 2 },
      ]),
    ).toBe('1/2 done · 1 failed');
  });

  it('shows clean done summary when all complete', () => {
    expect(
      computeSummary([
        { step: 'A', status: 'completed', startedAt: 0, finishedAt: 1 },
        { step: 'B', status: 'completed', startedAt: 1, finishedAt: 2 },
      ]),
    ).toBe('2/2 done');
  });
});

describe('ProgressPanel render', () => {
  it('returns null when there are no steps', () => {
    const { container } = render(<ProgressPanel steps={[]} sessionRunning={false} />);
    expect(container!.firstChild).toBeNull();
  });

  it('renders one row per step, preserving order', () => {
    const steps = [
      { step: 'Gather PR context', status: 'completed', startedAt: 0, finishedAt: 10_000 },
      { step: 'Analyze diff and files', status: 'started', startedAt: 10_000 },
      { step: 'Post formal review', status: 'failed', startedAt: 20_000, finishedAt: 25_000 },
    ];
    render(<ProgressPanel steps={steps} sessionRunning={true} />);

    const rows = screen.getAllByTestId('progress-step');
    expect(rows!).toHaveLength(3);
    expect(rows[0].textContent).toContain('Gather PR context');
    expect(rows[1].textContent).toContain('Analyze diff and files');
    expect(rows[2].textContent).toContain('Post formal review');
  });

  it('collapses to a one-liner summary when toggled', () => {
    const steps = [
      { step: 'A', status: 'completed', startedAt: 0, finishedAt: 5000 },
      { step: 'B', status: 'completed', startedAt: 5000, finishedAt: 10_000 },
    ];
    render(<ProgressPanel steps={steps} sessionRunning={false} />);

    // Default state: when session not running + all steps done, collapses
    // automatically. Expanding again makes the step rows visible.
    const toggle = screen.getByRole('button', { name: /Progress/ });
    fireEvent.click(toggle as any);
    expect(screen.getAllByTestId('progress-step')).toHaveLength(2);
    fireEvent.click(toggle as any);
    expect(screen.queryAllByTestId('progress-step')).toHaveLength(0);
    // Summary is always present in the header
    expect(screen.getByText(/2\/2 done/)).toBeInTheDocument();
  });

  it('renders failure detail under a failed step', () => {
    const steps = [
      {
        step: 'Session setup',
        status: 'failed',
        startedAt: 0,
        finishedAt: 1000,
        detail: '$ false (exit 1)\nboom',
      },
    ];
    render(<ProgressPanel steps={steps} sessionRunning={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Progress/ }));
    expect(screen.getByTestId('progress-step-detail').textContent).toContain('boom');
  });
});
