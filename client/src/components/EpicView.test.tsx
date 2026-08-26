import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import EpicView from './EpicView';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getBoard: vi.fn(),
    getModelConfig: vi.fn().mockResolvedValue({ engineValidModels: {} }),
    createEpic: vi.fn(),
    scopeEpic: vi.fn(),
    createCard: vi.fn(),
    updateCard: vi.fn(),
    updateEpic: vi.fn(),
    deleteEpic: vi.fn(),
    createPhase: vi.fn(),
    updatePhase: vi.fn(),
    runPhase: vi.fn(),
    stopPhase: vi.fn(),
  },
}));

const board = {
  columns: [
    { id: 'col-backlog', name: 'Backlog', position: 0 },
    { id: 'col-done', name: 'Done', position: 1 },
  ],
  cards: [
    {
      id: 'c1',
      title: 'Existing ticket',
      column_id: 'col-backlog',
      epic_id: 'e1',
      phase_id: 'ph1',
      position: 0,
    },
  ],
  epics: [
    {
      id: 'e1',
      name: 'Platform',
      color: '#6366F1',
      description: 'Core work',
      autonomous: 0,
      state: 'in_progress',
    },
  ],
  phases: [{ id: 'ph1', epic_id: 'e1', name: 'Build', position: 0 }],
};

