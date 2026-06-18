import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';

/**
 * KanbanBoard drag-and-drop — INTEGRATION through the real board handlers.
 *
 * jsdom has no layout engine, so dnd-kit's pointer/keyboard sensor pipeline
 * (collision detection, geometry) cannot run here — simulating raw pointer
 * events would test the mock, not the behavior. Instead we mock ONLY the
 * dnd-kit rendering/sensor layer: <DndContext> is replaced with a passthrough
 * that captures the `onDragStart` / `onDragEnd` props the board wires up, so the
 * test can invoke the board's REAL `handleDragEnd` with authentic dnd-kit event
 * shapes (`active.rect.current.translated` + `over.rect`). That exercises the
 * full handler chain: handleDragEnd -> resolveDropTarget -> requestMove ->
 * applyResolvedMove -> computeMoveUpdates -> commitUpdates -> api.moveCard,
 * including the top-half/bottom-half (before/after) distinction.
 */

const dnd = { handlers: {} };

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragStart, onDragEnd, onDragCancel }) => {
    dnd.handlers.onDragStart = onDragStart;
    dnd.handlers.onDragEnd = onDragEnd;
    dnd.handlers.onDragCancel = onDragCancel;
    return <div data-testid="dnd-context">{children}</div>;
  },
  DragOverlay: ({ children }) => <div data-testid="drag-overlay">{children}</div>,
  PointerSensor: function PointerSensor() {},
  KeyboardSensor: function KeyboardSensor() {},
  useSensor: () => ({}),
  useSensors: (...sensors) => sensors,
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  closestCorners: () => [],
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }) => <>{children}</>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
  sortableKeyboardCoordinates: () => ({}),
  verticalListSortingStrategy: {},
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}));

vi.mock('../utils/api.js', () => ({
  api: {
    getBoard: vi.fn(),
    getColumnCards: vi.fn(),
    get: vi.fn().mockResolvedValue([]),
    getCardComments: vi.fn().mockResolvedValue([]),
    getCardReplay: vi.fn().mockRejectedValue(new Error('404')),
    getModelConfig: vi.fn().mockResolvedValue({ engineValidModels: {} }),
    moveCard: vi.fn().mockResolvedValue({}),
    getLatestFinalizeRunForSession: vi.fn().mockResolvedValue({ run: null }),
  },
}));

import KanbanBoard from './KanbanBoard.jsx';
import { api } from '../utils/api.js';

const rect = (top, height = 100) => ({ top, height });

