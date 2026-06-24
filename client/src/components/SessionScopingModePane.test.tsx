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
    createPhase: vi.fn(),
    createSpecItem: vi.fn(),
    updateSpecItem: vi.fn(),
    decideSpecForMe: vi.fn(),
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
});
