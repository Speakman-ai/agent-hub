import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useKanbanCardDetail } from './useKanbanCardDetail';
import { api } from '../utils/api';

vi.mock('../utils/api.js', () => ({
  api: {
    getModelConfig: vi.fn().mockResolvedValue({ engineValidModels: {} }),
    getCardComments: vi.fn().mockResolvedValue([]),
    getCardReplay: vi.fn().mockResolvedValue(null),
    updateCard: vi.fn().mockResolvedValue({ id: 'c1', epic_id: 'e2', phase_id: null }),
    linkCardToEpic: vi.fn().mockResolvedValue({}),
  },
}));

describe('useKanbanCardDetail — handleLinkCardEpic', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes the epic change through updateCard and clears the stale phase', async () => {
    const onRefresh = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() =>
      useKanbanCardDetail({ projectId: 'p1', cards: [], onRefresh }),
    );

    // Select a phase-scoped card, then move it to a different epic.
    act(() => {
      result.current.openDetail({ id: 'c1', epic_id: 'e1', phase_id: 'ph1', title: 'T' });
    });

    await act(async () => {
      await result.current.handleLinkCardEpic('e2');
    });

    // Must use the reconciled update-card path (which clears phase_id), NOT the
    // legacy link endpoint that would leave the card split-scoped.
    expect(api.updateCard).toHaveBeenCalledWith('p1', 'c1', { epicId: 'e2', phaseId: null });
    expect(api.linkCardToEpic).not.toHaveBeenCalled();
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('clears the epic (and phase) when an empty epic is chosen', async () => {
    const onRefresh = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() =>
      useKanbanCardDetail({ projectId: 'p1', cards: [], onRefresh }),
    );

    act(() => {
      result.current.openDetail({ id: 'c9', epic_id: 'e1', phase_id: 'ph1', title: 'T' });
    });

    await act(async () => {
      await result.current.handleLinkCardEpic('');
    });

    expect(api.updateCard).toHaveBeenCalledWith('p1', 'c9', { epicId: null, phaseId: null });
  });
});
