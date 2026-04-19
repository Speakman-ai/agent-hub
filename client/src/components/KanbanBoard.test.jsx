import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import KanbanBoard from './KanbanBoard.jsx';
import { api } from '../utils/api.js';

/**
 * KanbanBoard — background refresh should NOT flash the "Loading board…"
 * screen.
 *
 * When a WebSocket event (card_moved, kanban_update, card_comment) arrives,
 * App.jsx bumps `refreshKey`. The board should silently re-fetch in the
 * background and update the card list in place — it must NOT toggle
 * `loading=true`, because that wipes the UI back to the loading spinner and
 * feels like a full page reload.
 *
 * The initial mount / project switch is the only case where the loading
 * spinner is acceptable.
 */

vi.mock('../utils/api.js', () => ({
  api: {
    getBoard: vi.fn(),
    get: vi.fn(),
    getCardComments: vi.fn(),
    moveCard: vi.fn(),
    updateCard: vi.fn(),
    deleteCard: vi.fn(),
    addCardComment: vi.fn(),
    linkCardToEpic: vi.fn(),
    assignCard: vi.fn(),
  },
}));

const makeBoard = (cards = []) => ({
  board: { id: 'b1' },
  columns: [
    { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
    { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
  ],
  cards,
  epics: [],
});

describe('KanbanBoard background refresh', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.get.mockResolvedValue([]);
  });

  it('shows "Loading board..." on initial mount, then renders the board', async () => {
    api.getBoard.mockResolvedValueOnce(
      makeBoard([{ id: 1, title: 'First card', column_id: 'col-todo', position: 0 }]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);

    expect(screen.getByText(/Loading board/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('First card')).toBeInTheDocument());
    expect(screen.queryByText(/Loading board/i)).not.toBeInTheDocument();
  });

  it('does NOT flash the loading screen when refreshKey bumps (WebSocket refresh)', async () => {
    api.getBoard.mockResolvedValueOnce(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );

    const { rerender } = render(
      <KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />,
    );
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());

    // Simulate a WebSocket-triggered refresh: parent bumps refreshKey with
    // an updated board payload (e.g. the card has moved columns on the
    // server after another client edited it).
    api.getBoard.mockResolvedValueOnce(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-done', position: 0 }]),
    );

    rerender(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={1} />);

    // Critical assertion: the loading spinner must NOT appear at any point
    // during the background refresh. The previous card state stays on
    // screen until the new data resolves.
    expect(screen.queryByText(/Loading board/i)).not.toBeInTheDocument();
    expect(screen.getByText('Card A')).toBeInTheDocument();

    // And fetchBoard was called again for the refresh.
    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(2));
  });
});

describe('KanbanBoard card detail modal', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.getCardComments.mockReset();
    api.get.mockResolvedValue([]);
    api.getCardComments.mockResolvedValue([]);
  });

  it('renders the card detail as a centered modal with sidebar metadata (not a right slide-over)', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-1',
          title: 'A big card',
          description: 'Some description',
          column_id: 'col-todo',
          position: 0,
          priority: 'high',
        },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('A big card')).toBeInTheDocument());

    // Open the card detail
    fireEvent.click(screen.getByText('A big card'));

    // Modal is rendered and uses a centered-modal layout, not a right slide-over.
    const modal = await screen.findByTestId('card-detail-modal');
    expect(modal.className).toMatch(/items-center/);
    expect(modal.className).toMatch(/justify-center/);
    expect(modal.className).not.toMatch(/justify-end/);

    // The description textarea has a larger row count than the old (rows=4).
    const description = within(modal).getByPlaceholderText(/add a description/i);
    expect(description.tagName).toBe('TEXTAREA');
    expect(Number(description.getAttribute('rows'))).toBeGreaterThanOrEqual(10);

    // Sidebar contains the metadata labels.
    expect(within(modal).getByText(/^Priority$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Assignee$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Epic$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Labels$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/GitHub Issue URL/i)).toBeInTheDocument();
    expect(within(modal).getByText(/Pull Request/i)).toBeInTheDocument();
  });
});

