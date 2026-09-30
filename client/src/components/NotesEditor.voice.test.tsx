import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import NotesEditor from './NotesEditor';
import { api } from '../utils/api';
import { padTranscriptForInsert } from '../hooks/useVoiceRecorder';
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
  mimeType: string;
  state = 'inactive';
  ondataavailable: any = null;
  onstop: any = null;
  onerror: any = null;
  constructor(_stream: any, opts: any = {}) {
    this.mimeType = opts.mimeType || 'audio/webm';
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
const origMR = (window as any).MediaRecorder;
const origMd = navigator.mediaDevices;

beforeEach(() => {
  vi.clearAllMocks();
  fetchResolvers = [];
  (api.getNotes as any).mockResolvedValue([]);
  (api.createNote as any).mockResolvedValue({ id: 'new-note', title: '', content: '' });
  (api.updateNote as any).mockResolvedValue({ id: 'new-note', title: '', content: '' });
  (api.summarizeVoiceTranscript as any).mockResolvedValue({
    summary: '**Gist.**',
    engine: 'claude-code',
    model: 'claude-opus-5-5',
  });
  (window as any).MediaRecorder = FakeMediaRecorder;
  (globalThis as any).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
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

async function recordAndStop() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Start voice input'));
  });
  await waitFor(() => expect(screen.getByLabelText('Stop recording')).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Stop recording'));
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
}

async function respond(transcript: string) {
  await act(async () => {
    fetchResolvers[0](new Response(JSON.stringify({ transcript }), { status: 200 }));
    await Promise.resolve();
  });
}

describe('NotesEditor voice input', () => {
  it('inserts the summary and a collapsed transcript at the caret captured when recording started', async () => {
    const textarea = await startNewNote();
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    textarea.setSelectionRange(5, 5);

    let finishSummary: (v: any) => void = () => {};
    (api.summarizeVoiceTranscript as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSummary = resolve;
        }),
    );

    await recordAndStop();
    expect((fetch as any).mock.calls[0][0]).toBe('/api/transcribe');

    // Typing at the front while the upload is pending shifts the anchor.
    fireEvent.change(textarea, { target: { value: '> hello world' } });
    await respond('big');
    await waitFor(() => expect(screen.getByText('Summarizing…')).toBeTruthy());
    expect(api.summarizeVoiceTranscript).toHaveBeenCalledWith('big', expect.anything());

    // ...and while the summary is pending.
    fireEvent.change(textarea, { target: { value: '>> hello world' } });
    await act(async () => {
      finishSummary({ summary: '**Big.**', engine: 'claude-code', model: 'm' });
      await Promise.resolve();
    });

    const block = buildVoiceNoteMarkdown({ summary: '**Big.**', transcript: 'big' });
    await waitFor(() => expect(textarea.value).toBe(`>> hello\n\n${block}\n\n world`));
  });

  it('keeps the collapsed transcript when summarizing fails', async () => {
    const textarea = await startNewNote();
    (api.summarizeVoiceTranscript as any).mockRejectedValueOnce(new Error('503: no engines'));
    await recordAndStop();
    await respond('just the words');

    await waitFor(() =>
      expect(textarea.value).toBe(buildVoiceNoteMarkdown({ transcript: 'just the words' })),
    );
    expect(screen.getByText(/Couldn't summarize the recording \(503: no engines\)/)).toBeTruthy();
  });

  it('drops a transcript that resolves after the note was closed', async () => {
    await startNewNote();
    await recordAndStop();

    await act(async () => {
      fireEvent.click(screen.getByTitle('New Note'));
      await Promise.resolve();
    });
    const fresh = screen.getByPlaceholderText(/Start writing/i) as HTMLTextAreaElement;
    await respond('stale words');

    expect(fresh.value).toBe('');
  });

  it('releases a mic granted after the note was left mid-permission-prompt', async () => {
    await startNewNote();
    const trackStop = vi.fn();
    let grant: (s: any) => void = () => {};
    (navigator.mediaDevices.getUserMedia as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const starts = vi.spyOn(FakeMediaRecorder.prototype, 'start');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Start voice input'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('New Note'));
      await Promise.resolve();
    });
    await act(async () => {
      grant({ getTracks: () => [{ stop: trackStop }] });
      await Promise.resolve();
    });

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(starts).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Start voice input')).toBeTruthy();
    starts.mockRestore();
  });

  it('a second mic click during the permission prompt supersedes the first', async () => {
    await startNewNote();
    const firstStop = vi.fn();
    const grants: Array<(s: any) => void> = [];
    (navigator.mediaDevices.getUserMedia as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          grants.push(resolve);
        }),
    );
    const starts = vi.spyOn(FakeMediaRecorder.prototype, 'start');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Start voice input'));
      fireEvent.click(screen.getByLabelText('Start voice input'));
    });
    await act(async () => {
      grants[1]({ getTracks: () => [{ stop: vi.fn() }] });
      await Promise.resolve();
    });
    await act(async () => {
      grants[0]({ getTracks: () => [{ stop: firstStop }] });
      await Promise.resolve();
    });
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(starts).toHaveBeenCalledTimes(1);
    starts.mockRestore();
  });

  it('shows the server hint when transcription is not configured', async () => {
    await startNewNote();
    await recordAndStop();
    await act(async () => {
      fetchResolvers[0](new Response(JSON.stringify({ hint: 'Set a key' }), { status: 501 }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('Set a key')).toBeTruthy());
  });
});

describe('padTranscriptForInsert', () => {
  it('adds spaces only where words would touch', () => {
    expect(padTranscriptForInsert('ab', 1, ' x ')).toBe(' x ');
    expect(padTranscriptForInsert('a b', 2, 'x')).toBe('x ');
    expect(padTranscriptForInsert('', 0, 'x')).toBe('x');
    expect(padTranscriptForInsert('a', 1, '   ')).toBe('');
  });
});
