/**
 * "Open Session" on a card linked to a session. Regression: the button resolved
 * the agent only by matching the card's assignee name, so cards linked at
 * creation (session_id set, assignee null) silently did nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getSession: vi.fn() }));
(vi as any).mock('../../utils/api.js', () => ({ api: apiMock }));

import KanbanCardDetailModal from './KanbanCardDetailModal';

function buildDetail(card: Record<string, unknown>, onNavigateToSession = vi.fn()) {
  const noop = vi.fn();
  return {
    selectedCard: { id: 'card-1', title: 'A card', blockers: [], ...card },
    setSelectedCard: noop,
    closeDetail: noop,
    detailForm: {
      title: 'A card',
      description: '',
      priority: 'medium',
      assignee: (card.assignee as string) || '',
      assigned_user_id: '',
      epic_id: '',
      labels: '',
      pr_url: '',
    },
    setDetailForm: noop,
    comments: [],
    cardReplay: null,
    watchingReplay: false,
    setWatchingReplay: noop,
    newComment: '',
    setNewComment: noop,
    saving: false,
    setSaving: noop,
    confirmDelete: false,
    setConfirmDelete: noop,
    assigning: false,
    setAssigning: noop,
    showReassign: false,
    setShowReassign: noop,
    unassigning: false,
    setUnassigning: noop,
    showBlockerPicker: false,
    setShowBlockerPicker: noop,
    blockerPickerQuery: '',
    setBlockerPickerQuery: noop,
    blockerError: '',
    setBlockerError: noop,
    descriptionEditing: false,
    setDescriptionEditing: noop,
    modelConfig: {},
    projectAgents: [],
    epics: [],
    cards: [],
    handleSaveDetail: noop,
    handleDeleteCard: noop,
    handleAddComment: noop,
    handleAddBlocker: noop,
    handleRemoveBlocker: noop,
    handleLinkCardEpic: noop,
    openDetail: noop,
    isCreating: false,
    cardTemplates: [],
    applyCardTemplate: noop,
    onRefresh: noop,
    onNavigateToSession,
    projectId: 'proj-1',
    columns: [],
  };
}

const AGENTS = [{ id: 'agent-hub-dev', name: 'Agent Hub Dev' }];

describe('<KanbanCardDetailModal /> — Open Session', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('uses the assignee agent when the card has one', () => {
    const nav = vi.fn();
    render(
      <KanbanCardDetailModal
        detail={buildDetail({ session_id: 'sess-1', assignee: 'Agent Hub Dev' }, nav) as any}
        agents={AGENTS}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Session' }));
    expect(nav).toHaveBeenCalledWith('agent-hub-dev', 'sess-1');
    expect(apiMock.getSession).not.toHaveBeenCalled();
  });

  it('falls back to the session agent when the card has no assignee', async () => {
    const nav = vi.fn();
    apiMock.getSession.mockResolvedValue({ id: 'sess-2', agent_id: 'agent-hub-dev' });
    render(
      <KanbanCardDetailModal
        detail={buildDetail({ session_id: 'sess-2', assignee: null }, nav) as any}
        agents={AGENTS}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Session' }));
    await waitFor(() => expect(nav).toHaveBeenCalledWith('agent-hub-dev', 'sess-2'));
    expect(apiMock.getSession).toHaveBeenCalledWith('sess-2');
  });
});
