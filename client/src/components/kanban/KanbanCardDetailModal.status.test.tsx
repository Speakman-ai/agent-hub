/**
 * The card dialog (shared by the board and epic views) exposes a Status
 * dropdown so an existing card can be moved, e.g. marked Done, without
 * dragging it on the board.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import KanbanCardDetailModal from './KanbanCardDetailModal';

(vi as any).mock('../../utils/api.js', () => ({
  api: {},
}));

function buildDetail(overrides: any = {}) {
  const selectedCard = {
    id: 'card-1',
    title: 'A card',
    epic_id: 'epic-9',
    blockers: [],
  };
  return {
    selectedCard: { ...selectedCard, column_id: 'col-todo' },
    setSelectedCard: vi.fn(),
    closeDetail: vi.fn(),
    detailForm: {
      title: 'A card',
      description: '',
      priority: 'medium',
      assignee: '',
      assigned_user_id: '',
      epic_id: 'epic-9',
      labels: '',
      pr_url: '',
    },
    setDetailForm: vi.fn(),
    comments: [],
    cardReplay: null,
    watchingReplay: false,
    setWatchingReplay: vi.fn(),
    newComment: '',
    setNewComment: vi.fn(),
    saving: false,
    setSaving: vi.fn(),
    confirmDelete: false,
    setConfirmDelete: vi.fn(),
    assigning: false,
    setAssigning: vi.fn(),
    showReassign: false,
    setShowReassign: vi.fn(),
    unassigning: false,
    setUnassigning: vi.fn(),
    showBlockerPicker: false,
    setShowBlockerPicker: vi.fn(),
    blockerPickerQuery: '',
    setBlockerPickerQuery: vi.fn(),
    blockerError: '',
    setBlockerError: vi.fn(),
    descriptionEditing: false,
    setDescriptionEditing: vi.fn(),
    modelConfig: {},
    projectAgents: [],
    epics: [{ id: 'epic-9', name: 'Payments epic' }],
    cards: [],
    handleSaveDetail: vi.fn(),
    handleDeleteCard: vi.fn(),
    handleAddComment: vi.fn(),
    handleAddBlocker: vi.fn(),
    handleRemoveBlocker: vi.fn(),
    handleLinkCardEpic: vi.fn(),
    openDetail: vi.fn(),
    isCreating: false,
    cardTemplates: [],
    applyCardTemplate: vi.fn(),
    onRefresh: vi.fn(),
    onNavigateToSession: vi.fn(),
    projectId: 'proj-1',
    columns: [
      { id: 'col-todo', name: 'To Do' },
      { id: 'col-done', name: 'Done' },
    ],
    handleChangeStatus: vi.fn(),
    handleForceStatus: vi.fn(),
    statusMoving: false,
    statusError: null,
    setStatusError: vi.fn(),
    ...overrides,
  };
}

describe('<KanbanCardDetailModal /> — status selector', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the current column and moves the card on change', () => {
    const detail = buildDetail();
    render(<KanbanCardDetailModal detail={detail as any} agents={[]} />);
    const select = screen.getByTestId('card-status-select') as HTMLSelectElement;
    expect(select.value).toBe('col-todo');
    expect(screen.getByLabelText('Status')).toBe(select);
    fireEvent.change(select, { target: { value: 'col-done' } });
    expect(detail.handleChangeStatus).toHaveBeenCalledWith('col-done');
  });

  it('offers a force retry when the move was rejected as premature Done', () => {
    const detail = buildDetail({
      statusError: {
        cardId: 'card-1',
        columnId: 'col-done',
        canForce: true,
        message: 'Done is written on merge',
      },
    });
    render(<KanbanCardDetailModal detail={detail as any} agents={[]} />);
    expect(screen.getByTestId('card-status-error').textContent).toMatch(/written on merge/);
    fireEvent.click(screen.getByTestId('card-status-force'));
    expect(detail.handleForceStatus).toHaveBeenCalled();
  });

  it('hides the selector when no columns are known', () => {
    render(<KanbanCardDetailModal detail={buildDetail({ columns: [] }) as any} agents={[]} />);
    expect(screen.queryByTestId('card-status-select')).toBeNull();
  });
});
