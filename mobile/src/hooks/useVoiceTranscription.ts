import { useState, useRef, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import {
  acquireRecording,
  finishRecording,
  releaseRecording,
  VoiceRecordingBusyError,
  type VoiceOwner,
} from '../utils/voiceAudioSession';
import { applyTranscriptAtAnchor, contentTypeForRecordingUri } from '../utils/voiceTranscription';
import { transcribeAudio } from '../utils/transcribeAudio';
import { transformRange } from '@shared/utils/noteAttachments';
import { padBlockForInsert } from '@shared/utils/voiceNoteMarkdown';
/**
 * Voice-input hook for the chat composer and the notes editor. Records via expo-av, uploads to
 * /api/transcribe, and splices the transcript at the captured caret position.
 * Mirrors client/src/components/MessageInput.jsx voice transcription flow.
 */
export function useVoiceTranscription({
  value,
  setValue,
  cursorRef,
  disabled,
  isProcessing,
  onError,
  sessionKey,
  prepareTranscript,
}: any) {
  // `prepareTranscript` (optional) turns the raw transcript into the text to
  // insert, e.g. notes wrap it with a model summary. Its result is inserted as
  // its own markdown block instead of inline words.
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const prepareRef = useRef<((t: string) => Promise<string>) | undefined>(prepareTranscript);
  prepareRef.current = prepareTranscript;
  const recordingRef = useRef<any>(null);
  const transcribeAnchorRef = useRef<any>(null);
  // Callers that swap the edited buffer (notes) pass a key identifying it; a
  // transcript recorded against one key is dropped if the key has changed.
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const startKeyRef = useRef<any>(undefined);
  // Each dictation attempt (start → record → stop → upload) is one owner
  // object. start(), cancel() and unmount replace it. Every async step
  // re-checks `isLive(attempt)` after each await before touching React state,
  // uploading, or delivering text. Native audio (recorder + iOS audio mode)
  // is shared app-wide, so it only changes through voiceAudioSession, which
  // serializes transitions and lets only the owning attempt reset the mode.
  const attemptRef = useRef<VoiceOwner | null>(null);
  const mountedRef = useRef(true);
  const isLive = useCallback(
    (attempt: VoiceOwner) => mountedRef.current && attemptRef.current === attempt,
    [],
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const attempt = attemptRef.current;
      attemptRef.current = null;
      const rec = recordingRef.current;
      recordingRef.current = null;
      // An attempt still starting releases itself once it sees it's stale.
      void releaseRecording(attempt, rec);
    };
  }, []);
  const reportError = useCallback(
    (msg: any) => {
      if (typeof onError === 'function') onError(msg);
    },
    [onError],
  );
  const applyTranscript = useCallback(
    (text: any, asBlock = false) => {
      const anchor = transcribeAnchorRef.current;
      transcribeAnchorRef.current = null;
      if (startKeyRef.current !== sessionKeyRef.current) return;
      setValue((prev: any) => {
        if (asBlock) {
          const at =
            typeof anchor === 'number' ? Math.min(Math.max(0, anchor), prev.length) : prev.length;
          const block = padBlockForInsert(prev, at, text);
          cursorRef.current = at + block.length;
          return prev.slice(0, at) + block + prev.slice(at);
        }
        const { text: next, caret } = applyTranscriptAtAnchor(prev, text, anchor);
        cursorRef.current = caret;
        return next;
      });
    },
    [setValue, cursorRef],
  );
  const startRecording = useCallback(async () => {
    if (isRecording || isTranscribing) return;
    const attempt: VoiceOwner = {};
    attemptRef.current = attempt;
    transcribeAnchorRef.current = cursorRef.current ?? value.length;
    startKeyRef.current = sessionKeyRef.current;
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!isLive(attempt)) return;
      if (permission.status !== 'granted') {
        reportError(
          'Microphone permission denied. Enable mic access in device settings, then tap the mic again.',
        );
        return;
      }
      const recording = await acquireRecording(attempt, () => isLive(attempt));
      if (!recording) return;
      if (!isLive(attempt)) {
        // Cancelled in the gap after the queue handed the recorder back.
        void releaseRecording(attempt, recording);
        return;
      }
      recordingRef.current = recording;
      setIsRecording(true);
    } catch (err: any) {
      if (!isLive(attempt)) return;
      reportError(
        err instanceof VoiceRecordingBusyError
          ? err.message
          : `Could not start microphone: ${err?.message || 'unknown error'}`,
      );
    }
  }, [isRecording, isTranscribing, value, cursorRef, isLive, reportError]);
  const stopRecording = useCallback(async () => {
    const attempt = attemptRef.current;
    const rec = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    if (!attempt || !rec) return;
    // Busy from the moment the user taps stop, through unload and upload, so
    // the mic can't be re-armed while this attempt is still finishing.
    setIsTranscribing(true);
    try {
      let uri: string | null;
      try {
        uri = await finishRecording(attempt, rec);
      } catch (err: any) {
        if (isLive(attempt)) reportError(`Recording error: ${err?.message || 'unknown error'}`);
        return;
      }
      if (!isLive(attempt)) return;
      if (!uri) {
        reportError("Couldn't capture audio — try again.");
        return;
      }
      try {
        const { transcript } = await transcribeAudio(uri, contentTypeForRecordingUri(uri));
        if (!isLive(attempt)) return;
        const prepare = prepareRef.current;
        if (typeof prepare !== 'function') {
          applyTranscript(transcript);
          return;
        }
        if (startKeyRef.current !== sessionKeyRef.current) {
          transcribeAnchorRef.current = null;
          return;
        }
        setIsPreparing(true);
        let prepared: string;
        try {
          prepared = await prepare(transcript);
        } finally {
          if (isLive(attempt)) setIsPreparing(false);
        }
        if (!isLive(attempt)) return;
        applyTranscript(prepared, true);
      } catch (err: any) {
        if (!isLive(attempt)) return;
        reportError(err?.message || 'Transcription failed. Tap mic to retry.');
      }
    } finally {
      // Only the live attempt owns the busy flag; cancel() already cleared it
      // for a superseded one, and a newer attempt may have set it since.
      if (isLive(attempt)) setIsTranscribing(false);
    }
  }, [isLive, applyTranscript, reportError]);
  const handleMicClick = useCallback(() => {
    if (isTranscribing) return;
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, isTranscribing, startRecording, stopRecording]);
  // Drops the current attempt. UI state resets synchronously; the recorder is
  // released through the shared queue, and any in-flight start/unload/upload
  // for the dropped attempt finishes without side effects.
  const cancel = useCallback(() => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    transcribeAnchorRef.current = null;
    const rec = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setIsTranscribing(false);
    setIsPreparing(false);
    if (rec) void releaseRecording(attempt, rec);
  }, []);
  // Keeps the captured dictation anchor aligned with edits made while the
  // recording or upload is pending (callers that let the user keep typing).
  const trackEdit = useCallback((prevText: string, nextText: string) => {
    const anchor = transcribeAnchorRef.current;
    if (typeof anchor !== 'number') return;
    transcribeAnchorRef.current = transformRange(
      { start: anchor, end: anchor },
      prevText || '',
      nextText || '',
    ).start;
  }, []);
  const micDisabled = (disabled && !isProcessing) || isTranscribing;
  return {
    isRecording,
    isTranscribing,
    isPreparing,
    micDisabled,
    handleMicClick,
    cancel,
    trackEdit,
  };
}
