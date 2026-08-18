import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getNotes: vi.fn(),
    getNote: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    getBoard: vi.fn(),
    createCard: vi.fn(),
  },
}));

import NotesEditor, { deriveNoteTitle } from './NotesEditor';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

let noteSeq = 0;

beforeEach(() => {
  vi.useFakeTimers();
  noteSeq = 0;
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.getNotes.mockResolvedValue([]);
  mockApi.getNote.mockResolvedValue(null);
  mockApi.createNote.mockImplementation(async (_pid: string, data: any) => ({
    id: `note-${++noteSeq}`,
    title: data.title,
    content: data.content,
    created_at: '2026-08-18T00:00:00',
    updated_at: '2026-08-18T00:00:00',
  }));
  mockApi.updateNote.mockImplementation(async (_pid: string, id: string, data: any) => ({
    id,
    title: data.title,
    content: data.content,
    created_at: '2026-08-18T00:00:00',
    updated_at: '2026-08-18T00:00:01',
  }));
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush() {
  // Advance past the 700ms auto-save debounce, then let the async save settle.
  await act(async () => {
    vi.advanceTimersByTime(750);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function startNewNote() {
  render(<NotesEditor projectId="proj-1" />);
  fireEvent.click(screen.getByTitle('New Note'));
}

describe('deriveNoteTitle', () => {
  it('prefers the typed title', () => {
    expect(deriveNoteTitle('My Title', 'body')).toBe('My Title');
  });
  it('derives from the first non-blank content line, stripping heading marks', () => {
    expect(deriveNoteTitle('', '\n## Shopping list\nmilk')).toBe('Shopping list');
  });
  it('falls back to Untitled when nothing usable', () => {
    expect(deriveNoteTitle('   ', '   \n\n')).toBe('Untitled');
  });
});

describe('NotesEditor — auto-create + debounced auto-save', () => {
  it('auto-creates a new note when you start typing (no Create click)', async () => {
    startNewNote();
    const title = screen.getByPlaceholderText('Note title...');
    fireEvent.change(title, { target: { value: 'Grocery' } });

    expect(mockApi.createNote).not.toHaveBeenCalled(); // still debouncing
    await flush();

    expect(mockApi.createNote).toHaveBeenCalledTimes(1);
    expect(mockApi.createNote).toHaveBeenCalledWith('proj-1', {
      title: 'Grocery',
      content: '',
    });
  });

  it('coalesces rapid keystrokes into a single create', async () => {
    startNewNote();
    const title = screen.getByPlaceholderText('Note title...');
    fireEvent.change(title, { target: { value: 'G' } });
    fireEvent.change(title, { target: { value: 'Gr' } });
    fireEvent.change(title, { target: { value: 'Gro' } });
    await flush();

    expect(mockApi.createNote).toHaveBeenCalledTimes(1);
    expect(mockApi.createNote.mock.calls[0][1]).toMatchObject({ title: 'Gro' });
  });

  it('derives a title when only content is typed', async () => {
    startNewNote();
    const body = screen.getByPlaceholderText(/Start writing/);
    fireEvent.change(body, { target: { value: 'first line\nsecond' } });
    await flush();

    expect(mockApi.createNote).toHaveBeenCalledTimes(1);
    expect(mockApi.createNote.mock.calls[0][1]).toMatchObject({
      title: 'first line',
      content: 'first line\nsecond',
    });
  });

  it('switches to debounced updates after the initial create — no duplicate creates', async () => {
    startNewNote();
    const title = screen.getByPlaceholderText('Note title...');
    fireEvent.change(title, { target: { value: 'Note A' } });
    await flush();
    expect(mockApi.createNote).toHaveBeenCalledTimes(1);

    const body = screen.getByPlaceholderText(/Start writing/);
    fireEvent.change(body, { target: { value: 'more text' } });
    await flush();

    expect(mockApi.createNote).toHaveBeenCalledTimes(1);
    expect(mockApi.updateNote).toHaveBeenCalledTimes(1);
    expect(mockApi.updateNote.mock.calls[0]).toEqual([
      'proj-1',
      'note-1',
      { title: 'Note A', content: 'more text' },
    ]);
  });

  it('does not create anything when nothing is typed', async () => {
    startNewNote();
    await flush();
    expect(mockApi.createNote).not.toHaveBeenCalled();
  });

  it('does not hijack selection when the user navigates away before create resolves', async () => {
    mockApi.getNotes.mockResolvedValue([
      { id: 'existing-1', title: 'Existing', updated_at: '2026-08-18T00:00:00' },
    ]);
    mockApi.getNote.mockResolvedValue({
      id: 'existing-1',
      title: 'Existing',
      content: 'existing body',
      created_at: '2026-08-18T00:00:00',
      updated_at: '2026-08-18T00:00:00',
    });
    let resolveCreate: (v: any) => void = () => {};
    mockApi.createNote.mockReturnValue(
      new Promise((res) => {
        resolveCreate = res;
      }),
    );

    render(<NotesEditor projectId="proj-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Existing')).toBeTruthy();

    fireEvent.click(screen.getByTitle('New Note'));
    fireEvent.change(screen.getByPlaceholderText('Note title...'), { target: { value: 'Draft' } });

    // Kick off the debounced create; it is now in flight and unresolved.
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(mockApi.createNote).toHaveBeenCalledTimes(1);

    // User navigates to an existing note before the create resolves.
    fireEvent.click(screen.getByText('Existing'));
    await act(async () => {
      await Promise.resolve();
    });

    // The stale create now resolves — it must persist but not steal selection.
    await act(async () => {
      resolveCreate({
        id: 'note-1',
        title: 'Draft',
        content: '',
        created_at: '2026-08-18T00:00:00',
        updated_at: '2026-08-18T00:00:00',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.getNote).toHaveBeenCalledWith('proj-1', 'existing-1');
    expect(mockApi.getNote).not.toHaveBeenCalledWith('proj-1', 'note-1');
    expect(screen.getByRole('heading', { name: 'Existing' })).toBeTruthy();
  });

  it('still persists edits made to a note navigated to while an earlier request is in flight', async () => {
    mockApi.getNotes.mockResolvedValue([
      { id: 'b-1', title: 'B', updated_at: '2026-08-18T00:00:00' },
    ]);
    mockApi.getNote.mockResolvedValue({
      id: 'b-1',
      title: 'B',
      content: 'B body',
      created_at: '2026-08-18T00:00:00',
      updated_at: '2026-08-18T00:00:00',
    });
    let resolveCreate: (v: any) => void = () => {};
    mockApi.createNote.mockReturnValue(
      new Promise((res) => {
        resolveCreate = res;
      }),
    );

    render(<NotesEditor projectId="proj-1" />);
    await act(async () => {
      await Promise.resolve();
    });

    // Start a new note; its create is deferred and stays in flight.
    fireEvent.click(screen.getByTitle('New Note'));
    fireEvent.change(screen.getByPlaceholderText('Note title...'), { target: { value: 'Draft' } });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(mockApi.createNote).toHaveBeenCalledTimes(1);

    // Navigate to note B and edit it while the create is still unresolved.
    fireEvent.click(screen.getByText('B'));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByPlaceholderText(/Start writing/), {
      target: { value: 'edited B body' },
    });
    // B's debounce fires while the create is in flight — coalesced into pending.
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(mockApi.updateNote).not.toHaveBeenCalled();

    // The create finally resolves; the pending save for B must now flush.
    await act(async () => {
      resolveCreate({
        id: 'note-1',
        title: 'Draft',
        content: '',
        created_at: '2026-08-18T00:00:00',
        updated_at: '2026-08-18T00:00:00',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.updateNote).toHaveBeenCalledTimes(1);
    expect(mockApi.updateNote.mock.calls[0]).toEqual([
      'proj-1',
      'b-1',
      { title: 'B', content: 'edited B body' },
    ]);
  });

  it('does not restore a stale response title over a title the user cleared mid-create', async () => {
    let resolveCreate: (v: any) => void = () => {};
    mockApi.createNote.mockReturnValue(
      new Promise((res) => {
        resolveCreate = res;
      }),
    );

    render(<NotesEditor projectId="proj-1" />);
    fireEvent.click(screen.getByTitle('New Note'));
    const title = screen.getByPlaceholderText('Note title...') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Foo' } });
    fireEvent.change(screen.getByPlaceholderText(/Start writing/), { target: { value: 'body' } });

    // Kick off the create (title 'Foo'); it stays in flight.
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(mockApi.createNote).toHaveBeenCalledWith('proj-1', { title: 'Foo', content: 'body' });

    // User clears the title while the POST is unresolved; a trailing save is
    // coalesced as pending (content is still non-empty, so it is a real save).
    fireEvent.change(title, { target: { value: '' } });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    // The create resolves echoing the stale title 'Foo'.
    await act(async () => {
      resolveCreate({
        id: 'note-1',
        title: 'Foo',
        content: 'body',
        created_at: '2026-08-18T00:00:00',
        updated_at: '2026-08-18T00:00:00',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The cleared title must not be overwritten by the stale response value,
    // and the trailing PUT must not persist 'Foo'.
    expect(title.value).toBe('');
    expect(mockApi.updateNote).toHaveBeenCalledTimes(1);
    expect(mockApi.updateNote.mock.calls[0][2].title).not.toBe('Foo');
    // Title was cleared, so the trailing save derives one from the content.
    expect(mockApi.updateNote.mock.calls[0][2]).toEqual({ title: 'body', content: 'body' });
  });

  it('flushes a new note when navigating away before the debounce fires', async () => {
    mockApi.getNotes.mockResolvedValue([
      { id: 'existing-1', title: 'Existing', updated_at: '2026-08-18T00:00:00' },
    ]);
    mockApi.getNote.mockResolvedValue({
      id: 'existing-1',
      title: 'Existing',
      content: 'existing body',
      created_at: '2026-08-18T00:00:00',
      updated_at: '2026-08-18T00:00:00',
    });

    render(<NotesEditor projectId="proj-1" />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTitle('New Note'));
    fireEvent.change(screen.getByPlaceholderText('Note title...'), {
      target: { value: 'Draft note' },
    });

    // Navigate to the existing note BEFORE the 700ms debounce fires.
    fireEvent.click(screen.getByText('Existing'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The in-progress new note must have been persisted, not dropped.
    expect(mockApi.createNote).toHaveBeenCalledTimes(1);
    expect(mockApi.createNote.mock.calls[0][1]).toEqual({ title: 'Draft note', content: '' });
    // ...and the navigation still lands on the selected existing note.
    expect(mockApi.getNote).toHaveBeenCalledWith('proj-1', 'existing-1');
  });

  it('flushes edits to an existing note when navigating away before the debounce fires', async () => {
    mockApi.getNotes.mockResolvedValue([
      { id: 'n1', title: 'N1', updated_at: '2026-08-18T00:00:00' },
      { id: 'n2', title: 'N2', updated_at: '2026-08-18T00:00:00' },
    ]);
    mockApi.getNote.mockImplementation(async (_pid: string, id: string) => ({
      id,
      title: id.toUpperCase(),
      content: `${id} body`,
      created_at: '2026-08-18T00:00:00',
      updated_at: '2026-08-18T00:00:00',
    }));

    render(<NotesEditor projectId="proj-1" />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('N1'));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByPlaceholderText(/Start writing/), {
      target: { value: 'n1 edited' },
    });

    // Switch to N2 before the debounce fires.
    fireEvent.click(screen.getByText('N2'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The unsaved edit to N1 must have been flushed via PUT.
    expect(mockApi.updateNote).toHaveBeenCalledTimes(1);
    expect(mockApi.updateNote.mock.calls[0]).toEqual([
      'proj-1',
      'n1',
      { title: 'N1', content: 'n1 edited' },
    ]);
  });

  it('persists the newest buffer when navigating while an earlier PUT is in flight', async () => {
    mockApi.getNotes.mockResolvedValue([
      { id: 'n1', title: 'N1', updated_at: '2026-08-18T00:00:00' },
      { id: 'n2', title: 'N2', updated_at: '2026-08-18T00:00:00' },
    ]);
    mockApi.getNote.mockImplementation(async (_pid: string, id: string) => ({
      id,
      title: id.toUpperCase(),
      content: `${id} body`,
      created_at: '2026-08-18T00:00:00',
      updated_at: '2026-08-18T00:00:00',
    }));
    // Keep the FIRST PUT in flight until we release it; later PUTs resolve fast.
    let releaseFirstPut: () => void = () => {};
    let putCount = 0;
    mockApi.updateNote.mockImplementation((_pid: string, id: string, data: any) => {
      putCount += 1;
      const result = {
        id,
        title: data.title,
        content: data.content,
        updated_at: 'x',
        created_at: 'x',
      };
      if (putCount === 1) {
        return new Promise((res) => {
          releaseFirstPut = () => res(result);
        });
      }
      return Promise.resolve(result);
    });

    render(<NotesEditor projectId="proj-1" />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('N1'));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('Edit'));

    // First edit → its PUT begins and stays in flight.
    fireEvent.change(screen.getByPlaceholderText(/Start writing/), { target: { value: 'v1' } });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(mockApi.updateNote).toHaveBeenCalledTimes(1);
    expect(mockApi.updateNote.mock.calls[0]).toEqual([
      'proj-1',
      'n1',
      { title: 'N1', content: 'v1' },
    ]);

    // Type again (newer buffer), then navigate to N2 BEFORE the second debounce.
    fireEvent.change(screen.getByPlaceholderText(/Start writing/), { target: { value: 'v2' } });
    fireEvent.click(screen.getByText('N2'));
    await act(async () => {
      await Promise.resolve();
    });

    // Release the first PUT; the queued newer buffer must now flush to N1.
    await act(async () => {
      releaseFirstPut();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.updateNote).toHaveBeenCalledTimes(2);
    // The newest buffer 'v2' is persisted, and it targets N1 (not N2).
    expect(mockApi.updateNote.mock.calls[1]).toEqual([
      'proj-1',
      'n1',
      { title: 'N1', content: 'v2' },
    ]);
  });

  it('persists a clear of both fields made while the initial create is in flight', async () => {
    let resolveCreate: (v: any) => void = () => {};
    mockApi.createNote.mockReturnValue(
      new Promise((res) => {
        resolveCreate = res;
      }),
    );

    render(<NotesEditor projectId="proj-1" />);
    fireEvent.click(screen.getByTitle('New Note'));
    const title = screen.getByPlaceholderText('Note title...') as HTMLInputElement;
    const body = screen.getByPlaceholderText(/Start writing/) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: 'Foo' } });
    fireEvent.change(body, { target: { value: 'body' } });

    // Kick off the create; it stays in flight.
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(mockApi.createNote).toHaveBeenCalledTimes(1);
    expect(mockApi.createNote.mock.calls[0][1]).toEqual({ title: 'Foo', content: 'body' });

    // Clear BOTH fields while the POST is still unresolved.
    fireEvent.change(body, { target: { value: '' } });
    fireEvent.change(title, { target: { value: '' } });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    // The create resolves; the trailing clear must now flush as an update.
    await act(async () => {
      resolveCreate({
        id: 'note-1',
        title: 'Foo',
        content: 'body',
        created_at: '2026-08-18T00:00:00',
        updated_at: '2026-08-18T00:00:00',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Editor stays blank and the emptied buffer is persisted to the new note.
    expect(title.value).toBe('');
    expect(body.value).toBe('');
    expect(mockApi.updateNote).toHaveBeenCalledTimes(1);
    expect(mockApi.updateNote.mock.calls[0]).toEqual([
      'proj-1',
      'note-1',
      { title: 'Untitled', content: '' },
    ]);
  });

  it('does not backfill a stale derived title when content changed during a content-only create', async () => {
    let resolveCreate: (v: any) => void = () => {};
    mockApi.createNote.mockReturnValue(
      new Promise((res) => {
        resolveCreate = res;
      }),
    );

    render(<NotesEditor projectId="proj-1" />);
    fireEvent.click(screen.getByTitle('New Note'));
    const title = screen.getByPlaceholderText('Note title...') as HTMLInputElement;
    const body = screen.getByPlaceholderText(/Start writing/) as HTMLTextAreaElement;

    // Content-only note: title stays blank, so the create derives 'first'.
    fireEvent.change(body, { target: { value: 'first' } });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(mockApi.createNote).toHaveBeenCalledTimes(1);
    expect(mockApi.createNote.mock.calls[0][1]).toEqual({ title: 'first', content: 'first' });

    // Change the content while the create is still in flight.
    fireEvent.change(body, { target: { value: 'second' } });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    // The create resolves echoing the now-stale derived title 'first'.
    await act(async () => {
      resolveCreate({
        id: 'note-1',
        title: 'first',
        content: 'first',
        created_at: '2026-08-18T00:00:00',
        updated_at: '2026-08-18T00:00:00',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale 'first' must NOT be backfilled into the title input.
    expect(title.value).toBe('');
    expect(body.value).toBe('second');
    // The trailing update persists the latest content with a freshly derived title.
    expect(mockApi.updateNote).toHaveBeenCalledTimes(1);
    expect(mockApi.updateNote.mock.calls[0]).toEqual([
      'proj-1',
      'note-1',
      { title: 'second', content: 'second' },
    ]);
  });
});
