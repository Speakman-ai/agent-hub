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

// Speech is fully intelligible at 32 kbps Opus/AAC; the browser default
// (~128 kbps) only inflates uploads.
export const RECORDING_BITS_PER_SECOND = 32_000;
// Long recordings are cut into independent files of this length so every
// upload stays far below any provider's per-request limit and transcription
// of earlier segments overlaps with recording.
export const SEGMENT_DURATION_MS = 10 * 60 * 1000;

export type SegmentResult =
  | { ok: true; transcript: string }
  | { ok: false; message: string }
  | { ok: false; aborted: true; message: '' };

/** Joins per-segment transcripts in recording order. */
export function joinSegmentTranscripts(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .join(' ');
}

async function readJson(res: any): Promise<any> {
  try {
    return (await res.json()) ?? {};
  } catch {
    return {};
  }
}

/**
 * POSTs one self-contained audio file to /api/transcribe and maps the
 * response to a transcript or a user-facing message. The endpoint is
 * express.raw({type:'audio/*'}): it wants the bare bytes with the correct
 * Content-Type, not a multipart body.
 */
export async function transcribeSegment(
  blob: Blob,
  contentType: string,
  signal: AbortSignal,
): Promise<SegmentResult> {
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...getAuthHeaders() },
      body: blob,
      signal,
    });
    if (res.status === 501) {
      const body = await readJson(res);
      return {
        ok: false,
        message:
          body.hint ||
          'Voice transcription not configured. Ask your admin to set the API key in Account settings.',
      };
    }
    if (res.status === 415) {
      const body = await readJson(res);
      return {
        ok: false,
        message:
          body.hint ||
          "This audio format isn't supported by the selected transcription provider. Switch the provider in Settings → Account.",
      };
    }
    if (res.status === 413) {
      const body = await readJson(res);
      return {
        ok: false,
        message: body.error
          ? `${body.error}.`
          : "Recording exceeds the transcription provider's upload limit.",
      };
    }
    if (!res.ok) {
      const body = await readJson(res);
      const detail = body.error || body.detail || '';
      return {
        ok: false,
        message: `Transcription failed (HTTP ${res.status})${detail ? ': ' + detail : ''}. Tap mic to retry.`,
      };
    }
    const body = await readJson(res);
    return { ok: true, transcript: typeof body.transcript === 'string' ? body.transcript : '' };
  } catch (err: any) {
    // AbortError means the caller cancelled mid-upload, not a user-visible error.
    if (err?.name === 'AbortError' || signal.aborted)
      return { ok: false, aborted: true, message: '' };
    return {
      ok: false,
      message: `Transcription failed: ${err?.message || 'network error'}. Tap mic to retry.`,
    };
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

// One mic session from start() to stop()/cancel(). It owns a chain of
// MediaRecorder segments over a single stream; each segment's result is a
// promise slotted in recording order.
interface Take {
  stream: any;
  mimeType: string;
  recorder: any;
  results: Promise<SegmentResult | null>[];
  controller: AbortController;
  timer: ReturnType<typeof setInterval> | null;
  stopping: boolean;
  finalizing: boolean;
}

/**
 * Record-then-transcribe voice input shared by the chat composer and the
 * notes editor. Recordings longer than SEGMENT_DURATION_MS are split into
 * independent files that upload while recording continues; the joined
 * transcript is delivered once after stop. `isRecording` covers the live-mic
 * window; `isTranscribing` covers the wait for outstanding segments after
 * stop. `cancel()` aborts everything so a caller switching context never
 * receives a stale transcript.
 */
export function useVoiceRecorder({ onTranscript, onError, onStart }: VoiceRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const takeRef = useRef<Take | null>(null);
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

  // Drops the recording and any in-flight uploads without delivering a
  // transcript. Handlers are cleared BEFORE stop() so buffered audio is not
  // uploaded, and the fetches are aborted so a late response can't land.
  const cancel = useCallback(() => {
    generationRef.current += 1;
    const take = takeRef.current;
    takeRef.current = null;
    if (take) {
      take.stopping = true;
      if (take.timer) clearInterval(take.timer);
      const rec = take.recorder;
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
      take.controller.abort();
      stopTracks(take.stream);
    }
    setIsRecording(false);
    setIsTranscribing(false);
  }, []);

  const finalize = useCallback(
    async (take: Take) => {
      if (take.finalizing) return;
      take.finalizing = true;
      setIsTranscribing(true);
      const results = await Promise.all(take.results);
      if (takeRef.current !== take) return; // cancelled or superseded
      takeRef.current = null;
      setIsTranscribing(false);
      const captured = results.filter((r): r is SegmentResult => r !== null);
      if (captured.length === 0) {
        reportError("Couldn't capture audio — try again.");
        return;
      }
      const transcript = joinSegmentTranscripts(captured.map((r) => (r.ok ? r.transcript : null)));
      const failure = captured.find((r) => !r.ok && r.message);
      if (transcript) onTranscriptRef.current(transcript);
      if (failure && !failure.ok) {
        reportError(
          transcript
            ? `Part of the recording couldn't be transcribed: ${failure.message}`
            : failure.message,
        );
      } else if (!transcript) {
        reportError("Couldn't hear anything — try again.");
      }
    },
    [reportError],
  );

  // Stops the current segment; its onstop finalizes the take. Audio captured
  // so far is still transcribed.
  const stopTake = useCallback(
    (take: Take) => {
      if (take.stopping) return;
      take.stopping = true;
      if (take.timer) clearInterval(take.timer);
      take.timer = null;
      const rec = take.recorder;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
          return;
        } catch {
          /* fall through to manual finalize */
        }
      }
      stopTracks(take.stream);
      setIsRecording(false);
      void finalize(take);
    },
    [finalize],
  );

  // Starts a new segment recorder on the take's stream. The returned recorder
  // becomes take.recorder; its result slot is reserved once start() succeeds
  // (a throwing start must not leave a slot nothing will settle) so segments
  // stay in order even if uploads finish out of order.
  const startSegment = useCallback(
    (take: Take) => {
      const opts: any = { audioBitsPerSecond: RECORDING_BITS_PER_SECOND };
      if (take.mimeType) opts.mimeType = take.mimeType;
      const recorder = new window.MediaRecorder(take.stream, opts);
      const chunks: Blob[] = [];
      let settle!: (r: Promise<SegmentResult> | null) => void;
      recorder.ondataavailable = (e: any) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        if (chunks.length === 0) settle(null);
        else {
          const effectiveType = recorder.mimeType || take.mimeType || 'audio/webm';
          const blob = new Blob(chunks, { type: effectiveType });
          settle(
            transcribeSegment(blob, baseAudioContentType(effectiveType), take.controller.signal),
          );
        }
        // Retired segments (rotated out) never end the take. The current one
        // does, whether the user stopped or the browser ended it on its own
        // (e.g. the mic was unplugged and every track ended).
        if (take.recorder === recorder) {
          take.stopping = true;
          if (take.timer) clearInterval(take.timer);
          take.timer = null;
          // Release the mic right away so the browser indicator goes off
          // while the remaining uploads finish.
          stopTracks(take.stream);
          setIsRecording(false);
          void finalize(take);
        }
      };
      recorder.onerror = (e: any) => {
        reportError(`Recording error: ${e?.error?.message || 'unknown error'}`);
        stopTake(take);
      };
      recorder.start();
      take.results.push(new Promise((resolve) => (settle = resolve)));
      take.recorder = recorder;
      return recorder;
    },
    [finalize, reportError, stopTake],
  );

  // Hands off to a fresh segment before stopping the old one, so the two
  // overlap by a few milliseconds instead of dropping audio between them.
  const rotate = useCallback(
    (take: Take) => {
      if (take.stopping || takeRef.current !== take) return;
      const old = take.recorder;
      try {
        startSegment(take);
      } catch (err: any) {
        reportError(`Could not continue recording: ${err?.message || 'unknown error'}`);
        stopTake(take);
        return;
      }
      try {
        old?.stop();
      } catch {
        /* already stopped */
      }
    },
    [startSegment, reportError, stopTake],
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

    const take: Take = {
      stream,
      mimeType,
      recorder: null,
      results: [],
      controller: new AbortController(),
      timer: null,
      stopping: false,
      finalizing: false,
    };
    try {
      startSegment(take);
    } catch (err: any) {
      reportError(`Could not start recording: ${err?.message || 'unsupported audio format'}`);
      stopTracks(stream);
      return;
    }
    takeRef.current = take;
    take.timer = setInterval(() => rotate(take), SEGMENT_DURATION_MS);
    setIsRecording(true);
  }, [isRecording, isTranscribing, reportError, startSegment, rotate]);

  const stop = useCallback(() => {
    const take = takeRef.current;
    if (!take) {
      setIsRecording(false);
      return;
    }
    stopTake(take);
  }, [stopTake]);

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
