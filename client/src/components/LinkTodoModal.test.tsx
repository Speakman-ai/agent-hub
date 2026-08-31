import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import LinkTodoModal from './LinkTodoModal';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
    getBoard: vi.fn(),
    getAgents: vi.fn(),
    getSessions: vi.fn(),
    linkTodo: vi.fn(),
  },
}));

const todo = { id: 'todo-1', title: 'Buy milk', status: 'open' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  (api.getProjects as any).mockResolvedValue([
    { id: 'proj-x', name: 'Project X' },
    { id: 'proj-y', name: 'Project Y' },
  ]);
  (api.getBoard as any).mockResolvedValue({
    cards: [
      { id: 'card-1', title: 'Fix login' },
      { id: 'card-2', title: 'Add dashboard' },
    ],
    epics: [{ id: 'epic-1', name: 'Q3 goals' }],
  });
  (api.getAgents as any).mockResolvedValue([
    { id: 'agent-1', name: 'Dev', projectId: 'proj-x' },
    { id: 'agent-2', name: 'Docs', projectId: 'proj-y' },
  ]);
  (api.getSessions as any).mockResolvedValue([{ id: 'sess-1', name: 'My session' }]);
  (api.linkTodo as any).mockResolvedValue({ todo: { ...todo, linkedType: 'card' } });
});

describe('LinkTodoModal', () => {
  it('defaults to the card target and lists the first project board cards', async () => {
    render(<LinkTodoModal todo={todo} onClose={() => {}} />);
    expect(screen.getByTestId('link-type-card')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTestId('link-option-card-1')).toBeInTheDocument());
    expect(screen.getByTestId('link-option-card-2')).toBeInTheDocument();
    expect(api.getBoard).toHaveBeenCalledWith('proj-x', { limit: 'all' });
  });

  it('links a card with the project id in the payload', async () => {
    const onLinked = vi.fn();
    render(<LinkTodoModal todo={todo} onClose={() => {}} onLinked={onLinked} />);
    await waitFor(() => expect(screen.getByTestId('link-option-card-1')).toBeInTheDocument());

    // Cannot submit until a target is chosen.
    expect(screen.getByTestId('link-submit')).toBeDisabled();
    fireEvent.click(screen.getByTestId('link-option-card-1'));
    fireEvent.click(screen.getByTestId('link-submit'));

    await waitFor(() =>
      expect(api.linkTodo).toHaveBeenCalledWith('todo-1', {
        targetType: 'card',
        targetId: 'card-1',
        projectId: 'proj-x',
      }),
    );
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
  });

  it('switches to epic target and lists board epics', async () => {
    render(<LinkTodoModal todo={todo} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('link-option-card-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('link-type-epic'));
    await waitFor(() => expect(screen.getByTestId('link-option-epic-1')).toBeInTheDocument());
    expect(screen.queryByTestId('link-option-card-1')).not.toBeInTheDocument();
  });

  it('browses project → agent → session and omits projectId for a session link', async () => {
    render(<LinkTodoModal todo={todo} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('link-option-card-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('link-type-session'));
    // Only the project's own agent is offered.
    await waitFor(() => expect(api.getAgents).toHaveBeenCalled());
    const agentSelect = screen.getByTestId('link-agent') as HTMLSelectElement;
    expect(agentSelect.querySelector('option[value="agent-1"]')).toBeTruthy();
    expect(agentSelect.querySelector('option[value="agent-2"]')).toBeFalsy();

    fireEvent.change(agentSelect, { target: { value: 'agent-1' } });
    await waitFor(() => expect(screen.getByTestId('link-option-sess-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('link-option-sess-1'));
    fireEvent.click(screen.getByTestId('link-submit'));

    await waitFor(() =>
      expect(api.linkTodo).toHaveBeenCalledWith('todo-1', {
        targetType: 'session',
        targetId: 'sess-1',
      }),
    );
  });

  it('filters the option list by name', async () => {
    render(<LinkTodoModal todo={todo} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('link-option-card-1')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('link-filter'), { target: { value: 'dashboard' } });
    await waitFor(() => expect(screen.queryByTestId('link-option-card-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('link-option-card-2')).toBeInTheDocument();
  });
});
