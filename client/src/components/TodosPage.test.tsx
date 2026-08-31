import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    listTodos: vi.fn(),
    createTodo: vi.fn(),
    updateTodo: vi.fn(),
    deleteTodo: vi.fn(),
    unlinkTodo: vi.fn(),
    reorderTodos: vi.fn(),
    getProjects: vi.fn(),
    getBoard: vi.fn(),
    promoteTodo: vi.fn(),
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
    priority: over.priority ?? 'medium',
    doDate: over.doDate ?? null,
    doStartAt: over.doStartAt ?? null,
    doEndAt: over.doEndAt ?? null,
    dueAt: over.dueAt ?? null,
    position: over.position ?? idCounter,
    sourceType: 'manual',
    sourceId: null,
    sourceMeta: null,
    linkedType: over.linkedType ?? null,
    linkedId: over.linkedId ?? null,
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
  mockApi.getProjects.mockResolvedValue([{ id: 'p1', name: 'Project One' }]);
  mockApi.getBoard.mockResolvedValue({ columns: [{ id: 'c1', name: 'To Do' }], epics: [] });
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
    // The add form writes the scheduling do-date (not the deprecated dueAt).
    expect(arg.doDate).not.toBeNull();
    expect(arg.priority).toBe('medium');
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

describe('TodosPage — detail notes', () => {
  it('sends the detail text when creating a todo', async () => {
    const created = todo({ id: 'new', title: 'Buy milk', notes: 'skim, 2%', status: 'open' });
    mockApi.createTodo.mockResolvedValue({ todo: created });
    render(<TodosPage />);
    await screen.findByTestId('todos-empty');

    fireEvent.change(screen.getByTestId('todo-new-title'), { target: { value: 'Buy milk' } });
    fireEvent.change(screen.getByTestId('todo-new-notes'), { target: { value: 'skim, 2%' } });
    fireEvent.click(screen.getByTestId('todo-add'));

    await waitFor(() => expect(mockApi.createTodo).toHaveBeenCalledTimes(1));
    expect(mockApi.createTodo.mock.calls[0][0].notes).toBe('skim, 2%');
  });

  it('renders the detail text under the title', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [
        todo({ id: 'a', title: 'Plan trip', notes: 'Book flights and hotel', status: 'open' }),
      ],
    });
    render(<TodosPage />);
    await screen.findByText('Plan trip');
    expect(screen.getByTestId('todo-notes')).toHaveTextContent('Book flights and hotel');
  });

  it('omits the detail block when a todo has no notes', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'No detail', notes: '', status: 'open' })],
    });
    render(<TodosPage />);
    await screen.findByText('No detail');
    expect(screen.queryByTestId('todo-notes')).not.toBeInTheDocument();
  });

  it('edits a todo detail inline and saves it', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'Task', notes: 'old detail', status: 'open' })],
    });
    mockApi.updateTodo.mockImplementation(async (_id: string, patch: any) => ({
      todo: todo({ id: 'a', title: 'Task', notes: patch.notes, status: 'open' }),
    }));
    render(<TodosPage />);
    await screen.findByText('Task');

    fireEvent.click(screen.getByLabelText('Edit todo'));
    const detail = screen.getByLabelText('Edit todo detail');
    expect(detail).toHaveValue('old detail');
    fireEvent.change(detail, { target: { value: 'new detail' } });
    fireEvent.click(screen.getByLabelText('Save todo'));

    await waitFor(() => expect(mockApi.updateTodo).toHaveBeenCalledTimes(1));
    expect(mockApi.updateTodo.mock.calls[0][1].notes).toBe('new detail');
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

describe('TodosPage — priority chip & sort', () => {
  it('renders a priority chip for each todo', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'Urgent thing', status: 'open', priority: 'urgent' })],
    });
    render(<TodosPage />);
    await screen.findByText('Urgent thing');
    const chip = screen.getByTestId('todo-priority');
    expect(chip).toHaveTextContent(/urgent/i);
  });

  it('orders open todos most-urgent first regardless of stored position', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [
        todo({ id: 'lo', title: 'Low task', status: 'open', priority: 'low', position: 0 }),
        todo({ id: 'ur', title: 'Urgent task', status: 'open', priority: 'urgent', position: 1 }),
        todo({ id: 'me', title: 'Medium task', status: 'open', priority: 'medium', position: 2 }),
      ],
    });
    render(<TodosPage />);
    await screen.findByText('Urgent task');
    const rows = screen.getAllByTestId('todo-row');
    const titles = rows.map((r) => within(r).getByTitle(/task/).textContent);
    expect(titles).toEqual(['Urgent task', 'Medium task', 'Low task']);
  });
});

