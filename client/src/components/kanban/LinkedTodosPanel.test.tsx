import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import LinkedTodosPanel from './LinkedTodosPanel';
import { api } from '../../utils/api';

vi.mock('../../utils/api', () => ({
  api: {
    getLinkedTodos: vi.fn(),
  },
}));

function todo(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'Follow up on login bug',
    status: 'open',
    priority: 'high',
    doDate: null,
    dueAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (api.getLinkedTodos as any).mockResolvedValue({ todos: [] });
});

describe('LinkedTodosPanel', () => {
  it('fetches and renders the caller from-todos for a saved card', async () => {
    (api.getLinkedTodos as any).mockResolvedValue({
      todos: [todo(), todo({ id: 't2', title: 'Write regression test', priority: 'low' })],
    });
    render(<LinkedTodosPanel targetType="card" entity={{ id: 'card-1' }} projectId="proj" />);

    await waitFor(() => expect(screen.getByTestId('linked-todos-panel')).toBeInTheDocument());
    expect(api.getLinkedTodos).toHaveBeenCalledWith({
      targetType: 'card',
      targetId: 'card-1',
      projectId: 'proj',
    });
    expect(screen.getByText('From your todos (2)')).toBeInTheDocument();
    expect(screen.getByText('Follow up on login bug')).toBeInTheDocument();
    expect(screen.getByText('Write regression test')).toBeInTheDocument();
    expect(screen.getAllByTestId('linked-todo-item')).toHaveLength(2);
  });

  it('renders nothing when there are no linked todos', async () => {
    (api.getLinkedTodos as any).mockResolvedValue({ todos: [] });
    const { container } = render(
      <LinkedTodosPanel targetType="card" entity={{ id: 'card-1' }} projectId="proj" />,
    );
    await waitFor(() => expect(api.getLinkedTodos).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="linked-todos-panel"]')).toBeNull();
  });

  it('does not fetch for a draft (unsaved) card', () => {
    render(
      <LinkedTodosPanel targetType="card" entity={{ id: 'x', __draft: true }} projectId="proj" />,
    );
    expect(api.getLinkedTodos).not.toHaveBeenCalled();
  });

  it('does not fetch when the project id is missing', () => {
    render(<LinkedTodosPanel targetType="epic" entity={{ id: 'epic-1' }} projectId="" />);
    expect(api.getLinkedTodos).not.toHaveBeenCalled();
  });

  it('queries an epic target with its project id', async () => {
    (api.getLinkedTodos as any).mockResolvedValue({ todos: [todo()] });
    render(<LinkedTodosPanel targetType="epic" entity={{ id: 'epic-9' }} projectId="proj" />);
    await waitFor(() =>
      expect(api.getLinkedTodos).toHaveBeenCalledWith({
        targetType: 'epic',
        targetId: 'epic-9',
        projectId: 'proj',
      }),
    );
  });

  it('refetches when a user_todo_update event fires', async () => {
    (api.getLinkedTodos as any).mockResolvedValue({ todos: [todo()] });
    render(<LinkedTodosPanel targetType="card" entity={{ id: 'card-1' }} projectId="proj" />);
    await waitFor(() => expect(api.getLinkedTodos).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('user_todo_update'));
    await waitFor(() => expect(api.getLinkedTodos).toHaveBeenCalledTimes(2));
  });
});
