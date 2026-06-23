import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import EpicView from './EpicView';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getBoard: vi.fn(),
    getModelConfig: vi.fn().mockResolvedValue({ engineValidModels: {} }),
    createEpic: vi.fn(),
    createCard: vi.fn(),
    updateEpic: vi.fn(),
    deleteEpic: vi.fn(),
  },
}));

const board = {
  columns: [
    { id: 'col-backlog', name: 'Backlog', position: 0 },
    { id: 'col-done', name: 'Done', position: 1 },
  ],
  cards: [
    { id: 'c1', title: 'Existing ticket', column_id: 'col-backlog', epic_id: 'e1', position: 0 },
  ],
  epics: [
    { id: 'e1', name: 'Platform', color: '#6366F1', description: 'Core work', autonomous: 0 },
  ],
};

describe('EpicView', () => {
  beforeEach(() => {
    (api.getBoard as any).mockResolvedValue(board);
  });

  it('lists epics and navigates to detail', async () => {
    const onOpenEpic = vi.fn();

    render(
      <EpicView
        projectId="p1"
        epicId={null}
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={onOpenEpic}
      />,
    );

    await waitFor(() => expect(screen.getByText('Platform')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('epic-list-item-e1' as any) as any);
    expect(onOpenEpic!).toHaveBeenCalledWith('e1');
  });

  it('adds a ticket on the epic detail screen', async () => {
    (api.createCard as any).mockResolvedValue({ id: 'c2' });
    (api.getBoard as any).mockResolvedValueOnce(board).mockResolvedValueOnce({
      ...board,
      cards: [
        ...board.cards,
        { id: 'c2', title: 'New ticket', column_id: 'col-backlog', epic_id: 'e1', position: 1 },
      ],
    });

    render(
      <EpicView
        projectId="p1"
        epicId="e1"
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Existing ticket')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('epic-add-ticket-input' as any), {
      target: { value: 'New ticket' },
    });
    fireEvent.click(screen.getByTestId('epic-add-ticket-button' as any) as any);

    await waitFor(() =>
      expect(api.createCard).toHaveBeenCalledWith('p1', {
        title: 'New ticket',
        priority: 'medium',
        columnId: 'col-backlog',
        epicId: 'e1',
        createdBy: 'user',
      }),
    );
    await waitFor(() => expect(screen.getAllByText('New ticket').length).toBeGreaterThan(0));
  });
});
