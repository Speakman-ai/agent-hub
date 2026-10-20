import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HubPage, { HUB_ASSISTANT_COLLAPSED_KEY } from './HubPage';

const panes = {
  assistant: <span>a</span>,
  today: <span>today-body</span>,
  org: <span>org-body</span>,
  todos: <span>todos-body</span>,
  reminders: <span>reminders-body</span>,
  calendar: <span>calendar-body</span>,
  mail: <span>mail-body</span>,
  chat: <span>chat-body</span>,
  support: <span>support-body</span>,
};

describe('HubPage', () => {
  it('hides the assistant column on desktop while the assistant is open in Chat', () => {
    window.localStorage.setItem(HUB_ASSISTANT_COLLAPSED_KEY, '1');
    const { rerender } = render(
      <HubPage pane="chat" onPaneChange={() => {}} {...panes} assistantInWorkspace />,
    );
    expect(screen.getByTestId('hub-assistant-pane').className).toContain('lg:hidden');
    // The "Show assistant" button would reopen a column with nothing in it.
    expect(screen.queryByTestId('hub-assistant-open')).toBeNull();

    window.localStorage.removeItem(HUB_ASSISTANT_COLLAPSED_KEY);
    rerender(<HubPage pane="chat" onPaneChange={() => {}} {...panes} />);
    expect(screen.getByTestId('hub-assistant-open')).toBeInTheDocument();
  });

  it('renders Hub chrome and switches workspace panes', () => {
    const onPaneChange = vi.fn();
    render(
      <HubPage
        pane="today"
        onPaneChange={onPaneChange}
        assistant={<div>assistant-body</div>}
        today={<div>today-body</div>}
        org={<div>org-body</div>}
        todos={<div>todos-body</div>}
        reminders={<div>reminders-body</div>}
        calendar={<div>calendar-body</div>}
        mail={<div>mail-body</div>}
        chat={<div>chat-body</div>}
        support={<div>support-body</div>}
      />,
    );

    expect(screen.getByTestId('hub-page')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Hub sections' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('hub-pane-assistant')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hub-pane-support')).not.toBeInTheDocument();
    expect(screen.getByText('today-body')).toBeInTheDocument();
    expect(screen.getByText('assistant-body')).toBeInTheDocument();
    expect(onPaneChange).not.toHaveBeenCalled();
  });

  it('shows the Support pane body when the support tab is active', () => {
    render(<HubPage pane="support" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('support-body')).toBeInTheDocument();
    expect(screen.queryByText('today-body')).not.toBeInTheDocument();
  });

  it('shows the selected pane body', () => {
    const { rerender } = render(<HubPage pane="mail" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('mail-body')).toBeInTheDocument();
    expect(screen.queryByText('today-body')).not.toBeInTheDocument();

    rerender(<HubPage pane="chat" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('chat-body')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-pane-chat')).not.toBeInTheDocument();

    rerender(<HubPage pane="todos" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('todos-body')).toBeInTheDocument();
  });

  it('wraps the workspace pane in a bounded flex column so flex-1 pane roots can scroll', () => {
    // Regression: org/todos/calendar/mail pane roots use `flex-1 overflow-y-auto`,
    // which only produces a scrollable, bounded box when the wrapper is a flex
    // container. When the wrapper was plain `block`, `flex-1` was inert and the
    // content overflowed the `overflow-hidden` wrapper with no scrollbar.
    render(<HubPage pane="todos" onPaneChange={() => undefined} {...panes} />);
    const wrapper = screen.getByText('todos-body').parentElement as HTMLElement;
    expect(wrapper.classList.contains('flex')).toBe(true);
    expect(wrapper.classList.contains('flex-col')).toBe(true);
    expect(wrapper.classList.contains('min-h-0')).toBe(true);
    expect(wrapper.classList.contains('overflow-hidden')).toBe(true);
  });

  it('renders assistant column actions', () => {
    render(
      <HubPage
        pane="today"
        onPaneChange={() => undefined}
        {...panes}
        assistantActions={<span>hub-clear-slot</span>}
      />,
    );
    expect(screen.getByText('hub-clear-slot')).toBeInTheDocument();
  });

  describe('assistant close', () => {
    beforeEach(() => window.localStorage.removeItem(HUB_ASSISTANT_COLLAPSED_KEY));

    it('hides the assistant column on desktop and reopens it from the header', () => {
      render(<HubPage pane="today" onPaneChange={vi.fn()} {...panes} mobileAssistantTab />);
      const aside = screen.getByTestId('hub-assistant-pane');
      expect(aside.className).toContain('lg:flex');
      expect(screen.queryByTestId('hub-assistant-open')).toBeNull();

      fireEvent.click(screen.getByTestId('hub-assistant-close'));
      expect(aside.className).toContain('lg:hidden');
      expect(aside.className).not.toContain('lg:flex');
      expect(window.localStorage.getItem(HUB_ASSISTANT_COLLAPSED_KEY)).toBe('1');

      fireEvent.click(screen.getByTestId('hub-assistant-open'));
      expect(aside.className).toContain('lg:flex');
      expect(screen.queryByTestId('hub-assistant-open')).toBeNull();
      expect(window.localStorage.getItem(HUB_ASSISTANT_COLLAPSED_KEY)).toBeNull();
    });

    it('restores the closed state on the next render', () => {
      window.localStorage.setItem(HUB_ASSISTANT_COLLAPSED_KEY, '1');
      render(<HubPage pane="today" onPaneChange={vi.fn()} {...panes} />);
      expect(screen.getByTestId('hub-assistant-pane').className).toContain('lg:hidden');
      expect(screen.getByTestId('hub-assistant-open')).toBeInTheDocument();
    });

    it('does not offer an Assistant tab', () => {
      render(
        <HubPage
          pane="today"
          onPaneChange={vi.fn()}
          {...panes}
          mobileAssistantTab
          mobileTab="assistant"
        />,
      );
      expect(screen.queryByTestId('hub-pane-assistant')).not.toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Hub sections' })).not.toBeInTheDocument();
    });
  });
});
