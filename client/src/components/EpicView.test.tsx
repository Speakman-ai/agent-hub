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
    { id: 'e1', name: 'Platform', color: '#6366F1', description: 'Core work', autonomous: 0 },
  ],
  phases: [{ id: 'ph1', epic_id: 'e1', name: 'Build', position: 0 }],
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
    fireEvent.click(screen.getByTestId('manage-epic-e1' as any) as any);
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

    const nameInput = await screen.findByPlaceholderText('e.g. Platform reliability' as any);
    fireEvent.change(nameInput, { target: { value: 'Payments' } });
    fireEvent.click(screen.getByTestId('epic-create-scope-button' as any));

    await waitFor(() => expect(api.createEpic).toHaveBeenCalled());
    await waitFor(() => expect(api.scopeEpic).toHaveBeenCalledWith('p1', 'e-new'));
    await waitFor(() => expect(onNavigateToSession).toHaveBeenCalledWith('a-2', 's-2'));
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
});