describe('KanbanBoard drag reorder', () => {
  // jsdom 29 has no DragEvent — fireEvent.dragOver falls back to plain
  // Event, which drops clientY. Build MouseEvents manually so the per-card
  // dragover handler can compute the insertion midpoint.
  const makeDataTransfer = () => {
    const store = new Map();
    return {
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: (k, v) => store.set(k, String(v)),
      getData: (k) => store.get(k) || '',
    };
  };

  const dragMouseEvent = (type, { clientY, dataTransfer }) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
    if (dataTransfer) {
      Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, writable: false });
    }
    return ev;
  };

  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.getCardComments.mockReset();
    api.moveCard.mockReset();
    api.get.mockResolvedValue([]);
    api.getCardComments.mockResolvedValue([]);
    api.moveCard.mockResolvedValue({});
  });

  it('reorders a card within the same column and renumbers affected siblings', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        { id: 'c1', title: 'Card One', column_id: 'col-todo', position: 0 },
        { id: 'c2', title: 'Card Two', column_id: 'col-todo', position: 1 },
        { id: 'c3', title: 'Card Three', column_id: 'col-todo', position: 2 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card One')).toBeInTheDocument());

    const dt = makeDataTransfer();
    const sourceCardEl = screen.getByTestId('card-row-c1').querySelector('[draggable="true"]');
    const targetCardEl = screen.getByTestId('card-row-c3').querySelector('[draggable="true"]');

    // Drag c1 to the bottom half of c3 → insert after c3 → end of column.
    fireEvent.dragStart(sourceCardEl, { dataTransfer: dt });
    // Mock getBoundingClientRect so the midpoint check picks "after".
    targetCardEl.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent(targetCardEl, dragMouseEvent('dragover', { clientY: 90, dataTransfer: dt }));
    fireEvent(targetCardEl, dragMouseEvent('drop', { clientY: 90, dataTransfer: dt }));

    // Expected new dense order: [c2=0, c3=1, c1=2]. The dropped card's old
    // position (0) was the start of the renumbered range, so c2 and c3 also
    // shift down by one. All three changes must persist so reload preserves
    // the new ordinal — no duplicate/stale position values left behind.
    await waitFor(() => expect(api.moveCard).toHaveBeenCalled());
    const calls = api.moveCard.mock.calls.map(([projId, id, body]) => ({ projId, id, ...body }));
    expect(calls.find((c) => c.id === 'c1')).toEqual({
      projId: 'p1',
      id: 'c1',
      columnId: 'col-todo',
      position: 2,
    });
    expect(calls.find((c) => c.id === 'c2')).toEqual({
      projId: 'p1',
      id: 'c2',
      columnId: 'col-todo',
      position: 0,
    });
    expect(calls.find((c) => c.id === 'c3')).toEqual({
      projId: 'p1',
      id: 'c3',
      columnId: 'col-todo',
      position: 1,
    });
    // Renumbered positions must be unique within the column.
    const todoPositions = calls
      .filter((c) => c.columnId === 'col-todo')
      .map((c) => c.position)
      .sort();
    expect(new Set(todoPositions).size).toBe(todoPositions.length);
  });

  it('reorders a middle card down by one slot (regression: no-op short-circuit must not swallow real moves)', async () => {
    // Reproducer for the review finding on PR #432: the original no-op
    // check used `currentIdx === targetIndex - 1`, which mixed two
    // coordinate spaces and silently dropped any "move down by one"
    // reorder. Concretely: in [c1, c2, c3], dragging c1 onto the top half
    // of c3 should yield [c2, c1, c3].
    api.getBoard.mockResolvedValue(
      makeBoard([
        { id: 'c1', title: 'Card One', column_id: 'col-todo', position: 0 },
        { id: 'c2', title: 'Card Two', column_id: 'col-todo', position: 1 },
        { id: 'c3', title: 'Card Three', column_id: 'col-todo', position: 2 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card One')).toBeInTheDocument());

    const dt = makeDataTransfer();
    const sourceCardEl = screen.getByTestId('card-row-c1').querySelector('[draggable="true"]');
    const targetCardEl = screen.getByTestId('card-row-c3').querySelector('[draggable="true"]');

    fireEvent.dragStart(sourceCardEl, { dataTransfer: dt });
    targetCardEl.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    // clientY=10 → top half of c3 → insert before c3 → targetIndex=1.
    fireEvent(targetCardEl, dragMouseEvent('dragover', { clientY: 10, dataTransfer: dt }));
    fireEvent(targetCardEl, dragMouseEvent('drop', { clientY: 10, dataTransfer: dt }));

    // Expected new dense order: [c2=0, c1=1, c3=2].
    await waitFor(() => expect(api.moveCard).toHaveBeenCalled());
    const calls = api.moveCard.mock.calls.map(([, id, body]) => ({ id, ...body }));
    expect(calls.find((c) => c.id === 'c1')).toEqual({
      id: 'c1',
      columnId: 'col-todo',
      position: 1,
    });
    expect(calls.find((c) => c.id === 'c2')).toEqual({
      id: 'c2',
      columnId: 'col-todo',
      position: 0,
    });
    // c3 stays at position 2 → no API write.
    expect(calls.find((c) => c.id === 'c3')).toBeUndefined();
  });

  it('drops a card at a precise index when crossing columns (not always appended)', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        { id: 'a1', title: 'Alpha', column_id: 'col-todo', position: 0 },
        { id: 'b1', title: 'Bravo', column_id: 'col-done', position: 0 },
        { id: 'b2', title: 'Bravo Two', column_id: 'col-done', position: 1 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    const dt = makeDataTransfer();
    const sourceCardEl = screen.getByTestId('card-row-a1').querySelector('[draggable="true"]');
    const targetCardEl = screen.getByTestId('card-row-b2').querySelector('[draggable="true"]');

    fireEvent.dragStart(sourceCardEl, { dataTransfer: dt });
    // Top half of b2 → insert before b2 → index 1 in col-done.
    targetCardEl.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent(targetCardEl, dragMouseEvent('dragover', { clientY: 10, dataTransfer: dt }));
    // Drop indicator should appear before b2.
    expect(screen.getByTestId('drop-indicator-before-b2')).toBeInTheDocument();
    fireEvent(targetCardEl, dragMouseEvent('drop', { clientY: 10, dataTransfer: dt }));

    // Expected new order in col-done: [b1, a1, b2] → positions 0,1,2.
    // a1 moves to col-done position 1; b2 moves from 1→2; b1 stays.
    await waitFor(() => expect(api.moveCard).toHaveBeenCalled());
    const calls = api.moveCard.mock.calls.map(([, id, body]) => ({ id, ...body }));
    expect(calls.find((c) => c.id === 'a1')).toEqual({
      id: 'a1',
      columnId: 'col-done',
      position: 1,
    });
    expect(calls.find((c) => c.id === 'b2')).toEqual({
      id: 'b2',
      columnId: 'col-done',
      position: 2,
    });
    expect(calls.find((c) => c.id === 'b1')).toBeUndefined();
  });

  it('moves a card down by one slot within the same column (not a no-op)', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        { id: 'c1', title: 'Card One', column_id: 'col-todo', position: 0 },
        { id: 'c2', title: 'Card Two', column_id: 'col-todo', position: 1 },
        { id: 'c3', title: 'Card Three', column_id: 'col-todo', position: 2 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card One')).toBeInTheDocument());

    const dt = makeDataTransfer();
    const sourceCardEl = screen.getByTestId('card-row-c1').querySelector('[draggable="true"]');
    const targetCardEl = screen.getByTestId('card-row-c2').querySelector('[draggable="true"]');

    // Drag c1 to the bottom half of c2 → insert after c2 → before c3.
    fireEvent.dragStart(sourceCardEl, { dataTransfer: dt });
    targetCardEl.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent(targetCardEl, dragMouseEvent('dragover', { clientY: 90, dataTransfer: dt }));
    fireEvent(targetCardEl, dragMouseEvent('drop', { clientY: 90, dataTransfer: dt }));

    // Expected new order: [c2=0, c1=1, c3=2]. This must NOT be treated as a
    // no-op — the old code's `currentIdx === targetIndex - 1` clause would
    // have incorrectly short-circuited here (currentIdx=0, targetIndex=1).
    await waitFor(() => expect(api.moveCard).toHaveBeenCalled());
    const calls = api.moveCard.mock.calls.map(([, id, body]) => ({ id, ...body }));
    expect(calls.find((c) => c.id === 'c1')).toEqual({
      id: 'c1',
      columnId: 'col-todo',
      position: 1,
    });
    expect(calls.find((c) => c.id === 'c2')).toEqual({
      id: 'c2',
      columnId: 'col-todo',
      position: 0,
    });
  });
});

describe('KanbanBoard reassign active session', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.getCardComments.mockReset();
    api.assignCard.mockReset();
    api.get.mockResolvedValue([
      { id: 'agent-a', name: 'AgentA' },
      { id: 'agent-b', name: 'AgentB' },
    ]);
    api.getCardComments.mockResolvedValue([]);
  });

  it('shows a Reassign button when the card has an active session, and reveals the agent picker on click', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-1',
          title: 'Assigned card',
          column_id: 'col-todo',
          position: 0,
          assignee: 'AgentA',
          session_id: 'sess-1',
        },
      ]),
    );

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[
          { id: 'agent-a', name: 'AgentA' },
          { id: 'agent-b', name: 'AgentB' },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Assigned card')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Assigned card'));
    const modal = await screen.findByTestId('card-detail-modal');

    // Initial state: "Session active" badge + Open Session + Reassign button.
    expect(within(modal).getByText(/Session active/i)).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: /Open Session/i })).toBeInTheDocument();

    const reassignBtn = within(modal).getByRole('button', { name: /^Reassign$/i });
    expect(reassignBtn).toBeInTheDocument();

    // Clicking Reassign reveals the agent dropdown + cancel button.
    fireEvent.click(reassignBtn);

    // There are multiple selects (Priority, Assignee, Epic); pick the one
    // that contains the "Unassigned" option.
    const combos = within(modal).getAllByRole('combobox');
    const assigneeSelect = combos.find((c) =>
      Array.from(c.options).some((o) => o.textContent === 'Unassigned'),
    );
    expect(assigneeSelect).toBeDefined();
    expect(within(modal).getByRole('button', { name: /Cancel/i })).toBeInTheDocument();

    // Picking a different agent shows "Reassign & Start" (not "Assign & Start").
    fireEvent.change(assigneeSelect, { target: { value: 'AgentB' } });
    expect(within(modal).getByRole('button', { name: /Reassign & Start/i })).toBeInTheDocument();

    // Clicking it fires the assignCard API with the new agent id.
    api.assignCard.mockResolvedValueOnce({ sessionId: 'sess-2' });
    fireEvent.click(within(modal).getByRole('button', { name: /Reassign & Start/i }));
    await waitFor(() => expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-b'));
  });

  it('Cancel returns to the Open Session view without calling assignCard', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-1',
          title: 'Assigned card',
          column_id: 'col-todo',
          position: 0,
          assignee: 'AgentA',
          session_id: 'sess-1',
        },
      ]),
    );

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[
          { id: 'agent-a', name: 'AgentA' },
          { id: 'agent-b', name: 'AgentB' },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Assigned card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Assigned card'));
    const modal = await screen.findByTestId('card-detail-modal');

    fireEvent.click(within(modal).getByRole('button', { name: /^Reassign$/i }));
    fireEvent.click(within(modal).getByRole('button', { name: /Cancel/i }));

    // Back to the session-active view.
    expect(within(modal).getByText(/Session active/i)).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: /Open Session/i })).toBeInTheDocument();
    expect(api.assignCard).not.toHaveBeenCalled();
  });
});
