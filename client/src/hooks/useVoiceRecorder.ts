import { useState, useRef, useEffect, useCallback } from 'react';
import { getAuthHeaders } from '../utils/connection';

// Ordered preference list for MediaRecorder mimeType. webm/opus first
// (Chrome/Firefox/Edge); audio/mp4 for Safari which lacks webm support.
// Each entry maps to a content-type the server's /api/transcribe endpoint
// accepts (express.raw({ type: 'audio/*' })).
const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2', // AAC-LC in MP4 (Safari)
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

// Picks the best MediaRecorder mimeType supported by this browser, or null
// if MediaRecorder itself is unavailable.
export function pickAudioMimeType() {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
    return null;
  }
  const MR = window.MediaRecorder;
  if (typeof MR.isTypeSupported !== 'function') {
    // Safari < 14 etc. Returning '' lets MediaRecorder choose its default.
    return '';
  }
  for (const candidate of AUDIO_MIME_CANDIDATES) {
    if (MR.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

// Reduce a full MediaRecorder mimeType (e.g. "audio/webm;codecs=opus") to
// the bare top-level/subtype the /api/transcribe endpoint accepts.
export function baseAudioContentType(mimeType: any) {
  if (!mimeType) return 'audio/webm';
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return base || 'audio/webm';
}

function stopTracks(stream: any) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* track already ended */
    }
  }
}

async function readHint(res: any): Promise<string> {
  try {
    return (await res.json())?.hint || '';
  } catch {
    return '';
  }
}

export interface VoiceRecorderOptions {
  /** Called with the non-empty transcript once the server responds. */
  onTranscript: (text: string) => void;
  /** Called with a user-facing message for any failure. */
  onError?: (message: string) => void;
  /**
   * Called synchronously when a recording is requested, before the mic
   * permission prompt steals focus. Callers capture their caret here.
   */
  onStart?: () => void;
}

/**
 * Record-then-transcribe voice input shared by the chat composer and the
 * notes editor. `isRecording` covers the live-mic window (user-cancellable);
 * `isTranscribing` covers upload + server wait (not cancellable by the user,
 * but `cancel()` aborts it so a caller switching context never receives a
 * stale transcript).
 */
