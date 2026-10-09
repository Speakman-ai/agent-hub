import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HubPage, { HUB_ASSISTANT_COLLAPSED_KEY } from './HubPage';

const panes = {
  assistant: <span>a</span>,
  today: <span>today-body</span>,
  summary: <span>summary-body</span>,
  org: <span>org-body</span>,
  todos: <span>todos-body</span>,
  calendar: <span>calendar-body</span>,
  mail: <span>mail-body</span>,
  chat: <span>chat-body</span>,
  support: <span>support-body</span>,
};

describe('HubPage', () => {
  it('renders Hub chrome and switches workspace panes', () => {
    const onPaneChange = vi.fn();
    render(
      <HubPage
        pane="today"
        onPaneChange={onPaneChange}
        assistant={<div>assistant-body</div>}
        today={<div>today-body</div>}
        summary={<div>summary-body</div>}
        org={<div>org-body</div>}
        todos={<div>todos-body</div>}
        calendar={<div>calendar-body</div>}
        mail={<div>mail-body</div>}
        chat={<div>chat-body</div>}
        support={<div>support-body</div>}
      />,
    );

    expect(screen.getByTestId('hub-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Agent Hub' })).toBeInTheDocument();
    expect(screen.getByTestId('brand-logo')).toBeInTheDocument();
    expect(screen.getByText('today-body')).toBeInTheDocument();
    expect(screen.getByText('assistant-body')).toBeInTheDocument();
    expect(screen.getByTestId('hub-pane-today')).toHaveTextContent('Dashboard');
    expect(screen.getByTestId('hub-pane-summary')).toHaveTextContent('Daily Summary');
    expect(screen.getByTestId('hub-pane-support')).toHaveTextContent('Support');
    expect(screen.queryByTestId('hub-pane-troubleshoot')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('hub-pane-org'));
    expect(onPaneChange).toHaveBeenCalledWith('org');
    fireEvent.click(screen.getByTestId('hub-pane-summary'));
    expect(onPaneChange).toHaveBeenCalledWith('summary');
    fireEvent.click(screen.getByTestId('hub-pane-support'));
    expect(onPaneChange).toHaveBeenCalledWith('support');
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
    expect(screen.getByTestId('hub-pane-chat')).toHaveTextContent('Chat');

    rerender(<HubPage pane="todos" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('todos-body')).toBeInTheDocument();

    rerender(<HubPage pane="summary" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('summary-body')).toBeInTheDocument();
    expect(screen.queryByText('todos-body')).not.toBeInTheDocument();
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

  it('shows an unread badge on the Chat tab only when there is something unread', () => {
    const { rerender } = render(
      <HubPage pane="today" onPaneChange={vi.fn()} {...panes} paneBadges={{ chat: 120 }} />,
    );
    expect(screen.getByTestId('hub-pane-chat-badge').textContent).toBe('99+');
    expect(screen.queryByTestId('hub-pane-mail-badge')).toBeNull();
    rerender(<HubPage pane="today" onPaneChange={vi.fn()} {...panes} paneBadges={{ chat: 0 }} />);
    expect(screen.queryByTestId('hub-pane-chat-badge')).toBeNull();
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

    it('still shows the assistant on the mobile Assistant tab when closed on desktop', () => {
      window.localStorage.setItem(HUB_ASSISTANT_COLLAPSED_KEY, '1');
      render(
        <HubPage
          pane="today"
          onPaneChange={vi.fn()}
          {...panes}
          mobileAssistantTab
          mobileTab="assistant"
        />,
      );
      const cls = screen.getByTestId('hub-assistant-pane').className.split(/\s+/);
      expect(cls).toContain('flex');
      expect(cls).toContain('lg:hidden');
    });
  });
});
