import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
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
    getModelConfig: vi.fn().mockResolvedValue({
      defaultModel: 'claude-opus-4-7',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-7', 'claude-sonnet-4-20250514'] },
    }),
    moveCard: vi.fn(),
    updateCard: vi.fn(),
    deleteCard: vi.fn(),
    addCardComment: vi.fn(),
    linkCardToEpic: vi.fn(),
    assignCard: vi.fn(),
  },
}));

// HTML5 drag-and-drop relies on a DataTransfer object. jsdom doesn't provide
// one that `setData` / `getData` correctly round-trip on, so we fake one that
// both handlers share across the whole drag sequence.
const makeDataTransfer = () => {
  const store = {};
  return {
    setData: (k, v) => {
      store[k] = v;
    },
    getData: (k) => store[k] || '',
    effectAllowed: '',
    dropEffect: '',
  };
};

// Give each draggable card a deterministic bounding rect so
// `handleCardDragOver` can compute top/bottom half from `clientY`.
const stubCardRect = (el, top, height = 100) => {
  el.getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    left: 0,
    right: 200,
    width: 200,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
};

// jsdom + testing-library don't round-trip `clientY` on synthetic drag events.
// Dispatch the event manually with a defineProperty-set clientY so the
// component's drag handlers can read it.
const fireDragEventWithY = (element, type, { dataTransfer, clientY }) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
  Object.defineProperty(event, 'clientY', { value: clientY, configurable: true });
  act(() => {
    element.dispatchEvent(event);
  });
};

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

    // Read mode: description is rendered as markdown, not a raw textarea.
    expect(within(modal).getByTestId('card-description-preview')).toBeInTheDocument();
    expect(within(modal).queryByTestId('card-description-editor')).not.toBeInTheDocument();

    fireEvent.click(within(modal).getByRole('button', { name: /^Edit$/i }));
    const description = within(modal).getByTestId('card-description-editor');
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

  it('renders card description as markdown in read mode and updates preview after edit', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-md',
          title: 'Markdown card',
          description: '## Problem\n\n- One\n- Two',
          column_id: 'col-todo',
          position: 0,
        },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Markdown card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Markdown card'));
    const modal = await screen.findByTestId('card-detail-modal');
    const preview = within(modal).getByTestId('card-description-preview');
    expect(preview.querySelector('h2')).not.toBeNull();
    expect(preview.querySelector('h2')?.textContent).toMatch(/Problem/i);
    expect(preview.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);

    fireEvent.click(within(modal).getByRole('button', { name: /^Edit$/i }));
    const editor = within(modal).getByTestId('card-description-editor');
    fireEvent.change(editor, {
      target: { value: '## Updated title\n\n[Example](https://example.com/path)' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: /^Preview$/i }));
    const preview2 = within(modal).getByTestId('card-description-preview');
    expect(preview2.querySelector('h2')?.textContent).toMatch(/Updated title/i);
    expect(preview2.querySelector('a')?.getAttribute('href')).toBe('https://example.com/path');
  });
});

describe('KanbanBoard reassign active session', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.getCardComments.mockReset();
    api.getModelConfig.mockReset();
    api.assignCard.mockReset();
    api.get.mockResolvedValue([
      { id: 'agent-a', name: 'AgentA' },
      { id: 'agent-b', name: 'AgentB' },
    ]);
    api.getCardComments.mockResolvedValue([]);
    api.getModelConfig.mockResolvedValue({
      defaultModel: 'claude-opus-4-7',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-7' },
      engineValidModels: { 'claude-code': ['claude-opus-4-7', 'claude-sonnet-4-20250514'] },
    });
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
          { id: 'agent-a', name: 'AgentA', engine: 'claude-code' },
          { id: 'agent-b', name: 'AgentB', engine: 'claude-code' },
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
    await waitFor(() => expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-b', {}));
  });

  it('passes model to assignCard when Session model override is chosen', async () => {
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
          { id: 'agent-a', name: 'AgentA', engine: 'claude-code' },
          { id: 'agent-b', name: 'AgentB', engine: 'claude-code' },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Assigned card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Assigned card'));
    const modal = await screen.findByTestId('card-detail-modal');
    fireEvent.click(within(modal).getByRole('button', { name: /^Reassign$/i }));

    const combos = within(modal).getAllByRole('combobox');
    const assigneeSelect = combos.find((c) =>
      Array.from(c.options).some((o) => o.textContent === 'Unassigned'),
    );
    fireEvent.change(assigneeSelect, { target: { value: 'AgentB' } });

    const modelSelect = combos.find((c) =>
      Array.from(c.options).some((o) => o.textContent === 'Agent default'),
    );
    expect(modelSelect).toBeDefined();
    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-20250514' } });

    api.assignCard.mockResolvedValueOnce({ sessionId: 'sess-2' });
    fireEvent.click(within(modal).getByRole('button', { name: /Reassign & Start/i }));
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-b', {
        model: 'claude-sonnet-4-20250514',
      }),
    );
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
          { id: 'agent-a', name: 'AgentA', engine: 'claude-code' },
          { id: 'agent-b', name: 'AgentB', engine: 'claude-code' },
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

