import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { partitionAttachmentFiles } from '../utils/attachmentValidation';
import { getAuthHeaders } from '../utils/connection';
import { formatShortcut, getPlatform } from '../utils/shortcuts';

// Keep in sync with the `toggle-microphone` entry in utils/shortcuts.js.
const MIC_TOGGLE_BINDING = 'Mod+Alt+M';

// genId() only works in secure contexts (HTTPS / localhost).
// Fall back to Math.random-based ID for plain HTTP (e.g. remote EC2 over HTTP).
const genId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c: any) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

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

function MessageInput(
  {
    onSend,
    onCancel,
    disabled,
    isProcessing,
    queueLength = 0,
    agentColor,
    skills,
    askMode,
    consultMode = askMode,
    consultHint = null,
    readOnly,
    draftKey,
    onFileError,
    composerPrefill,
    onComposerPrefillClear,
    onReplaceQueuedMessage,
    sessionAgents = [],
    enableMentions = false,
    toolbarStart = null,
  }: any,
  ref: any,
) {
  // Per-session (per-draftKey) draft store. Lives for the component's lifetime
  // so switching agents/sessions preserves each composer's unsent text.
  // When `draftKey` changes, we stash the current draft under the previous key
  // and load the new key's draft (empty if none). This uses React's
  // "set state during render" pattern to keep the swap in sync with the prop.
  const draftsRef = useRef<Map<any, any>>(new Map());
  const [activeKey, setActiveKey] = useState(draftKey);
  // Fresh Map on mount means no stored draft is reachable here — start empty.
  const [value, setValue] = useState('');

  const [images, setImages] = useState<any[]>([]); // [{id, name, dataUrl, file?, type?}]
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<any>(null);
  const fileInputRef = useRef<any>(null);

  // Voice transcription state.
  // `isRecording` flips the mic button into stop-state and shows the live
  // indicator. `isTranscribing` covers the "upload + wait for server" window
  // — the button shows a spinner and is disabled. Splitting them keeps the
  // UX legible (recording is user-cancellable; transcribing is not).
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<any>(null);
  const audioChunksRef = useRef<any[]>([]);
  const mediaStreamRef = useRef<any>(null);
  // Caret position captured the moment the user clicks the mic. The
  // transcribed text is spliced in at that location so the user can keep
  // typing during the upload without losing their insertion point.
  const transcribeAnchorRef = useRef<any>(null);
  // AbortController for the in-flight /api/transcribe fetch. Aborted on
  // draftKey change so a session-A upload can't land in session-B's composer.
  const transcribeAbortRef = useRef<any>(null);

  // Slash-command autocomplete state
  const [slashQuery, setSlashQuery] = useState<any>(null); // null = closed, string = filter
  const [slashIndex, setSlashIndex] = useState(0); // highlighted item
  const [slashStart, setSlashStart] = useState<any>(null); // cursor pos of the '/'
  const popupRef = useRef<any>(null);
  const mentionPopupRef = useRef<any>(null);

  // @mention autocomplete (multi-agent sessions)
  const [mentionQuery, setMentionQuery] = useState<any>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState<any>(null);

  const mentionsEnabled = enableMentions && sessionAgents.length > 1;

  // Swap draft when draftKey changes (during render, before any effects run)
  if (activeKey !== draftKey) {
    draftsRef.current.set(activeKey, value);
    setValue(draftsRef.current.get(draftKey) ?? '');
    setActiveKey(draftKey);
    // Reset transient slash-autocomplete state when switching sessions
    setSlashQuery(null);
    setSlashStart(null);
    setSlashIndex(0);
    setMentionQuery(null);
    setMentionStart(null);
    setMentionIndex(0);
    // Clear media attachments on session switch.
    // deferred (blob URLs complicate it); for now keep the composer's attach
    // state in lockstep with the text draft so A's thumbnails don't bleed into
    // B's composer. Revoke any active blob URLs first to avoid leaks.
    if (images.length > 0) {
      for (const img of images) {
        if ((img.type === 'video' || img.type === 'file') && img.dataUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(img.dataUrl);
        }
      }
      setImages([]);
    }
  }

  // Cancel an in-flight recording on session switch — don't paste audio
  // from session A's prompt into session B's composer. We clear the
  // onstop / onerror handlers BEFORE calling stop() so the buffered
  // chunks aren't uploaded to /api/transcribe for a session the user
  // already navigated away from. We also abort any fetch that has
  // already started (i.e. onstop already fired but the response hasn't
  // arrived yet) so the transcript can't splice into the new session.
  useEffect(() => {
    return () => {
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
      const stream = mediaStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
            /* track already ended */
          }
        }
      }
      mediaStreamRef.current = null;
      audioChunksRef.current = [];
      // Abort any in-flight upload so the resolved transcript doesn't land
      // in the wrong session's composer.
      transcribeAbortRef.current?.abort();
      transcribeAbortRef.current = null;
      setIsRecording(false);
      setIsTranscribing(false);
    };
  }, [draftKey]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [value]);

  // Focus on mount and when not disabled
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  // ── Slash-command autocomplete helpers ────────────────────────

  const filteredSkills = (skills || []).filter((s: any) =>
    slashQuery === null
      ? false
      : (s.name || s.id || '').toLowerCase().includes(slashQuery.toLowerCase()) ||
        (s.description || '').toLowerCase().includes(slashQuery.toLowerCase()),
  );

  // Reset index when query changes
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  // Keep highlighted item scrolled into view
  useEffect(() => {
    if (popupRef.current && slashQuery !== null) {
      const active = popupRef.current.querySelector('[data-active="true"]');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  }, [slashIndex, slashQuery]);

  const closeSlash = useCallback(() => {
    setSlashQuery(null);
    setSlashStart(null);
    setSlashIndex(0);
  }, []);

  const closeMention = useCallback(() => {
    setMentionQuery(null);
    setMentionStart(null);
    setMentionIndex(0);
  }, []);

  const mentionAgents =
    sessionAgents.filter(
      (a: any, index: number, roster: any[]) =>
        mentionQuery !== null &&
        a.name.toLowerCase().includes(mentionQuery.toLowerCase()) &&
        roster.findIndex((candidate: any) => candidate.id === a.id) === index,
    ) || [];

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  const insertMention = useCallback(
    (agentName: any) => {
      if (mentionStart === null) return;
      const before = value.slice(0, mentionStart);
      const after = value.slice(textareaRef.current?.selectionStart || value.length);
      const newValue = `${before}@${agentName} ${after}`;
      setValue(newValue);
      closeMention();
      requestAnimationFrame(() => {
        const pos = before.length + agentName.length + 2;
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(pos, pos);
      });
    },
    [value, mentionStart, closeMention],
  );

  const insertSkill = useCallback(
    (skillId: any) => {
      if (slashStart === null) return;
      const before = value.slice(0, slashStart);
      const cursorPos = textareaRef.current?.selectionStart || value.length;
      const after = value.slice(cursorPos);
      const newValue = `${before}/${skillId} ${after}`;
      setValue(newValue);
      closeSlash();
      requestAnimationFrame(() => {
        const pos = before.length + skillId.length + 2; // / + name + space
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(pos, pos);
      });
    },
    [value, slashStart, closeSlash],
  );

  // ── Voice transcription ───────────────────────────────────────

  // Inserts `text` at the captured caret position (or appends to the end
  // if no anchor was captured). Joins with a single space when splicing
  // into existing content so words don't run together.
  const insertTranscriptAtAnchor = useCallback((text: any) => {
    if (!text) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setValue((prev: any) => {
      const anchor =
        transcribeAnchorRef.current === null || transcribeAnchorRef.current === undefined
          ? prev.length
          : Math.min(Math.max(0, transcribeAnchorRef.current), prev.length);
      const before = prev.slice(0, anchor);
      const after = prev.slice(anchor);
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
      const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
      const insertion = (needsLeadingSpace ? ' ' : '') + trimmed + (needsTrailingSpace ? ' ' : '');
      const next = before + insertion + after;
      // Restore focus + caret to just after the inserted text. RAF defers
      // until React has committed the new value.
      const caret = before.length + insertion.length;
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          try {
            ta.setSelectionRange(caret, caret);
          } catch {
            /* setSelectionRange can throw if textarea was unmounted */
          }
        }
      });
      return next;
    });
    transcribeAnchorRef.current = null;
  }, []);

  // Hard-stops any in-flight recording and releases the mic. Safe to call
  // from cleanup paths (unmount, draftKey switch, error fallthrough) — all
  // refs are guarded.
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
    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* track already ended */
        }
      }
    }
    mediaStreamRef.current = null;
    audioChunksRef.current = [];
    setIsRecording(false);
  }, []);

  const reportTranscribeError = useCallback(
    (msg: any) => {
      if (typeof onFileError === 'function') onFileError(msg);
      else if (typeof window !== 'undefined') console.warn('[transcribe]', msg);
    },
    [onFileError],
  );

  // Uploads the audio blob to the server and inserts the resulting
  // transcript at the anchor. The endpoint is express.raw({type:'audio/*'})
  // — it wants the bare audio bytes with the correct Content-Type, NOT a
  // multipart body. (Card AC mentions multipart; the server contract is
  // raw and a multipart POST 415s. See card comment for rationale.)
  const uploadForTranscription = useCallback(
    async (blob: any, contentType: any) => {
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
          let hint = '';
          try {
            hint = (await res.json())?.hint || '';
          } catch {
            /* non-JSON body */
          }
          reportTranscribeError(
            hint ||
              'Voice transcription not configured. Ask your admin to set the API key in Account settings.',
          );
          return;
        }
        if (res.status === 415) {
          // Most common cause: the Gemini provider is selected but the browser
          // recorded WebM/MP4, which Gemini can't read. Surface the server hint.
          let hint = '';
          try {
            hint = (await res.json())?.hint || '';
          } catch {
            /* non-JSON body */
          }
          reportTranscribeError(
            hint ||
              "This audio format isn't supported by the selected transcription provider. Switch the provider in Settings → Account.",
          );
          return;
        }
        if (res.status === 413) {
          reportTranscribeError('Recording is too long. Try a shorter clip.');
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
          reportTranscribeError(
            `Transcription failed (HTTP ${res.status})${detail ? ': ' + detail : ''}. Tap mic to retry.`,
          );
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (typeof body?.transcript !== 'string' || !body.transcript.trim()) {
          reportTranscribeError("Couldn't hear anything — try again.");
          return;
        }
        insertTranscriptAtAnchor(body.transcript);
      } catch (err: any) {
        // AbortError means the session switched mid-upload — not a user-visible error.
        if (err?.name === 'AbortError') return;
        reportTranscribeError(
          `Transcription failed: ${err?.message || 'network error'}. Tap mic to retry.`,
        );
      } finally {
        transcribeAbortRef.current = null;
        setIsTranscribing(false);
      }
    },
    [reportTranscribeError, insertTranscriptAtAnchor],
  );

  const startRecording = useCallback(async () => {
    if (isRecording || isTranscribing) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      reportTranscribeError('Microphone is not available in this browser.');
      return;
    }
    const mimeType = pickAudioMimeType();
    if (mimeType === null) {
      reportTranscribeError(
        'Voice recording is not supported in this browser. Try Chrome, Edge, or Safari 14.1+.',
      );
      return;
    }
    // Capture caret BEFORE the permission prompt steals focus.
    transcribeAnchorRef.current = textareaRef.current?.selectionStart ?? value.length;

    let stream: any;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
      reportTranscribeError(
        denied
          ? 'Microphone permission denied. Enable mic access in your browser settings, then tap the mic again.'
          : `Could not start microphone: ${err?.message || err?.name || 'unknown error'}`,
      );
      return;
    }
    mediaStreamRef.current = stream;

    let recorder: any;
    try {
      recorder = mimeType
        ? new window.MediaRecorder(stream, { mimeType })
        : new window.MediaRecorder(stream);
    } catch (err: any) {
      reportTranscribeError(
        `Could not start recording: ${err?.message || 'unsupported audio format'}`,
      );
      teardownRecording();
      return;
    }

    audioChunksRef.current = [];
    recorder.ondataavailable = (e: any) => {
      if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    // When stop() fires (user click), assemble the blob and ship it. Errors
    // and aborts both land here — we check chunk count before uploading.
    recorder.onstop = async () => {
      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];
      // Release the mic immediately so the browser indicator goes away
      // while the upload is in flight.
      const stream = mediaStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
            /* noop */
          }
        }
      }
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      setIsRecording(false);
      if (chunks.length === 0) {
        reportTranscribeError("Couldn't capture audio — try again.");
        return;
      }
      const effectiveType = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: effectiveType });
      await uploadForTranscription(blob, baseAudioContentType(effectiveType));
    };
    recorder.onerror = (e: any) => {
      reportTranscribeError(`Recording error: ${e?.error?.message || 'unknown error'}`);
      teardownRecording();
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);
  }, [
    isRecording,
    isTranscribing,
    value,
    reportTranscribeError,
    teardownRecording,
    uploadForTranscription,
  ]);

  const stopRecording = useCallback(() => {
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

  const handleMicClick = useCallback(() => {
    if (isTranscribing) return;
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, isTranscribing, startRecording, stopRecording]);

  // The mic button is disabled when the composer is disabled (and not mid-stream)
  // or while a transcription upload is in flight. Mirror that exact condition so
  // the keyboard shortcut is a true no-op whenever the button itself isn't.
  const micDisabled = (disabled && !isProcessing) || isTranscribing;

  // Human-readable chord for the mic button tooltip (e.g. "⌘⌥M" / "Ctrl+Alt+M").
  const micShortcutLabel = formatShortcut(MIC_TOGGLE_BINDING, getPlatform());

  // Expose an imperative toggle so the global keyboard shortcut (wired in
  // App.jsx via useKeyboardShortcuts) can start/stop voice input on the active
  // composer without prop-drilling the recording state up the tree.
  useImperativeHandle(
    ref,
    () => ({
      toggleRecording: () => {
        if (micDisabled) return false;
        handleMicClick();
        return true;
      },
      isRecording: () => isRecording,
    }),
    [micDisabled, handleMicClick, isRecording],
  );

  // Cleanup on unmount — never leave the mic LED on.
  useEffect(() => {
    return () => {
      teardownRecording();
    };
  }, [teardownRecording]);

  // ── Image helpers (unchanged) ─────────────────────────────────

  // Resize image using canvas to keep uploads reasonable
  const resizeImage = useCallback((dataUrl: any, maxDim: any = 2000) => {
    return new Promise((resolve: any) => {
      const img = new Image();
      img.onload = () => {
        if (img.width <= maxDim && img.height <= maxDim) {
          resolve(dataUrl);
          return;
        }
        const scale = maxDim / Math.max(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }, []);

  const addImageFiles = useCallback(
    async (files: any) => {
      // Pre-flight validation: reject files that would blow the 100 MB server
      // limit (or are empty) *before* the user hits Send. Without this the
      // upload would fail silently in handleSend and the text would go through
      // without the video — exactly the "videos don't go through in chat" bug.
      const { accepted, rejected } = partitionAttachmentFiles(Array.from(files));
      if (rejected.length > 0 && typeof onFileError === 'function') {
        for (const { reason } of rejected) onFileError(reason);
      }
      const list = accepted;
      if (list.length === 0) return;

      const newImages: any[] = [];
      for (const file of list) {
        if (file.type.startsWith('video/')) {
          const previewUrl = URL.createObjectURL(file);
          newImages.push({
            id: genId(),
            name: file.name,
            dataUrl: previewUrl,
            file,
            type: 'video',
          });
        } else if (
          file.type.startsWith('image/') ||
          (!file.type && /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(file.name))
        ) {
          const dataUrl = await new Promise((resolve: any) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
          });
          const resized = await resizeImage(dataUrl);
          newImages.push({
            id: genId(),
            name: file.name,
            dataUrl: resized,
            type: 'image',
          });
        } else {
          newImages.push({
            id: genId(),
            name: file.name,
            dataUrl: null,
            file,
            type: 'file',
          });
        }
      }
      setImages((prev: any) => [...prev, ...newImages]);
    },
    [resizeImage, onFileError],
  );

  const removeImage = useCallback((id: any) => {
    setImages((prev: any) => {
      const removed = prev.find((img: any) => img.id === id);
      if (
        (removed?.type === 'video' || removed?.type === 'file') &&
        removed.dataUrl?.startsWith('blob:')
      ) {
        URL.revokeObjectURL(removed.dataUrl);
      }
      return prev.filter((img: any) => img.id !== id);
    });
  }, []);

  // ── Input handlers ────────────────────────────────────────────

  const handleInputChange = (e: any) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart;
    setValue(val);

    // Detect / trigger at start of input or after a newline
    const textBeforeCursor = val.slice(0, cursor);
    const slashMatch = textBeforeCursor.match(/(^|\n)\/([a-zA-Z0-9_.-]*)$/);
    if (slashMatch && skills?.length > 0) {
      const query = slashMatch[2];
      const slashPos = textBeforeCursor.length - slashMatch[0].length + slashMatch[1].length;
      setSlashQuery(query);
      setSlashStart(slashPos);
      closeMention();
    } else {
      closeSlash();
      if (mentionsEnabled) {
        const atMatch = textBeforeCursor.match(/(^|[\s])@([^\s]*)$/);
        if (atMatch) {
          const query = atMatch[2];
          const atPos = textBeforeCursor.length - atMatch[0].length + (atMatch[1] ? 1 : 0);
          setMentionQuery(query);
          setMentionStart(atPos);
        } else {
          closeMention();
        }
      } else {
        closeMention();
      }
    }
  };

  const editingQueuedMessage = Boolean(composerPrefill?.messageId);

  useEffect(() => {
    if (!composerPrefill?.content) return;
    setValue(composerPrefill.content);
    if (images.length > 0) {
      images.forEach((img: any) => {
        if ((img.type === 'video' || img.type === 'file') && img.dataUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(img.dataUrl);
        }
      });
      setImages([]);
    }
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const len = composerPrefill.content.length;
      textareaRef.current?.setSelectionRange?.(len, len);
    });
  }, [composerPrefill?.messageId, composerPrefill?.content]);

  const handleSubmit = ({ interrupt = false }: any = {}) => {
    const trimmed = value.trim();
    if ((!trimmed && images.length === 0) || disabled) return;

    if (composerPrefill?.messageId && onReplaceQueuedMessage) {
      if (images.length > 0) {
        onFileError?.(
          'Editing a queued message only updates the text. Remove attachments and try again, or cancel edit first.',
        );
        return;
      }
      onReplaceQueuedMessage(composerPrefill.messageId, trimmed);
      setValue('');
      onComposerPrefillClear?.();
      closeSlash();
      return;
    }

    // Mid-stream: queue by default; interrupt only when explicitly requested
    // (e.g. the amber Interrupt button). Enter never interrupts on its own.
    const shouldInterrupt = isProcessing && interrupt;
    const hasVideo = images.some((img: any) => img.type === 'video');
    const hasFile = images.some((img: any) => img.type === 'file');
    const fallbackText = hasFile
      ? '(file attached)'
      : hasVideo
        ? '(media attached)'
        : '(image attached)';
    onSend(trimmed || fallbackText, images, { interrupt: shouldInterrupt });
    setValue('');
    // Revoke blob URLs for videos before clearing to prevent memory leaks
    images.forEach((img: any) => {
      if ((img.type === 'video' || img.type === 'file') && img.dataUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(img.dataUrl);
      }
    });
    setImages([]);
    closeSlash();
    closeMention();
  };

  const handleKeyDown = (e: any) => {
    if (mentionQuery !== null && mentionAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i: any) => (i + 1) % mentionAgents.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i: any) => (i - 1 + mentionAgents.length) % mentionAgents.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        insertMention(mentionAgents[mentionIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
    }

    // Slash-command autocomplete navigation
    if (slashQuery !== null && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i: any) => (i + 1) % filteredSkills.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i: any) => (i - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        insertSkill(filteredSkills[slashIndex].id);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlash();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Enter queues by default, even mid-stream. To interrupt, click the
      // explicit amber Interrupt button (or edit the message while queued).
      handleSubmit();
    }
    if (e.key === 'Escape' && isProcessing) {
      onCancel?.();
    }
  };

  // Handle paste for screenshots
  const handlePaste = useCallback(
    (e: any) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const mediaItems = Array.from(items).filter(
        (item: any) => item.type.startsWith('image/') || item.type.startsWith('video/'),
      );
      if (mediaItems.length === 0) return;

      e.preventDefault();
      const files = mediaItems.map((item: any) => item.getAsFile()).filter(Boolean);
      addImageFiles(files);
    },
    [addImageFiles],
  );

  // Drag and drop handlers
  const handleDragOver = useCallback((e: any) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: any) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer?.files) {
        addImageFiles(e.dataTransfer.files);
      }
    },
    [addImageFiles],
  );

  const handleFileSelect = useCallback(
    (e: any) => {
      if (e.target.files) {
        addImageFiles(e.target.files);
        e.target.value = '';
      }
    },
    [addImageFiles],
  );

  // Read-only sessions (currently reviewer threads spawned by the Finalize
  // review phase) render only a banner — no composer, no send button, no
  // drag-drop affordance. Reviewer threads are shared with the whole
  // org and server-side writes are gated to the system spawn path; this
  // hides the UX so users don't try to type into a thread they can't
  // post to.
  if (readOnly) {
    return (
      <div className="border-t border-gray-800 p-3 md:p-4 safe-bottom">
        <div
          data-testid="reviewer-readonly-banner"
          className="flex items-center gap-2 px-3 py-2 bg-purple-900/20 border border-purple-800/40 rounded-lg text-xs text-purple-300"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-3.5 w-3.5 flex-shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 012 0v4a1 1 0 11-2 0V9zm1-4a1 1 0 100 2 1 1 0 000-2z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            Reviewer thread, read-only. This conversation is shared with everyone in the org.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`border-t border-gray-800 p-3 md:p-4 safe-bottom transition-colors ${
        dragOver ? 'bg-blue-900/20 border-blue-500' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {editingQueuedMessage && (
        <div
          className="flex items-center justify-between gap-2 mb-2 px-2 py-1.5 bg-amber-900/20 border border-amber-800/40 rounded-lg text-xs text-amber-200/90"
          data-testid="composer-edit-queued-banner"
        >
          <span>
            Editing queued message (text only — your queue slot is kept until you send or cancel)
          </span>
          <button
            type="button"
            onClick={() => {
              onComposerPrefillClear?.();
              setValue('');
            }}
            className="text-amber-300/80 hover:text-amber-100 shrink-0"
          >
            Cancel edit
          </button>
        </div>
      )}
      {/* Consult mode indicator */}
      {consultMode && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-blue-900/20 border border-blue-800/40 rounded-lg text-xs text-blue-400">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-3.5 w-3.5 flex-shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            {consultHint || 'Consult mode — Hub project updates only, no code ship or Finalize'}
          </span>
        </div>
      )}

      {/* Media / file previews */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 px-1">
          {images.map((img: any) => (
            <div key={img.id} className="relative group">
              {img.type === 'video' ? (
                <div className="h-16 w-20 rounded-lg border border-gray-700 bg-gray-800 flex items-center justify-center overflow-hidden relative">
                  <video src={img.dataUrl} className="h-full w-full object-cover" muted />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-6 w-6 text-white/80"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <span className="absolute bottom-0.5 left-0.5 text-[9px] text-white/70 bg-black/60 px-1 rounded">
                    {img.name?.split('.').pop()?.toUpperCase()}
                  </span>
                </div>
              ) : img.type === 'file' ? (
                <div className="h-16 max-w-[140px] px-2 rounded-lg border border-gray-700 bg-gray-800 flex items-center gap-2">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-8 w-8 flex-shrink-0 text-gray-400"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[11px] text-gray-300 truncate" title={img.name}>
                    {img.name}
                  </span>
                </div>
              ) : (
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  className="h-16 w-16 object-cover rounded-lg border border-gray-700"
                />
              )}
              <button
                onClick={() => removeImage(img.id)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-600 rounded-full flex items-center justify-center text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {toolbarStart ? (
        <div className="flex items-center gap-2 mb-2 min-w-0" data-testid="composer-toolbar-start">
          {toolbarStart}
        </div>
      ) : null}

      <div className="flex items-end gap-2 md:gap-3 mx-auto relative">
        {/* Slash-command autocomplete popup */}
        {slashQuery !== null && filteredSkills.length > 0 && (
          <div
            ref={popupRef}
            className="absolute bottom-full mb-1 left-0 w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-10 max-h-64 overflow-y-auto"
          >
            <div className="px-3 py-1.5 text-[11px] text-gray-500 border-b border-gray-700 flex items-center gap-1.5">
              <svg
                className="w-3 h-3 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Skills
              <span className="ml-auto text-gray-600">
                <kbd className="text-[10px]">&uarr;&darr;</kbd> navigate
                <span className="mx-1">&middot;</span>
                <kbd className="text-[10px]">Tab</kbd> select
              </span>
            </div>
            {filteredSkills.map((skill: any, i: any) => (
              <button
                key={skill.id}
                data-active={i === slashIndex}
                onMouseDown={(e: any) => {
                  e.preventDefault(); // prevent textarea blur
                  insertSkill(skill.id);
                }}
                onMouseEnter={() => setSlashIndex(i)}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 text-sm transition-colors ${
                  i === slashIndex
                    ? 'bg-blue-600/25 text-white'
                    : 'text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                <span className="text-gray-500 font-mono flex-shrink-0 text-xs mt-0.5">/</span>
                <div className="min-w-0">
                  <span className="font-medium">{skill.name || skill.id}</span>
                  {skill.description && (
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{skill.description}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {mentionQuery !== null && mentionAgents.length > 0 && (
          <div
            ref={mentionPopupRef}
            className="absolute bottom-full mb-1 left-0 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-10"
          >
            <div className="px-2 py-1.5 text-xs text-gray-500 border-b border-gray-700">
              Agents — type to filter, ↑↓ navigate, Enter to select
            </div>
            {mentionAgents.map((a: any, i: any) => (
              <button
                key={a.participantId || a.id}
                onMouseDown={(e: any) => {
                  e.preventDefault();
                  insertMention(a.name);
                }}
                onMouseEnter={() => setMentionIndex(i)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2.5 text-sm transition-colors ${
                  i === mentionIndex
                    ? 'bg-blue-600/30 text-white'
                    : 'text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: a.color }}
                />
                <span className="font-medium">{a.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* Image attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={(disabled && !isProcessing) || editingQueuedMessage}
          className="px-2 py-3 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-30"
          title={
            editingQueuedMessage
              ? 'Attachments are not supported when editing a queued message'
              : 'Attach file, image, or video (or paste/drop)'
          }
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="*/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Mic / voice transcription button */}
        <button
          type="button"
          onClick={handleMicClick}
          disabled={micDisabled}
          aria-label={
            isTranscribing
              ? 'Transcribing audio'
              : isRecording
                ? 'Stop recording'
                : 'Start voice input'
          }
          aria-pressed={isRecording}
          title={
            isTranscribing
              ? 'Transcribing...'
              : isRecording
                ? `Stop recording (tap or ${micShortcutLabel})`
                : `Voice input (tap or ${micShortcutLabel} to toggle)`
          }
          className={`px-2 py-3 transition-colors disabled:opacity-30 ${
            isRecording
              ? 'text-red-400 hover:text-red-300 animate-pulse'
              : isTranscribing
                ? 'text-gray-500'
                : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {isTranscribing ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
          ) : isRecording ? (
            // Solid square = stop
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <rect x="5" y="5" width="10" height="10" rx="1.5" />
            </svg>
          ) : (
            // Microphone
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path d="M7 4a3 3 0 016 0v5a3 3 0 11-6 0V4z" />
              <path d="M5.5 9.5a.75.75 0 011.5 0 3 3 0 006 0 .75.75 0 011.5 0 4.5 4.5 0 01-3.75 4.436V16h2.25a.75.75 0 010 1.5h-6a.75.75 0 010-1.5h2.25v-2.064A4.5 4.5 0 015.5 9.5z" />
            </svg>
          )}
        </button>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => setTimeout(closeSlash, 150)}
          placeholder={
            disabled
              ? 'Waiting...'
              : consultMode
                ? window.innerWidth < 640
                  ? 'Ask a question...'
                  : 'Consult on Agent Hub — board, wiki, workflows…'
                : window.innerWidth < 640
                  ? 'Message...'
                  : 'Type a message... (paste or drop files)'
          }
          disabled={disabled && !isProcessing}
          rows={1}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-gray-600 disabled:opacity-50 transition-colors"
        />
        {isProcessing && (
          <button
            onClick={onCancel}
            className="px-3 py-3 rounded-xl font-medium text-white bg-red-600 hover:bg-red-500 transition-all active:scale-95"
            title="Cancel (Esc)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
        {isProcessing && value.trim() ? (
          /* During processing with text: expose both Interrupt (explicit) and Queue (Enter default) */
          <>
            <button
              onClick={() => handleSubmit({ interrupt: true })}
              disabled={disabled}
              className="px-3 py-3 rounded-xl font-medium text-white bg-amber-600 hover:bg-amber-500 transition-all active:scale-95"
              title="Interrupt agent and send this message now"
              aria-label="Interrupt agent and send now"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </button>
            <button
              onClick={() => handleSubmit()}
              disabled={disabled}
              className="px-4 py-3 rounded-xl font-medium text-white transition-all hover:brightness-110 active:scale-95 flex items-center gap-1.5"
              style={{
                backgroundColor: disabled ? '#4b5563' : agentColor || '#4F46E5',
              }}
              title="Queue message to send after agent finishes (Enter)"
              aria-label="Queue message"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
              {queueLength > 0 && (
                <span className="text-xs bg-white/20 rounded-full px-1.5">{queueLength}</span>
              )}
            </button>
          </>
        ) : (
          <button
            onClick={() => handleSubmit()}
            disabled={disabled || (!value.trim() && images.length === 0)}
            className="px-4 py-3 rounded-xl font-medium text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:brightness-110 active:scale-95"
            style={{
              backgroundColor: disabled ? '#4b5563' : agentColor || '#4F46E5',
            }}
            title={isProcessing ? 'Send (will be queued)' : 'Send'}
          >
            {isProcessing ? (
              <div className="flex items-center gap-1.5">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
                {queueLength > 0 && (
                  <span className="text-xs bg-white/20 rounded-full px-1.5">{queueLength}</span>
                )}
              </div>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Drag overlay hint */}
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-900/30 rounded-lg pointer-events-none z-10">
          <div className="text-blue-300 font-medium text-lg">Drop image here</div>
        </div>
      )}
    </div>
  );
}

export default forwardRef(MessageInput);
