import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../utils/api';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { buildVoiceNoteMarkdown, padBlockForInsert } from '@shared/utils/voiceNoteMarkdown';

export interface NoteRecordingTarget {
  projectId: string;
  /**
   * Null while the note is an unsaved draft. Filled in once the owning
   * editor's queued create lands (see `release`).
   */
  noteId: string | null;
  title: string;
}

export interface EditingNote {
  projectId: string;
  noteId: string;
}

/**
 * A mounted notes editor. Every editor registers, not just the one that
 * started the take: the finished block goes to whichever editor has the
 * target note open, and only falls back to an API append when none does.
 * That keeps one rule for every phase (recording, transcribing,
 * summarizing, waiting on writes) instead of per-phase hand-offs.
 */
export interface NoteRecordingEditor {
  onStart: () => void;
  onError: (message: string) => void;
  /** Inserts at the caret captured when this editor started the take. */
  insertAtAnchor: (block: string) => boolean;
  /** The saved note this editor is editing right now, read live. */
  editingNote: () => EditingNote | null;
  /** Appends to the open buffer of the note returned by `editingNote`. */
  appendBlock: (block: string) => void;
  /** The provider wrote a note through the API; refresh any cached copy. */
  noteSaved: (projectId: string, note: any) => void;
  /** True while this editor has queued or in-flight note saves. */
  hasPendingWrites: () => boolean;
  /**
   * Saved note ids its queued or in-flight saves will write. A create whose
   * id is not known yet is left out: it cannot target a note that exists.
   * Read live, and still valid after the editor unmounts.
   */
  pendingWriteNoteIds: () => string[];
  /** Resolves once this editor's write queue has drained. */
  writesSettled: () => Promise<void>;
}
export type NoteRecordingEditorRef = { current: NoteRecordingEditor };

export interface NoteRecordingContextValue {
  isRecording: boolean;
  isTranscribing: boolean;
  summarizing: boolean;
  /** Settling the editor's writes or appending through the API. */
  saving: boolean;
  /**
   * The one ordering point for writers of a note. Runs `fn` in a single queue
   * that also runs delivery of a finished take, and only once no editor
   * (mounted, or unmounted with saves still landing) has a save pending for
   * `noteId`, or for any note when `noteId` is omitted. An editor loading a
   * note for editing does it here, so the load sees every earlier save, and
   * the voice block either reaches its buffer (edit first) or is already in
   * the content it loads (append first).
   */
  serialize: <T>(fn: () => Promise<T> | T, noteId?: string) => Promise<T>;
  /** True while any editor has a save pending for `noteId` (any note if omitted). */
  writesOutstanding: (noteId?: string) => boolean;
  /** Tells every mounted editor a note save landed, so cached copies refresh. */
  notifyNoteSaved: (projectId: string, note: any) => void;
  /** True while a mounted editor owns the take. The floating widget hides then. */
  attached: boolean;
  target: NoteRecordingTarget | null;
  startedAt: number | null;
  /** Failure surfaced by the widget once no editor is attached. */
  error: string;
  /** Voice block that could not be saved, kept so the user can copy it. */
  unsavedBlock: string;
  start: (target: NoteRecordingTarget, owner: NoteRecordingEditorRef) => void;
  stop: () => void;
  cancel: () => void;
  owns: (editor: NoteRecordingEditorRef) => boolean;
  register: (editor: NoteRecordingEditorRef) => () => void;
  /**
   * Makes `editor` the take's owner when the take records into this note.
   * Editors call it whenever they open a note for editing, so "this editor
   * has the take" has one meaning everywhere (toolbar, stop, cancel on
   * switching notes, errors, widget), whether it started the take or came
   * back to it after leaving the page.
   */
  adopt: (editor: NoteRecordingEditorRef, projectId: string, noteId: string) => boolean;
  /**
   * Called by every editor as it unmounts. `writesSettled` resolves once every
   * write the editor queued has finished; the API append waits on it so it
   * never reads content an in-flight save is about to overwrite. For the
   * owning editor it resolves with the note's id (the created id for a draft),
   * which is promoted into the target, and recording keeps going.
   */
  release: (editor: NoteRecordingEditorRef, writesSettled: Promise<string | null>) => void;
  dismissError: () => void;
}

const NoteRecordingContext = createContext<NoteRecordingContextValue | null>(null);

export function useNoteRecording(): NoteRecordingContextValue | null {
  return useContext(NoteRecordingContext);
}

export const DETACHED_NOTE_TITLE = 'Voice note';

