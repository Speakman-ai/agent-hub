import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import NotesEditor from './NotesEditor';
import NoteRecordingWidget, { formatElapsed } from './NoteRecordingWidget';
import { NoteRecordingProvider } from './NoteRecordingProvider';
import { api } from '../utils/api';
import { buildVoiceNoteMarkdown } from '@shared/utils/voiceNoteMarkdown';

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
    summarizeVoiceTranscript: vi.fn(),
  },
}));

class FakeMediaRecorder {
  static isTypeSupported = (t: string) => t.startsWith('audio/webm');
  static instances: FakeMediaRecorder[] = [];
  mimeType: string;
  state = 'inactive';
  ondataavailable: any = null;
  onstop: any = null;
  onerror: any = null;
  constructor(_stream: any, opts: any = {}) {
    this.mimeType = opts.mimeType || 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

let fetchResolvers: Array<(r: Response) => void>;
let trackStop: ReturnType<typeof vi.fn>;
const origMR = (window as any).MediaRecorder;
const origMd = navigator.mediaDevices;

const BLOCK = buildVoiceNoteMarkdown({ summary: '**Gist.**', transcript: 'remember the milk' });

// Mirrors App: the provider sits above the view switch, so leaving Notes
// unmounts the editor but not the recorder.
function Shell() {
  const [view, setView] = useState<'notes' | 'chat'>('notes');
  return (
    <>
      <button onClick={() => setView(view === 'notes' ? 'chat' : 'notes')}>switch view</button>
      {view === 'notes' ? <NotesEditor projectId="proj-1" /> : <div>chat view</div>}
      <NoteRecordingWidget onOpenNotes={() => setView('notes')} />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeMediaRecorder.instances = [];
  fetchResolvers = [];
  trackStop = vi.fn();
  (api.getNotes as any).mockResolvedValue([{ id: 'n1', title: 'Standup', content: 'agenda' }]);
  (api.getNote as any).mockResolvedValue({ id: 'n1', title: 'Standup', content: 'agenda' });
  (api.createNote as any).mockResolvedValue({ id: 'created', title: 'Draft', content: 'draft' });
  (api.updateNote as any).mockResolvedValue({ id: 'n1', title: 'Standup', content: 'agenda' });
  (api.summarizeVoiceTranscript as any).mockResolvedValue({
    summary: '**Gist.**',
    engine: 'claude-code',
    model: 'm',
  });
  (window as any).MediaRecorder = FakeMediaRecorder;
  (globalThis as any).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          fetchResolvers.push(resolve);
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  (window as any).MediaRecorder = origMR;
  (globalThis as any).MediaRecorder = origMR;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: origMd,
  });
});

async function mountShell() {
  await act(async () => {
    render(
      <NoteRecordingProvider>
        <Shell />
      </NoteRecordingProvider>,
    );
    await Promise.resolve();
  });
}

async function startRecording() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Start voice input'));
  });
  await waitFor(() => expect(screen.getByLabelText('Stop recording')).toBeTruthy());
}

async function leaveNotes() {
  await act(async () => {
    fireEvent.click(screen.getByText('switch view'));
    await Promise.resolve();
  });
  expect(screen.getByText('chat view')).toBeTruthy();
}

