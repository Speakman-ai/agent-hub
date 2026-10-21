import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import HubPage from './HubPage';

const panes = {
  agent: <span>agent-body</span>,
  agentSettings: <span>agent-settings-body</span>,
  today: <span>today-body</span>,
  org: <span>org-body</span>,
  todos: <span>todos-body</span>,
  reminders: <span>reminders-body</span>,
  calendar: <span>calendar-body</span>,
  mail: <span>mail-body</span>,
  chat: <span>chat-body</span>,
  googleChat: <span>google-chat-body</span>,
  support: <span>support-body</span>,
};

describe('HubPage', () => {
  it('renders the selected workspace pane and no assistant column', () => {
    const onPaneChange = vi.fn();
    render(<HubPage pane="today" onPaneChange={onPaneChange} {...panes} />);

    expect(screen.getByTestId('hub-page')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-assistant-pane')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hub-assistant-open')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Hub sections' })).not.toBeInTheDocument();
    expect(screen.getByText('today-body')).toBeInTheDocument();
    expect(onPaneChange).not.toHaveBeenCalled();
  });

  it('lands on the Server Agent when no pane is chosen', () => {
    const { rerender } = render(<HubPage pane={null} onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('agent-body')).toBeInTheDocument();
    expect(screen.queryByText('today-body')).not.toBeInTheDocument();

    rerender(<HubPage pane="agent-settings" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('agent-settings-body')).toBeInTheDocument();
    expect(screen.queryByText('agent-body')).not.toBeInTheDocument();
  });

  it('shows the Support pane body when the support pane is active', () => {
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

    rerender(<HubPage pane="google-chat" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('google-chat-body')).toBeInTheDocument();
    expect(screen.queryByText('chat-body')).not.toBeInTheDocument();

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
});
