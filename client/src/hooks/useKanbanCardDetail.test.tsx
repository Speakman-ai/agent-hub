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
    createCard: vi.fn().mockResolvedValue({ id: 'new-1' }),
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

describe('useKanbanCardDetail — create mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('openCreateDetail opens a blank draft and createCard on save', async () => {
    const onRefresh = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() =>
      useKanbanCardDetail({
        projectId: 'p1',
        cards: [],
        columns: [{ id: 'col-todo', name: 'To Do' }],
        onRefresh,
      }),
    );

    act(() => {
      result.current.openCreateDetail('col-todo', { epicId: 'e1' });
    });

    expect(result.current.isCreating).toBe(true);
    expect(result.current.detailForm.title).toBe('');
    expect(result.current.detailForm.epic_id).toBe('e1');
    expect(api.getCardComments).not.toHaveBeenCalled();

    act(() => {
      result.current.setDetailForm((f) => ({
        ...f,
        title: 'New feature',
        description: 'Details',
        priority: 'high',
      }));
    });

    await act(async () => {
      await result.current.handleSaveDetail();
    });

    expect(api.createCard).toHaveBeenCalledWith('p1', {
      title: 'New feature',
      description: 'Details',
      priority: 'high',
      labels: null,
      columnId: 'col-todo',
      createdBy: 'user',
      epicId: 'e1',
      githubIssueUrl: null,
      assignee: null,
      assignedUserId: null,
    });
    expect(onRefresh).toHaveBeenCalled();
    expect(result.current.selectedCard).toBeNull();
  });

  it('keeps the created card selected when the follow-up PR URL update fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    (api.createCard as any).mockResolvedValue({ id: 'new-1' });
    (api.updateCard as any)
      .mockRejectedValueOnce(new Error('pr url failed'))
      .mockResolvedValueOnce({ id: 'new-1' });
    const { result } = renderHook(() =>
      useKanbanCardDetail({
        projectId: 'p1',
        cards: [],
        columns: [{ id: 'col-todo', name: 'To Do' }],
      }),
    );

    act(() => {
      result.current.openCreateDetail('col-todo');
      result.current.setDetailForm((f) => ({
        ...f,
        title: 'New feature',
        pr_url: 'https://example.test/pr/1',
      }));
    });

    await act(async () => {
      await result.current.handleSaveDetail();
    });

    expect(api.createCard).toHaveBeenCalledTimes(1);
    expect(api.updateCard).toHaveBeenCalledWith('p1', 'new-1', {
      prUrl: 'https://example.test/pr/1',
    });
    expect(result.current.selectedCard).toMatchObject({ id: 'new-1' });
    expect(result.current.isCreating).toBe(false);

    await act(async () => {
      await result.current.handleSaveDetail();
    });

    expect(api.createCard).toHaveBeenCalledTimes(1);
    expect(api.updateCard).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it('handleLinkCardEpic updates the draft form without calling the API', async () => {
    const { result } = renderHook(() =>
      useKanbanCardDetail({ projectId: 'p1', cards: [], columns: [] }),
    );

    act(() => {
      result.current.openCreateDetail('col-todo');
    });

    await act(async () => {
      await result.current.handleLinkCardEpic('e3');
    });

    expect(result.current.detailForm.epic_id).toBe('e3');
    expect(api.updateCard).not.toHaveBeenCalled();
  });

  it('applyCardTemplate fills the draft form while creating', () => {
    const { result } = renderHook(() =>
      useKanbanCardDetail({ projectId: 'p1', cards: [], columns: [] }),
    );

    act(() => {
      result.current.openCreateDetail('col-todo');
    });

    act(() => {
      result.current.applyCardTemplate({
        id: 't1',
        name: 'Bug',
        title: 'Fix login',
        description: 'Steps',
        priority: 'high',
        labels: 'bug',
        epicId: 'e1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    expect(result.current.detailForm.title).toBe('Fix login');
    expect(result.current.detailForm.description).toBe('Steps');
    expect(result.current.detailForm.priority).toBe('high');
  });
});
