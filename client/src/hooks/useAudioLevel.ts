import { useEffect, useState } from 'react';
import {
  createSilenceTracker,
  dbfsToMeter,
  rmsToDbfs,
  samplesRms,
  silenceWarning,
  trackLevel,
  type SilenceWarning,
} from '@shared/utils/audioLevel';

export const LEVEL_POLL_MS = 100;

export interface AudioLevel {
  /** 0..1 meter fill for the latest reading. */
  level: number;
  warning: SilenceWarning;
}

const IDLE: AudioLevel = { level: 0, warning: null };

/**
 * Meters a live MediaStream. Taps the stream with an AnalyserNode (no output,
 * so nothing is played back) and polls it on a timer rather than
 * requestAnimationFrame, which stops in background tabs where meetings are
 * often recorded.
 */
export function useAudioLevel(stream: MediaStream | null): AudioLevel {
  const [state, setState] = useState<AudioLevel>(IDLE);

  useEffect(() => {
    setState(IDLE);
    if (!stream || typeof window === 'undefined') return;
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;

    let ctx: AudioContext;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      ctx = new Ctx();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
    } catch {
      return;
    }
    // Created after the mic prompt resolved, so it may start suspended.
    void ctx.resume?.().catch(() => undefined);

    const buf = new Float32Array(analyser.fftSize);
    let tracker = createSilenceTracker(Date.now());
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const db = rmsToDbfs(samplesRms(buf));
      const now = Date.now();
      tracker = trackLevel(tracker, db, now);
      const next = { level: dbfsToMeter(db), warning: silenceWarning(tracker, now) };
      setState((prev) =>
        Math.abs(prev.level - next.level) < 0.01 && prev.warning === next.warning ? prev : next,
      );
    }, LEVEL_POLL_MS);

    return () => {
      clearInterval(timer);
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      void ctx.close?.().catch(() => undefined);
    };
  }, [stream]);

  return state;
}
