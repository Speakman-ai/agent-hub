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
    getColumnCards: vi.fn(),
    get: vi.fn(),
    getCardComments: vi.fn(),
    // Opening a card resolves its (optional) session replay. Default to "none"
    // (404) so the "Watch replay" CTA stays hidden in tests that don't care.
    getCardReplay: vi.fn().mockRejectedValue(new Error('404: No replay for card')),
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
    unassignCard: vi.fn(),
    updateEpic: vi.fn().mockResolvedValue({}),
    // Cards now render <FinalizeCardBadge /> which calls this on mount
    // whenever the card has a session_id. Mocked to "no run" so the badge
    // is invisible in kanban-flow tests that don't care about finalize.
    getLatestFinalizeRunForSession: vi.fn().mockResolvedValue({ run: null }),
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

  it('shows a "Watch replay" CTA on a card that has an attributed replay and opens the player', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-replay',
          title: 'Converted bug card',
          description: 'Converted from a bug ticket',
          column_id: 'col-todo',
          position: 0,
          priority: 'high',
        },
      ]),
    );
    api.getCardReplay.mockResolvedValueOnce({
      replayId: 'replay-xyz',
      durationMs: 5000,
      eventCount: 9,
      createdAt: '2026-06-14 10:00:00',
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Converted bug card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Converted bug card'));

    const modal = await screen.findByTestId('card-detail-modal');
    const watchBtn = await within(modal).findByTestId('card-watch-replay-button');
    expect(watchBtn).toBeInTheDocument();
    expect(api.getCardReplay).toHaveBeenCalledWith('p1', 'card-replay');

    // Clicking it mounts the sandboxed player.
    fireEvent.click(watchBtn);
    const iframe = await screen.findByTestId('replay-player-iframe');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
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

  it('renders an orphaned badge on a card whose working session was closed', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-orphan',
          title: 'Orphaned card',
          column_id: 'col-todo',
          position: 0,
          orphaned_at: '2026-06-19 20:00:00',
        },
        {
          id: 'card-live',
          title: 'Live card',
          column_id: 'col-todo',
          position: 1,
          orphaned_at: null,
        },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Orphaned card')).toBeInTheDocument());

    // Exactly one badge — only the orphaned card carries it.
    expect(screen.getAllByTestId('card-orphaned-badge')).toHaveLength(1);
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
          { id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' },
          { id: 'agent-b', name: 'AgentB', engine: 'claude-code', projectId: 'p1' },
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
    // The card has no explicit auto_merge preference, so the assign omits the
    // field — letting the server fall back to the project auto-merge default.
    await waitFor(() => expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-b', {}));
  });

  it('only offers agents from the current project in the assign dropdown', async () => {
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
        agents={[
          { id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' },
          // Belongs to a different project — must NOT appear in this board's picker.
          { id: 'agent-z', name: 'AgentZ', engine: 'claude-code', projectId: 'other' },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Unassigned card')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Unassigned card'));
    const modal = await screen.findByTestId('card-detail-modal');

    const combos = within(modal).getAllByRole('combobox');
    const assigneeSelect = combos.find((c) =>
      Array.from(c.options).some((o) => o.textContent === 'Unassigned'),
    );
    expect(assigneeSelect).toBeDefined();

    const optionNames = Array.from(assigneeSelect.options).map((o) => o.textContent);
    expect(optionNames).toContain('AgentA');
    expect(optionNames).not.toContain('AgentZ');
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
          { id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' },
          { id: 'agent-b', name: 'AgentB', engine: 'claude-code', projectId: 'p1' },
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
          { id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' },
          { id: 'agent-b', name: 'AgentB', engine: 'claude-code', projectId: 'p1' },
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
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
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
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
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

describe('KanbanBoard drag-and-drop (@dnd-kit)', () => {
  // The reorder / cross-column / drop-target math is unit-tested directly in
  // utils/kanbanReorder.test.js. The full pointer + keyboard drag *gesture*
  // (sensor activation, collision detection, DragOverlay) is exercised in the
  // Playwright e2e suite (e2e/tests/kanban.spec.js) where a real layout engine
  // exists — jsdom has no geometry, so simulating a dnd-kit pointer drag here
  // would be testing the mock, not the behavior. These tests cover the move
  // *pipeline* (optimistic apply → persist → reconcile-on-error, blocker
  // gating) through the supported quick-move trigger, which routes through the
  // exact same requestMove/applyResolvedMove path a drop does.
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.getCardComments.mockReset();
    api.moveCard.mockReset();
    api.get.mockResolvedValue([]);
    api.getCardComments.mockResolvedValue([]);
    api.moveCard.mockResolvedValue({});
  });

  it('renders cards as dnd-kit sortables, not native HTML5 draggables', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([{ id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );
    const { container } = render(
      <KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />,
    );
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());

    // No native draggable attribute anywhere — the native HTML5 DnD is gone.
    expect(container.querySelector('[draggable]')).toBeNull();
    // The card is wrapped in the dnd-kit sortable wrapper instead.
    expect(screen.getByTestId('card-draggable-card-a')).toBeInTheDocument();
  });

  it('cross-column move optimistically updates column_id and reverts on server error', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([{ id: 'card-1', title: 'Card 1', column_id: 'col-todo', position: 0 }]),
    );
    // The move persist fails — the pipeline must reconcile (re-fetch) the board.
    api.moveCard.mockRejectedValueOnce(new Error('boom'));

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card 1')).toBeInTheDocument());
    const initialFetches = api.getBoard.mock.calls.length;

    // Quick-move into Done (cross-column) — same requestMove path as a drop.
    fireEvent.contextMenu(screen.getByText('Card 1'));
    await screen.findByTestId('card-context-menu');
    fireEvent.click(screen.getByTestId('ctx-item-status'));
    fireEvent.click(screen.getByTestId('ctx-sub-col-col-done'));

    // Optimistic persist attempt targets the new column...
    await waitFor(() =>
      expect(api.moveCard).toHaveBeenCalledWith(
        'p1',
        'card-1',
        expect.objectContaining({ columnId: 'col-done' }),
      ),
    );
    // ...and because it rejected, the board reconciles via a fresh getBoard.
    await waitFor(() => expect(api.getBoard.mock.calls.length).toBeGreaterThan(initialFetches));
  });

  it('gates a blocked-card move into a blocker-sensitive column behind the confirm dialog', async () => {
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
      ],
      epics: [],
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Blocked card')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Blocked card'));
    await screen.findByTestId('card-context-menu');
    fireEvent.click(screen.getByTestId('ctx-item-status'));
    fireEvent.click(screen.getByTestId('ctx-sub-col-col-progress'));

    // Confirm dialog appears; moveCard must NOT have fired yet.
    const confirm = await screen.findByTestId('confirm-move-dialog');
    expect(confirm).toBeInTheDocument();
    expect(api.moveCard).not.toHaveBeenCalled();

    // "Move anyway" commits the (cross-column) move.
    fireEvent.click(within(confirm).getByRole('button', { name: /Move anyway/i }));
    await waitFor(() =>
      expect(api.moveCard).toHaveBeenCalledWith(
        'p1',
        'card-a',
        expect.objectContaining({ columnId: 'col-progress', position: 0 }),
      ),
    );
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
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
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

  it('pre-checks Auto-merge and sends autoMerge:true for a card with auto_merge=1', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([
        { id: 'card-1', title: 'Prefers merge', column_id: 'col-todo', position: 0, auto_merge: 1 },
      ]),
    );
    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Prefers merge')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Prefers merge'));
    const modal = await screen.findByTestId('card-detail-modal');

    const assigneeSelect = within(modal)
      .getAllByRole('combobox')
      .find((c) => Array.from(c.options).some((o) => o.textContent === 'Unassigned'));
    fireEvent.change(assigneeSelect, { target: { value: 'AgentA' } });

    // The card's stored preference pre-checks the box.
    expect(within(modal).getByTestId('card-auto-merge-new').checked).toBe(true);

    api.assignCard.mockResolvedValueOnce({ sessionId: 'sess-m' });
    fireEvent.click(within(modal).getByRole('button', { name: /Assign & Start/i }));
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-a', { autoMerge: true }),
    );
  });

  it('toggling Auto-merge on a null-preference card sends an explicit override', async () => {
    api.getBoard.mockResolvedValue(
      makeBoard([{ id: 'card-1', title: 'No pref', column_id: 'col-todo', position: 0 }]),
    );
    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('No pref')).toBeInTheDocument());
    fireEvent.click(screen.getByText('No pref'));
    const modal = await screen.findByTestId('card-detail-modal');

    const assigneeSelect = within(modal)
      .getAllByRole('combobox')
      .find((c) => Array.from(c.options).some((o) => o.textContent === 'Unassigned'));
    fireEvent.change(assigneeSelect, { target: { value: 'AgentA' } });

    // Unchecked by default (no explicit preference). Tick it → explicit true.
    const box = within(modal).getByTestId('card-auto-merge-new');
    expect(box.checked).toBe(false);
    fireEvent.click(box);

    api.assignCard.mockResolvedValueOnce({ sessionId: 'sess-t' });
    fireEvent.click(within(modal).getByRole('button', { name: /Assign & Start/i }));
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-a', { autoMerge: true }),
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
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
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

