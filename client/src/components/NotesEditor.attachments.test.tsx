import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import NotesEditor from './NotesEditor';
import { api } from '../utils/api';

// Exercise the asynchronous attachment controller through the real component —
// NOT reconstructed cursor arithmetic. These cover the two behaviours the pure
// helper tests can't: (1) an upload that resolves after the edit buffer changed
// must NOT write into the new note, and (2) overlapping uploads serialize and
// insert in arrival order.
vi.mock('../utils/api', () => ({
  api: {
    getNotes: vi.fn(),
    getNote: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    uploadImage: vi.fn(),
    uploadFile: vi.fn(),
    getBoard: vi.fn(),
    createCard: vi.fn(),
    processNote: vi.fn(),
    scopeFromNotes: vi.fn(),
  },
}));

// Each uploadFile call parks on a deferred we resolve by hand, so the test
// controls exactly when an upload completes relative to buffer transitions.
let uploadResolvers: Array<(v: any) => void>;

function makeFile(name: string) {
  return new File(['x'], name, { type: 'application/pdf' });
}

function dropFile(textarea: Element, file: File) {
  fireEvent.drop(textarea, {
    dataTransfer: { files: [file], types: ['Files'] },
  });
}

async function resolveUpload(index: number, url: string) {
  await act(async () => {
    uploadResolvers[index]({ url, filename: url.split('/').pop() });
    // let the drain loop's continuation run
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadResolvers = [];
  (api.getNotes as any).mockResolvedValue([]);
  (api.createNote as any).mockResolvedValue({ id: 'new-note', title: '', content: '' });
  (api.updateNote as any).mockResolvedValue({ id: 'new-note', title: '', content: '' });
  (api.uploadFile as any).mockImplementation(
    () =>
      new Promise((resolve) => {
        uploadResolvers.push(resolve);
      }),
  );
});

async function startNewNote() {
  await act(async () => {
    render(<NotesEditor projectId="proj-1" />);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByTitle('New Note'));
    await Promise.resolve();
  });
  return screen.getByPlaceholderText(/Start writing/i) as HTMLTextAreaElement;
}

describe('NotesEditor attachment controller', () => {
  it('discards an upload whose edit session changed before it resolved', async () => {
    const textarea = await startNewNote();

    // Begin an attachment in this edit session (upload parks, unresolved).
    dropFile(textarea, makeFile('doc.pdf'));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1));

    // Transition the buffer: open a fresh "New Note" (bumps the edit session).
    await act(async () => {
      fireEvent.click(screen.getByTitle('New Note'));
      await Promise.resolve();
    });
    const fresh = screen.getByPlaceholderText(/Start writing/i) as HTMLTextAreaElement;
    expect(fresh.value).toBe('');

    // Now the earlier upload finally resolves — it must NOT touch the new buffer.
    await resolveUpload(0, '/uploads/doc.pdf');

    expect(fresh.value).toBe('');
    // And nothing auto-saved the stale attachment into any note.
    const savedContents = [
      ...(api.createNote as any).mock.calls.map((c: any[]) => c[1]?.content ?? ''),
      ...(api.updateNote as any).mock.calls.map((c: any[]) => c[2]?.content ?? ''),
    ];
    expect(savedContents.some((c: string) => c.includes('/uploads/doc.pdf'))).toBe(false);
  });

  it('serializes overlapping uploads and inserts them in arrival order', async () => {
    const textarea = await startNewNote();

    // Two attachments dropped while the first is still uploading.
    dropFile(textarea, makeFile('first.pdf'));
    dropFile(textarea, makeFile('second.pdf'));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1)); // serialized: 2nd waits

    await resolveUpload(0, '/uploads/first.pdf');
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2)); // now 2nd runs
    await resolveUpload(1, '/uploads/second.pdf');

    await waitFor(() => {
      const v = (screen.getByPlaceholderText(/Start writing/i) as HTMLTextAreaElement).value;
      expect(v).toContain('/uploads/first.pdf');
      expect(v).toContain('/uploads/second.pdf');
      expect(v.indexOf('/uploads/first.pdf')).toBeLessThan(v.indexOf('/uploads/second.pdf'));
    });
  });

  it('tracks the anchor when the user types BEFORE it during an upload', async () => {
    const textarea = await startNewNote();

    // Type "abc" and place the caret at the end (offset 3).
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'abc' } });
      await Promise.resolve();
    });
    textarea.setSelectionRange(3, 3);

    // Start an attachment anchored at offset 3 (upload parks).
    dropFile(textarea, makeFile('doc.pdf'));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1));

    // While it's uploading, the user inserts "XY" at the START (before offset 3).
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'XYabc' } });
      await Promise.resolve();
    });

    await resolveUpload(0, '/uploads/doc.pdf');

    await waitFor(() => {
      const v = (screen.getByPlaceholderText(/Start writing/i) as HTMLTextAreaElement).value;
      // The attachment landed AFTER "abc" (its intended logical spot), not
      // inside it — the anchor followed the earlier edit.
      expect(v.startsWith('XYabc')).toBe(true);
      expect(v).toContain('[doc.pdf](/uploads/doc.pdf)');
      expect(v.indexOf('/uploads/doc.pdf')).toBeGreaterThan(v.indexOf('abc'));
    });
  });

  it('inserts each independent action at its OWN captured cursor', async () => {
    const textarea = await startNewNote();

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'HELLO' } });
      await Promise.resolve();
    });

    // Action A: caret at the END (offset 5), drop a file.
    textarea.setSelectionRange(5, 5);
    dropFile(textarea, makeFile('a.pdf'));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1));

    // Action B: move the caret to the START (offset 0) and drop another file
    // while A is still uploading. B must anchor at 0, not after A.
    textarea.setSelectionRange(0, 0);
    dropFile(textarea, makeFile('b.pdf'));

    await resolveUpload(0, '/uploads/a.pdf'); // A inserts at offset 5
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2));
    await resolveUpload(1, '/uploads/b.pdf'); // B inserts at offset 0

    await waitFor(() => {
      const v = (screen.getByPlaceholderText(/Start writing/i) as HTMLTextAreaElement).value;
      // b.pdf before HELLO (its own cursor), a.pdf after HELLO (its own cursor).
      expect(v.indexOf('/uploads/b.pdf')).toBeLessThan(v.indexOf('HELLO'));
      expect(v.indexOf('HELLO')).toBeLessThan(v.indexOf('/uploads/a.pdf'));
    });
  });
});
