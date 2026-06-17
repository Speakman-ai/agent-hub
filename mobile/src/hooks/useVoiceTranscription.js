import { useState, useRef, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import {
  applyTranscriptAtAnchor,
  contentTypeForRecordingUri,
} from '../utils/voiceTranscription';
import { transcribeAudio } from '../utils/transcribeAudio';

/**
 * Voice-input hook for the chat composer. Records via expo-av, uploads to
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
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recordingRef = useRef(null);
  const transcribeAnchorRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const rec = recordingRef.current;
      if (rec) {
        rec.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      // Reset iOS recording mode so a voice note doesn't leave global app
      // audio routed/configured for recording after the composer unmounts.
      Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
    };
  }, []);

  const reportError = useCallback(
    (msg) => {
      if (typeof onError === 'function') onError(msg);
    },
    [onError],
  );

  const applyTranscript = useCallback(
    (text) => {
      const anchor = transcribeAnchorRef.current;
      transcribeAnchorRef.current = null;
      setValue((prev) => {
        const { text: next, caret } = applyTranscriptAtAnchor(prev, text, anchor);
        cursorRef.current = caret;
        return next;
      });
    },
    [setValue, cursorRef],
  );

  // Restore playback audio mode after recording. Best-effort: failing to
  // reset the iOS recording flag is non-fatal but would otherwise leave global
  // audio routed for recording after a voice note.
  const resetAudioMode = useCallback(async () => {
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    } catch {
      /* non-fatal */
    }
  }, []);

  const teardownRecording = useCallback(async () => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (rec) {
      try {
        await rec.stopAndUnloadAsync();
      } catch {
        /* already stopped */
      }
    }
    await resetAudioMode();
    if (mountedRef.current) setIsRecording(false);
  }, [resetAudioMode]);

  const uploadRecording = useCallback(
    async (uri) => {
      if (!uri) {
        reportError("Couldn't capture audio — try again.");
        return;
      }
      setIsTranscribing(true);
      try {
        const contentType = contentTypeForRecordingUri(uri);
        const { transcript } = await transcribeAudio(uri, contentType);
        if (!mountedRef.current) return;
        applyTranscript(transcript);
      } catch (err) {
        if (!mountedRef.current) return;
        reportError(err?.message || 'Transcription failed. Tap mic to retry.');
      } finally {
        if (mountedRef.current) setIsTranscribing(false);
      }
    },
    [applyTranscript, reportError],
  );

  const startRecording = useCallback(async () => {
    if (isRecording || isTranscribing) return;

    transcribeAnchorRef.current = cursorRef.current ?? value.length;

    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        reportError(
          'Microphone permission denied. Enable mic access in device settings, then tap the mic again.',
        );
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      recordingRef.current = recording;
      setIsRecording(true);
    } catch (err) {
      await teardownRecording();
      reportError(`Could not start microphone: ${err?.message || 'unknown error'}`);
    }
  }, [
    isRecording,
    isTranscribing,
    value,
    cursorRef,
    reportError,
    teardownRecording,
  ]);

  const stopRecording = useCallback(async () => {
    const rec = recordingRef.current;
    if (!rec) {
      await teardownRecording();
      return;
    }
    recordingRef.current = null;
    setIsRecording(false);
    try {
      await rec.stopAndUnloadAsync();
      // Reset before the (network) upload so audio mode is restored even if
      // transcription is slow or fails.
      await resetAudioMode();
      const uri = rec.getURI();
      await uploadRecording(uri);
    } catch (err) {
      reportError(`Recording error: ${err?.message || 'unknown error'}`);
      await teardownRecording();
    }
  }, [teardownRecording, uploadRecording, reportError, resetAudioMode]);

  const handleMicClick = useCallback(() => {
    if (isTranscribing) return;
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, isTranscribing, startRecording, stopRecording]);

  const micDisabled = (disabled && !isProcessing) || isTranscribing;

  return {
    isRecording,
    isTranscribing,
    micDisabled,
    handleMicClick,
  };
}