describe('EpicView', () => {
  beforeEach(() => {
    localStorage.clear();
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
    fireEvent.click(screen.getByTestId('epic-manage-open-e1' as any) as any);
    expect(onOpenEpic!).toHaveBeenCalledWith('e1');
  });

  it('opens a scoping session pre-linked to the epic and navigates to it', async () => {
    (api.scopeEpic as any).mockResolvedValue({ sessionId: 's-1', agentId: 'a-1' });
    const onNavigateToSession = vi.fn();

    render(
      <EpicView
        projectId="p1"
        epicId="e1"
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
        onNavigateToSession={onNavigateToSession}
      />,
    );

    const button = await screen.findByTestId('epic-scope-button' as any);
    fireEvent.click(button);

    await waitFor(() => expect(api.scopeEpic).toHaveBeenCalledWith('p1', 'e1'));
    await waitFor(() => expect(onNavigateToSession).toHaveBeenCalledWith('a-1', 's-1'));
  });

  it('shows unassigned epic tickets and assigns them to a phase', async () => {
    const unassignedBoard = {
      ...board,
      cards: [
        ...board.cards,
        {
          id: 'c2',
          title: 'Unassigned ticket',
          column_id: 'col-backlog',
          epic_id: 'e1',
          phase_id: null,
          position: 1,
        },
      ],
    };
    (api.getBoard as any).mockResolvedValue(unassignedBoard);
    (api.updateCard as any).mockResolvedValue({ ...unassignedBoard.cards[1], phase_id: 'ph1' });

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

    expect(await screen.findByTestId('unassigned-tickets')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('assign-phase-c2'), {
      target: { value: 'ph1' },
    });

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'c2', { phaseId: 'ph1' }),
    );
  });

  it('shows an error when assigning an unassigned ticket fails', async () => {
    const unassignedBoard = {
      ...board,
      cards: [
        ...board.cards,
        {
          id: 'c2',
          title: 'Unassigned ticket',
          column_id: 'col-backlog',
          epic_id: 'e1',
          phase_id: null,
          position: 1,
        },
      ],
    };
    (api.getBoard as any).mockResolvedValue(unassignedBoard);
    (api.updateCard as any).mockRejectedValue(new Error('Phase assignment failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

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

    fireEvent.change(await screen.findByTestId('assign-phase-c2'), {
      target: { value: 'ph1' },
    });

    await waitFor(() => expect(screen.getByText('Phase assignment failed')).toBeInTheDocument());
    consoleError.mockRestore();
  });

  it('creates an epic and opens a scoping session for it via Create & scope', async () => {
    (api.createEpic as any).mockResolvedValue({ id: 'e-new' });
    (api.scopeEpic as any).mockResolvedValue({ sessionId: 's-2', agentId: 'a-2' });
    const onNavigateToSession = vi.fn();

    render(
      <EpicView
        projectId="p1"
        epicId={null}
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
        onNavigateToSession={onNavigateToSession}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('epic-list-toolbar' as any)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('epic-list-create-scope-button' as any));
    expect(screen.queryByTestId('epic-create-button' as any)).not.toBeInTheDocument();
    const nameInput = await screen.findByPlaceholderText('e.g. Platform reliability' as any);
    fireEvent.change(nameInput, { target: { value: 'Payments' } });
    fireEvent.click(screen.getByTestId('epic-create-scope-button' as any));

    await waitFor(() => expect(api.createEpic).toHaveBeenCalled());
    await waitFor(() => expect(api.scopeEpic).toHaveBeenCalledWith('p1', 'e-new'));
    await waitFor(() => expect(onNavigateToSession).toHaveBeenCalledWith('a-2', 's-2'));
  });

  it('retries Create & scope against the created epic when initial scoping fails', async () => {
    vi.clearAllMocks();
    (api.getBoard as any).mockResolvedValue(board);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    (api.createEpic as any).mockResolvedValue({ id: 'e-new' });
    (api.scopeEpic as any)
      .mockRejectedValueOnce(new Error('scope failed'))
      .mockResolvedValueOnce({ sessionId: 's-2', agentId: 'a-2' });
    const onNavigateToSession = vi.fn();

    render(
      <EpicView
        projectId="p1"
        epicId={null}
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
        onNavigateToSession={onNavigateToSession}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('epic-list-toolbar' as any)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('epic-list-create-scope-button' as any));
    const nameInput = await screen.findByPlaceholderText('e.g. Platform reliability' as any);
    fireEvent.change(nameInput, { target: { value: 'Payments' } });
    fireEvent.click(screen.getByTestId('epic-create-scope-button' as any));

    await waitFor(() => expect(api.scopeEpic).toHaveBeenCalledTimes(1));
    expect(api.createEpic).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('epic-create-scope-button' as any));

    await waitFor(() => expect(api.scopeEpic).toHaveBeenCalledTimes(2));
    expect(api.createEpic).toHaveBeenCalledTimes(1);
    expect(api.scopeEpic).toHaveBeenLastCalledWith('p1', 'e-new');
    await waitFor(() => expect(onNavigateToSession).toHaveBeenCalledWith('a-2', 's-2'));
    consoleError.mockRestore();
  });

  it('filters epics by label on the list page', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...board,
      epics: [
        {
          id: 'e1',
          name: 'Platform',
          color: '#6366F1',
          description: 'Core work',
          labels: 'infra',
          state: 'in_progress',
        },
        {
          id: 'e2',
          name: 'Mobile',
          color: '#6366F1',
          description: '',
          labels: 'mobile',
          state: 'in_progress',
        },
      ],
    });

    render(
      <EpicView
        projectId="p1"
        epicId={null}
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('epic-list-label-infra' as any)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('epic-list-label-infra' as any));
    await waitFor(() => expect(screen.getByText('Platform')).toBeInTheDocument());
    expect(screen.queryByText('Mobile')).toBeNull();
  });

  it('filters epics by lifecycle state on the list page', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...board,
      epics: [
        {
          id: 'e1',
          name: 'Platform',
          color: '#6366F1',
          description: 'Core work',
          state: 'in_progress',
        },
        {
          id: 'e2',
          name: 'Archived',
          color: '#6366F1',
          description: '',
          state: 'done',
        },
        {
          id: 'e3',
          name: 'Empty epic',
          color: '#6366F1',
          description: '',
          state: null,
        },
        {
          id: 'e4',
          name: 'Todo epic',
          color: '#6366F1',
          description: '',
          state: 'not_started',
        },
      ],
    });

    render(
      <EpicView
        projectId="p1"
        epicId={null}
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Platform')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('epic-list-filter-state' as any), {
      target: { value: 'not_started' },
    });
    await waitFor(() => expect(screen.getByText('Todo epic')).toBeInTheDocument());
    expect(screen.queryByText('Empty epic')).toBeNull();

    fireEvent.change(screen.getByTestId('epic-list-filter-state' as any), {
      target: { value: 'done' },
    });
    await waitFor(() => expect(screen.getByText('Archived')).toBeInTheDocument());
    expect(screen.queryByText('Platform')).toBeNull();
  });

  it('shows in-progress epics by default on the list page', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...board,
      epics: [
        {
          id: 'e1',
          name: 'Active Platform',
          color: '#6366F1',
          description: 'Core work',
          state: 'in_progress',
        },
        {
          id: 'e2',
          name: 'Completed Platform',
          color: '#6366F1',
          description: '',
          state: 'done',
        },
      ],
    });

    render(
      <EpicView
        projectId="p1"
        epicId={null}
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Active Platform')).toBeInTheDocument());
    expect(screen.queryByText('Completed Platform')).toBeNull();
    expect(screen.getByTestId('epic-list-filter-state')).toHaveValue('in_progress');
  });

  it('toggles between list and board views, grouping epics by state on the board', async () => {
    localStorage.clear();
    (api.getBoard as any).mockResolvedValue({
      ...board,
      epics: [
        { id: 'e1', name: 'Platform', color: '#6366F1', description: '', state: 'in_progress' },
        { id: 'e2', name: 'Archived', color: '#6366F1', description: '', state: 'done' },
        { id: 'e3', name: 'Queued', color: '#6366F1', description: '', state: 'not_started' },
      ],
    });

    render(
      <EpicView
        projectId="p1"
        epicId={null}
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
      />,
    );

    // Default list view shows the card grid, not the board.
    await waitFor(() => expect(screen.getByTestId('epic-manage-list' as any)).toBeInTheDocument());
    expect(screen.queryByTestId('epic-board' as any)).toBeNull();

    fireEvent.click(screen.getByTestId('epic-view-toggle-board' as any));

    // Board view appears; state filter dropdown is hidden; all three states show
    // even though the list default filter is in_progress.
    await waitFor(() => expect(screen.getByTestId('epic-board' as any)).toBeInTheDocument());
    expect(screen.queryByTestId('epic-list-filter-state' as any)).toBeNull();
    const inProgress = screen.getByTestId('epic-board-column-in_progress' as any);
    const done = screen.getByTestId('epic-board-column-done' as any);
    const notStarted = screen.getByTestId('epic-board-column-not_started' as any);
    expect(within(inProgress).getByText('Platform')).toBeInTheDocument();
    expect(within(done).getByText('Archived')).toBeInTheDocument();
    expect(within(notStarted).getByText('Queued')).toBeInTheDocument();

    // Preference persists.
    expect(localStorage.getItem('epicListViewMode')).toBe('board');
  });

  it('deletes an epic from the list view', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (api.deleteEpic as any).mockResolvedValue({});
    (api.getBoard as any)
      .mockResolvedValueOnce(board)
      .mockResolvedValueOnce({ ...board, epics: [] });

    render(
      <EpicView
        projectId="p1"
        epicId={null}
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('manage-epic-e1' as any)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('epic-manage-delete-e1' as any));

    await waitFor(() => expect(api.deleteEpic).toHaveBeenCalledWith('p1', 'e1'));
    await waitFor(() => expect(screen.getByText('No epics yet.')).toBeInTheDocument());
  });

  it('adds a ticket to a phase on the epic detail screen', async () => {
    (api.createCard as any).mockResolvedValue({ id: 'c2' });
    (api.getBoard as any).mockResolvedValueOnce(board).mockResolvedValueOnce({
      ...board,
      cards: [
        ...board.cards,
        {
          id: 'c2',
          title: 'New ticket',
          column_id: 'col-backlog',
          epic_id: 'e1',
          phase_id: 'ph1',
          position: 1,
        },
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

    // The existing phase-scoped ticket renders inside its phase column.
    const phaseColumn = await screen.findByTestId('phase-column-ph1' as any);
    await waitFor(() =>
      expect(within(phaseColumn).getByText('Existing ticket')).toBeInTheDocument(),
    );

    // Open the per-phase add-ticket form, type a title, and submit.
    fireEvent.click(within(phaseColumn).getByText('Add ticket'));
    const form = await within(phaseColumn).findByTestId('add-ticket-form' as any);
    fireEvent.change(within(form).getByLabelText('Ticket title'), {
      target: { value: 'New ticket' },
    });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(api.createCard).toHaveBeenCalledWith('p1', {
        title: 'New ticket',
        priority: 'medium',
        columnId: 'col-backlog',
        epicId: 'e1',
        phaseId: 'ph1',
        createdBy: 'user',
      }),
    );
    await waitFor(() => expect(screen.getAllByText('New ticket').length).toBeGreaterThan(0));
  });

  it('persists the phase auto-dispatch toggle immediately, preserving other settings', async () => {
    // Regression: toggling auto-dispatch only updated local form state, so it
    // reverted on remount/refetch ("toggle doesn't stick") and the Run phase
    // button would silently no-op. Flipping the toggle must call updatePhase.
    //
    // Second regression (reviewer): the persist payload was derived from a
    // `merged` variable assigned inside the functional setState updater, which
    // React may defer — so the request could fire with only `{ autonomous }`
    // and reset the phase's other settings to defaults. Seed the phase with
    // NON-default interval/concurrency/model/send-it and assert they survive.
    const enrichedBoard = {
      ...board,
      phases: [
        {
          id: 'ph1',
          epic_id: 'e1',
          name: 'Build',
          position: 0,
          autonomous: 0,
          autonomous_interval: 9,
          autonomous_max_concurrent: 4,
          autonomous_model: 'claude-sonnet-4-6',
          autonomous_send_it: 1,
        },
      ],
    };
    (api.updatePhase as any).mockResolvedValue({ id: 'ph1', autonomous: 1 });
    (api.getBoard as any).mockResolvedValue(enrichedBoard);

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

    const toggle = await screen.findByLabelText('Auto-dispatch for Build' as any);
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(api.updatePhase).toHaveBeenCalledWith('p1', 'ph1', {
        name: 'Build',
        description: '',
        autonomous: 1,
        autonomousInterval: 9,
        autonomousMaxConcurrent: 4,
        autonomousModel: 'claude-sonnet-4-6',
        autonomousSendIt: 1,
      }),
    );
  });

  it('persists every phase setting when it changes on the feature page', async () => {
    vi.clearAllMocks();
    const enrichedBoard = {
      ...board,
      phases: [
        {
          id: 'ph1',
          epic_id: 'e1',
          name: 'Build',
          position: 0,
          autonomous: 1,
          autonomous_interval: 9,
          autonomous_max_concurrent: 4,
          autonomous_model: 'claude-sonnet-4-6',
          autonomous_send_it: 1,
        },
      ],
    };
    (api.getBoard as any).mockResolvedValue(enrichedBoard);
    (api.getModelConfig as any).mockResolvedValue({
      engineValidModels: { 'claude-code': ['claude-sonnet-4-6', 'claude-opus-4-8'] },
    });
    (api.updatePhase as any).mockResolvedValue({ id: 'ph1' });

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

    const model = await screen.findByTestId('phase-model-ph1' as any);
    fireEvent.change(model, { target: { value: 'claude-opus-4-8' } });
    await waitFor(() =>
      expect(api.updatePhase).toHaveBeenLastCalledWith('p1', 'ph1', {
        name: 'Build',
        description: '',
        autonomous: 1,
        autonomousInterval: 9,
        autonomousMaxConcurrent: 4,
        autonomousModel: 'claude-opus-4-8',
        autonomousSendIt: 1,
      }),
    );

    fireEvent.click(within(screen.getByTestId('phase-auto-merge-ph1' as any)).getByRole('switch'));
    await waitFor(() =>
      expect(api.updatePhase).toHaveBeenLastCalledWith('p1', 'ph1', {
        name: 'Build',
        description: '',
        autonomous: 1,
        autonomousInterval: 9,
        autonomousMaxConcurrent: 4,
        autonomousModel: 'claude-opus-4-8',
        autonomousSendIt: 0,
      }),
    );

    fireEvent.change(screen.getByTestId('phase-max-concurrent-ph1' as any), {
      target: { value: '3' },
    });
    await waitFor(() =>
      expect(api.updatePhase).toHaveBeenLastCalledWith('p1', 'ph1', {
        name: 'Build',
        description: '',
        autonomous: 1,
        autonomousInterval: 9,
        autonomousMaxConcurrent: 3,
        autonomousModel: 'claude-opus-4-8',
        autonomousSendIt: 0,
      }),
    );
    expect(screen.queryByText('Save phase settings')).not.toBeInTheDocument();
  });

  it('autosaves branch controls and preserves stored feature automation fields', async () => {
    const boardWithUnsetAutoMerge = {
      ...board,
      epics: [
        {
          id: 'e1',
          name: 'Platform',
          color: '#6366F1',
          description: 'Core work',
          autonomous: 1,
          autonomous_interval: 5,
          autonomous_max_concurrent: 1,
          autonomous_model: '',
          autonomous_send_it: null,
        },
      ],
    };
    (api.updateEpic as any).mockResolvedValue({ id: 'e1' });
    (api.getBoard as any).mockResolvedValue(boardWithUnsetAutoMerge);

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

    const controls = await screen.findByTestId('feature-controls' as any);
    expect(within(controls).getByText('Keep on feature branch')).toBeInTheDocument();
    expect(screen.queryByText('Enable autonomous dispatch')).not.toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();

    fireEvent.click(within(controls).getByRole('switch', { name: 'Keep on feature branch' }));
    await waitFor(() =>
      expect(screen.getByTestId('feature-pr-base-input' as any)).toHaveValue('feature/platform'),
    );

    await waitFor(() =>
      expect(api.updateEpic).toHaveBeenCalledWith(
        'p1',
        'e1',
        expect.objectContaining({
          autonomous: 1,
          autonomousSendIt: 1,
          prBaseBranch: 'feature/platform',
        }),
      ),
    );
    expect(screen.queryByTestId('feature-branch-save-button' as any)).not.toBeInTheDocument();
    expect(screen.queryByTestId('epic-save-button' as any)).not.toBeInTheDocument();
  });

  it('autosaves epic details when editing finishes without a Save button', async () => {
    vi.clearAllMocks();
    (api.getBoard as any).mockResolvedValue(board);
    (api.updateEpic as any).mockResolvedValue({ id: 'e1', name: 'Platform reliability' });

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

    const nameInput = await screen.findByTestId('epic-name-input' as any);
    fireEvent.change(nameInput, { target: { value: 'Platform reliability' } });
    fireEvent.blur(nameInput);

    await waitFor(() =>
      expect(api.updateEpic).toHaveBeenCalledWith(
        'p1',
        'e1',
        expect.objectContaining({
          name: 'Platform reliability',
          description: 'Core work',
          prBaseBranch: null,
        }),
      ),
    );
    expect(screen.queryByTestId('epic-save-button' as any)).not.toBeInTheDocument();
    expect(screen.getByTestId('epic-autosave-status' as any)).toHaveTextContent('Saved');
  });

  it('flushes a pending epic edit on unmount so navigating away within the debounce window does not lose it', async () => {
    vi.clearAllMocks();
    (api.getBoard as any).mockResolvedValue(board);
    (api.updateEpic as any).mockResolvedValue({ id: 'e1', name: 'Platform reliability' });

    const { unmount } = render(
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

    const nameInput = await screen.findByTestId('epic-name-input' as any);
    // Edit without blurring: the 500ms debounce is still pending. Unmounting
    // (navigating away) must flush it rather than drop it.
    fireEvent.change(nameInput, { target: { value: 'Platform reliability' } });
    unmount();

    await waitFor(() =>
      expect(api.updateEpic).toHaveBeenCalledWith(
        'p1',
        'e1',
        expect.objectContaining({ name: 'Platform reliability' }),
      ),
    );
  });

  it('flushes the outgoing epic when the epic id changes within the debounce window', async () => {
    vi.clearAllMocks();
    const twoEpicBoard = {
      ...board,
      epics: [
        ...board.epics,
        {
          id: 'e2',
          name: 'Second epic',
          color: '#22C55E',
          description: 'Other work',
          autonomous: 0,
          state: 'in_progress',
        },
      ],
    };
    (api.getBoard as any).mockResolvedValue(twoEpicBoard);
    (api.updateEpic as any).mockResolvedValue({ id: 'e1', name: 'Platform reliability' });

    const { rerender } = render(
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

    const nameInput = await screen.findByTestId('epic-name-input' as any);
    // Edit epic e1 (debounce pending), then switch to e2 before it fires.
    fireEvent.change(nameInput, { target: { value: 'Platform reliability' } });
    rerender(
      <EpicView
        projectId="p1"
        epicId="e2"
        project={{ name: 'P' }}
        refreshKey={0}
        onBackToBoard={vi.fn()}
        onOpenEpicsList={vi.fn()}
        onOpenEpic={vi.fn()}
      />,
    );

    // The outgoing edit is persisted against e1, not misattributed or lost.
    await waitFor(() =>
      expect(api.updateEpic).toHaveBeenCalledWith(
        'p1',
        'e1',
        expect.objectContaining({ name: 'Platform reliability' }),
      ),
    );
  });
});
