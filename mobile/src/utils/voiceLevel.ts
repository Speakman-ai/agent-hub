import {
  createSilenceTracker,
  dbfsToMeter,
  silenceWarning,
  trackLevel,
  type SilenceTracker,
  type SilenceWarning,
} from '@shared/utils/audioLevel';

export interface VoiceLevel {
  level: number;
  warning: SilenceWarning;
}

export const IDLE_VOICE_LEVEL: VoiceLevel = { level: 0, warning: null };
export const METERING_INTERVAL_MS = 200;

/**
 * Holds the live input level outside React state so only the meter
 * re-renders on each reading, not the whole screen that owns the recorder.
 */
export interface VoiceLevelStore {
  get: () => VoiceLevel;
  subscribe: (listener: () => void) => () => void;
  /** Starts metering a new take. */
  begin: (now: number) => void;
  /** Feeds one expo-audio metering reading (dBFS). */
  push: (dbfs: number | undefined, now: number) => void;
  reset: () => void;
}

export function createVoiceLevelStore(): VoiceLevelStore {
  let value = IDLE_VOICE_LEVEL;
  let tracker: SilenceTracker | null = null;
  const listeners = new Set<() => void>();
  const set = (next: VoiceLevel) => {
    if (Math.abs(next.level - value.level) < 0.01 && next.warning === value.warning) return;
    value = next;
    for (const l of listeners) l();
  };
  return {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin: (now) => {
      tracker = createSilenceTracker(now);
      set(IDLE_VOICE_LEVEL);
    },
    push: (dbfs, now) => {
      if (!tracker) return;
      // expo-audio omits metering when the platform has no reading; count that as silence.
      const db = typeof dbfs === 'number' && Number.isFinite(dbfs) ? dbfs : -Infinity;
      tracker = trackLevel(tracker, db, now);
      set({ level: dbfsToMeter(db), warning: silenceWarning(tracker, now) });
    },
    reset: () => {
      tracker = null;
      set(IDLE_VOICE_LEVEL);
    },
  };
}
