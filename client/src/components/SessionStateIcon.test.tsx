import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SessionStateIcon from './SessionStateIcon';
import { SESSION_STATES } from '@shared/utils/sessionState';

describe('SessionStateIcon', () => {
  it('renders an icon for every canonical state and never returns null', () => {
    for (const state of SESSION_STATES) {
      const { getByTestId, unmount } = render(<SessionStateIcon state={state} />);
      const el = getByTestId('session-state-icon');
      expect(el!).toBeTruthy();
      expect(el!.getAttribute('data-session-state')).toBe(state);
      unmount();
    }
  });

  it('falls back to a present icon for an unknown state', () => {
    const { getByTestId } = render(<SessionStateIcon state="bogus" />);
    const el = getByTestId('session-state-icon');
    expect(el!).toBeTruthy();
    // falls back to the waiting label
    expect(el!.getAttribute('aria-label')).toBe('Waiting for user input');
  });

  it('animates active states (spin for working, pulse for running tests)', () => {
    const working = render(<SessionStateIcon state="working" />);
    expect(working.getByTestId('session-state-icon').classList.contains('animate-spin')).toBe(true);
    working.unmount();

    const tests = render(<SessionStateIcon state="running_tests" />);
    expect(tests.getByTestId('session-state-icon').classList.contains('animate-pulse')).toBe(true);
  });

  it('renders needs_input as a red exclamation, with a specific label when given', () => {
    const generic = render(<SessionStateIcon state="needs_input" />);
    const el = generic.getByTestId('session-state-icon');
    expect(el!.getAttribute('class')).toContain('text-rose-400');
    expect(el!.getAttribute('class')).toContain('lucide-circle-alert');
    expect(el!.getAttribute('aria-label')).toBe('Needs your input');
    generic.unmount();

    const specific = render(
      <SessionStateIcon state="needs_input" label="Needs your input: approve an action" />,
    );
    expect(specific.getByTestId('session-state-icon').getAttribute('aria-label')).toBe(
      'Needs your input: approve an action',
    );
  });

  it('does not animate settled states (merged)', () => {
    const { getByTestId } = render(<SessionStateIcon state="merged" />);
    const el = getByTestId('session-state-icon');
    expect(el!.classList.contains('animate-spin')).toBe(false);
    expect(el!.classList.contains('animate-pulse')).toBe(false);
  });

  it('applies the per-state color class', () => {
    const { getByTestId } = render(<SessionStateIcon state="merged" />);
    expect(getByTestId('session-state-icon').classList.contains('text-emerald-400')).toBe(true);
  });
});