export function useVoiceRecorder({ onTranscript, onError, onStart }: VoiceRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<any>(null);
  const audioChunksRef = useRef<any[]>([]);
  const mediaStreamRef = useRef<any>(null);
  const transcribeAbortRef = useRef<any>(null);
  // Bumped by cancel() and every start() so a start() still awaiting mic permission knows it was
  // abandoned and releases the stream instead of recording.
  const generationRef = useRef(0);

  // Keep the latest callbacks in refs so start/stop keep stable identities and
  // an in-flight upload always reports to the current handlers.
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;
  onStartRef.current = onStart;

  const reportError = useCallback((msg: string) => {
    const fn = onErrorRef.current;
    if (typeof fn === 'function') fn(msg);
    else if (typeof window !== 'undefined') console.warn('[transcribe]', msg);
  }, []);

  // Hard-stops any in-flight recording and releases the mic. The recorder's
  // onstop still fires, so this is the "stop and discard nothing" path used on
  // errors; use cancel() to drop the audio instead.
  const teardownRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    mediaRecorderRef.current = null;
    stopTracks(mediaStreamRef.current);
    mediaStreamRef.current = null;
    audioChunksRef.current = [];
    setIsRecording(false);
  }, []);

  // Drops the recording and any in-flight upload without delivering a
  // transcript. Handlers are cleared BEFORE stop() so buffered chunks are not
  // uploaded, and the fetch is aborted so a late response can't land.
  const cancel = useCallback(() => {
    generationRef.current += 1;
    const rec = mediaRecorderRef.current;
    if (rec) {
      rec.onstop = null;
      rec.onerror = null;
      rec.ondataavailable = null;
      if (rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    mediaRecorderRef.current = null;
    stopTracks(mediaStreamRef.current);
    mediaStreamRef.current = null;
    audioChunksRef.current = [];
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    setIsRecording(false);
    setIsTranscribing(false);
  }, []);

  // The endpoint is express.raw({type:'audio/*'}): it wants the bare audio
  // bytes with the correct Content-Type, not a multipart body.
  const uploadForTranscription = useCallback(
    async (blob: any, contentType: string) => {
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      setIsTranscribing(true);
      try {
        const res = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': contentType, ...getAuthHeaders() },
          body: blob,
          signal: controller.signal,
        });
        if (res.status === 501) {
          reportError(
            (await readHint(res)) ||
              'Voice transcription not configured. Ask your admin to set the API key in Account settings.',
          );
          return;
        }
        if (res.status === 415) {
          // Most common cause: the Gemini provider is selected but the browser
          // recorded WebM/MP4, which Gemini can't read. Surface the server hint.
          reportError(
            (await readHint(res)) ||
              "This audio format isn't supported by the selected transcription provider. Switch the provider in Settings → Account.",
          );
          return;
        }
        if (res.status === 413) {
          reportError('Recording is too long. Try a shorter clip.');
          return;
        }
        if (!res.ok) {
          let detail = '';
          try {
            const body = await res.json();
            detail = body?.error || body?.detail || '';
          } catch {
            /* non-JSON error body */
          }
          reportError(
            `Transcription failed (HTTP ${res.status})${detail ? ': ' + detail : ''}. Tap mic to retry.`,
          );
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (typeof body?.transcript !== 'string' || !body.transcript.trim()) {
          reportError("Couldn't hear anything — try again.");
          return;
        }
        onTranscriptRef.current(body.transcript);
      } catch (err: any) {
        // AbortError means the caller cancelled mid-upload, not a user-visible error.
        if (err?.name === 'AbortError') return;
        reportError(`Transcription failed: ${err?.message || 'network error'}. Tap mic to retry.`);
      } finally {
        if (transcribeAbortRef.current === controller) {
          transcribeAbortRef.current = null;
          setIsTranscribing(false);
        }
      }
    },
    [reportError],
  );

  const start = useCallback(async () => {
    if (isRecording || isTranscribing) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      reportError('Microphone is not available in this browser.');
      return;
    }
    const mimeType = pickAudioMimeType();
    if (mimeType === null) {
      reportError(
        'Voice recording is not supported in this browser. Try Chrome, Edge, or Safari 14.1+.',
      );
      return;
    }
    onStartRef.current?.();
    // A newer start() supersedes one still waiting on the permission prompt.
    const generation = ++generationRef.current;

    let stream: any;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      if (generation !== generationRef.current) return;
      const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
      reportError(
        denied
          ? 'Microphone permission denied. Enable mic access in your browser settings, then tap the mic again.'
          : `Could not start microphone: ${err?.message || err?.name || 'unknown error'}`,
      );
      return;
    }
    if (generation !== generationRef.current) {
      stopTracks(stream);
      return;
    }
    mediaStreamRef.current = stream;

    let recorder: any;
    try {
      recorder = mimeType
        ? new window.MediaRecorder(stream, { mimeType })
        : new window.MediaRecorder(stream);
    } catch (err: any) {
      reportError(`Could not start recording: ${err?.message || 'unsupported audio format'}`);
      teardownRecording();
      return;
    }

    audioChunksRef.current = [];
    recorder.ondataavailable = (e: any) => {
      if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    // When stop() fires, assemble the blob and ship it. Errors land here too,
    // so check the chunk count before uploading.
    recorder.onstop = async () => {
      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];
      // Release the mic immediately so the browser indicator goes away while
      // the upload is in flight.
      stopTracks(mediaStreamRef.current);
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      setIsRecording(false);
      if (chunks.length === 0) {
        reportError("Couldn't capture audio — try again.");
        return;
      }
      const effectiveType = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: effectiveType });
      await uploadForTranscription(blob, baseAudioContentType(effectiveType));
    };
    recorder.onerror = (e: any) => {
      reportError(`Recording error: ${e?.error?.message || 'unknown error'}`);
      teardownRecording();
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);
  }, [isRecording, isTranscribing, reportError, teardownRecording, uploadForTranscription]);

  const stop = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop(); // onstop handler picks up from here
      } catch {
        // If the recorder is already torn down, force-cleanup so the UI
        // doesn't stay stuck in the recording state.
        teardownRecording();
      }
    } else {
      teardownRecording();
    }
  }, [teardownRecording]);

  const toggle = useCallback(() => {
    if (isTranscribing) return;
    if (isRecording) stop();
    else void start();
  }, [isRecording, isTranscribing, start, stop]);

  // Never leave the mic LED on, and never deliver a transcript to an
  // unmounted caller.
  useEffect(() => cancel, [cancel]);

  return { isRecording, isTranscribing, start, stop, toggle, cancel };
}

// Pads a transcript with a single space on either side where it would
// otherwise run into adjacent words at `at` in `text`.
export function padTranscriptForInsert(text: string, at: number, transcript: string): string {
  const trimmed = (transcript || '').trim();
  if (!trimmed) return '';
  const base = text || '';
  const pos = Math.min(Math.max(0, at), base.length);
  const before = base.slice(0, pos);
  const after = base.slice(pos);
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  return lead + trimmed + trail;
}
