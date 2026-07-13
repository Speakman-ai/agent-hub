import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import KanbanBoard from './KanbanBoard';
import { api } from '../utils/api';

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

(vi as any).mock('../utils/api.js', () => ({
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
    createColumn: vi.fn(),
    createCard: vi.fn(),
    updateColumn: vi.fn(),
    reorderColumns: vi.fn(),
    deleteColumn: vi.fn(),
    // Cards now render <FinalizeCardBadge /> which calls this on mount
    // whenever the card has a session_id. Mocked to "no run" so the badge
    // is invisible in kanban-flow tests that don't care about finalize.
    getLatestFinalizeRunForSession: vi.fn().mockResolvedValue({ run: null }),
  },
}));

const makeBoard = (cards: any = [], extras: any = {}) => ({
  board: { id: 'b1', project_id: 'p1' },
  columns: [
    { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
    { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
  ],
  cards,
  epics: [],
  counts: extras.counts || {},
  cursors: extras.cursors || {},
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('KanbanBoard background refresh', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
  });

  it('shows "Loading board..." on initial mount, then renders the board', async () => {
    (api.getBoard as any).mockResolvedValueOnce(
      makeBoard([{ id: 1, title: 'First card', column_id: 'col-todo', position: 0 }]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);

    expect(screen.getByText(/Loading board/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('First card')).toBeInTheDocument());
    expect(screen.queryByText(/Loading board/i)).not.toBeInTheDocument();
  });

  it('does NOT flash the loading screen when refreshKey bumps (WebSocket refresh)', async () => {
    (api.getBoard as any).mockResolvedValueOnce(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );

    const { rerender } = render(
      <KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />,
    );
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());

    // Simulate a WebSocket-triggered refresh: parent bumps refreshKey with
    // an updated board payload (e.g. the card has moved columns on the
    // server after another client edited it).
    (api.getBoard as any).mockResolvedValueOnce(
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

describe('KanbanBoard template actions', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.getCardComments as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.getCardComments as any).mockResolvedValue([]);
  });

  it('opens a requested template after columns finish loading', async () => {
    const boardLoad = deferred<any>();
    let actions: any = null;
    (api.getBoard as any).mockReturnValueOnce(boardLoad.promise);

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        onCardActionsReady={(next: any) => {
          actions = next;
        }}
      />,
    );

    await waitFor(() => expect(actions?.openCreateFromTemplate).toBeTypeOf('function'));

    act(() => {
      actions.openCreateFromTemplate({
        id: 'template-1',
        name: 'Bug template',
        title: 'Fix queued bug',
        description: 'Queued template body',
        priority: 'high',
        labels: 'bug',
        epicId: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    expect(screen.queryByTestId('card-detail-modal')).not.toBeInTheDocument();

    await act(async () => {
      boardLoad.resolve(makeBoard([]));
      await boardLoad.promise;
    });

    const modal = await screen.findByTestId('card-detail-modal');
    expect(within(modal).getByDisplayValue('Fix queued bug')).toBeInTheDocument();
    expect(within(modal).getByDisplayValue('Queued template body')).toBeInTheDocument();
  });

  it('consumes a pending template prop after columns finish loading', async () => {
    const boardLoad = deferred<any>();
    const onConsumed = vi.fn();
    (api.getBoard as any).mockReturnValueOnce(boardLoad.promise);

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        pendingCreateTemplate={{
          id: 'template-1',
          name: 'Bug template',
          title: 'Fix pending bug',
          description: 'Pending template body',
          priority: 'high',
          labels: 'bug',
          epicId: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }}
        onPendingCreateTemplateConsumed={onConsumed}
      />,
    );

    await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('card-detail-modal')).not.toBeInTheDocument();

    await act(async () => {
      boardLoad.resolve(makeBoard([]));
      await boardLoad.promise;
    });

    const modal = await screen.findByTestId('card-detail-modal');
    expect(within(modal).getByDisplayValue('Fix pending bug')).toBeInTheDocument();
    expect(within(modal).getByDisplayValue('Pending template body')).toBeInTheDocument();
  });
});

describe('KanbanBoard card detail modal', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.getCardComments as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.getCardComments as any).mockResolvedValue([]);
  });

  it('renders the card detail as a centered modal with sidebar metadata (not a right slide-over)', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    fireEvent.click(screen.getByText('A big card' as any) as any);

    // Modal is rendered and uses a centered-modal layout, not a right slide-over.
    const modal = await screen.findByTestId('card-detail-modal');
    expect(modal!.className).toMatch(/items-center/);
    expect(modal!.className).toMatch(/justify-center/);
    expect(modal!.className).not.toMatch(/justify-end/);

    // Read mode: description is rendered as markdown, not a raw textarea.
    expect(within(modal).getByTestId('card-description-preview')).toBeInTheDocument();
    expect(within(modal).queryByTestId('card-description-editor')).not.toBeInTheDocument();

    fireEvent.click(within(modal as any).getByRole('button', { name: /^Edit$/i }));
    const description = within(modal).getByTestId('card-description-editor');
    expect(description.tagName).toBe('TEXTAREA');
    expect(Number(description.getAttribute('rows'))).toBeGreaterThanOrEqual(10);

    // Sidebar contains the metadata labels.
    expect(within(modal).getByText(/^Priority$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Agent$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Feature$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Labels$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/GitHub Issue URL/i)).toBeInTheDocument();
    expect(within(modal).getByText(/Pull Request/i)).toBeInTheDocument();
  });

  it('shows a "Watch replay" CTA on a card that has an attributed replay and opens the player', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    (api.getCardReplay as any).mockResolvedValueOnce({
      replayId: 'replay-xyz',
      durationMs: 5000,
      eventCount: 9,
      createdAt: '2026-06-14 10:00:00',
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Converted bug card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Converted bug card' as any) as any);

    const modal = await screen.findByTestId('card-detail-modal');
    const watchBtn = await within(modal).findByTestId('card-watch-replay-button');
    expect(watchBtn!).toBeInTheDocument();
    expect(api.getCardReplay).toHaveBeenCalledWith('p1', 'card-replay');

    // Clicking it mounts the isolated-origin player: a data: URL (opaque origin,
    // cross-origin to the host app) — NOT srcDoc — with allow-scripts
    // allow-same-origin so rrweb's nested replay frame can render. See
    // ReplayPlayerModal / utils/replayPlayer.ts for the isolation rationale.
    fireEvent.click(watchBtn as any);
    const iframe = await screen.findByTestId('replay-player-iframe');
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(iframe!.getAttribute('srcdoc')).toBeNull();
    expect((iframe!.getAttribute('src') || '').startsWith('data:text/html')).toBe(true);
  });

  it('renders card description as markdown in read mode and updates preview after edit', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    fireEvent.click(screen.getByText('Markdown card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');
    const preview = within(modal).getByTestId('card-description-preview');
    expect(preview.querySelector('h2')).not.toBeNull();
    expect(preview.querySelector('h2')?.textContent).toMatch(/Problem/i);
    expect(preview.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);

    fireEvent.click(within(modal as any).getByRole('button', { name: /^Edit$/i }));
    const editor = within(modal).getByTestId('card-description-editor');
    fireEvent.change(editor, {
      target: { value: '## Updated title\n\n[Example](https://example.com/path as any)' },
    });
    fireEvent.click(within(modal as any).getByRole('button', { name: /^Preview$/i }));
    const preview2 = within(modal).getByTestId('card-description-preview');
    expect(preview2.querySelector('h2')?.textContent).toMatch(/Updated title/i);
    expect(preview2.querySelector('a')?.getAttribute('href')).toBe('https://example.com/path');
  });

  it('does NOT render the card description on the board (board card shows title + chips only)', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    (api.getBoard as any).mockResolvedValue(
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
    (api.getBoard as any).mockResolvedValue(
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

    fireEvent.click(screen.getByText('Photo card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');
    const preview = within(modal).getByTestId('card-description-preview');
    const imgInModal = within(preview).getByRole('img', { name: 'diagram' });
    expect(imgInModal.getAttribute('src')).toBe('https://example.com/diagram.png');
  });

  it('resolves /uploads/ image paths in card markdown like chat', async () => {
    (api.getBoard as any).mockResolvedValue(
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

    fireEvent.click(screen.getByText('Upload card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');
    const preview = within(modal).getByTestId('card-description-preview');
    const img = within(preview).getByRole('img', { name: 'shot' });
    expect(img.getAttribute('src')).toBe('/uploads/abc/photo.png');
  });
});

describe('KanbanBoard reassign active session', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.getCardComments as any).mockReset();
    (api.getModelConfig as any).mockReset();
    (api.assignCard as any).mockReset();
    (api.get as any).mockResolvedValue([
      { id: 'agent-a', name: 'AgentA' },
      { id: 'agent-b', name: 'AgentB' },
    ]);
    (api.getCardComments as any).mockResolvedValue([]);
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-20250514'] },
    });
  });

  it('shows a Reassign button when the card has an active session, and reveals the agent picker on click', async () => {
    (api.getBoard as any).mockResolvedValue(
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

    fireEvent.click(screen.getByText('Assigned card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');

    // Initial state: "Session active" badge + Open Session + Reassign button.
    expect(within(modal).getByText(/Session active/i)).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: /Open Session/i })).toBeInTheDocument();

    const reassignBtn = within(modal).getByRole('button', { name: /^Reassign$/i });
    expect(reassignBtn!).toBeInTheDocument();

    // Clicking Reassign reveals the agent dropdown + cancel button.
    fireEvent.click(reassignBtn as any);

    // There are multiple selects (Priority, Agent, Epic); pick the one
    // that contains the "Unassigned" option.
    const combos = within(modal).getAllByRole('combobox');
    const assigneeSelect = combos.find((c: any) =>
      Array.from((c as any).options).some((o: any) => (o as any).textContent === 'Unassigned'),
    );
    expect(assigneeSelect!).toBeDefined();
    expect(within(modal).getByRole('button', { name: /Cancel/i })).toBeInTheDocument();

    // Picking a different agent shows "Reassign & Start" (not "Assign & Start").
    fireEvent.change(assigneeSelect as any, { target: { value: 'AgentB' } } as any);
    expect(within(modal).getByRole('button', { name: /Reassign & Start/i })).toBeInTheDocument();

    // Clicking it fires the assignCard API with the new agent id.
    (api.assignCard as any).mockResolvedValueOnce({ sessionId: 'sess-2' });
    fireEvent.click(within(modal as any).getByRole('button', { name: /Reassign & Start/i }));
    // The card has no explicit auto_merge preference, so the assign omits the
    // field — letting the server fall back to the project auto-merge default.
    await waitFor(() => expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-b', {}));
  });

  it('only offers agents from the current project in the assign dropdown', async () => {
    (api.getBoard as any).mockResolvedValue(
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

    fireEvent.click(screen.getByText('Unassigned card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');

    const combos = within(modal).getAllByRole('combobox');
    const assigneeSelect = combos.find((c: any) =>
      Array.from((c as any).options).some((o: any) => (o as any).textContent === 'Unassigned'),
    );
    expect(assigneeSelect!).toBeDefined();

    const optionNames = Array.from((assigneeSelect as any).options).map(
      (o: any) => (o as any).textContent,
    );
    expect(optionNames!).toContain('AgentA');
    expect(optionNames!).not.toContain('AgentZ');
  });

  it('passes model to assignCard when Session model override is chosen', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    fireEvent.click(screen.getByText('Assigned card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');
    fireEvent.click(within(modal as any).getByRole('button', { name: /^Reassign$/i }));

    const combos = within(modal).getAllByRole('combobox');
    const assigneeSelect = combos.find((c: any) =>
      Array.from((c as any).options).some((o: any) => (o as any).textContent === 'Unassigned'),
    );
    fireEvent.change(assigneeSelect as any, { target: { value: 'AgentB' } } as any);

    const modelSelect = await within(modal).findByTestId('card-model-select-new');
    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-20250514' } } as any);

    (api.assignCard as any).mockResolvedValueOnce({ sessionId: 'sess-2' });
    fireEvent.click(within(modal as any).getByRole('button', { name: /Reassign & Start/i }));
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-b', {
        model: 'claude-sonnet-4-20250514',
      }),
    );
  });

  it('Cancel returns to the Open Session view without calling assignCard', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    fireEvent.click(screen.getByText('Assigned card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');

    fireEvent.click(within(modal as any).getByRole('button', { name: /^Reassign$/i }));
    fireEvent.click(within(modal as any).getByRole('button', { name: /Cancel/i }));

    // Back to the session-active view.
    expect(within(modal).getByText(/Session active/i)).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: /Open Session/i })).toBeInTheDocument();
    expect(api.assignCard).not.toHaveBeenCalled();
  });

  it('shows Session model dropdown in assigned/active state and "Save model override" on change', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    (api.updateCard as any).mockResolvedValue({});

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Active card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Active card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');

    // The Session model dropdown should be visible without clicking Reassign.
    const modelSelect = await within(modal).findByTestId('card-model-select');
    // Current value should match card's assign_model.
    expect((modelSelect as any).value).toBe('claude-opus-4-8');

    // "Save override" button should NOT appear yet (no change).
    expect(within(modal).queryByRole('button', { name: /Save override/i })).toBeNull();

    // Change to a different model.
    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-20250514' } } as any);

    // "Save override" button should now appear.
    const saveBtn = await within(modal).findByRole('button', { name: /Save override/i });
    expect(saveBtn!).toBeInTheDocument();

    // Click save — should call updateCard with the new model. The engine
    // override is unchanged (null on both sides) so it still goes in the
    // payload as null — same diff as before the engine selector shipped.
    fireEvent.click(saveBtn as any);
    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', {
        assign_model: 'claude-sonnet-4-20250514',
        assign_engine: null,
      }),
    );
  });

  it('can clear model override back to Agent default from session-active view', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    (api.updateCard as any).mockResolvedValue({});

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Active card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Active card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');

    const modelSelect = await within(modal).findByTestId('card-model-select');

    // Clear the model override by selecting "Engine default" (empty value).
    fireEvent.change(modelSelect, { target: { value: '' } } as any);

    const saveBtn = await within(modal).findByRole('button', { name: /Save override/i });
    fireEvent.click(saveBtn as any);

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
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.getCardComments as any).mockReset();
    (api.moveCard as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.getCardComments as any).mockResolvedValue([]);
    (api.moveCard as any).mockResolvedValue({});
  });

  it('renders cards as dnd-kit sortables, not native HTML5 draggables', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([{ id: 'card-a', title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );
    const { container } = render(
      <KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />,
    );
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());

    // No native draggable attribute anywhere — the native HTML5 DnD is gone.
    expect(container!.querySelector('[draggable]')).toBeNull();
    // The card is wrapped in the dnd-kit sortable wrapper instead.
    expect(screen.getByTestId('card-draggable-card-a')).toBeInTheDocument();
  });

  it('cross-column move optimistically updates column_id and reverts on server error', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([{ id: 'card-1', title: 'Card 1', column_id: 'col-todo', position: 0 }]),
    );
    // The move persist fails — the pipeline must reconcile (re-fetch) the board.
    (api.moveCard as any).mockRejectedValueOnce(new Error('boom'));

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card 1')).toBeInTheDocument());
    const initialFetches = (api.getBoard as any).mock.calls.length;

    // Quick-move into Done (cross-column) — same requestMove path as a drop.
    fireEvent.contextMenu(screen.getByText('Card 1') as any);
    await screen.findByTestId('card-context-menu');
    fireEvent.click(screen.getByTestId('ctx-item-status' as any) as any);
    fireEvent.click(screen.getByTestId('ctx-sub-col-col-done' as any) as any);

    // Optimistic persist attempt targets the new column...
    await waitFor(() =>
      expect(api.moveCard).toHaveBeenCalledWith(
        'p1',
        'card-1',
        expect.objectContaining({ columnId: 'col-done' }),
      ),
    );
    // ...and because it rejected, the board reconciles via a fresh getBoard.
    await waitFor(() =>
      expect((api.getBoard as any).mock.calls.length).toBeGreaterThan(initialFetches),
    );
  });

  it('gates a blocked-card move into a blocker-sensitive column behind the confirm dialog', async () => {
    (api.getBoard as any).mockResolvedValue({
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

    fireEvent.contextMenu(screen.getByText('Blocked card') as any);
    await screen.findByTestId('card-context-menu');
    fireEvent.click(screen.getByTestId('ctx-item-status' as any) as any);
    fireEvent.click(screen.getByTestId('ctx-sub-col-col-progress' as any) as any);

    // Confirm dialog appears; moveCard must NOT have fired yet.
    const confirm = await screen.findByTestId('confirm-move-dialog');
    expect(confirm!).toBeInTheDocument();
    expect(api.moveCard).not.toHaveBeenCalled();

    // "Move anyway" commits the (cross-column) move.
    fireEvent.click(within(confirm as any).getByRole('button', { name: /Move anyway/i }));
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
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.getCardComments as any).mockReset();
    (api.getModelConfig as any).mockReset();
    (api.assignCard as any).mockReset();
    (api.updateCard as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.getCardComments as any).mockResolvedValue([]);
    // Multi-engine config so the engine selector has > 1 option.
    (api.getModelConfig as any).mockResolvedValue({
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
    (api.getBoard as any).mockResolvedValue(
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
    fireEvent.click(screen.getByText('Unassigned card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');

    // Pick assignee — engine + model selectors should render.
    const initialCombos = within(modal).getAllByRole('combobox');
    const assigneeSelect = initialCombos.find((c: any) =>
      Array.from((c as any).options).some((o: any) => (o as any).textContent === 'Unassigned'),
    );
    fireEvent.change(assigneeSelect as any, { target: { value: 'AgentA' } } as any);

    // The engine dropdown carries a `data-testid` so it's unambiguous.
    const engineSelect = await within(modal).findByTestId('card-engine-select-new');
    expect(engineSelect!).toBeDefined();
    expect(
      Array.from((engineSelect as any).options)
        .map((o: any) => (o as any).value)
        .filter(Boolean),
    ).toEqual(expect.arrayContaining(['claude-code', 'codex-cli']));

    // Switch engine to codex-cli — the model dropdown must repopulate with
    // codex models AND must NOT carry over a stale claude-code model.
    fireEvent.change(engineSelect, { target: { value: 'codex-cli' } } as any);

    const modelSelect = await within(modal).findByTestId('card-model-select-new');
    expect(
      Array.from((modelSelect as any).options)
        .map((o: any) => (o as any).value)
        .filter(Boolean),
    ).toEqual(expect.arrayContaining(['gpt-5.3-codex', 'gpt-5.4']));
    fireEvent.change(modelSelect, { target: { value: 'gpt-5.3-codex' } } as any);

    (api.assignCard as any).mockResolvedValueOnce({ sessionId: 'sess-x' });
    fireEvent.click(within(modal as any).getByRole('button', { name: /Assign & Start/i }));
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-a', {
        model: 'gpt-5.3-codex',
        engine: 'codex-cli',
      }),
    );
  });

  it('pre-checks Auto-merge and sends autoMerge:true for a card with auto_merge=1', async () => {
    (api.getBoard as any).mockResolvedValue(
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
      .find((c: any) =>
        Array.from((c as any).options).some((o: any) => (o as any).textContent === 'Unassigned'),
      );
    fireEvent.change(assigneeSelect as any, { target: { value: 'AgentA' } });

    // The card's stored preference pre-checks the box.
    expect((within(modal).getByTestId('card-auto-merge-new') as any).checked).toBe(true);

    (api.assignCard as any).mockResolvedValueOnce({ sessionId: 'sess-m' });
    fireEvent.click(within(modal).getByRole('button', { name: /Assign & Start/i }));
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-a', { autoMerge: true }),
    );
  });

  it('toggling Auto-merge on a null-preference card sends an explicit override', async () => {
    (api.getBoard as any).mockResolvedValue(
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
      .find((c: any) =>
        Array.from((c as any).options).some((o: any) => (o as any).textContent === 'Unassigned'),
      );
    fireEvent.change(assigneeSelect as any, { target: { value: 'AgentA' } });

    // Unchecked by default (no explicit preference). Tick it → explicit true.
    const box = within(modal).getByTestId('card-auto-merge-new') as any;
    expect(box.checked).toBe(false);
    fireEvent.click(box);

    (api.assignCard as any).mockResolvedValueOnce({ sessionId: 'sess-t' });
    fireEvent.click(within(modal).getByRole('button', { name: /Assign & Start/i }));
    await waitFor(() =>
      expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-a', { autoMerge: true }),
    );
  });

  it('PUT updateCard includes both assign_engine + assign_model on an active card', async () => {
    (api.getBoard as any).mockResolvedValue(
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
    (api.updateCard as any).mockResolvedValue({});

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
      />,
    );
    await waitFor(() => expect(screen.getByText('Active card')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Active card' as any) as any);
    const modal = await screen.findByTestId('card-detail-modal');

    // The active-state engine dropdown carries its own test id.
    const engineSelect = await within(modal).findByTestId('card-engine-select');
    fireEvent.change(engineSelect, { target: { value: 'codex-cli' } } as any);

    const modelSelect = await within(modal).findByTestId('card-model-select');
    fireEvent.change(modelSelect, { target: { value: 'gpt-5.3-codex' } } as any);

    const saveBtn = await within(modal).findByRole('button', { name: /Save override/i });
    fireEvent.click(saveBtn as any);

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', {
        assign_engine: 'codex-cli',
        assign_model: 'gpt-5.3-codex',
      }),
    );
  });
});

