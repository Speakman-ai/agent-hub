import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getNotes: vi.fn(),
    getNote: vi.fn(),
    updateNote: vi.fn(),
  },
}));

import NotesEditor from './NotesEditor';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const MINE = {
  id: 'note-1',
  title: 'Standup',
  content: 'notes',
  shared: false,
  can_manage: true,
  owner_username: 'me',
  updated_at: '2026-09-30T00:00:00',
  created_at: '2026-09-30T00:00:00',
};

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.getNotes.mockResolvedValue([MINE]);
  mockApi.getNote.mockResolvedValue(MINE);
  mockApi.updateNote.mockResolvedValue({ ...MINE, shared: true });
});

afterEach(() => vi.restoreAllMocks());

async function open(title: string) {
  render(<NotesEditor projectId="proj-1" />);
  await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
  fireEvent.click(screen.getByText(title));
}

describe('NotesEditor — sharing toggle', () => {
  it('marks private notes in the list and shares one on click', async () => {
    await open('Standup');
    expect(screen.getByLabelText('Private note')).toBeTruthy();
    fireEvent.mouseEnter(screen.getAllByText('Standup')[0]);
    expect(screen.getByTitle('Delete note')).toBeTruthy();

    const toggle = await screen.findByRole('button', { name: /Private note\. Toggle sharing/ });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockApi.updateNote).toHaveBeenCalledWith('proj-1', 'note-1', { shared: true }),
    );
    await screen.findByRole('button', { name: /Shared note\. Toggle sharing/ });
  });

  it('shows a teammate’s shared note read-only with its owner and no delete', async () => {
    const theirs = { ...MINE, shared: true, can_manage: false, owner_username: 'alice' };
    mockApi.getNotes.mockResolvedValue([theirs]);
    mockApi.getNote.mockResolvedValue(theirs);
    await open('Standup');

    expect(screen.getByText('by alice')).toBeTruthy();
    const pill = await screen.findByRole('button', { name: 'Shared note' });
    expect((pill as HTMLButtonElement).disabled).toBe(true);
    fireEvent.mouseEnter(screen.getAllByText('Standup')[0]);
    expect(screen.queryByTitle('Delete note')).toBeNull();
  });

  it('closes an open note once the owner makes it private', async () => {
    await open('Standup');
    await screen.findByRole('heading', { name: 'Standup' });
    mockApi.getNote.mockRejectedValue(new Error('Note not found'));
    mockApi.getNotes.mockResolvedValue([]);
    window.dispatchEvent(
      new CustomEvent('note_update', { detail: { projectId: 'proj-1', note: { id: 'note-1' } } }),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Standup' })).toBeNull());
  });
});
