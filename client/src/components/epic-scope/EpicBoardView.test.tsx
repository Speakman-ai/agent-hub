import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import EpicBoardView from './EpicBoardView';

const columns = [
  { id: 'col-todo', name: 'To Do', position: 0 },
  { id: 'col-done', name: 'Done', position: 1 },
];

const epics = [
  { id: 'e1', name: 'Active epic', color: '#6366F1', state: 'in_progress' },
  { id: 'e2', name: 'Finished epic', color: '#6366F1', state: 'done' },
  { id: 'e3', name: 'Empty epic', color: '#6366F1', state: null },
  { id: 'e4', name: 'Queued epic', color: '#6366F1', state: 'not_started' },
];

const cards = [
  { id: 'c1', epic_id: 'e1', column_id: 'col-todo' },
  { id: 'c2', epic_id: 'e2', column_id: 'col-done' },
];

describe('EpicBoardView', () => {
  it('renders three lifecycle columns and buckets epics by state', () => {
    render(
      <EpicBoardView
        epics={epics}
        phases={[]}
        cards={cards}
        columns={columns}
        onOpenEpic={vi.fn()}
      />,
    );

    const notStarted = screen.getByTestId('epic-board-column-not_started');
    const inProgress = screen.getByTestId('epic-board-column-in_progress');
    const done = screen.getByTestId('epic-board-column-done');

    // Empty (null) and not_started epics land under "Not started".
    expect(within(notStarted).getByText('Empty epic')).toBeInTheDocument();
    expect(within(notStarted).getByText('Queued epic')).toBeInTheDocument();
    expect(within(inProgress).getByText('Active epic')).toBeInTheDocument();
    expect(within(done).getByText('Finished epic')).toBeInTheDocument();
  });

  it('shows per-column counts', () => {
    render(
      <EpicBoardView
        epics={epics}
        phases={[]}
        cards={cards}
        columns={columns}
        onOpenEpic={vi.fn()}
      />,
    );
    const notStarted = screen.getByTestId('epic-board-column-not_started');
    expect(within(notStarted).getByText('2')).toBeInTheDocument();
  });

  it('opens an epic when its card is clicked', () => {
    const onOpenEpic = vi.fn();
    render(
      <EpicBoardView
        epics={epics}
        phases={[]}
        cards={cards}
        columns={columns}
        onOpenEpic={onOpenEpic}
      />,
    );
    fireEvent.click(screen.getByTestId('epic-board-open-e1'));
    expect(onOpenEpic).toHaveBeenCalledWith('e1');
  });

  it('renders the empty message when there are no epics', () => {
    render(
      <EpicBoardView
        epics={[]}
        phases={[]}
        cards={[]}
        columns={columns}
        onOpenEpic={vi.fn()}
        emptyMessage="Nothing here"
      />,
    );
    expect(screen.getByTestId('epic-board-empty')).toHaveTextContent('Nothing here');
  });
});
