/**
 * Tests for the compact <CardBadge /> shown on a kanban card row.
 *
 * We mock `useFinalizeRun` so each test can drive the badge's branches
 * without touching the WS bridge. The hook itself is covered by its own
 * test file — here we only assert the UI surface (visibility rules,
 * tone/icon picks, data attributes that the kanban view relies on to
 * gate the Finalize button).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import CardBadge from './CardBadge.jsx';

vi.mock('../../hooks/useFinalizeRun.js', async () => {
  const actual = await vi.importActual('../../hooks/useFinalizeRun.js');
  return {
    ...actual,
    useFinalizeRun: vi.fn(),
  };
});

import { useFinalizeRun } from '../../hooks/useFinalizeRun.js';

function setHook(overrides = {}) {
  useFinalizeRun.mockReturnValue({
    run: null,
    steps: [],
    phase: null,
    status: null,
    isActive: false,
    isPaused: false,
    isTerminal: false,
    activeSeconds: null,
    wallSeconds: null,
    loadError: null,
    ...overrides,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('<CardBadge /> — prefetchedRun forwarding (PR #1169 blocker fix)', () => {
  it('forwards prefetchedRun to useFinalizeRun', () => {
    setHook({ run: null });
    render(<CardBadge sessionId="s1" prefetchedRun={null} />);
    expect(useFinalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', prefetchedRun: null, enabled: true }),
    );
  });

  it('forwards a row-shaped prefetchedRun', () => {
    setHook({ run: null });
    const row = { id: 'r1', session_id: 's1', status: 'reviewing' };
    render(<CardBadge sessionId="s1" prefetchedRun={row} />);
    expect(useFinalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', prefetchedRun: row }),
    );
  });

  it('disables the hook when sessionId is null (no fetch, no subscribe)', () => {
    setHook({ run: null });
    render(<CardBadge sessionId={null} />);
    expect(useFinalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null, enabled: false }),
    );
  });
});

describe('<CardBadge />', () => {
  it('renders nothing when there is no finalize run', () => {
    setHook({ run: null });
    const { container } = render(<CardBadge sessionId="s1" />);
    expect(container.querySelector('[data-testid="finalize-card-badge"]')).toBeNull();
  });

  it('renders nothing when the run is cancelled', () => {
    setHook({ run: { id: 'r', session_id: 's1' }, status: 'cancelled' });
    const { container } = render(<CardBadge sessionId="s1" />);
    expect(container.querySelector('[data-testid="finalize-card-badge"]')).toBeNull();
  });

  it('renders phase label and active-time as the primary metric', () => {
    setHook({
      run: { id: 'r1', session_id: 's1' },
      status: 'reviewing',
      phase: 'review',
      activeSeconds: 240,
      wallSeconds: 360,
      isActive: true,
    });
    render(<CardBadge sessionId="s1" />);
    const badge = screen.getByTestId('finalize-card-badge');
    expect(badge).toHaveAttribute('data-run-id', 'r1');
    expect(badge).toHaveAttribute('data-status', 'reviewing');
    expect(badge).toHaveAttribute('data-phase', 'review');
    expect(badge).toHaveAttribute('data-active-seconds', '240');
    expect(badge).toHaveAttribute('data-wall-seconds', '360');
    expect(screen.getByTestId('finalize-card-badge-label').textContent).toBe('reviewing');
    expect(screen.getByTestId('finalize-card-badge-active').textContent).toMatch(/4m active/);
  });

  it('exposes wall-clock and full status in the tooltip', () => {
    setHook({
      run: { id: 'r1', session_id: 's1' },
      status: 'running',
      phase: 'tasks',
      activeSeconds: 120,
      wallSeconds: 600,
      isActive: true,
    });
    render(<CardBadge sessionId="s1" />);
    const badge = screen.getByTestId('finalize-card-badge');
    const title = badge.getAttribute('title') || '';
    expect(title).toMatch(/running checks/);
    expect(title).toMatch(/active 2m/);
    expect(title).toMatch(/wall 10m/);
  });

  it('signals "Finalize blocked" via a data attribute when the run is in flight', () => {
    setHook({
      run: { id: 'r1', session_id: 's1' },
      status: 'reviewing',
      phase: 'review',
      isActive: true,
      activeSeconds: 0,
      wallSeconds: 0,
    });
    render(<CardBadge sessionId="s1" />);
    expect(screen.getByTestId('finalize-card-badge')).toHaveAttribute(
      'data-finalize-blocked',
      'true',
    );
  });

  it('does NOT mark the Finalize button blocked when the run is terminal', () => {
    setHook({
      run: { id: 'r1', session_id: 's1' },
      status: 'pushed',
      phase: 'push',
      isTerminal: true,
      activeSeconds: 600,
      wallSeconds: 700,
    });
    render(<CardBadge sessionId="s1" />);
    expect(screen.getByTestId('finalize-card-badge').getAttribute('data-finalize-blocked')).toBe(
      null,
    );
  });

  it('marks the badge as paused when status is dispatching', () => {
    setHook({
      run: { id: 'r1', session_id: 's1' },
      status: 'dispatching',
      phase: 'dispatching',
      isActive: true,
      isPaused: true,
      activeSeconds: 100,
      wallSeconds: 500,
    });
    render(<CardBadge sessionId="s1" />);
    const badge = screen.getByTestId('finalize-card-badge');
    expect(badge).toHaveAttribute('data-paused', 'true');
    expect(screen.getByTestId('finalize-card-badge-label').textContent).toBe('awaiting fix');
  });

  it('marks the badge as paused for stalled_no_response (terminal pause)', () => {
    setHook({
      run: { id: 'r1', session_id: 's1' },
      status: 'stalled_no_response',
      phase: 'dispatching',
      isPaused: true,
      isTerminal: true,
      activeSeconds: 1800,
      wallSeconds: 3600,
    });
    render(<CardBadge sessionId="s1" />);
    expect(screen.getByTestId('finalize-card-badge')).toHaveAttribute('data-paused', 'true');
  });

  it('renders a pushed badge after success', () => {
    setHook({
      run: { id: 'r1', session_id: 's1' },
      status: 'pushed',
      phase: 'push',
      isTerminal: true,
      activeSeconds: 350,
      wallSeconds: 450,
    });
    render(<CardBadge sessionId="s1" />);
    expect(screen.getByTestId('finalize-card-badge-label').textContent).toBe('pushed');
  });
});
