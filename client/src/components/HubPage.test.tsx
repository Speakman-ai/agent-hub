import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HubPage from './HubPage';

const panes = {
  assistant: <span>a</span>,
  today: <span>today-body</span>,
  summary: <span>summary-body</span>,
  org: <span>org-body</span>,
  todos: <span>todos-body</span>,
  calendar: <span>calendar-body</span>,
  mail: <span>mail-body</span>,
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
      />,
    );

    expect(screen.getByTestId('hub-page')).toBeInTheDocument();
    expect(screen.getByText('today-body')).toBeInTheDocument();
    expect(screen.getByText('assistant-body')).toBeInTheDocument();
    expect(screen.getByTestId('hub-pane-today')).toHaveTextContent('Dashboard');
    expect(screen.getByTestId('hub-pane-summary')).toHaveTextContent('Daily Summary');
    expect(screen.queryByTestId('hub-pane-troubleshoot')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('hub-pane-org'));
    expect(onPaneChange).toHaveBeenCalledWith('org');
    fireEvent.click(screen.getByTestId('hub-pane-summary'));
    expect(onPaneChange).toHaveBeenCalledWith('summary');
  });

  it('shows the selected pane body', () => {
    const { rerender } = render(<HubPage pane="mail" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('mail-body')).toBeInTheDocument();
    expect(screen.queryByText('today-body')).not.toBeInTheDocument();

    rerender(<HubPage pane="todos" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('todos-body')).toBeInTheDocument();

    rerender(<HubPage pane="summary" onPaneChange={() => undefined} {...panes} />);
    expect(screen.getByText('summary-body')).toBeInTheDocument();
    expect(screen.queryByText('todos-body')).not.toBeInTheDocument();
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
});
