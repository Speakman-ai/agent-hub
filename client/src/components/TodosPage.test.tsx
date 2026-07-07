import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    listTodos: vi.fn(),
    createTodo: vi.fn(),
    updateTodo: vi.fn(),
    deleteTodo: vi.fn(),
    reorderTodos: vi.fn(),
  },
}));

import TodosPage from './TodosPage';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

let idCounter = 0;
function todo(over: Partial<any> = {}): any {
  idCounter += 1;
  return {
    id: over.id || `t${idCounter}`,
    userId: 'u1',
    title: over.title || `Todo ${idCounter}`,
    notes: '',
    status: over.status || 'open',
    dueAt: over.dueAt ?? null,
    position: over.position ?? idCounter,
    sourceType: 'manual',
    sourceId: null,
    sourceMeta: null,
    linkedCardId: over.linkedCardId ?? null,
    linkedProjectId: null,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  idCounter = 0;
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.listTodos.mockResolvedValue({ todos: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TodosPage — render & no-Google independence', () => {
  it('loads and renders todos without ever touching Google APIs', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'Write tests', status: 'open' })],
    });
    render(<TodosPage />);
    expect(await screen.findByText('Write tests')).toBeInTheDocument();
    // The mocked api exposes only todo methods — no Google surface is called.
    expect(mockApi.listTodos).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when there are no todos', async () => {
    render(<TodosPage />);
    expect(await screen.findByTestId('todos-empty')).toBeInTheDocument();
  });
});

describe('TodosPage — add', () => {
  it('creates a todo from the add form and appends it to the list', async () => {
    const created = todo({ id: 'new', title: 'Buy milk', status: 'open' });
    mockApi.createTodo.mockResolvedValue({ todo: created });
    render(<TodosPage />);
    await screen.findByTestId('todos-empty');

    fireEvent.change(screen.getByTestId('todo-new-title'), { target: { value: 'Buy milk' } });
    fireEvent.change(screen.getByTestId('todo-new-due'), { target: { value: '2026-07-12' } });
    fireEvent.click(screen.getByTestId('todo-add'));

    await waitFor(() => expect(mockApi.createTodo).toHaveBeenCalledTimes(1));
    const arg = mockApi.createTodo.mock.calls[0][0];
    expect(arg.title).toBe('Buy milk');
    expect(arg.dueAt).not.toBeNull();
    expect(await screen.findByText('Buy milk')).toBeInTheDocument();
  });

  it('does not submit an empty title', async () => {
    render(<TodosPage />);
    await screen.findByTestId('todos-empty');
    // Button disabled while the title is blank.
    expect(screen.getByTestId('todo-add')).toBeDisabled();
    fireEvent.click(screen.getByTestId('todo-add'));
    expect(mockApi.createTodo).not.toHaveBeenCalled();
  });
});

describe('TodosPage — complete', () => {
  it('marks a todo done and moves it to the completed section', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'Finish report', status: 'open' })],
    });
    mockApi.updateTodo.mockImplementation(async (_id: string, patch: any) => ({
      todo: todo({ id: 'a', title: 'Finish report', status: patch.status }),
    }));
    render(<TodosPage />);
    await screen.findByText('Finish report');

    fireEvent.click(screen.getByLabelText('Mark as done'));
    await waitFor(() => expect(mockApi.updateTodo).toHaveBeenCalledWith('a', { status: 'done' }));
    // Completed section header appears with a count of 1.
    expect(await screen.findByTestId('todos-done-toggle')).toHaveTextContent('Completed (1)');
  });
});

describe('TodosPage — delete', () => {
  it('optimistically removes a todo', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'Delete me', status: 'open' })],
    });
    mockApi.deleteTodo.mockResolvedValue({ ok: true });
    render(<TodosPage />);
    await screen.findByText('Delete me');

    fireEvent.click(screen.getByLabelText('Delete todo'));
    await waitFor(() => expect(screen.queryByText('Delete me')).not.toBeInTheDocument());
    expect(mockApi.deleteTodo).toHaveBeenCalledWith('a');
  });
});

describe('TodosPage — reorder', () => {
  it('moves an open todo down and persists the new order', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [
        todo({ id: 'a', title: 'First', status: 'open', position: 0 }),
        todo({ id: 'b', title: 'Second', status: 'open', position: 1 }),
      ],
    });
    mockApi.reorderTodos.mockResolvedValue({ todos: [] });
    render(<TodosPage />);
    await screen.findByText('First');

    // "First" is the top row — move it down past "Second".
    const rows = screen.getAllByTestId('todo-row');
    const moveDown = within(rows[0]).getByLabelText('Move down');
    fireEvent.click(moveDown);

    await waitFor(() => expect(mockApi.reorderTodos).toHaveBeenCalledTimes(1));
    expect(mockApi.reorderTodos).toHaveBeenCalledWith(['b', 'a']);
  });
});

describe('TodosPage — edit', () => {
  it('edits a todo title inline and saves', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'Old title', status: 'open' })],
    });
    mockApi.updateTodo.mockImplementation(async (_id: string, patch: any) => ({
      todo: todo({ id: 'a', title: patch.title, status: 'open' }),
    }));
    render(<TodosPage />);
    await screen.findByText('Old title');

    fireEvent.click(screen.getByLabelText('Edit todo'));
    const input = screen.getByLabelText('Edit todo title');
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.click(screen.getByLabelText('Save todo'));

    await waitFor(() => expect(mockApi.updateTodo).toHaveBeenCalledTimes(1));
    expect(mockApi.updateTodo.mock.calls[0][1].title).toBe('New title');
    expect(await screen.findByText('New title')).toBeInTheDocument();
  });
});

describe('TodosPage — live updates', () => {
  it('refetches when a user_todo_update window event fires', async () => {
    mockApi.listTodos.mockResolvedValueOnce({ todos: [] });
    render(<TodosPage />);
    await screen.findByTestId('todos-empty');
    expect(mockApi.listTodos).toHaveBeenCalledTimes(1);

    mockApi.listTodos.mockResolvedValueOnce({
      todos: [todo({ id: 'x', title: 'Arrived via WS', status: 'open' })],
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('user_todo_update', { detail: {} }));
    });

    expect(await screen.findByText('Arrived via WS')).toBeInTheDocument();
    expect(mockApi.listTodos).toHaveBeenCalledTimes(2);
  });
});
