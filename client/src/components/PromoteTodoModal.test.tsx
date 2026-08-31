import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
    getBoard: vi.fn(),
    promoteTodo: vi.fn(),
  },
}));

import PromoteTodoModal from './PromoteTodoModal';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function todo(over: Partial<any> = {}): any {
  return {
    id: over.id || 't1',
    userId: 'u1',
    title: over.title || 'Ship the thing',
    notes: '',
    status: 'open',
    priority: over.priority ?? 'high',
    doDate: null,
    doStartAt: null,
    doEndAt: null,
    dueAt: null,
    position: 0,
    sourceType: 'manual',
    sourceId: null,
    sourceMeta: null,
    linkedType: null,
    linkedId: null,
    linkedCardId: null,
    linkedProjectId: null,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.getProjects.mockResolvedValue([
    { id: 'proj-a', name: 'Project A' },
    { id: 'proj-b', name: 'Project B' },
  ]);
  mockApi.getBoard.mockResolvedValue({
    columns: [
      { id: 'col-todo', name: 'To Do' },
      { id: 'col-doing', name: 'In Progress' },
    ],
    epics: [{ id: 'epic-1', name: 'Q3 Launch' }],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PromoteTodoModal — picker', () => {
  it('loads projects then the selected board, defaulting to the first project/column', async () => {
    render(<PromoteTodoModal todo={todo()} onClose={() => {}} />);

    await waitFor(() => expect(mockApi.getProjects).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockApi.getBoard).toHaveBeenCalledWith('proj-a', { limit: 'all' }));

    const project = (await screen.findByTestId('promote-project')) as HTMLSelectElement;
    const column = (await screen.findByTestId('promote-column')) as HTMLSelectElement;
    await waitFor(() => expect(project.value).toBe('proj-a'));
    await waitFor(() => expect(column.value).toBe('col-todo'));
  });

  it('defaults the priority to the todo priority so a promote maps 1:1', async () => {
    render(<PromoteTodoModal todo={todo({ priority: 'urgent' })} onClose={() => {}} />);
    const priority = (await screen.findByTestId('promote-priority')) as HTMLSelectElement;
    expect(priority.value).toBe('urgent');
  });

  it('reloads the board when the project changes', async () => {
    render(<PromoteTodoModal todo={todo()} onClose={() => {}} />);
    await waitFor(() => expect(mockApi.getBoard).toHaveBeenCalledWith('proj-a', { limit: 'all' }));

    fireEvent.change(await screen.findByTestId('promote-project'), {
      target: { value: 'proj-b' },
    });
    await waitFor(() => expect(mockApi.getBoard).toHaveBeenCalledWith('proj-b', { limit: 'all' }));
  });

  it('promotes with the chosen project, column, priority (and epic)', async () => {
    const onPromoted = vi.fn();
    const onClose = vi.fn();
    mockApi.promoteTodo.mockResolvedValue({
      todo: todo({ linkedType: 'card', linkedId: 'card-9', linkedProjectId: 'proj-a' }),
      card: { id: 'card-9' },
    });

    render(<PromoteTodoModal todo={todo()} onClose={onClose} onPromoted={onPromoted} />);

    // Wait for board (column + epic) to load, then pick a non-default column + epic.
    await screen.findByTestId('promote-column');
    fireEvent.change(screen.getByTestId('promote-column'), { target: { value: 'col-doing' } });
    fireEvent.change(screen.getByTestId('promote-priority'), { target: { value: 'low' } });
    fireEvent.change(await screen.findByTestId('promote-epic'), { target: { value: 'epic-1' } });

    fireEvent.click(screen.getByTestId('promote-submit'));

    await waitFor(() => expect(mockApi.promoteTodo).toHaveBeenCalledTimes(1));
    expect(mockApi.promoteTodo).toHaveBeenCalledWith('t1', {
      projectId: 'proj-a',
      columnId: 'col-doing',
      priority: 'low',
      epicId: 'epic-1',
    });
    await waitFor(() => expect(onPromoted).toHaveBeenCalledTimes(1));
  });

  it('surfaces a promote failure without closing', async () => {
    const onClose = vi.fn();
    mockApi.promoteTodo.mockRejectedValue(new Error('boom'));
    render(<PromoteTodoModal todo={todo()} onClose={onClose} />);

    await screen.findByTestId('promote-column');
    fireEvent.click(screen.getByTestId('promote-submit'));

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