const makeBoard = (cards = [], columns) => ({
  board: { id: 'b1' },
  columns: columns || [
    { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
    { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
  ],
  cards,
  epics: [],
});

const renderBoard = async (cards, columns) => {
  api.getBoard.mockResolvedValue(makeBoard(cards, columns));
  render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
  await waitFor(() => expect(screen.getByTestId('dnd-context')).toBeInTheDocument());
};

// Drive the board's real onDragEnd with a dnd-kit-shaped event.
const dragEnd = async ({ activeId, overId, activeRect, overRect }) => {
  await act(async () => {
    await dnd.handlers.onDragEnd({
      active: { id: activeId, rect: { current: { translated: activeRect ?? null } } },
      over: overId == null ? null : { id: overId, rect: overRect ?? null },
    });
  });
};

beforeEach(() => {
  dnd.handlers = {};
  api.getBoard.mockReset();
  api.moveCard.mockReset();
  api.moveCard.mockResolvedValue({});
});

describe('KanbanBoard DnD integration (real handleDragEnd)', () => {
  it('same-column reorder: top-half drop renumbers position through api.moveCard', async () => {
    await renderBoard([
      { id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 },
      { id: 'card-b', title: 'Card B', column_id: 'col-todo', position: 1 },
    ]);

    // Drag B onto A's top half → order becomes B, A.
    await dragEnd({
      activeId: 'card-b',
      overId: 'card-a',
      activeRect: rect(-40, 100), // dragged clone above A's midpoint → before
      overRect: rect(0, 100),
    });

    await waitFor(() => expect(api.moveCard).toHaveBeenCalledTimes(2));
    expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-b', {
      columnId: 'col-todo',
      position: 0,
    });
    expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-a', {
      columnId: 'col-todo',
      position: 1,
    });
  });

  it('cross-column TOP-half drop inserts BEFORE the hovered card', async () => {
    await renderBoard([
      { id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 },
      { id: 'card-b', title: 'Card B', column_id: 'col-done', position: 0 },
      { id: 'card-c', title: 'Card C', column_id: 'col-done', position: 1 },
    ]);

    // Drop A onto C's top half → A between B@0 and C → position 1; C → 2.
    await dragEnd({
      activeId: 'card-a',
      overId: 'card-c',
      activeRect: rect(180, 100), // center 230 < C midpoint 250 → before
      overRect: rect(200, 100),
    });

    await waitFor(() =>
      expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-a', {
        columnId: 'col-done',
        position: 1,
      }),
    );
    expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-c', {
      columnId: 'col-done',
      position: 2,
    });
    // B stays at 0.
    expect(api.moveCard.mock.calls.filter((c) => c[1] === 'card-b')).toEqual([]);
  });

  it('cross-column BOTTOM-half drop inserts AFTER the hovered card (regression)', async () => {
    await renderBoard([
      { id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 },
      { id: 'card-b', title: 'Card B', column_id: 'col-done', position: 0 },
      { id: 'card-c', title: 'Card C', column_id: 'col-done', position: 1 },
    ]);

    // Drop A onto C's BOTTOM half → A lands after C → position 2.
    await dragEnd({
      activeId: 'card-a',
      overId: 'card-c',
      activeRect: rect(220, 100), // center 270 > C midpoint 250 → after
      overRect: rect(200, 100),
    });

    await waitFor(() =>
      expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-a', {
        columnId: 'col-done',
        position: 2,
      }),
    );
    // Appending after the last card shifts nothing — B and C keep their slots.
    expect(api.moveCard.mock.calls.filter((c) => c[1] === 'card-b')).toEqual([]);
    expect(api.moveCard.mock.calls.filter((c) => c[1] === 'card-c')).toEqual([]);
  });

  it('drop onto a column droppable appends to the end of that column', async () => {
    await renderBoard([
      { id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 },
      { id: 'card-b', title: 'Card B', column_id: 'col-done', position: 0 },
    ]);

    await dragEnd({ activeId: 'card-a', overId: 'column:col-done' });

    await waitFor(() =>
      expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-a', {
        columnId: 'col-done',
        position: 1,
      }),
    );
  });

  it('no `over` is a no-op (drop outside any droppable)', async () => {
    await renderBoard([{ id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 }]);
    await dragEnd({ activeId: 'card-a', overId: null });
    expect(api.moveCard).not.toHaveBeenCalled();
  });

  it('same-column whitespace/container drop is a no-op (does NOT append to end)', async () => {
    // Reviewer-flagged: dropping a card back into its own column whitespace
    // must preserve its position, not relocate it to the end.
    await renderBoard([
      { id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 },
      { id: 'card-b', title: 'Card B', column_id: 'col-todo', position: 1 },
      { id: 'card-c', title: 'Card C', column_id: 'col-todo', position: 2 },
    ]);

    // Release A into col-todo's container (over a card-less area of its column).
    await dragEnd({
      activeId: 'card-a',
      overId: 'column:col-todo',
      activeRect: rect(40, 100),
      overRect: rect(0, 600),
    });

    expect(api.moveCard).not.toHaveBeenCalled();
  });

  it('gates a blocked-card cross-column drop behind the confirm dialog', async () => {
    await renderBoard(
      [
        {
          id: 'card-a',
          title: 'Blocked card',
          column_id: 'col-todo',
          position: 0,
          blockers: [{ id: 'blk-1', title: 'Blocker', done: false }],
        },
        { id: 'card-t', title: 'Target card', column_id: 'col-progress', position: 0 },
      ],
      [
        { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
        { id: 'col-progress', name: 'In Progress', color: '#22c55e', position: 1 },
      ],
    );

    await dragEnd({
      activeId: 'card-a',
      overId: 'card-t',
      activeRect: rect(0, 100),
      overRect: rect(0, 100),
    });

    // Confirm dialog appears; nothing persisted yet.
    const confirm = await screen.findByTestId('confirm-move-dialog');
    expect(api.moveCard).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: /Move anyway/i }));
    await waitFor(() =>
      expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-a', {
        columnId: 'col-progress',
        position: 0,
      }),
    );
  });

  it('onDragStart selects the active card so the DragOverlay clone renders', async () => {
    await renderBoard([{ id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 }]);

    // Before a drag, the overlay is empty.
    expect(within(screen.getByTestId('drag-overlay')).queryByText('Card A')).toBeNull();

    await act(async () => {
      dnd.handlers.onDragStart({ active: { id: 'card-a' } });
    });

    // The floating clone now mirrors the dragged card.
    expect(within(screen.getByTestId('drag-overlay')).getByText('Card A')).toBeInTheDocument();
  });
});