describe('TodosPage — do-date time window & link badge', () => {
  it('renders the do-date with an optional time window', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [
        todo({
          id: 'a',
          title: 'Scheduled task',
          status: 'open',
          doDate: '2026-07-12T00:00:00.000Z',
          doStartAt: '2026-07-12T14:00:00.000Z',
          doEndAt: '2026-07-12T15:30:00.000Z',
        }),
      ],
    });
    render(<TodosPage />);
    await screen.findByText('Scheduled task');
    const badge = screen.getByTestId('todo-due-badge');
    // Time window rendered next to the date (locale clock, so match the dash).
    expect(badge.textContent).toMatch(/–/);
  });

  it('renders a link badge reflecting the polymorphic linked_type', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [
        todo({
          id: 'c',
          title: 'Linked to card',
          status: 'open',
          linkedType: 'card',
          linkedId: 'k1',
        }),
        todo({
          id: 'e',
          title: 'Linked to epic',
          status: 'open',
          linkedType: 'epic',
          linkedId: 'p1',
        }),
        todo({
          id: 's',
          title: 'Linked to session',
          status: 'open',
          linkedType: 'session',
          linkedId: 'sess1',
        }),
      ],
    });
    render(<TodosPage />);
    await screen.findByText('Linked to card');
    const badges = screen.getAllByTestId('todo-link-badge').map((b) => b.textContent);
    expect(badges).toEqual(expect.arrayContaining(['Ticket', 'Epic', 'Session']));
  });

  it('falls back to a Ticket badge for a legacy linkedCardId', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'l', title: 'Legacy link', status: 'open', linkedCardId: 'k9' })],
    });
    render(<TodosPage />);
    await screen.findByText('Legacy link');
    expect(screen.getByTestId('todo-link-badge')).toHaveTextContent('Ticket');
  });

  it('unlinks a linked todo via the badge X and clears its link locally', async () => {
    const linked = todo({
      id: 'u',
      title: 'Unlink me',
      status: 'open',
      linkedType: 'card',
      linkedId: 'c1',
    });
    mockApi.listTodos.mockResolvedValue({ todos: [linked] });
    mockApi.unlinkTodo.mockResolvedValue({ todo: { ...linked, linkedType: null, linkedId: null } });
    render(<TodosPage />);
    await screen.findByText('Unlink me');

    fireEvent.click(screen.getByTestId('todo-unlink'));
    await waitFor(() => expect(mockApi.unlinkTodo).toHaveBeenCalledWith('u'));
    await waitFor(() => expect(screen.queryByTestId('todo-link-badge')).not.toBeInTheDocument());
  });
});

describe('TodosPage — capture origin', () => {
  it('shows an origin link back to the source for a captured todo', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [
        todo({
          id: 'c',
          title: 'Review the Q3 budget',
          status: 'open',
          sourceType: 'email',
          sourceId: 'msg-9',
          sourceMeta: { kind: 'gmail', deepLink: 'https://mail.google.com/mail/u/0/#all/t1' },
        }),
      ],
    });
    render(<TodosPage />);
    await screen.findByText('Review the Q3 budget');

    const origin = screen.getByTestId('todo-origin');
    expect(origin).toHaveTextContent('From email');
    expect(origin).toHaveAttribute('href', 'https://mail.google.com/mail/u/0/#all/t1');
  });
});

describe('TodosPage — promote', () => {
  it('shows a promote control on an open, unlinked todo', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'Promotable', status: 'open' })],
    });
    render(<TodosPage />);
    await screen.findByText('Promotable');
    expect(screen.getByTestId('todo-promote')).toBeInTheDocument();
  });

  it('hides the promote control on an already-linked todo', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [
        todo({
          id: 'l',
          title: 'Already linked',
          status: 'open',
          linkedType: 'card',
          linkedId: 'k1',
        }),
      ],
    });
    render(<TodosPage />);
    await screen.findByText('Already linked');
    expect(screen.queryByTestId('todo-promote')).not.toBeInTheDocument();
  });

  it('opens the promote modal when the control is clicked', async () => {
    mockApi.listTodos.mockResolvedValue({
      todos: [todo({ id: 'a', title: 'Promotable', status: 'open' })],
    });
    render(<TodosPage />);
    await screen.findByText('Promotable');
    fireEvent.click(screen.getByTestId('todo-promote'));
    expect(await screen.findByTestId('promote-todo-modal')).toBeInTheDocument();
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
