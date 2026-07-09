import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getNotes: vi.fn(),
    getNote: vi.fn(),
    scopeFromNotes: vi.fn(),
  },
}));

import NotesEditor from './NotesEditor';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const NOTE = {
  id: 'note-1',
  title: 'Inspections',
  content:
    '# Title 1\n- under title 1\n\n## Title 2\n- under title 2\n\n# Title 3\n- under title 3',
  updated_at: '2026-07-09T00:00:00',
  created_at: '2026-07-09T00:00:00',
};

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.getNotes.mockResolvedValue([
    { id: NOTE.id, title: NOTE.title, updated_at: NOTE.updated_at },
  ]);
  mockApi.getNote.mockResolvedValue(NOTE);
  mockApi.scopeFromNotes.mockResolvedValue({ sessionId: 'sess-abcdef12', agentId: 'a1' });
});

afterEach(() => vi.restoreAllMocks());

async function openNote() {
  render(<NotesEditor projectId="proj-1" />);
  await waitFor(() => expect(screen.getByText('Inspections')).toBeTruthy());
  fireEvent.click(screen.getByText('Inspections'));
  await waitFor(() => expect(mockApi.getNote).toHaveBeenCalledWith('proj-1', 'note-1'));
}

describe('NotesEditor — scope from notes', () => {
  it('whole-note Scope button posts the full note content and title', async () => {
    await openNote();
    // The header "Scope" button (whole note).
    const scopeBtn = await screen.findByTitle(/Scope this whole note/i);
    fireEvent.click(scopeBtn);
    await waitFor(() => expect(mockApi.scopeFromNotes).toHaveBeenCalledTimes(1));
    const [projectId, payload] = mockApi.scopeFromNotes.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(payload.title).toBe('Inspections');
    expect(payload.content).toContain('# Title 1');
    expect(payload.content).toContain('# Title 3');
    // Success feedback surfaces the session id.
    await waitFor(() => expect(screen.getByText(/Scoping session started/i)).toBeTruthy());
  });

  it('a heading Scope button slices only that section (H1 includes nested H2)', async () => {
    await openNote();
    // Each rendered heading gets its own "Scope" button (text "Scope").
    const headingScopeButtons = await screen.findAllByTitle(/Scope everything under this heading/i);
    // Title 1 (first) → includes its nested "## Title 2" but not "# Title 3".
    fireEvent.click(headingScopeButtons[0]);
    await waitFor(() => expect(mockApi.scopeFromNotes).toHaveBeenCalledTimes(1));
    const payload = mockApi.scopeFromNotes.mock.calls[0][1];
    expect(payload.title).toBe('Title 1');
    expect(payload.content).toContain('Title 1');
    expect(payload.content).toContain('Title 2');
    expect(payload.content).not.toContain('Title 3');
  });
});
