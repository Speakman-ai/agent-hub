import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SessionScopingModePane from './SessionScopingModePane';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getBoard: vi.fn(),
    updatePhase: vi.fn().mockResolvedValue({}),
    runPhase: vi.fn().mockResolvedValue({}),
    stopPhase: vi.fn().mockResolvedValue({}),
    runAutonomous: vi.fn().mockResolvedValue({}),
    createCard: vi.fn(),
    updateCard: vi.fn(),
    createPhase: vi.fn(),
    createSpecItem: vi.fn(),
    updateSpecItem: vi.fn(),
    decideSpecForMe: vi.fn(),
    getModelConfig: vi.fn(),
  },
}));

function boardWith(phaseOverrides: Record<string, any> = {}) {
  return {
    columns: [
      { id: 'col-todo', name: 'To Do', position: 0 },
      { id: 'col-done', name: 'Done', position: 1 },
    ],
    cards: [],
    epics: [{ id: 'e1', name: 'Platform', color: '#6366F1', autonomous: 0 }],
    phases: [
      {
        id: 'ph1',
        epic_id: 'e1',
        name: 'Build',
        position: 0,
        autonomous: 1,
        autonomous_max_concurrent: 2,
        ...phaseOverrides,
      },
    ],
    specItems: [],
  };
}

