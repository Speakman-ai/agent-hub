import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { History, Package } from 'lucide-react';
import SessionActionsMenu from './SessionActionsMenu';

describe('<SessionActionsMenu />', () => {
  it('keeps items collapsed until the trigger is clicked', () => {
    const onSelect = vi.fn();
    render(
      <SessionActionsMenu
        items={[
          {
            id: 'timeline',
            testId: 'toggle-timeline-pane',
            label: 'Timeline',
            icon: History,
            onSelect,
          },
        ]}
      />,
    );

    expect(screen.queryByTestId('session-actions-dropdown')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-actions-trigger'));
    expect(screen.getByTestId('session-actions-dropdown')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toggle-timeline-pane'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows a pressed count on the trigger and a check on the active item', () => {
    render(
      <SessionActionsMenu
        items={[
          {
            id: 'timeline',
            testId: 'toggle-timeline-pane',
            label: 'Timeline',
            icon: History,
            pressed: true,
            badge: 3,
            onSelect: () => undefined,
          },
          {
            id: 'artifacts',
            testId: 'toggle-artifacts-pane',
            label: 'Artifacts',
            icon: Package,
            onSelect: () => undefined,
          },
        ]}
      />,
    );

    expect(screen.getByTestId('session-actions-open-count')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId('session-actions-trigger'));
    expect(screen.getByTestId('toggle-timeline-pane')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('toggle-artifacts-pane')).toHaveAttribute('aria-checked', 'false');
  });

  it('renders nested extra controls after the pane toggles', () => {
    render(
      <SessionActionsMenu
        items={[
          {
            id: 'timeline',
            testId: 'toggle-timeline-pane',
            label: 'Timeline',
            icon: History,
            onSelect: () => undefined,
          },
        ]}
      >
        <button type="button" data-testid="nested-extra">
          Nested
        </button>
      </SessionActionsMenu>,
    );

    fireEvent.click(screen.getByTestId('session-actions-trigger'));
    expect(screen.getByTestId('nested-extra')).toBeInTheDocument();
  });

  it('renders nothing when there are no items or extra controls', () => {
    const { container } = render(<SessionActionsMenu items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('inline mode surfaces items as flat toolbar buttons with no dropdown trigger', () => {
    const onSelect = vi.fn();
    render(
      <SessionActionsMenu
        inline
        items={[
          {
            id: 'timeline',
            testId: 'toggle-timeline-pane',
            label: 'Timeline',
            icon: History,
            pressed: true,
            badge: 2,
            onSelect,
          },
          {
            id: 'terminal',
            testId: 'toggle-terminal-pane',
            label: 'Terminal',
            icon: Package,
            hidden: true,
            onSelect: () => undefined,
          },
        ]}
      >
        <button type="button" data-testid="nested-extra">
          Nested
        </button>
      </SessionActionsMenu>,
    );

    // No dropdown affordance at all.
    expect(screen.queryByTestId('session-actions-trigger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-actions-dropdown')).not.toBeInTheDocument();

    // Visible item is directly clickable; hidden item is dropped; children render.
    const timeline = screen.getByTestId('toggle-timeline-pane');
    expect(timeline).toHaveAttribute('aria-pressed', 'true');
    expect(timeline).toHaveTextContent('2');
    expect(screen.queryByTestId('toggle-terminal-pane')).not.toBeInTheDocument();
    expect(screen.getByTestId('nested-extra')).toBeInTheDocument();

    fireEvent.click(timeline);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('inline mode with only children (all items hidden) still renders the controls', () => {
    render(
      <SessionActionsMenu
        inline
        items={[
          {
            id: 'terminal',
            testId: 'toggle-terminal-pane',
            label: 'Terminal',
            icon: Package,
            hidden: true,
            onSelect: () => undefined,
          },
        ]}
      >
        <button type="button" data-testid="nested-extra">
          Nested
        </button>
      </SessionActionsMenu>,
    );

    expect(screen.queryByTestId('session-actions-trigger')).not.toBeInTheDocument();
    expect(screen.getByTestId('nested-extra')).toBeInTheDocument();
  });

  it('inline mode renders nothing when there are no items or extra controls', () => {
    const { container } = render(<SessionActionsMenu inline items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
