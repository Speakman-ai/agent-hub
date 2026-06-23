import { useCallback, useEffect, useRef, useState } from 'react';
import { planReadback } from '../utils/readbackText';

// Streaming text-to-speech ("readback"). Owns the Web Speech API side effects;
// the pure sentence-buffering / sanitizing logic lives in utils/readbackText.js.
//
// Usage from App:
//   const readback = useReadback();
//   ... on a `stream` event:  readback.feed(messageId, content)
//   ... on a `done` event:    readback.flush(messageId, finalContent)
//   ... on session switch:    readback.cancel()
//   ... toggle button:        readback.toggle()  /  readback.enabled
//
// Only ever speaks NEW, complete sentences of assistant *text*. Tool calls and
// code render through separate events, so the streamed `content` is text-only
// by construction; we additionally strip code/markdown for clean prose.

const STORAGE_KEY = 'agentHub.readbackEnabled';

function isSupported() {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

function stopSpeaking() {
  if (!isSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* noop */
  }
}

export default function useReadback() {
  const supported = isSupported();

  const [enabled, setEnabledState] = useState<any>(() => {
    if (!supported) return false;
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Refs so the feed/flush callbacks stay stable (safe to call from a
  // useCallback-memoized WebSocket handler without churning its deps).
  const enabledRef = useRef(enabled);
  const consumedRef = useRef(0);
  const msgIdRef = useRef<any>(null);
  const lastContentRef = useRef('');

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const resetTracking = useCallback(() => {
    consumedRef.current = 0;
    msgIdRef.current = null;
    lastContentRef.current = '';
  }, []);

  const enqueue = useCallback(
    (utterances: any) => {
      if (!supported || !utterances || utterances.length === 0) return;
      for (const text of utterances) {
        try {
          window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(text));
        } catch {
          /* noop — never let TTS break the chat */
        }
      }
    },
    [supported],
  );

  const cancel = useCallback(() => {
    resetTracking();
    stopSpeaking();
  }, [resetTracking]);

  const feed = useCallback(
    (messageId: any, content: any) => {
      if (!enabledRef.current || !supported || typeof content !== 'string') return;
      // A new assistant message: stop any leftover playback and start fresh.
      if (msgIdRef.current !== messageId) {
        stopSpeaking();
        msgIdRef.current = messageId;
        consumedRef.current = 0;
      }
      lastContentRef.current = content;
      const { utterances, consumed } = planReadback(content, consumedRef.current);
      consumedRef.current = consumed;
      enqueue(utterances);
    },
    [supported, enqueue],
  );

  const flush = useCallback(
    (messageId: any, content: any) => {
      if (!enabledRef.current || !supported) {
        resetTracking();
        return;
      }
      const text =
        typeof content === 'string' && content.length > 0 ? content : lastContentRef.current;
      const startedSameMessage = msgIdRef.current === messageId || msgIdRef.current === null;
      const from = startedSameMessage ? consumedRef.current : 0;
      const { utterances } = planReadback(text, from, { final: true });
      enqueue(utterances);
      resetTracking();
    },
    [supported, enqueue, resetTracking],
  );

  const setEnabled = useCallback(
    (next: any) => {
      setEnabledState((prev: any) => {
        const value = typeof next === 'function' ? next(prev) : next;
        try {
          window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
        } catch {
          /* noop */
        }
        if (!value) {
          // Turning readback off stops playback immediately.
          resetTracking();
          stopSpeaking();
        }
        return value;
      });
    },
    [resetTracking],
  );

  const toggle = useCallback(() => setEnabled((prev: any) => !prev), [setEnabled]);

  // Stop any in-flight speech if the app unmounts.
  useEffect(() => () => stopSpeaking(), []);

  return { enabled, supported, toggle, setEnabled, feed, flush, cancel };
}
