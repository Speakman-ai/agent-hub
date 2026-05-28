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
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-20250514'] },
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

  it('does NOT render the card description on the board (board card shows title + chips only)', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-desc',
          title: 'Card with description',
          description: 'This description should NOT appear on the board card.',
          column_id: 'col-todo',
          position: 0,
        },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card with description')).toBeInTheDocument());

    expect(screen.queryByTestId('card-description-snippet')).not.toBeInTheDocument();
    expect(
      screen.queryByText('This description should NOT appear on the board card.'),
    ).not.toBeInTheDocument();
  });

  it('renders markdown images in the card detail preview when the card is opened', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-img',
          title: 'Photo card',
          description: 'Context\n\n![diagram](https://example.com/diagram.png)',
          column_id: 'col-todo',
          position: 0,
        },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Photo card')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Photo card'));
    const modal = await screen.findByTestId('card-detail-modal');
    const preview = within(modal).getByTestId('card-description-preview');
    const imgInModal = within(preview).getByRole('img', { name: 'diagram' });
    expect(imgInModal.getAttribute('src')).toBe('https://example.com/diagram.png');
  });

  it('resolves /uploads/ image paths in card markdown like chat', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-up',
          title: 'Upload card',
          description: '![shot](/uploads/abc/photo.png)',
          column_id: 'col-todo',
          position: 0,
        },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Upload card')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Upload card'));
    const modal = await screen.findByTestId('card-detail-modal');
    const preview = within(modal).getByTestId('card-description-preview');
    const img = within(preview).getByRole('img', { name: 'shot' });
    expect(img.getAttribute('src')).toBe('/uploads/abc/photo.png');
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
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-20250514'] },
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

    const modelSelect = await within(modal).findByTestId('card-model-select-new');
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

  it('shows Session model dropdown in assigned/active state and "Save model override" on change', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-1',
          title: 'Active card',
          column_id: 'col-todo',
          position: 0,
          assignee: 'AgentA',
          session_id: 'sess-1',
          assign_model: 'claude-opus-4-8',
        },
      ]),
    );
    api.updateCard.mockResolvedValue({});

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Active card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Active card'));
    const modal = await screen.findByTestId('card-detail-modal');

    // The Session model dropdown should be visible without clicking Reassign.
    const modelSelect = await within(modal).findByTestId('card-model-select');
    // Current value should match card's assign_model.
    expect(modelSelect.value).toBe('claude-opus-4-8');

    // "Save override" button should NOT appear yet (no change).
    expect(within(modal).queryByRole('button', { name: /Save override/i })).toBeNull();

    // Change to a different model.
    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-20250514' } });

    // "Save override" button should now appear.
    const saveBtn = await within(modal).findByRole('button', { name: /Save override/i });
    expect(saveBtn).toBeInTheDocument();

    // Click save — should call updateCard with the new model. The engine
    // override is unchanged (null on both sides) so it still goes in the
    // payload as null — same diff as before the engine selector shipped.
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', {
        assign_model: 'claude-sonnet-4-20250514',
        assign_engine: null,
      }),
    );
  });

  it('can clear model override back to Agent default from session-active view', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-1',
          title: 'Active card',
          column_id: 'col-todo',
          position: 0,
          assignee: 'AgentA',
          session_id: 'sess-1',
          assign_model: 'claude-sonnet-4-20250514',
        },
      ]),
    );
    api.updateCard.mockResolvedValue({});

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Active card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Active card'));
    const modal = await screen.findByTestId('card-detail-modal');

    const modelSelect = await within(modal).findByTestId('card-model-select');

    // Clear the model override by selecting "Engine default" (empty value).
    fireEvent.change(modelSelect, { target: { value: '' } });

    const saveBtn = await within(modal).findByRole('button', { name: /Save override/i });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', {
        assign_model: null,
        assign_engine: null,
      }),
    );
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