describe('KanbanBoard feature filter', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.updateEpic as any).mockReset();
    (api.updateEpic as any).mockResolvedValue({});
  });

  it('filters cards by selected feature without obsolete feature autonomy', async () => {
    (api.getBoard as any).mockResolvedValueOnce({
      ...makeBoard([
        { id: 'c1', title: 'Epic one card', column_id: 'col-todo', position: 0, epic_id: 'e1' },
        { id: 'c2', title: 'Other epic card', column_id: 'col-todo', position: 1, epic_id: 'e2' },
      ]),
      epics: [
        { id: 'e1', name: 'Platform', color: '#6366F1', autonomous: 0 },
        { id: 'e2', name: 'Mobile', color: '#22C55E', autonomous: 0 },
      ],
    });

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        selectedEpicIds={new Set(['e1'])}
      />,
    );

    await waitFor(() => expect(screen.getByText('Epic one card')).toBeInTheDocument());
    expect(screen.queryByText('Other epic card')).not.toBeInTheDocument();

    expect(screen.queryByTestId('open-autonomous-dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Autonomous')).not.toBeInTheDocument();
  });
});

describe('KanbanBoard infinite scroll (per-column pagination)', () => {
  // Capture each ColumnLoadMoreSentinel's IntersectionObserver callback keyed
  // by the observed element's data-testid so a test can simulate the sentinel
  // scrolling into view. jsdom ships no IntersectionObserver, so without this
  // mock the component's `typeof IntersectionObserver === 'undefined'` guard
  // would skip observing entirely.
  let triggers: any;
  beforeEach(() => {
    triggers = new Map();
    class MockIntersectionObserver {
      [key: string]: any;
      constructor(cb: any) {
        this.cb = cb;
      }
      observe(el: any) {
        triggers.set(el.getAttribute('data-testid'), this.cb);
      }
      unobserve() {}
      disconnect() {}
    }
    (globalThis as any).IntersectionObserver = MockIntersectionObserver;
    (window as any).IntersectionObserver = MockIntersectionObserver;

    (api.getBoard as any).mockReset();
    (api.getColumnCards as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
  });

  const intersect = (testid: any) => {
    const cb = triggers.get(testid);
    if (!cb) throw new Error(`no observer for ${testid}`);
    act(() => cb([{ isIntersecting: true }]));
  };

  // A board whose `col-todo` column has more cards than the first page, with a
  // server-provided cursor to resume from.
  const pagedBoard = (firstPageCards: any) => ({
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
    (api.getBoard as any).mockResolvedValue(
      pagedBoard([
        { id: 'card-1', title: 'Card 1', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Card 2', column_id: 'col-todo', position: 1 },
      ]),
    );
    (api.getColumnCards as any).mockResolvedValue({
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
    (api.getBoard as any).mockResolvedValue({
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
    (api.getBoard as any).mockResolvedValue(
      pagedBoard([{ id: 'card-1', title: 'Card 1', column_id: 'col-todo', position: 0 }]),
    );
    // Defer the page response so both intersects land while the fetch is inflight.
    let resolvePage: any;
    (api.getColumnCards as any).mockReturnValue(
      new Promise((resolve: any) => {
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
    (api.getBoard as any).mockResolvedValue({
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
    (api.getColumnCards as any).mockResolvedValue({
      cards: [{ id: 'card-3', title: 'Cherry', column_id: 'col-todo', position: 2 }],
      nextCursor: null,
      total: 3,
    });

    const { rerender } = render(
      <KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} searchQuery="" />,
    );
    await waitFor(() => expect(screen.getByText('Apple')).toBeInTheDocument());

    // Page 2 (Cherry) not loaded yet, and no fetch has happened.
    expect(screen.queryByText('Cherry')).not.toBeInTheDocument();
    expect(api.getColumnCards).not.toHaveBeenCalled();

    // Activating a filter eagerly drains the column so the off-page match loads.
    rerender(
      <KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} searchQuery="Cherry" />,
    );

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
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
  });

  const renderCard = async (cardOverrides: any = {}, boardOverrides: any = {}) => {
    (api.getBoard as any).mockResolvedValueOnce({
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
    expect(avatar!).toHaveTextContent('AH');
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
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.updateCard as any).mockReset();
    (api.moveCard as any).mockReset();
    (api.deleteCard as any).mockReset();
    (api.linkCardToEpic as any).mockReset();
    (api.assignCard as any).mockReset();
    (api.unassignCard as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.updateCard as any).mockResolvedValue({});
    (api.moveCard as any).mockResolvedValue({});
    (api.deleteCard as any).mockResolvedValue({});
  });

  const ctxBoard = (overrides: any = {}) =>
    (api.getBoard as any).mockResolvedValue(
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
    fireEvent.contextMenu(screen.getByText('Context card') as any);
    return screen.findByTestId('card-context-menu');
  };

  it('opens on right-click without opening the card detail modal', async () => {
    ctxBoard();
    const menu = await openMenu();
    expect(menu!).toBeInTheDocument();
    expect(screen.queryByTestId('card-detail-modal')).not.toBeInTheDocument();
  });

  it('Priority > High calls updateCard with priority:high', async () => {
    ctxBoard();
    await openMenu();
    fireEvent.click(screen.getByTestId('ctx-item-priority' as any) as any);
    fireEvent.click(screen.getByTestId('ctx-sub-pri-high' as any) as any);
    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', { priority: 'high' }),
    );
  });

  it('clicking the priority icon marks a medium card high without opening detail', async () => {
    ctxBoard();
    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Context card')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('card-priority-toggle'));

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', { priority: 'high' }),
    );
    expect(screen.queryByTestId('card-detail-modal')).not.toBeInTheDocument();
  });

  it('clicking the priority icon on a high card clears back to medium', async () => {
    ctxBoard({ priority: 'high' });
    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Context card')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('card-priority-toggle'));

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', { priority: 'medium' }),
    );
  });

  it('Status > Done moves the card via moveCard', async () => {
    ctxBoard();
    await openMenu();
    fireEvent.click(screen.getByTestId('ctx-item-status' as any) as any);
    fireEvent.click(screen.getByTestId('ctx-sub-col-col-done' as any) as any);
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
    fireEvent.click(screen.getByTestId('ctx-item-delete' as any) as any);
    // First click only reveals the confirm step — no delete yet.
    expect(api.deleteCard).not.toHaveBeenCalled();
    expect(screen.getByTestId('ctx-delete-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ctx-confirm-delete' as any) as any);
    await waitFor(() => expect(api.deleteCard).toHaveBeenCalledWith('p1', 'card-1'));
  });

  it('toggling a label calls updateCard with the new comma list', async () => {
    ctxBoard();
    await openMenu();
    fireEvent.click(screen.getByTestId('ctx-item-labels' as any) as any);
    // Existing label "bug" is checked; toggling removes it -> empty string.
    fireEvent.click(screen.getByTestId('ctx-sub-label-bug' as any) as any);
    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', { labels: '' }),
    );
  });

  it('outside-click closes the menu', async () => {
    ctxBoard();
    const menu = await openMenu();
    expect(menu!).toBeInTheDocument();
    fireEvent.mouseDown(document.body as any);
    await waitFor(() => expect(screen.queryByTestId('card-context-menu')).not.toBeInTheDocument());
  });

  it('Escape closes the menu', async () => {
    ctxBoard();
    const menu = await openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' } as any);
    await waitFor(() => expect(screen.queryByTestId('card-context-menu')).not.toBeInTheDocument());
  });
});

describe('KanbanBoard multi-select', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.moveCard as any).mockReset();
    (api.updateCard as any).mockReset();
    (api.deleteCard as any).mockReset();
    (api.assignCard as any).mockReset();
    (api.deleteCard as any).mockResolvedValue({});
    (api.updateCard as any).mockResolvedValue({});
    (api.moveCard as any).mockResolvedValue({});
    (api.assignCard as any).mockResolvedValue({ sessionId: 'bulk-session' });
  });

  it('select mode toggles cards and shows the bulk action bar', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([
        { id: 'card-1', title: 'Alpha', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Beta', column_id: 'col-todo', position: 1 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-select-mode'));
    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.click(screen.getByText('Beta'));

    expect(screen.getByTestId('kanban-bulk-bar')).toHaveTextContent('2 selected');
    expect(screen.getByTestId('card-select-card-1')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Cmd+click toggles selection without opening the detail modal', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([{ id: 'card-1', title: 'Solo card', column_id: 'col-todo', position: 0 }]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Solo card')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Solo card'), { metaKey: true });
    expect(screen.getByTestId('kanban-bulk-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('card-detail-modal')).not.toBeInTheDocument();
  });

  it('bulk move sends moveCard for each selected card', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([
        { id: 'card-1', title: 'One', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Two', column_id: 'col-todo', position: 1 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-select-mode'));
    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'));

    fireEvent.change(screen.getByLabelText('Move selected cards'), {
      target: { value: 'col-done' },
    });

    await waitFor(() => expect(api.moveCard).toHaveBeenCalled());
    expect((api.moveCard as any).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('bulk priority update calls updateCard for each selected card', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([
        { id: 'card-1', title: 'One', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Two', column_id: 'col-todo', position: 1 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-select-mode'));
    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'));

    fireEvent.change(screen.getByLabelText('Set priority'), { target: { value: 'high' } });

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', { priority: 'high' }),
    );
    expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-2', { priority: 'high' });
  });

  it('bulk Mark high button sets high priority on all selected cards', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([
        { id: 'card-1', title: 'One', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Two', column_id: 'col-todo', position: 1 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-select-mode'));
    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'));

    fireEvent.click(screen.getByTestId('kanban-bulk-mark-high'));

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-1', { priority: 'high' }),
    );
    expect(api.updateCard).toHaveBeenCalledWith('p1', 'card-2', { priority: 'high' });
  });

  it('bulk Assign opens agent options and starts each selected card with model and auto-merge', async () => {
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-20250514'] },
    });
    (api.getBoard as any).mockResolvedValue(
      makeBoard([
        { id: 'card-1', title: 'One', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Two', column_id: 'col-todo', position: 1 },
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
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-select-mode'));
    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'));
    fireEvent.click(screen.getByTestId('kanban-bulk-assign'));

    const dialog = await screen.findByTestId('kanban-bulk-assign-dialog');
    fireEvent.change(within(dialog).getByTestId('kanban-bulk-agent-select'), {
      target: { value: 'agent-a' },
    });
    fireEvent.change(await within(dialog).findByTestId('kanban-bulk-model-select'), {
      target: { value: 'claude-sonnet-4-20250514' },
    });
    fireEvent.click(within(dialog).getByTestId('kanban-bulk-auto-merge'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Assign & Start/i }));

    await waitFor(() => expect(api.assignCard).toHaveBeenCalledTimes(2));
    expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-1', 'agent-a', {
      autoMerge: true,
      model: 'claude-sonnet-4-20250514',
    });
    expect(api.assignCard).toHaveBeenCalledWith('p1', 'card-2', 'agent-a', {
      autoMerge: true,
      model: 'claude-sonnet-4-20250514',
    });
  });

  it('column select-all toggles every visible card in that column', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([
        { id: 'card-1', title: 'One', column_id: 'col-todo', position: 0 },
        { id: 'card-2', title: 'Two', column_id: 'col-todo', position: 1 },
      ]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-select-mode'));
    fireEvent.click(screen.getByTestId('column-select-all-col-todo'));

    expect(screen.getByTestId('kanban-bulk-bar')).toHaveTextContent('2 selected');
  });
});

describe('KanbanBoard column management', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.createColumn as any).mockReset();
    (api.updateColumn as any).mockReset();
    (api.reorderColumns as any).mockReset();
    (api.deleteColumn as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.createColumn as any).mockResolvedValue([
      { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
      { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
      { id: 'col-qa', name: 'QA', color: '#3B82F6', position: 2 },
    ]);
    (api.updateColumn as any).mockResolvedValue({ ok: true });
    (api.reorderColumns as any).mockResolvedValue([
      { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
      { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
      { id: 'col-qa', name: 'QA', color: '#3B82F6', position: 2 },
    ]);
    (api.deleteColumn as any).mockResolvedValue({ ok: true });
  });

  it('creates a column from the header button', async () => {
    (api.getBoard as any).mockResolvedValue(makeBoard([]));

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId('kanban-add-column')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-add-column'));
    fireEvent.change(screen.getByTestId('kanban-column-name-input'), { target: { value: 'QA' } });
    fireEvent.click(screen.getByTestId('kanban-column-save'));

    await waitFor(() =>
      expect(api.createColumn).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'QA' })),
    );
  });

  it('updates a custom column from the column edit button', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...makeBoard([]),
      columns: [
        { id: 'col-todo', name: 'To Do', color: '#6b7280', position: 0 },
        { id: 'col-qa', name: 'QA', color: '#22c55e', position: 1 },
      ],
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId('column-edit-col-qa')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('column-edit-col-qa'));
    fireEvent.change(screen.getByTestId('kanban-column-name-input'), {
      target: { value: 'Review' },
    });
    fireEvent.click(screen.getByTestId('kanban-column-save'));

    await waitFor(() =>
      expect(api.updateColumn).toHaveBeenCalledWith('p1', 'col-qa', {
        name: 'Review',
        color: '#22c55e',
      }),
    );
    expect((api.updateColumn as any).mock.calls[0][2]).not.toHaveProperty('position');
  });

  it('moves a column through the atomic reorder endpoint', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...makeBoard([]),
      columns: [
        { id: 'col-todo', name: 'To Do', color: '#6b7280', position: 0 },
        { id: 'col-qa', name: 'QA', color: '#3B82F6', position: 1 },
        { id: 'col-done', name: 'Done', color: '#22c55e', position: 2 },
      ],
    });
    (api.reorderColumns as any).mockResolvedValue([
      { id: 'col-todo', name: 'To Do', color: '#6b7280', position: 0 },
      { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
      { id: 'col-qa', name: 'QA', color: '#3B82F6', position: 2 },
    ]);

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId('column-edit-col-qa')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('column-edit-col-qa'));
    fireEvent.click(screen.getByTestId('kanban-column-move-right'));

    await waitFor(() =>
      expect(api.reorderColumns).toHaveBeenCalledWith('p1', ['col-todo', 'col-done', 'col-qa']),
    );
    expect(api.updateColumn).not.toHaveBeenCalled();
  });

  it('locks To Do, In Progress, and Done from rename/delete', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...makeBoard([]),
      columns: [
        { id: 'col-todo', name: 'To Do', color: '#6b7280', position: 0 },
        { id: 'col-progress', name: 'In Progress', color: '#f59e0b', position: 1 },
        { id: 'col-done', name: 'Done', color: '#22c55e', position: 2 },
      ],
    });

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId('column-edit-col-todo')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('column-edit-col-todo'));
    expect(screen.getByTestId('kanban-column-locked-notice')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-column-name-input')).toBeDisabled();
    expect(screen.queryByTestId('kanban-column-delete')).not.toBeInTheDocument();
  });

  it('blocks delete when the column still has cards', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-todo', position: 0 }], {
        counts: { 'col-todo': 1 },
      }),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId('column-edit-col-todo')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('column-edit-col-todo'));
    expect(screen.getByTestId('kanban-column-delete-blocked')).toHaveTextContent(
      /still has 1 card/i,
    );
    expect(screen.getByTestId('kanban-column-delete')).toBeDisabled();
  });
});

