/**
 * Manual smoke (Electron or browser):
 * 1. Open Agent Hub, pick an agent with sessions in the sidebar.
 * 2. In a second client (or curl), create a session for that agent via POST /api/agents/:id/sessions.
 * 3. Wait 2+ minutes on the first client without switching agents — the new row should appear, or
 *    switch away from the window and back — the row should appear immediately on focus.
 * 4. Kanban: leave the board open 3+ minutes after another client moves a card — columns should
 *    reconcile, without flashing the full-page "Loading board…" spinner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useVisibleIntervalRefresh } from './useVisibleIntervalRefresh';

function Harness({ onRefresh, intervalMs, enabled, runOnVisible }: any) {
  useVisibleIntervalRefresh(onRefresh, intervalMs, { enabled, runOnVisible });
  return null;
}

describe('useVisibleIntervalRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not arm the interval when disabled', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} intervalMs={60_000} enabled={false} />);
    vi.advanceTimersByTime(120_000);
    expect(onRefresh!).not.toHaveBeenCalled();
  });

  it('fires on interval while visible (not on mount)', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      writable: true,
      value: 'visible',
    });
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} intervalMs={50_000} enabled />);
    expect(onRefresh!).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50_000);
    expect(onRefresh!).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50_000);
    expect(onRefresh!).toHaveBeenCalledTimes(2);
  });

  it('does not fire on interval while hidden; fires when returning to visible if runOnVisible', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      writable: true,
      value: 'visible',
    });
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} intervalMs={30_000} enabled runOnVisible />);
    expect(onRefresh!).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(120_000);
    expect(onRefresh!).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onRefresh!).toHaveBeenCalledTimes(1);
  });
});