describe('KanbanBoard drag-and-drop', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.getCardComments.mockReset();
    api.moveCard.mockReset();
    api.get.mockResolvedValue([]);
    api.getCardComments.mockResolvedValue([]);
    api.moveCard.mockResolvedValue({});
  });

  // Grab the *outer* draggable container for a card by its rendered title.
  // KanbanBoard wraps every card in a non-draggable wrapper and nests the
  // draggable div inside — `getByText(title).closest('[draggable]')` finds
  // that nested div.
  const draggableFor = (title) => screen.getByText(title).closest('[draggable]');

  it('reorders within the same column when dropping on the top half of another card', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        { id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 },
        { id: 'card-b', title: 'Card B', column_id: 'col-todo', position: 1 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());

    const cardA = draggableFor('Card A');
    const cardB = draggableFor('Card B');
    stubCardRect(cardA, 0);
    stubCardRect(cardB, 100);

    const dt = makeDataTransfer();
    fireDragEventWithY(cardB, 'dragstart', { dataTransfer: dt, clientY: 110 });
    // Drop on Card A's top half — B should land at position 0.
    fireDragEventWithY(cardA, 'dragover', { dataTransfer: dt, clientY: 10 });
    fireDragEventWithY(cardA, 'drop', { dataTransfer: dt, clientY: 10 });

    await waitFor(() => expect(api.moveCard).toHaveBeenCalledTimes(2));

    // Card B should be moved to position 0 in col-todo.
    expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-b', {
      columnId: 'col-todo',
      position: 0,
    });
    // Card A should be pushed down to position 1.
    expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-a', {
      columnId: 'col-todo',
      position: 1,
    });

    // Optimistic DOM update: Card B is now rendered before Card A.
    await waitFor(() => {
      const titles = screen.getAllByText(/^Card [AB]$/).map((n) => n.textContent);
      expect(titles).toEqual(['Card B', 'Card A']);
    });
  });

  it('cross-column drop on the top half of a card inserts at that index (not appended)', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        { id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 },
        { id: 'card-b', title: 'Card B', column_id: 'col-done', position: 0 },
        { id: 'card-c', title: 'Card C', column_id: 'col-done', position: 1 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card C')).toBeInTheDocument());

    const cardA = draggableFor('Card A');
    const cardC = draggableFor('Card C');
    stubCardRect(cardA, 0);
    stubCardRect(cardC, 100);

    const dt = makeDataTransfer();
    fireDragEventWithY(cardA, 'dragstart', { dataTransfer: dt, clientY: 10 });
    // Drop on Card C's top half → A should land at index 1 in col-done
    // (between B and C), not appended to the end.
    fireDragEventWithY(cardC, 'dragover', { dataTransfer: dt, clientY: 110 });
    fireDragEventWithY(cardC, 'drop', { dataTransfer: dt, clientY: 110 });

    await waitFor(() => expect(api.moveCard).toHaveBeenCalled());

    // Card A moves to col-done at position 1 (between B@0 and C@2).
    expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-a', {
      columnId: 'col-done',
      position: 1,
    });
    // Card C is pushed down to position 2.
    expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-c', {
      columnId: 'col-done',
      position: 2,
    });
    // Card B stays at position 0 — no call needed for it.
    const bCalls = api.moveCard.mock.calls.filter((args) => args[1] === 'card-b');
    expect(bCalls).toEqual([]);
  });

  it('keeps the blocker-warn confirm dialog working for cross-column moves', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-a',
          title: 'Blocked card',
          column_id: 'col-todo',
          position: 0,
          blockers: [{ id: 'blk-1', title: 'Blocker', done: false }],
        },
        { id: 'card-b', title: 'Other card', column_id: 'col-todo', position: 1 },
      ]),
    );
    // Rename the second column to something blocker-sensitive so the
    // confirm dialog fires. (Default "Done" is exempt.)
    api.getBoard.mockResolvedValue({
      board: { id: 'b1' },
      columns: [
        { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
        { id: 'col-progress', name: 'In Progress', color: '#22c55e', position: 1 },
      ],
      cards: [
        {
          id: 'card-a',
          title: 'Blocked card',
          column_id: 'col-todo',
          position: 0,
          blockers: [{ id: 'blk-1', title: 'Blocker', done: false }],
        },
        { id: 'card-target', title: 'Landing card', column_id: 'col-progress', position: 0 },
      ],
      epics: [],
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Blocked card')).toBeInTheDocument());

    const cardA = draggableFor('Blocked card');
    const cardTarget = draggableFor('Landing card');
    stubCardRect(cardA, 0);
    stubCardRect(cardTarget, 0);

    const dt = makeDataTransfer();
    fireDragEventWithY(cardA, 'dragstart', { dataTransfer: dt, clientY: 10 });
    fireDragEventWithY(cardTarget, 'dragover', { dataTransfer: dt, clientY: 10 });
    fireDragEventWithY(cardTarget, 'drop', { dataTransfer: dt, clientY: 10 });

    // Confirm dialog appears; moveCard should NOT have fired yet.
    const confirm = await screen.findByTestId('confirm-move-dialog');
    expect(confirm).toBeInTheDocument();
    expect(api.moveCard).not.toHaveBeenCalled();

    // Click "Move anyway" to commit the move.
    fireEvent.click(within(confirm).getByRole('button', { name: /Move anyway/i }));
    await waitFor(() => expect(api.moveCard).toHaveBeenCalled());
    expect(api.moveCard).toHaveBeenCalledWith('p1', 'card-a', {
      columnId: 'col-progress',
      position: 0,
    });
  });
});