describe('KanbanBoard column collapse', () => {
  beforeEach(() => {
    localStorage.clear();
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('collapses and expands a column from the header controls', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());

    expect(screen.getByTestId('kanban-column-col-todo')).toHaveAttribute('data-collapsed', 'false');

    fireEvent.click(screen.getByTestId('column-collapse-col-todo'));
    expect(screen.getByTestId('kanban-column-col-todo')).toHaveAttribute('data-collapsed', 'true');
    expect(screen.queryByText('Card A')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('column-expand-col-todo'));
    expect(screen.getByTestId('kanban-column-col-todo')).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByText('Card A')).toBeInTheDocument();
  });

  it('preserves stored collapsed columns while the board is loading', async () => {
    localStorage.setItem('kanbanCollapsedColumns:p1', JSON.stringify(['col-todo']));
    (api.getBoard as any).mockResolvedValue(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);

    await waitFor(() =>
      expect(screen.getByTestId('kanban-column-col-todo')).toHaveAttribute(
        'data-collapsed',
        'true',
      ),
    );
    expect(screen.queryByText('Card A')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('kanbanCollapsedColumns:p1') || '[]')).toEqual([
      'col-todo',
    ]);
  });
});

describe('KanbanBoard label filter', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
  });

  it('shows only cards matching selected labels', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([
        { id: 'c1', title: 'Bug card', column_id: 'col-todo', position: 0, labels: 'bug' },
        { id: 'c2', title: 'Feature card', column_id: 'col-todo', position: 1, labels: 'feature' },
      ]),
    );

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        selectedLabels={new Set(['bug'])}
      />,
    );

    await waitFor(() => expect(screen.getByText('Bug card')).toBeInTheDocument());
    expect(screen.queryByText('Feature card')).not.toBeInTheDocument();
  });

  it('publishes server-provided label facets even when labels are not on loaded cards', async () => {
    const onAvailableLabelsChange = vi.fn();
    (api.getBoard as any).mockResolvedValue({
      ...makeBoard([
        { id: 'c1', title: 'Visible card', column_id: 'col-todo', position: 0, labels: 'visible' },
      ]),
      availableLabels: ['hidden', 'visible'],
    });

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        onAvailableLabelsChange={onAvailableLabelsChange}
      />,
    );

    await waitFor(() =>
      expect(onAvailableLabelsChange).toHaveBeenCalledWith(['hidden', 'visible']),
    );
  });
});