async function stopFromWidget() {
  const widget = screen.getByRole('status', { name: 'Note recording' });
  await act(async () => {
    fireEvent.click(within(widget).getByLabelText('Stop recording'));
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await act(async () => {
    fetchResolvers[0](
      new Response(JSON.stringify({ transcript: 'remember the milk' }), { status: 200 }),
    );
    await Promise.resolve();
  });
}

describe('notes recording across navigation', () => {
  it('keeps recording after leaving Notes and saves the take from the widget', async () => {
    await mountShell();
    await act(async () => {
      fireEvent.click(await screen.findByText('Standup'));
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByText('Edit'));
    await startRecording();

    // No widget while the editor owns the take.
    expect(screen.queryByRole('status', { name: 'Note recording' })).toBeNull();

    await leaveNotes();

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].state).toBe('recording');
    expect(trackStop).not.toHaveBeenCalled();
    const widget = screen.getByRole('status', { name: 'Note recording' });
    expect(within(widget).getByText('Recording note')).toBeTruthy();
    expect(within(widget).getByText('Standup')).toBeTruthy();

    (api.getNote as any).mockResolvedValue({ id: 'n1', title: 'Standup', content: 'agenda' });
    await stopFromWidget();

    expect(trackStop).toHaveBeenCalled();
    await waitFor(() =>
      expect(api.updateNote).toHaveBeenCalledWith('proj-1', 'n1', {
        content: `agenda\n\n${BLOCK}`,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Note recording' })).toBeNull(),
    );
  });

  it('saves into the created note when leaving an unsaved draft mid-recording', async () => {
    (api.getNotes as any).mockResolvedValue([]);
    await mountShell();
    await act(async () => {
      fireEvent.click(screen.getByTitle('New Note'));
      await Promise.resolve();
    });
    fireEvent.change(screen.getByPlaceholderText(/Start writing/i), {
      target: { value: 'draft' },
    });
    await startRecording();
    await leaveNotes();

    // The unmount flushed the draft instead of dropping the debounce.
    expect(api.createNote).toHaveBeenCalledTimes(1);
    expect(api.createNote).toHaveBeenCalledWith('proj-1', { title: 'draft', content: 'draft' });

    (api.getNote as any).mockResolvedValue({ id: 'created', title: 'draft', content: 'draft' });
    await stopFromWidget();

    await waitFor(() =>
      expect(api.updateNote).toHaveBeenCalledWith('proj-1', 'created', {
        content: `draft\n\n${BLOCK}`,
      }),
    );
    expect(api.createNote).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight save to an existing note before appending', async () => {
    await mountShell();
    await act(async () => {
      fireEvent.click(await screen.findByText('Standup'));
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.change(screen.getByPlaceholderText(/Start writing/i), {
      target: { value: 'agenda plus' },
    });
    let finishSave: (v: any) => void = () => {};
    (api.updateNote as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    await startRecording();
    await leaveNotes();
    // The unmount flushed the edit; that save is still in flight.
    expect(api.updateNote).toHaveBeenCalledWith('proj-1', 'n1', {
      title: 'Standup',
      content: 'agenda plus',
    });

    const readsBefore = (api.getNote as any).mock.calls.length;
    await stopFromWidget();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((api.getNote as any).mock.calls.length).toBe(readsBefore);

    (api.getNote as any).mockResolvedValue({ id: 'n1', title: 'Standup', content: 'agenda plus' });
    await act(async () => {
      finishSave({ id: 'n1', title: 'Standup', content: 'agenda plus' });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(api.updateNote).toHaveBeenLastCalledWith('proj-1', 'n1', {
        content: `agenda plus\n\n${BLOCK}`,
      }),
    );
  });

  it('hands the block to the editor when the note is reopened while summarizing', async () => {
    await mountShell();
    await act(async () => {
      fireEvent.click(await screen.findByText('Standup'));
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByText('Edit'));
    await startRecording();
    await leaveNotes();

    let finishSummary: (v: any) => void = () => {};
    (api.summarizeVoiceTranscript as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSummary = resolve;
        }),
    );
    await stopFromWidget();
    await waitFor(() => expect(screen.getByText('Summarizing…')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText('switch view'));
      await Promise.resolve();
    });
    // The widget also shows the note title; click the list entry.
    const listEntry = (await screen.findAllByText('Standup')).find(
      (el) => !el.closest('[role="status"]'),
    )!;
    await act(async () => {
      fireEvent.click(listEntry);
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByText('Edit'));
    // Editing the recording's note loads it fresh first.
    const textarea = (await screen.findByPlaceholderText(/Start writing/i)) as HTMLTextAreaElement;
    // The editor took the take over, so the widget is gone.
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Note recording' })).toBeNull(),
    );

    const readsBefore = (api.getNote as any).mock.calls.length;
    await act(async () => {
      finishSummary({ summary: '**Gist.**', engine: 'claude-code', model: 'm' });
      await Promise.resolve();
    });
    await waitFor(() => expect(textarea.value).toBe(`agenda\n\n${BLOCK}`));
    // Delivered into the buffer, not appended behind the editor's back.
    expect((api.getNote as any).mock.calls.length).toBe(readsBefore);
  });

  it('returning to Notes does not cancel the background take', async () => {
    await mountShell();
    await act(async () => {
      fireEvent.click(await screen.findByText('Standup'));
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByText('Edit'));
    await startRecording();
    await leaveNotes();
    await act(async () => {
      fireEvent.click(screen.getByText('switch view'));
      await Promise.resolve();
    });

    expect(FakeMediaRecorder.instances[0].state).toBe('recording');
    expect(trackStop).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Note recording' })).toBeTruthy();
  });
  it('a reopened draft reclaims its recording once the create lands', async () => {
    (api.getNotes as any).mockResolvedValue([]);
    await mountShell();
    await act(async () => {
      fireEvent.click(screen.getByTitle('New Note'));
      await Promise.resolve();
    });
    fireEvent.change(screen.getByPlaceholderText(/Start writing/i), {
      target: { value: 'draft' },
    });
    await startRecording();
    (api.getNotes as any).mockResolvedValue([{ id: 'created', title: 'draft', content: 'draft' }]);
    (api.getNote as any).mockResolvedValue({ id: 'created', title: 'draft', content: 'draft' });
    await leaveNotes();
    await waitFor(() => expect(api.createNote).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByText('switch view'));
      await Promise.resolve();
    });
    const listEntry = (await screen.findAllByText('draft')).find(
      (el) => !el.closest('[role="status"]'),
    )!;
    await act(async () => {
      fireEvent.click(listEntry);
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByText('Edit'));
    const textarea = (await screen.findByPlaceholderText(/Start writing/i)) as HTMLTextAreaElement;

    // The promoted note id matches, so the editor shows the take as its own.
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Note recording' })).toBeNull(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop recording'));
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      fetchResolvers[0](
        new Response(JSON.stringify({ transcript: 'remember the milk' }), { status: 200 }),
      );
      await Promise.resolve();
    });

    await waitFor(() => expect(textarea.value).toBe(`draft\n\n${BLOCK}`));
    // Never appended behind the editor's back.
    expect(api.updateNote).not.toHaveBeenCalledWith('proj-1', 'created', {
      content: `draft\n\n${BLOCK}`,
    });

    // Later edits keep the block, since it lives in the buffer.
    fireEvent.change(textarea, { target: { value: `${textarea.value}\nmore` } });
    await waitFor(
      () =>
        expect(api.updateNote).toHaveBeenLastCalledWith('proj-1', 'created', {
          title: 'draft',
          content: `draft\n\n${BLOCK}\nmore`,
        }),
      { timeout: 2000 },
    );
  });

  it('waits for a save from an editor that reopened the note and then left', async () => {
    await mountShell();
    await act(async () => {
      fireEvent.click(await screen.findByText('Standup'));
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByText('Edit'));
    await startRecording();
    await leaveNotes();

    // Come back, edit the same note, and close it while its save is in flight.
    await act(async () => {
      fireEvent.click(screen.getByText('switch view'));
      await Promise.resolve();
    });
    const listEntry = (await screen.findAllByText('Standup')).find(
      (el) => !el.closest('[role="status"]'),
    )!;
    await act(async () => {
      fireEvent.click(listEntry);
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByText('Edit'));
    const textarea = (await screen.findByPlaceholderText(/Start writing/i)) as HTMLTextAreaElement;
    let finishSave: (v: any) => void = () => {};
    (api.updateNote as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    fireEvent.change(textarea, { target: { value: 'agenda edited' } });
    await leaveNotes();

    const readsBefore = (api.getNote as any).mock.calls.length;
    await stopFromWidget();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((api.getNote as any).mock.calls.length).toBe(readsBefore);

    (api.getNote as any).mockResolvedValue({
      id: 'n1',
      title: 'Standup',
      content: 'agenda edited',
    });
    await act(async () => {
      finishSave({ id: 'n1', title: 'Standup', content: 'agenda edited' });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(api.updateNote).toHaveBeenLastCalledWith('proj-1', 'n1', {
        content: `agenda edited\n\n${BLOCK}`,
      }),
    );
  });
  describe('editing the note while a finished take is delivered', () => {
    async function recordLeaveAndReturn() {
      await mountShell();
      await act(async () => {
        fireEvent.click(await screen.findByText('Standup'));
        await Promise.resolve();
      });
      fireEvent.click(await screen.findByText('Edit'));
      await startRecording();
      await leaveNotes();
    }

    async function openStandupFromList() {
      await act(async () => {
        fireEvent.click(screen.getByText('switch view'));
        await Promise.resolve();
      });
      const listEntry = (await screen.findAllByText('Standup')).find(
        (el) => !el.closest('[role="status"]'),
      )!;
      await act(async () => {
        fireEvent.click(listEntry);
        await Promise.resolve();
      });
    }

    function deferNext(mock: any) {
      let resolve: (v: any) => void = () => {};
      mock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      return (v: any) => resolve(v);
    }

    it("Edit waits for a released editor's save before loading the note", async () => {
      await mountShell();
      await act(async () => {
        fireEvent.click(await screen.findByText('Standup'));
        await Promise.resolve();
      });
      fireEvent.click(await screen.findByText('Edit'));
      fireEvent.change(screen.getByPlaceholderText(/Start writing/i), {
        target: { value: 'agenda edited' },
      });
      await startRecording();
      // The unmount flush of 'agenda edited' stays in flight.
      const finishUnmountSave = deferNext(api.updateNote);
      await leaveNotes();
      expect(api.updateNote).toHaveBeenCalledWith('proj-1', 'n1', {
        title: 'Standup',
        content: 'agenda edited',
      });

      await openStandupFromList();
      const loadsBefore = (api.getNote as any).mock.calls.length;
      fireEvent.click(await screen.findByText('Edit'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      // Nothing is loaded into an editor while that save could still change it.
      expect((api.getNote as any).mock.calls.length).toBe(loadsBefore);
      expect(screen.queryByPlaceholderText(/Start writing/i)).toBeNull();

      (api.getNote as any).mockResolvedValue({
        id: 'n1',
        title: 'Standup',
        content: 'agenda edited',
      });
      await act(async () => {
        finishUnmountSave({ id: 'n1', title: 'Standup', content: 'agenda edited' });
        await Promise.resolve();
      });
      const textarea = (await screen.findByPlaceholderText(
        /Start writing/i,
      )) as HTMLTextAreaElement;
      expect(textarea.value).toBe('agenda edited');

      // Stopping now delivers into the up-to-date buffer.
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Stop recording'));
      });
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await act(async () => {
        fetchResolvers[0](
          new Response(JSON.stringify({ transcript: 'remember the milk' }), { status: 200 }),
        );
        await Promise.resolve();
      });
      await waitFor(() => expect(textarea.value).toBe(`agenda edited\n\n${BLOCK}`));
      fireEvent.change(textarea, { target: { value: `${textarea.value}\nmore` } });
      await waitFor(
        () =>
          expect(api.updateNote).toHaveBeenLastCalledWith('proj-1', 'n1', {
            title: 'Standup',
            content: `agenda edited\n\n${BLOCK}\nmore`,
          }),
        { timeout: 2000 },
      );
    });

    it('a save that lands after the note was selected refreshes what Edit opens', async () => {
      await mountShell();
      await act(async () => {
        fireEvent.click(await screen.findByText('Standup'));
        await Promise.resolve();
      });
      fireEvent.click(await screen.findByText('Edit'));
      fireEvent.change(screen.getByPlaceholderText(/Start writing/i), {
        target: { value: 'agenda edited' },
      });
      const finishUnmountSave = deferNext(api.updateNote);
      await leaveNotes();

      // Selecting the note reads the server before the save lands.
      await openStandupFromList();
      await act(async () => {
        finishUnmountSave({ id: 'n1', title: 'Standup', content: 'agenda edited' });
        await Promise.resolve();
      });
      fireEvent.click(await screen.findByText('Edit'));
      const textarea = (await screen.findByPlaceholderText(
        /Start writing/i,
      )) as HTMLTextAreaElement;
      expect(textarea.value).toBe('agenda edited');
    });

    it('switching notes cancels a take the editor reclaimed, as for one it started', async () => {
      (api.getNotes as any).mockResolvedValue([
        { id: 'n1', title: 'Standup', content: 'agenda' },
        { id: 'n2', title: 'Retro', content: 'wins' },
      ]);
      await recordLeaveAndReturn();
      await openStandupFromList();
      fireEvent.click(await screen.findByText('Edit'));
      await screen.findByPlaceholderText(/Start writing/i);
      // Reclaimed: the toolbar shows the take and the widget is gone.
      await waitFor(() => expect(screen.getByLabelText('Stop recording')).toBeTruthy());
      expect(screen.queryByRole('status', { name: 'Note recording' })).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByText('Retro'));
        await Promise.resolve();
      });

      expect(FakeMediaRecorder.instances[0].state).toBe('inactive');
      expect(trackStop).toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.queryByRole('status', { name: 'Note recording' })).toBeNull();
    });

    it('closing a reclaimed take with Done cancels it too', async () => {
      await recordLeaveAndReturn();
      await openStandupFromList();
      fireEvent.click(await screen.findByText('Edit'));
      await screen.findByPlaceholderText(/Start writing/i);
      await act(async () => {
        fireEvent.click(screen.getByText('Done'));
        await Promise.resolve();
      });
      expect(FakeMediaRecorder.instances[0].state).toBe('inactive');
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.queryByRole('status', { name: 'Note recording' })).toBeNull();
    });

    it('an Edit load that resolves after leaving Notes does not take the recording', async () => {
      await recordLeaveAndReturn();
      await openStandupFromList();
      const finishEditLoad = deferNext(api.getNote);
      fireEvent.click(await screen.findByText('Edit'));
      await leaveNotes();

      await act(async () => {
        finishEditLoad({ id: 'n1', title: 'Standup', content: 'agenda' });
        await new Promise((r) => setTimeout(r, 20));
      });

      // Still recording, still controllable from the widget.
      expect(FakeMediaRecorder.instances[0].state).toBe('recording');
      const widget = screen.getByRole('status', { name: 'Note recording' });
      expect(within(widget).getByLabelText('Stop recording')).toBeTruthy();

      (api.getNote as any).mockResolvedValue({ id: 'n1', title: 'Standup', content: 'agenda' });
      await stopFromWidget();
      await waitFor(() =>
        expect(api.updateNote).toHaveBeenCalledWith('proj-1', 'n1', {
          content: `agenda\n\n${BLOCK}`,
        }),
      );
    });

    it('a slow Edit load that straddles delivery still keeps the recording', async () => {
      await recordLeaveAndReturn();
      const finishSummary = deferNext(api.summarizeVoiceTranscript);
      await stopFromWidget();
      await openStandupFromList();

      // Edit's fresh load is in flight when the summary finishes.
      const finishEditLoad = deferNext(api.getNote);
      fireEvent.click(await screen.findByText('Edit'));
      await act(async () => {
        finishSummary({ summary: '**Gist.**', engine: 'claude-code', model: 'm' });
        await new Promise((r) => setTimeout(r, 20));
      });
      // Delivery queued behind the Edit load instead of appending around it.
      expect(api.updateNote).not.toHaveBeenCalled();

      await act(async () => {
        finishEditLoad({ id: 'n1', title: 'Standup', content: 'agenda' });
        await Promise.resolve();
      });
      const textarea = (await screen.findByPlaceholderText(
        /Start writing/i,
      )) as HTMLTextAreaElement;
      await waitFor(() => expect(textarea.value).toBe(`agenda\n\n${BLOCK}`));

      fireEvent.change(textarea, { target: { value: `${textarea.value}\nmore` } });
      await waitFor(
        () =>
          expect(api.updateNote).toHaveBeenLastCalledWith('proj-1', 'n1', {
            title: 'Standup',
            content: `agenda\n\n${BLOCK}\nmore`,
          }),
        { timeout: 2000 },
      );
      // The only writes were the editor's own; no API append raced it.
      for (const call of (api.updateNote as any).mock.calls) {
        expect(call[2]).toHaveProperty('title');
      }
    });

    it('an Edit clicked during the API append opens the appended content', async () => {
      await recordLeaveAndReturn();
      await openStandupFromList();

      // The append's read of the note is in flight when Edit is clicked.
      const finishAppendRead = deferNext(api.getNote);
      await stopFromWidget();
      await waitFor(() => expect((api.getNote as any).mock.calls.length).toBeGreaterThan(0));
      fireEvent.click(await screen.findByText('Edit'));
      expect(screen.queryByPlaceholderText(/Start writing/i)).toBeNull();

      (api.getNote as any).mockResolvedValue({
        id: 'n1',
        title: 'Standup',
        content: `agenda\n\n${BLOCK}`,
      });
      await act(async () => {
        finishAppendRead({ id: 'n1', title: 'Standup', content: 'agenda' });
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(api.updateNote).toHaveBeenCalledWith('proj-1', 'n1', {
          content: `agenda\n\n${BLOCK}`,
        }),
      );
      const textarea = (await screen.findByPlaceholderText(
        /Start writing/i,
      )) as HTMLTextAreaElement;
      expect(textarea.value).toBe(`agenda\n\n${BLOCK}`);
    });
  });
});

describe('formatElapsed', () => {
  it('formats minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });
});
