import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getNotes: vi.fn(),
    getNote: vi.fn(),
    getBoard: vi.fn(),
    createCard: vi.fn(),
  },
}));

import NotesEditor from './NotesEditor';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const NOTE = {
  id: 'note-1',
  title: 'Templates',
  content:
    '## Templates\n- Cant apply to multiple states\n  - nested detail\n- Name has to be unique',
  updated_at: '2026-07-09T00:00:00',
  created_at: '2026-07-09T00:00:00',
};

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.getNotes.mockResolvedValue([
    { id: NOTE.id, title: NOTE.title, updated_at: NOTE.updated_at },
  ]);
  mockApi.getNote.mockResolvedValue(NOTE);
  mockApi.getBoard.mockResolvedValue({
    columns: [
      { id: 'col-todo', name: 'To Do' },
      { id: 'col-doing', name: 'In Progress' },
    ],
  });
  mockApi.createCard.mockResolvedValue({ id: 'card-1', title: 'Cant apply to multiple states' });
});

afterEach(() => vi.restoreAllMocks());

async function openNote() {
  render(<NotesEditor projectId="proj-1" />);
  await waitFor(() => expect(screen.getByText('Templates')).toBeTruthy());
  fireEvent.click(screen.getByText('Templates'));
  await waitFor(() => expect(mockApi.getNote).toHaveBeenCalledWith('proj-1', 'note-1'));
}

describe('NotesEditor — convert line item to ticket', () => {
  it('creates a To Do card from a bullet using its own text (excluding nested sub-bullets)', async () => {
    await openNote();
    // Each list item (parent AND nested) gets its own button, disambiguated by aria-label.
    const btn = await screen.findByLabelText(
      'Convert "Cant apply to multiple states" into a To Do ticket',
    );
    fireEvent.click(btn);

    await waitFor(() => expect(mockApi.createCard).toHaveBeenCalledTimes(1));
    const [projectId, payload] = mockApi.createCard.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(payload.columnId).toBe('col-todo');
    // Uses the bullet's own text only — nested detail is NOT appended.
    expect(payload.title).toBe('Cant apply to multiple states');
    expect(payload.title).not.toContain('nested detail');

    await waitFor(() => expect(screen.getByText(/Ticket created:/i)).toBeTruthy());
  });

  it('a nested sub-bullet converts to its own ticket', async () => {
    await openNote();
    const btn = await screen.findByLabelText('Convert "nested detail" into a To Do ticket');
    fireEvent.click(btn);
    await waitFor(() => expect(mockApi.createCard).toHaveBeenCalledTimes(1));
    expect(mockApi.createCard.mock.calls[0][1].title).toBe('nested detail');
  });

  it('falls back to the first column when there is no "To Do" column', async () => {
    mockApi.getBoard.mockResolvedValue({ columns: [{ id: 'col-x', name: 'Backlog' }] });
    await openNote();
    const btn = await screen.findByLabelText('Convert "Name has to be unique" into a To Do ticket');
    fireEvent.click(btn);
    await waitFor(() => expect(mockApi.createCard).toHaveBeenCalledTimes(1));
    expect(mockApi.createCard.mock.calls[0][1].columnId).toBe('col-x');
    expect(mockApi.createCard.mock.calls[0][1].title).toBe('Name has to be unique');
  });
});