describe('KanbanBoard user filter', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
  });

  it('shows only cards matching selected lead users', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...makeBoard([
        {
          id: 'c1',
          title: 'Ryan card',
          column_id: 'col-todo',
          position: 0,
          assigned_user_id: 'u1',
        },
        {
          id: 'c2',
          title: 'Other card',
          column_id: 'col-todo',
          position: 1,
          assigned_user_id: 'u2',
        },
      ]),
      assignableUsers: [
        { id: 'u1', username: 'ryan' },
        { id: 'u2', username: 'alex' },
      ],
    });

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        selectedUserIds={new Set(['u1'])}
        assignableUsers={[{ id: 'u1', username: 'ryan' }]}
      />,
    );

    await waitFor(() => expect(screen.getByText('Ryan card')).toBeInTheDocument());
    expect(screen.queryByText('Other card')).not.toBeInTheDocument();
  });
});

describe('KanbanBoard add card', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.getCardComments as any).mockReset();
    (api.getCardComments as any).mockResolvedValue([]);
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
    (api.createCard as any).mockReset();
    (api.updateCard as any).mockReset();
    (api.assignCard as any).mockReset();
  });

  it('opens the full detail modal in create mode', async () => {
    (api.getBoard as any).mockResolvedValue(makeBoard([]));

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId('kanban-add-card')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-add-card'));

    const modal = await screen.findByTestId('card-detail-modal');
    expect(within(modal).getByText('New card')).toBeInTheDocument();
    expect(within(modal).getByPlaceholderText('Card title')).toHaveValue('');
    expect(within(modal).getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(api.getCardComments).not.toHaveBeenCalled();
  });

  it('does not create a duplicate card when Create & Start assignment fails and is retried', async () => {
    (api.getBoard as any).mockResolvedValue(makeBoard([]));
    (api.createCard as any).mockResolvedValueOnce({
      id: 'card-created',
      title: 'Retry assignment card',
      description: '',
      priority: 'medium',
      column_id: 'col-todo',
      blockers: [],
      blocks: [],
    });
    (api.assignCard as any)
      .mockRejectedValueOnce(new Error('assignment failed'))
      .mockResolvedValueOnce({ sessionId: 'session-1' });

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('kanban-add-card')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-add-card'));
    const modal = await screen.findByTestId('card-detail-modal');
    fireEvent.change(within(modal).getByPlaceholderText('Card title'), {
      target: { value: 'Retry assignment card' },
    });
    const assigneeSelect = within(modal)
      .getAllByRole('combobox')
      .find((c: any) =>
        Array.from((c as any).options).some((o: any) => o.textContent === 'Unassigned'),
      );
    expect(assigneeSelect).toBeDefined();
    fireEvent.change(assigneeSelect as any, { target: { value: 'AgentA' } });

    fireEvent.click(within(modal).getByRole('button', { name: /Create & Start/i }));
    await waitFor(() => expect(api.createCard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.assignCard).toHaveBeenCalledTimes(1));

    const retryButton = await within(modal).findByRole('button', { name: /Assign & Start/i });
    fireEvent.click(retryButton);

    await waitFor(() => expect(api.assignCard).toHaveBeenCalledTimes(2));
    expect(api.createCard).toHaveBeenCalledTimes(1);
    expect(api.assignCard).toHaveBeenLastCalledWith('p1', 'card-created', 'agent-a', {});
  });

  it('retries the PR URL update before assigning a created card', async () => {
    (api.getBoard as any).mockResolvedValue(makeBoard([]));
    (api.createCard as any).mockResolvedValueOnce({
      id: 'card-created',
      title: 'Retry PR card',
      description: '',
      priority: 'medium',
      column_id: 'col-todo',
      blockers: [],
      blocks: [],
    });
    (api.updateCard as any)
      .mockRejectedValueOnce(new Error('pr update failed'))
      .mockResolvedValueOnce({
        id: 'card-created',
        pr_url: 'https://github.com/acme/repo/pull/7',
      });
    (api.assignCard as any).mockResolvedValueOnce({ sessionId: 'session-1' });

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        agents={[{ id: 'agent-a', name: 'AgentA', engine: 'claude-code', projectId: 'p1' }]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('kanban-add-card')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kanban-add-card'));
    const modal = await screen.findByTestId('card-detail-modal');
    fireEvent.change(within(modal).getByPlaceholderText('Card title'), {
      target: { value: 'Retry PR card' },
    });
    fireEvent.change(within(modal).getByPlaceholderText('https://github.com/.../pull/123'), {
      target: { value: 'https://github.com/acme/repo/pull/7' },
    });
    const assigneeSelect = within(modal)
      .getAllByRole('combobox')
      .find((c: any) =>
        Array.from((c as any).options).some((o: any) => o.textContent === 'Unassigned'),
      );
    expect(assigneeSelect).toBeDefined();
    fireEvent.change(assigneeSelect as any, { target: { value: 'AgentA' } });

    fireEvent.click(within(modal).getByRole('button', { name: /Create & Start/i }));
    await waitFor(() => expect(api.createCard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.updateCard).toHaveBeenCalledTimes(1));
    expect(api.assignCard).not.toHaveBeenCalled();

    const retryButton = await within(modal).findByRole('button', { name: /Assign & Start/i });
    fireEvent.click(retryButton);

    await waitFor(() => expect(api.updateCard).toHaveBeenCalledTimes(2));
    expect(api.updateCard).toHaveBeenLastCalledWith('p1', 'card-created', {
      prUrl: 'https://github.com/acme/repo/pull/7',
    });
    await waitFor(() => expect(api.assignCard).toHaveBeenCalledTimes(1));
    expect(api.createCard).toHaveBeenCalledTimes(1);
    expect(api.assignCard).toHaveBeenLastCalledWith('p1', 'card-created', 'agent-a', {});
  });
});