describe('KanbanBoard epic filter and autonomous dispatch', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.get.mockResolvedValue([]);
    api.updateEpic.mockReset();
    api.updateEpic.mockResolvedValue({});
  });

  it('filters cards by selected epic and opens autonomous settings', async () => {
    api.getBoard.mockResolvedValueOnce({
      ...makeBoard([
        { id: 'c1', title: 'Epic one card', column_id: 'col-todo', position: 0, epic_id: 'e1' },
        { id: 'c2', title: 'Other epic card', column_id: 'col-todo', position: 1, epic_id: 'e2' },
      ]),
      epics: [
        { id: 'e1', name: 'Platform', color: '#6366F1', autonomous: 0 },
        { id: 'e2', name: 'Mobile', color: '#22C55E', autonomous: 0 },
      ],
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);

    await waitFor(() => expect(screen.getByText('Epic one card')).toBeInTheDocument());
    expect(screen.getByText('Other epic card')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('epic-filter-dropdown').querySelector('button'));
    fireEvent.click(screen.getByRole('option', { name: /Platform/i }));

    await waitFor(() => {
      expect(screen.getByText('Epic one card')).toBeInTheDocument();
      expect(screen.queryByText('Other epic card')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-autonomous-dialog'));
    expect(screen.getByTestId('epic-autonomous-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('epic-autonomous-panel')).toBeInTheDocument();
  });
});

describe('KanbanBoard infinite scroll (per-column pagination)', () => {
  // Capture each ColumnLoadMoreSentinel's IntersectionObserver callback keyed
  // by the observed element's data-testid so a test can simulate the sentinel
  // scrolling into view. jsdom ships no IntersectionObserver, so without this
  // mock the component's `typeof IntersectionObserver === 'undefined'` guard
  // would skip observing entirely.
  let triggers;
  beforeEach(() => {
    triggers = new Map();
    class MockIntersectionObserver {
      constructor(cb) {
        this.cb = cb;
      }
      observe(el) {
        triggers.set(el.getAttribute('data-testid'), this.cb);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.IntersectionObserver = MockIntersectionObserver;
    window.IntersectionObserver = MockIntersectionObserver;

    api.getBoard.mockReset();
    api.getColumnCards.mockReset();
    api.get.mockReset();
    api.get.mockResolvedValue([]);
  });

  const intersect = (testid) => {
    const cb = triggers.get(testid);
    if (!cb) throw new Error(`no observer for ${testid}`);
    act(() => cb([{ isIntersecting: true }]));
  };

  // A board whose `col-todo` column has more cards than the first page, with a
  // server-provided cursor to resume from.
  const pagedBoard = (firstPageCards) => ({
    board: { id: 'b1' },
    columns: [
      { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
      { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
    ],
    cards: firstPageCards,
    epics: [],
    counts: { 'col-todo': 3, 'col-done': 0 },
    cursors: { 'col-todo': 'CURSOR1', 'col-done': null },
  });

  it('fetches and appends the next page when the column sentinel scrolls into view', async () => {
    api.getBoard.mockResolvedValue(
      pagedBoard([
        { id: 'card-1', title: 'Card 1', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Card 2', column_id: 'col-todo', position: 1 },
      ]),
    );
    api.getColumnCards.mockResolvedValue({
      cards: [{ id: 'card-3', title: 'Card 3', column_id: 'col-todo', position: 2 }],
      nextCursor: null,
      total: 3,
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card 1')).toBeInTheDocument());

    // Header shows "2 of 3" before the extra page loads.
    expect(screen.getByTestId('column-count-col-todo')).toHaveTextContent('2 of 3');
    // Card 3 isn't loaded yet.
    expect(screen.queryByText('Card 3')).not.toBeInTheDocument();

    // Sentinel scrolls into view → next page is fetched with the server cursor.
    intersect('column-load-more-sentinel-col-todo');

    await waitFor(() =>
      expect(api.getColumnCards).toHaveBeenCalledWith('p1', 'col-todo', {
        cursor: 'CURSOR1',
        limit: 50,
      }),
    );
    await waitFor(() => expect(screen.getByText('Card 3')).toBeInTheDocument());
    // Now fully loaded → header collapses to the plain total.
    await waitFor(() => expect(screen.getByTestId('column-count-col-todo')).toHaveTextContent('3'));
  });

  it('renders no sentinel and never fetches when the first page is the whole column', async () => {
    api.getBoard.mockResolvedValue({
      board: { id: 'b1' },
      columns: [{ id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 }],
      cards: [{ id: 'card-1', title: 'Card 1', column_id: 'col-todo', position: 0 }],
      epics: [],
      counts: { 'col-todo': 1 },
      cursors: { 'col-todo': null },
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card 1')).toBeInTheDocument());

    expect(screen.queryByTestId('column-load-more-sentinel-col-todo')).not.toBeInTheDocument();
    expect(api.getColumnCards).not.toHaveBeenCalled();
  });

  it('guards against double-fetch: two intersects before the page resolves fetch once', async () => {
    api.getBoard.mockResolvedValue(
      pagedBoard([{ id: 'card-1', title: 'Card 1', column_id: 'col-todo', position: 0 }]),
    );
    // Defer the page response so both intersects land while the fetch is inflight.
    let resolvePage;
    api.getColumnCards.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card 1')).toBeInTheDocument());

    intersect('column-load-more-sentinel-col-todo');
    intersect('column-load-more-sentinel-col-todo');

    await waitFor(() => expect(api.getColumnCards).toHaveBeenCalledTimes(1));

    act(() =>
      resolvePage({
        cards: [{ id: 'card-2', title: 'Card 2', column_id: 'col-todo', position: 1 }],
        nextCursor: null,
        total: 3,
      }),
    );
    await waitFor(() => expect(screen.getByText('Card 2')).toBeInTheDocument());
    // Still only one fetch — the inflight guard suppressed the duplicate.
    expect(api.getColumnCards).toHaveBeenCalledTimes(1);
  });

  it('drains remaining pages when a search filter is active so off-page matches surface', async () => {
    // First page holds Apple + Banana; the matching "Cherry" lives on page 2.
    // Without the filter-drain, searching "Cherry" would find nothing because
    // it was never loaded.
    api.getBoard.mockResolvedValue({
      board: { id: 'b1' },
      columns: [
        { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
        { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
      ],
      cards: [
        { id: 'card-1', title: 'Apple', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Banana', column_id: 'col-todo', position: 1 },
      ],
      epics: [],
      counts: { 'col-todo': 3, 'col-done': 0 },
      cursors: { 'col-todo': 'CURSOR1', 'col-done': null },
    });
    api.getColumnCards.mockResolvedValue({
      cards: [{ id: 'card-3', title: 'Cherry', column_id: 'col-todo', position: 2 }],
      nextCursor: null,
      total: 3,
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Apple')).toBeInTheDocument());

    // Page 2 (Cherry) not loaded yet, and no fetch has happened.
    expect(screen.queryByText('Cherry')).not.toBeInTheDocument();
    expect(api.getColumnCards).not.toHaveBeenCalled();

    // Activating a filter eagerly drains the column so the off-page match loads.
    fireEvent.change(screen.getByPlaceholderText(/Search cards/i), {
      target: { value: 'Cherry' },
    });

    await waitFor(() =>
      expect(api.getColumnCards).toHaveBeenCalledWith('p1', 'col-todo', {
        cursor: 'CURSOR1',
        limit: 50,
      }),
    );
    // The off-page match is now visible; the non-matching first-page cards are
    // filtered out.
    await waitFor(() => expect(screen.getByText('Cherry')).toBeInTheDocument());
    expect(screen.queryByText('Apple')).not.toBeInTheDocument();
    expect(screen.queryByText('Banana')).not.toBeInTheDocument();
    // The fully-loaded column (cursor null) is never drained.
    expect(api.getColumnCards).toHaveBeenCalledTimes(1);
  });
});

describe('KanbanBoard card redesign (Linear density)', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.get.mockResolvedValue([]);
  });

  const renderCard = async (cardOverrides, boardOverrides = {}) => {
    api.getBoard.mockResolvedValueOnce({
      board: { id: 'b1', card_prefix: 'AH', ...boardOverrides },
      columns: [{ id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 }],
      cards: [
        {
          id: 'c1',
          title: 'Redesigned card',
          column_id: 'col-todo',
          position: 0,
          priority: 'urgent',
          short_id: 7,
          assignee: 'Agent Hub Dev',
          created_at: '2025-03-09T10:00:00Z',
          ...cardOverrides,
        },
      ],
      epics: [],
    });
    render(<KanbanBoard projectId="p1" project={{ name: 'Agent Hub' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Redesigned card')).toBeInTheDocument());
  };

  it('renders the short id from board prefix + card short_id', async () => {
    await renderCard();
    expect(screen.getByTestId('card-short-id')).toHaveTextContent('AH-7');
  });

  it('renders a priority icon carrying the card priority', async () => {
    await renderCard({ priority: 'urgent' });
    expect(screen.getByTestId('card-priority-icon')).toHaveAttribute('data-priority', 'urgent');
  });

  it('renders the assignee as an avatar with initials, not the raw name', async () => {
    await renderCard({ assignee: 'Agent Hub Dev' });
    const avatar = screen.getByTestId('card-assignee-avatar');
    expect(avatar).toHaveTextContent('AH');
    // The full name is not rendered as card body text (it lives in the title attr).
    expect(screen.queryByText('Agent Hub Dev')).not.toBeInTheDocument();
  });

  it('renders the created date', async () => {
    await renderCard({ created_at: '2025-03-09T10:00:00Z' });
    expect(screen.getByTestId('card-created-date')).toHaveTextContent(/Mar/);
  });

  it('omits the short-id chip when the card has no short_id (legacy row)', async () => {
    await renderCard({ short_id: null });
    expect(screen.queryByTestId('card-short-id')).not.toBeInTheDocument();
  });

  it('renders a compact review glyph instead of the old text badge', async () => {
    await renderCard({ review_status: 'approved' });
    expect(screen.getByTestId('card-review-glyph')).toHaveAttribute(
      'data-review-status',
      'approved',
    );
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
  });
});

describe('KanbanBoard right-click context menu', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.updateCard.mockReset();
    api.moveCard.mockReset();
    api.deleteCard.mockReset();
    api.linkCardToEpic.mockReset();
    api.assignCard.mockReset();
    api.unassignCard.mockReset();
    api.get.mockResolvedValue([]);
    api.updateCard.mockResolvedValue({});
    api.moveCard.mockResolvedValue({});
    api.deleteCard.mockResolvedValue({});
  });

  const ctxBoard = (overrides = {}) =>
    api.getBoard.mockResolvedValue(
      makeBoard([
        {
          id: 'card-1',
          title: 'Context card',
          column_id: 'col-todo',
          position: 0,
          priority: 'medium',
          labels: 'bug',
          ...overrides,
        },
      ]),
    );

  const openMenu = async () => {
    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Context card')).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByText('Context card'));
    return screen.findByTestId('card-context-menu');
  };

  it('opens on right-click without opening the card detail modal', async () => {
    ctxBoard();
    const menu = await openMenu();
    expect(menu).toBeInTheDocument();
    expect(screen.queryByTestId('card-detail-modal')).not.toBeInTheDocument();
  });

  it('Priority > High calls updateCard with priority:high', async () => {
    ctxBoard();
    await openMenu();
    fireEvent.click(screen.getByTestId('ctx-item-priority'));
    fireEvent.click(screen.getByTestId('ctx-sub-pri-high'));
    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', { priority: 'high' }),
    );
  });

  it('Status > Done moves the card via moveCard', async () => {
    ctxBoard();
    await openMenu();
    fireEvent.click(screen.getByTestId('ctx-item-status'));
    fireEvent.click(screen.getByTestId('ctx-sub-col-col-done'));
    await waitFor(() =>
      expect(api.moveCard).toHaveBeenCalledWith(
        'p1',
        'card-1',
        expect.objectContaining({ columnId: 'col-done' }),
      ),
    );
  });

  it('Delete confirms before deleting', async () => {
    ctxBoard();
    await openMenu();
    fireEvent.click(screen.getByTestId('ctx-item-delete'));
    // First click only reveals the confirm step — no delete yet.
    expect(api.deleteCard).not.toHaveBeenCalled();
    expect(screen.getByTestId('ctx-delete-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ctx-confirm-delete'));
    await waitFor(() => expect(api.deleteCard).toHaveBeenCalledWith('p1', 'card-1'));
  });

  it('toggling a label calls updateCard with the new comma list', async () => {
    ctxBoard();
    await openMenu();
    fireEvent.click(screen.getByTestId('ctx-item-labels'));
    // Existing label "bug" is checked; toggling removes it -> empty string.
    fireEvent.click(screen.getByTestId('ctx-sub-label-bug'));
    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', { labels: '' }),
    );
  });

  it('outside-click closes the menu', async () => {
    ctxBoard();
    const menu = await openMenu();
    expect(menu).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId('card-context-menu')).not.toBeInTheDocument());
  });

  it('Escape closes the menu', async () => {
    ctxBoard();
    const menu = await openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('card-context-menu')).not.toBeInTheDocument());
  });
});