describe('KanbanBoard Session engine dropdown', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.getCardComments.mockReset();
    api.getModelConfig.mockReset();
    api.assignCard.mockReset();
    api.updateCard.mockReset();
    api.get.mockResolvedValue([]);
    api.getCardComments.mockResolvedValue([]);
    // Multi-engine config so the engine selector has > 1 option.
    api.getModelConfig.mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8', 'codex-cli': 'gpt-5.3-codex' },
      engineValidModels: {
        'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-20250514'],
        'codex-cli': ['gpt-5.3-codex', 'gpt-5.4'],
      },
    });
  });

  it('passes both engine + model to assignCard when an unassigned card is started cross-engine', async () => {
    // Card has no session yet → the picker shows the assignee dropdown +
    // engine selector + model selector. Pick a claude-code agent but
    // override the engine to codex-cli and the model to a codex model.
    // Both must be sent to api.assignCard.
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-1',
          title: 'Unassigned card',
          column_id: 'col-todo',
          position: 0,
        },
      ]),
    );

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Unassigned card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Unassigned card'));
    const modal = await screen.findByTestId('card-detail-modal');

    // Pick assignee — engine + model selectors should render.
    const initialCombos = within(modal).getAllByRole('combobox');
    const assigneeSelect = initialCombos.find((c) =>
      Array.from(c.options).some((o) => o.textContent === 'Unassigned'),
    );
    fireEvent.change(assigneeSelect, { target: { value: 'AgentA' } });

    // The engine dropdown carries a `data-testid` so it's unambiguous.
    const engineSelect = await within(modal).findByTestId('card-engine-select-new');
    expect(engineSelect).toBeDefined();
    expect(
      Array.from(engineSelect.options)
        .map((o) => o.value)
        .filter(Boolean),
    ).toEqual(expect.arrayContaining(['claude-code', 'codex-cli']));

    // Switch engine to codex-cli — the model dropdown must repopulate with
    // codex models AND must NOT carry over a stale claude-code model.
    fireEvent.change(engineSelect, { target: { value: 'codex-cli' } });

    const modelSelect = await within(modal).findByTestId('card-model-select-new');
    expect(
      Array.from(modelSelect.options)
        .map((o) => o.value)
        .filter(Boolean),
    ).toEqual(expect.arrayContaining(['gpt-5.3-codex', 'gpt-5.4']));
    fireEvent.change(modelSelect, { target: { value: 'gpt-5.3-codex' } });

    api.assignCard.mockResolvedValueOnce({ sessionId: 'sess-x' });
    fireEvent.click(within(modal).getByRole('button', { name: /Assign & Start/i }));
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-a', {
        model: 'gpt-5.3-codex',
        engine: 'codex-cli',
      }),
    );
  });

  it('PUT updateCard includes both assign_engine + assign_model on an active card', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-1',
          title: 'Active card',
          column_id: 'col-todo',
          position: 0,
          assignee: 'AgentA',
          session_id: 'sess-1',
          assign_model: null,
          assign_engine: null,
        },
      ]),
    );
    api.updateCard.mockResolvedValue({});

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Active card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Active card'));
    const modal = await screen.findByTestId('card-detail-modal');

    // The active-state engine dropdown carries its own test id.
    const engineSelect = await within(modal).findByTestId('card-engine-select');
    fireEvent.change(engineSelect, { target: { value: 'codex-cli' } });

    const modelSelect = await within(modal).findByTestId('card-model-select');
    fireEvent.change(modelSelect, { target: { value: 'gpt-5.3-codex' } });

    const saveBtn = await within(modal).findByRole('button', { name: /Save override/i });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', {
        assign_engine: 'codex-cli',
        assign_model: 'gpt-5.3-codex',
      }),
    );
  });
});

describe('KanbanBoard PR & reviews strip', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.get.mockResolvedValue([]);
    api.getModelConfig.mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
  });

  it('refetches /reviews when the PR & reviews panel is opened', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([{ id: 1, title: 'Card C', column_id: 'col-todo', position: 0 }]),
    );
    const reviewLog = {
      id: 'l1',
      event_kind: 'pr_created',
      pr_title: 'Fresh from server',
      pr_url: 'https://github.com/o/r/pull/9',
      author_agent: 'agent',
      completed_at: new Date().toISOString(),
    };
    api.get.mockImplementation((path) => {
      if (String(path).includes('/reviews')) {
        return Promise.resolve([reviewLog]);
      }
      return Promise.resolve([]);
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card C')).toBeInTheDocument());

    const reviewCallsBefore = api.get.mock.calls.filter((c) =>
      String(c[0]).includes('/reviews'),
    ).length;

    fireEvent.click(screen.getByRole('button', { name: /PR & reviews/i }));

    await waitFor(() => {
      const n = api.get.mock.calls.filter((c) => String(c[0]).includes('/reviews')).length;
      expect(n).toBeGreaterThan(reviewCallsBefore);
    });
    await screen.findByText(/Fresh from server/i);
  });
});
