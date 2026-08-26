/**
 * The card detail modal exposes the linked epic as a clickable "Open epic"
 * control, not just an assignment dropdown. Clicking it calls onOpenEpic with
 * the card's epic_id so the caller can navigate to the epic view. Regression:
 * previously the epic was assign-only, so a card gave no way to open its epic.
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
    selectedCard,
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
    columns: [],
    ...overrides,
  };
}

describe('<KanbanCardDetailModal /> — epic link', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders an Open epic control and calls onOpenEpic with the card epic id', () => {
    const onOpenEpic = vi.fn();
    render(
      <KanbanCardDetailModal detail={buildDetail() as any} agents={[]} onOpenEpic={onOpenEpic} />,
    );

    const openEpic = screen.getByRole('button', { name: /open epic/i });
    fireEvent.click(openEpic);
    expect(onOpenEpic).toHaveBeenCalledWith('epic-9');
  });

  it('hides the Open epic control when the card has no epic', () => {
    const onOpenEpic = vi.fn();
    const detail = buildDetail({
      selectedCard: { id: 'card-2', title: 'No epic', epic_id: null, blockers: [] },
      detailForm: {
        title: 'No epic',
        description: '',
        priority: 'medium',
        assignee: '',
        assigned_user_id: '',
        epic_id: '',
        labels: '',
        pr_url: '',
      },
    });
    render(<KanbanCardDetailModal detail={detail as any} agents={[]} onOpenEpic={onOpenEpic} />);
    expect(screen.queryByRole('button', { name: /open epic/i })).toBeNull();
  });

  it('hides the Open epic control when no onOpenEpic handler is provided', () => {
    render(<KanbanCardDetailModal detail={buildDetail() as any} agents={[]} />);
    expect(screen.queryByRole('button', { name: /open epic/i })).toBeNull();
  });
});