describe('KanbanBoard epics toolbar', () => {
  beforeEach(() => {
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
  });

  it('shows the Features button without rendering the epic filter in the board header', async () => {
    const onOpenEpics = vi.fn();
    const onSelectedEpicIdsChange = vi.fn();
    (api.getBoard as any).mockResolvedValue({
      ...makeBoard([]),
      epics: [{ id: 'e1', name: 'Platform', color: '#6366F1', autonomous: 0 }],
    });

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        onOpenEpics={onOpenEpics}
        onSelectedEpicIdsChange={onSelectedEpicIdsChange}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('kanban-edit-epics')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('kanban-edit-epics'));
    expect(onOpenEpics).toHaveBeenCalled();
    expect(screen.queryByTestId('kanban-epic-filter')).not.toBeInTheDocument();
    expect(onSelectedEpicIdsChange).not.toHaveBeenCalled();
  });
});

describe('KanbanBoard collapsed-column wiring (controlled vs uncontrolled)', () => {
  beforeEach(() => {
    localStorage.clear();
    (api.getBoard as any).mockReset();
    (api.get as any).mockReset();
    (api.get as any).mockResolvedValue([]);
  });

  afterEach(() => {
    localStorage.clear();
  });

  const STORAGE_KEY = 'kanbanCollapsedColumns:p1';

  it('controlled mode: a toggle notifies the parent and does NOT write localStorage', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );
    const onCollapsedColumnIdsChange = vi.fn();

    render(
      <KanbanBoard
        projectId="p1"
        project={{ name: 'P' }}
        refreshKey={0}
        collapsedColumnIds={new Set()}
        onCollapsedColumnIdsChange={onCollapsedColumnIdsChange}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('column-collapse-col-todo')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('column-collapse-col-todo'));

    // Parent is notified with the next layout...
    expect(onCollapsedColumnIdsChange).toHaveBeenCalledTimes(1);
    const next = onCollapsedColumnIdsChange.mock.calls[0][0] as Set<string>;
    expect(next.has('col-todo')).toBe(true);
    // ...and the board does NOT persist directly in controlled mode (App owns it).
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('uncontrolled mode: a toggle falls back to internal state + localStorage', async () => {
    (api.getBoard as any).mockResolvedValue(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);

    await waitFor(() => expect(screen.getByTestId('column-collapse-col-todo')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('column-collapse-col-todo'));

    // The column reflects the collapsed state from internal state...
    await waitFor(() =>
      expect(screen.getByTestId('kanban-column-col-todo').getAttribute('data-collapsed')).toBe(
        'true',
      ),
    );
    // ...and the layout is persisted to localStorage.
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      expect(stored).toContain('col-todo');
    });
  });
});