/** Appends a voice block to a note that is not open in an editor. */
export async function saveVoiceBlockToNote(
  projectId: string,
  noteId: string | null,
  block: string,
): Promise<any> {
  if (!noteId) {
    return api.createNote(projectId, { title: DETACHED_NOTE_TITLE, content: block });
  }
  const note = await api.getNote(projectId, noteId);
  const content: string = note?.content || '';
  const snippet = padBlockForInsert(content, content.length, block);
  return api.updateNote(projectId, noteId, { content: content + snippet });
}

function sameNote(a: EditingNote | null, t: NoteRecordingTarget | null): boolean {
  return !!a && !!t && !!t.noteId && a.projectId === t.projectId && a.noteId === t.noteId;
}

/**
 * Owns the notes voice recorder above the router so a take survives leaving
 * the Notes page.
 */
export function NoteRecordingProvider({ children }: { children: ReactNode }) {
  const [summarizing, setSummarizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ownerMounted, setOwnerMounted] = useState(false);
  const [target, setTarget] = useState<NoteRecordingTarget | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [unsavedBlock, setUnsavedBlock] = useState('');
  const editorsRef = useRef<Set<NoteRecordingEditorRef>>(new Set());
  const ownerRef = useRef<NoteRecordingEditorRef | null>(null);
  const targetRef = useRef<NoteRecordingTarget | null>(null);
  // Bumped per take so async steps can tell they were superseded or cancelled.
  const takeIdRef = useRef(0);
  // Unmounted editors whose saves have not all landed. Their closures read
  // refs, so they keep answering pendingWriteNoteIds/writesSettled.
  // Each maps to the promise that settles once its saves land and the owner's
  // note id (if any) has been promoted into the target.
  const releasedRef = useRef<Map<NoteRecordingEditorRef, Promise<unknown>>>(new Map());
  const summaryAbortRef = useRef<AbortController | null>(null);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const writersFor = useCallback((noteId?: string) => {
    const writers = [...editorsRef.current, ...releasedRef.current.keys()];
    return writers.filter((w) =>
      noteId === undefined
        ? w.current.hasPendingWrites()
        : w.current.pendingWriteNoteIds().includes(noteId),
    );
  }, []);

  const writesOutstanding = useCallback(
    (noteId?: string) => writersFor(noteId).length > 0,
    [writersFor],
  );

  const serialize = useCallback(
    <T,>(fn: () => Promise<T> | T, noteId?: string): Promise<T> => {
      const run = queueRef.current.then(async () => {
        // Loops because a writer can queue another save while one lands.
        for (let writers = writersFor(noteId); writers.length; writers = writersFor(noteId)) {
          await Promise.all(
            writers.map((w) => releasedRef.current.get(w) ?? w.current.writesSettled()),
          );
        }
        return fn();
      });
      queueRef.current = run.catch(() => undefined);
      return run;
    },
    [writersFor],
  );

  const notifyNoteSaved = useCallback((projectId: string, note: any) => {
    for (const editor of editorsRef.current) editor.current.noteSaved(projectId, note);
  }, []);

  const reportError = useCallback((message: string) => {
    const owner = ownerRef.current;
    if (owner) owner.current.onError(message);
    else setError(message);
  }, []);

  const clearTake = useCallback(() => {
    ownerRef.current = null;
    targetRef.current = null;
    setOwnerMounted(false);
    setTarget(null);
    setStartedAt(null);
  }, []);

  const promoteNoteId = useCallback((takeId: number, noteId: string | null) => {
    const current = targetRef.current;
    if (takeIdRef.current !== takeId || !current || current.noteId || !noteId) return;
    const next = { ...current, noteId };
    targetRef.current = next;
    setTarget(next);
  }, []);

  const deliver = useCallback(
    async (transcript: string) => {
      const takeId = takeIdRef.current;
      if (!targetRef.current) return;
      const controller = new AbortController();
      summaryAbortRef.current = controller;
      setSummarizing(true);
      let summary = '';
      try {
        summary = (await api.summarizeVoiceTranscript(transcript, { signal: controller.signal }))
          .summary;
      } catch (err: any) {
        if (controller.signal.aborted) return;
        reportError(
          `Couldn't summarize the recording (${err?.message || 'unknown error'}). Kept the transcript.`,
        );
      } finally {
        if (summaryAbortRef.current === controller) {
          summaryAbortRef.current = null;
          setSummarizing(false);
        }
      }
      if (controller.signal.aborted || takeIdRef.current !== takeId) return;
      const block = buildVoiceNoteMarkdown({ summary, transcript });

      const owner = ownerRef.current;
      if (owner && owner.current.insertAtAnchor(block)) {
        clearTake();
        return;
      }

      setSaving(true);
      try {
        await serialize(async () => {
          const take = targetRef.current;
          if (takeIdRef.current !== takeId || !take) return;
          for (const editor of editorsRef.current) {
            if (sameNote(editor.current.editingNote(), take)) {
              editor.current.appendBlock(block);
              return;
            }
          }
          try {
            const note = await saveVoiceBlockToNote(take.projectId, take.noteId, block);
            notifyNoteSaved(take.projectId, note);
          } catch (err: any) {
            setUnsavedBlock(block);
            setError(`Couldn't save the recording to the note: ${err?.message || 'unknown error'}`);
          }
        });
      } finally {
        if (takeIdRef.current === takeId) clearTake();
        setSaving(false);
      }
    },
    [clearTake, reportError, serialize, notifyNoteSaved],
  );

  const {
    isRecording,
    isTranscribing,
    start: startRecorder,
    stop: stopRecorder,
    cancel: cancelRecorder,
  } = useVoiceRecorder({
    onStart: () => ownerRef.current?.current.onStart(),
    onTranscript: (transcript) => void deliver(transcript),
    onError: reportError,
  });

  const start = useCallback(
    (next: NoteRecordingTarget, owner: NoteRecordingEditorRef) => {
      if (summarizing || saving || !editorsRef.current.has(owner)) return;
      takeIdRef.current += 1;
      setError('');
      setUnsavedBlock('');
      ownerRef.current = owner;
      targetRef.current = next;
      setOwnerMounted(true);
      setTarget(next);
      setStartedAt(Date.now());
      void startRecorder();
    },
    [startRecorder, summarizing, saving],
  );

  const cancel = useCallback(() => {
    takeIdRef.current += 1;
    cancelRecorder();
    summaryAbortRef.current?.abort();
    summaryAbortRef.current = null;
    setSummarizing(false);
    clearTake();
  }, [cancelRecorder, clearTake]);

  const owns = useCallback((editor: NoteRecordingEditorRef) => ownerRef.current === editor, []);

  // Invariant: ownerRef only ever points at a registered (mounted) editor.
  // Editors finish async work (a queued Edit load, a mic permission prompt)
  // after they may have unmounted; a call from one that is gone must not
  // take the recording, or the widget would hide with no Stop anywhere.
  const adopt = useCallback((editor: NoteRecordingEditorRef, projectId: string, noteId: string) => {
    if (!editorsRef.current.has(editor)) return false;
    const take = targetRef.current;
    if (!take || take.projectId !== projectId || take.noteId !== noteId) return false;
    ownerRef.current = editor;
    setOwnerMounted(true);
    return true;
  }, []);

  const register = useCallback((editor: NoteRecordingEditorRef) => {
    editorsRef.current.add(editor);
    return () => {
      editorsRef.current.delete(editor);
    };
  }, []);

  const release = useCallback(
    (editor: NoteRecordingEditorRef, writesSettled: Promise<string | null>) => {
      const isOwner = ownerRef.current === editor;
      const takeId = takeIdRef.current;
      const settled = writesSettled
        .catch(() => null)
        .then((id) => {
          if (isOwner) promoteNoteId(takeId, id);
        });
      releasedRef.current.set(editor, settled);
      void settled.finally(() => {
        if (releasedRef.current.get(editor) === settled) releasedRef.current.delete(editor);
      });
      if (!isOwner) return;
      ownerRef.current = null;
      setOwnerMounted(false);
    },
    [promoteNoteId],
  );

  const dismissError = useCallback(() => {
    setError('');
    setUnsavedBlock('');
  }, []);

  const attached = ownerMounted;

  const value = useMemo<NoteRecordingContextValue>(
    () => ({
      isRecording,
      isTranscribing,
      summarizing,
      saving,
      serialize,
      writesOutstanding,
      notifyNoteSaved,
      attached,
      target,
      startedAt,
      error,
      unsavedBlock,
      start,
      stop: stopRecorder,
      cancel,
      owns,
      register,
      adopt,
      release,
      dismissError,
    }),
    [
      isRecording,
      isTranscribing,
      stopRecorder,
      summarizing,
      saving,
      serialize,
      writesOutstanding,
      notifyNoteSaved,
      attached,
      target,
      startedAt,
      error,
      unsavedBlock,
      start,
      cancel,
      owns,
      register,
      adopt,
      release,
      dismissError,
    ],
  );

  return <NoteRecordingContext.Provider value={value}>{children}</NoteRecordingContext.Provider>;
}