describe('SessionScopingModePane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.createPhase as any).mockResolvedValue({});
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {
        'claude-code': 'claude-opus-4-8',
        'codex-cli': 'gpt-5.5',
      },
      engineValidModels: {
        'claude-code': ['claude-opus-4-8'],
        'codex-cli': ['gpt-5.5', 'gpt-5.4'],
      },
    });
  });

  it('runs a specific phase via runPhase, not the board-wide runAutonomous', async () => {
    (api.getBoard as any).mockResolvedValue(boardWith({ autonomous_running: 0 }));

    render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId="e1"
        onLinkEpic={vi.fn()}
      />,
    );

    const runButton = await screen.findByText('Run phase');
    fireEvent.click(runButton);

    await waitFor(() => expect(api.runPhase).toHaveBeenCalledWith('p1', 'ph1'));
    expect(api.updatePhase).toHaveBeenCalled();
    // The bug: side pane called the board-wide endpoint instead of the phase one.
    expect(api.runAutonomous).not.toHaveBeenCalled();
  });

  it('stops a running phase via stopPhase', async () => {
    (api.getBoard as any).mockResolvedValue(boardWith({ autonomous_running: 1 }));

    render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId="e1"
        onLinkEpic={vi.fn()}
      />,
    );

    const stopButton = await screen.findByTestId('stop-phase-ph1' as any);
    fireEvent.click(stopButton);

    await waitFor(() => expect(api.stopPhase).toHaveBeenCalledWith('p1', 'ph1'));
    expect(api.runAutonomous).not.toHaveBeenCalled();
  });

  it('assigns an unphased ticket to a phase from the compact workbench', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...boardWith(),
      cards: [
        {
          id: 'ticket-1',
          title: 'Unphased ticket',
          column_id: 'col-todo',
          epic_id: 'e1',
          phase_id: null,
        },
      ],
    });
    (api.updateCard as any).mockResolvedValue({});

    render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId="e1"
        onLinkEpic={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('unassigned-tickets')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('assign-phase-ticket-1'), {
      target: { value: 'ph1' },
    });

    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith('p1', 'ticket-1', { phaseId: 'ph1' }),
    );
  });

  it('shows an error when compact phase assignment fails', async () => {
    (api.getBoard as any).mockResolvedValue({
      ...boardWith(),
      cards: [
        {
          id: 'ticket-1',
          title: 'Unphased ticket',
          column_id: 'col-todo',
          epic_id: 'e1',
          phase_id: null,
        },
      ],
    });
    (api.updateCard as any).mockRejectedValue(new Error('Compact assignment failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId="e1"
        onLinkEpic={vi.fn()}
      />,
    );

    fireEvent.change(await screen.findByTestId('assign-phase-ticket-1'), {
      target: { value: 'ph1' },
    });

    await waitFor(() => expect(screen.getByText('Compact assignment failed')).toBeInTheDocument());
    consoleError.mockRestore();
  });

  it('auto-selects a newly created epic when nothing is linked yet', async () => {
    (api.getBoard as any)
      .mockResolvedValueOnce({
        columns: [{ id: 'col-todo', name: 'To Do', position: 0 }],
        cards: [],
        epics: [
          { id: 'e1', name: 'Platform', color: '#6366F1', created_at: '2026-07-01 00:00:00' },
        ],
        phases: [],
        specItems: [],
      })
      .mockResolvedValueOnce({
        columns: [{ id: 'col-todo', name: 'To Do', position: 0 }],
        cards: [],
        epics: [
          { id: 'e1', name: 'Platform', color: '#6366F1', created_at: '2026-07-01 00:00:00' },
          { id: 'e2', name: 'New Epic', color: '#22C55E', created_at: '2026-07-08 12:00:00' },
        ],
        phases: [],
        specItems: [],
      });

    const onLinkEpic = vi.fn();
    const { rerender } = render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId={null}
        onLinkEpic={onLinkEpic}
        reloadToken={0}
      />,
    );

    // First board load seeds the baseline — no auto-select over pre-existing epics.
    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(1));
    expect(onLinkEpic).not.toHaveBeenCalled();

    // A new epic appears on the next board refresh → auto-linked.
    rerender(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId={null}
        onLinkEpic={onLinkEpic}
        reloadToken={1}
      />,
    );

    await waitFor(() => expect(onLinkEpic).toHaveBeenCalledWith('e2'));
  });

  it('does not override an already-linked epic when a new epic appears', async () => {
    (api.getBoard as any).mockResolvedValueOnce(boardWith()).mockResolvedValueOnce({
      ...boardWith(),
      epics: [
        { id: 'e1', name: 'Platform', color: '#6366F1' },
        { id: 'e2', name: 'Another', color: '#22C55E', created_at: '2026-07-08 12:00:00' },
      ],
    });

    const onLinkEpic = vi.fn();
    const { rerender } = render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId="e1"
        onLinkEpic={onLinkEpic}
        reloadToken={0}
      />,
    );

    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(1));

    rerender(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId="e1"
        onLinkEpic={onLinkEpic}
        reloadToken={1}
      />,
    );

    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(2));
    expect(onLinkEpic).not.toHaveBeenCalled();
  });

  it('re-seeds on session switch instead of auto-linking a prior session baseline', async () => {
    // s1 board has only e1; s2's refetch surfaces e1 + e2. Without the
    // session-switch reset, e2 would look "new" relative to s1's baseline and
    // get auto-linked — this guards that defensive branch.
    (api.getBoard as any)
      .mockResolvedValueOnce({
        columns: [{ id: 'col-todo', name: 'To Do', position: 0 }],
        cards: [],
        epics: [
          { id: 'e1', name: 'Platform', color: '#6366F1', created_at: '2026-07-01 00:00:00' },
        ],
        phases: [],
        specItems: [],
      })
      .mockResolvedValueOnce({
        columns: [{ id: 'col-todo', name: 'To Do', position: 0 }],
        cards: [],
        epics: [
          { id: 'e1', name: 'Platform', color: '#6366F1', created_at: '2026-07-01 00:00:00' },
          { id: 'e2', name: 'Foreign', color: '#22C55E', created_at: '2026-07-08 12:00:00' },
        ],
        phases: [],
        specItems: [],
      });

    const onLinkEpic = vi.fn();
    const { rerender } = render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId="e1"
        onLinkEpic={onLinkEpic}
        reloadToken={0}
      />,
    );

    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(1));

    // Switch to a different session with no linked epic; its board refetch
    // brings a new epic e2. The reset effect re-seeds → no auto-link.
    rerender(
      <SessionScopingModePane
        sessionId="s2"
        projectId="p1"
        linkedEpicId={null}
        onLinkEpic={onLinkEpic}
        reloadToken={1}
      />,
    );

    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(2));
    expect(onLinkEpic).not.toHaveBeenCalled();
  });

  it('links the most recently created epic when several appear in one refresh', async () => {
    (api.getBoard as any)
      .mockResolvedValueOnce({
        columns: [{ id: 'col-todo', name: 'To Do', position: 0 }],
        cards: [],
        epics: [],
        phases: [],
        specItems: [],
      })
      .mockResolvedValueOnce({
        columns: [{ id: 'col-todo', name: 'To Do', position: 0 }],
        cards: [],
        epics: [
          // Deliberately unordered so the tie-break can't pass by array position.
          { id: 'older', name: 'Older', color: '#6366F1', created_at: '2026-07-08 09:00:00' },
          { id: 'newest', name: 'Newest', color: '#22C55E', created_at: '2026-07-08 15:30:00' },
          { id: 'middle', name: 'Middle', color: '#EAB308', created_at: '2026-07-08 12:00:00' },
        ],
        phases: [],
        specItems: [],
      });

    const onLinkEpic = vi.fn();
    const { rerender } = render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId={null}
        onLinkEpic={onLinkEpic}
        reloadToken={0}
      />,
    );

    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(1));
    expect(onLinkEpic).not.toHaveBeenCalled();

    rerender(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId={null}
        onLinkEpic={onLinkEpic}
        reloadToken={1}
      />,
    );

    await waitFor(() => expect(onLinkEpic).toHaveBeenCalledWith('newest'));
    expect(onLinkEpic).toHaveBeenCalledTimes(1);
  });

  it('creates phases with the current session owner agent default model', async () => {
    (api.getBoard as any).mockResolvedValue(boardWith({ autonomous_running: 0 }));

    render(
      <SessionScopingModePane
        sessionId="s1"
        projectId="p1"
        linkedEpicId="e1"
        agent={{ id: 'agent-a', engine: 'codex-cli' }}
        sessionEngine="codex-cli"
        sessionModel="gpt-5.4"
        onLinkEpic={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add phase' }));
    fireEvent.change(screen.getByPlaceholderText('Phase name'), {
      target: { value: 'Implementation' },
    });
    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    fireEvent.click(addButtons[addButtons.length - 1]);

    await waitFor(() =>
      expect(api.createPhase).toHaveBeenCalledWith('p1', {
        epicId: 'e1',
        name: 'Implementation',
        agentId: 'agent-a',
        autonomousModel: 'gpt-5.4',
      }),
    );
  });
});
