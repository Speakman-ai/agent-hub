import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import KanbanBoard from './KanbanBoard.jsx';
import { api } from '../utils/api.js';

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

vi.mock('../utils/api.js', () => ({
  api: {
    getBoard: vi.fn(),
    get: vi.fn(),
    getCardComments: vi.fn(),
    moveCard: vi.fn(),
    updateCard: vi.fn(),
    deleteCard: vi.fn(),
    addCardComment: vi.fn(),
    linkCardToEpic: vi.fn(),
    assignCard: vi.fn(),
  },
}));

const makeBoard = (cards = []) => ({
  board: { id: 'b1' },
  columns: [
    { id: 'col-todo', name: 'Todo', color: '#6b7280', position: 0 },
    { id: 'col-done', name: 'Done', color: '#22c55e', position: 1 },
  ],
  cards,
  epics: [],
});

describe('KanbanBoard background refresh', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.get.mockResolvedValue([]);
  });

  it('shows "Loading board..." on initial mount, then renders the board', async () => {
    api.getBoard.mockResolvedValueOnce(
      makeBoard([{ id: 1, title: 'First card', column_id: 'col-todo', position: 0 }]),
    );

    render(<KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />);

    expect(screen.getByText(/Loading board/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('First card')).toBeInTheDocument());
    expect(screen.queryByText(/Loading board/i)).not.toBeInTheDocument();
  });

  it('does NOT flash the loading screen when refreshKey bumps (WebSocket refresh)', async () => {
    api.getBoard.mockResolvedValueOnce(
      makeBoard([{ id: 1, title: 'Card A', column_id: 'col-todo', position: 0 }]),
    );

    const { rerender } = render(
      <KanbanBoard projectId="p1" project={{ name: 'P' }} refreshKey={0} />,
    );
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());

    // Simulate a WebSocket-triggered refresh: parent bumps refreshKey with
    // an updated board payload (e.g. the card has moved columns on the
    // server after another client edited it).
    api.getBoard.mockResolvedValueOnce(
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

describe('KanbanBoard card detail modal', () => {
  beforeEach(() => {
    api.getBoard.mockReset();
    api.get.mockReset();
    api.getCardComments.mockReset();
    api.get.mockResolvedValue([]);
    api.getCardComments.mockResolvedValue([]);
  });

  it('renders the card detail as a centered modal with sidebar metadata (not a right slide-over)', async () => {
    api.getBoard.mockResolvedValue(
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
    fireEvent.click(screen.getByText('A big card'));

    // Modal is rendered and uses a centered-modal layout, not a right slide-over.
    const modal = await screen.findByTestId('card-detail-modal');
    expect(modal.className).toMatch(/items-center/);
    expect(modal.className).toMatch(/justify-center/);
    expect(modal.className).not.toMatch(/justify-end/);

    // The description textarea has a larger row count than the old (rows=4).
    const description = within(modal).getByPlaceholderText(/add a description/i);
    expect(description.tagName).toBe('TEXTAREA');
    expect(Number(description.getAttribute('rows'))).toBeGreaterThanOrEqual(10);

    // Sidebar contains the metadata labels.
    expect(within(modal).getByText(/^Priority$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Assignee$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Epic$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/^Labels$/i)).toBeInTheDocument();
    expect(within(modal).getByText(/GitHub Issue URL/i)).toBeInTheDocument();
    expect(within(modal).getByText(/Pull Request/i)).toBeInTheDocument();
  });
});
