/**
 * Live input-level metering for voice recordings, shared by the web recorder
 * (Web Audio AnalyserNode) and mobile (expo-av metering, already in dBFS).
 *
 * The point is to show the user, while recording, whether audio is actually
 * arriving, so a take that is capturing silence is caught before Stop.
 */

/** Meter floor. Anything quieter draws as an empty meter. */
export const METER_FLOOR_DBFS = -60;
/** Below this level the recording is not hearing speech or meeting audio. */
export const QUIET_DBFS = -50;
/**
 * A muted, blocked, or permission-denied input delivers exact zeros (or the
 * platform's floor, -160 dB on iOS). Room noise on a live mic sits far above.
 */
export const NO_SIGNAL_DBFS = -100;
/** How long the input must stay quiet before the recorder warns about it. */
export const SILENCE_WARNING_MS = 6000;

export function samplesRms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function rmsToDbfs(rms: number): number {
  if (!(rms > 0)) return -Infinity;
  return 20 * Math.log10(rms);
}

/** Maps a dBFS reading to a 0..1 meter fill. */
export function dbfsToMeter(dbfs: number): number {
  if (!Number.isFinite(dbfs) || dbfs <= METER_FLOOR_DBFS) return 0;
  if (dbfs >= 0) return 1;
  return (dbfs - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS;
}

export interface SilenceTracker {
  startedAt: number;
  /** When the input last dropped below QUIET_DBFS, or null while loud. */
  quietSince: number | null;
  /** True once any reading rose above NO_SIGNAL_DBFS. */
  heardSignal: boolean;
}

export function createSilenceTracker(now: number): SilenceTracker {
  return { startedAt: now, quietSince: now, heardSignal: false };
}

export function trackLevel(state: SilenceTracker, dbfs: number, now: number): SilenceTracker {
  const heardSignal = state.heardSignal || dbfs > NO_SIGNAL_DBFS;
  const quiet = !(dbfs > QUIET_DBFS);
  const quietSince = quiet ? (state.quietSince ?? now) : null;
  if (heardSignal === state.heardSignal && quietSince === state.quietSince) return state;
  return { ...state, heardSignal, quietSince };
}

/**
 * - `no-signal`: the input has delivered nothing at all, which points at a
 *   blocked permission or a muted/disconnected device rather than a quiet room.
 * - `quiet`: a live input that has not picked up anything audible lately.
 */
export type SilenceWarning = 'no-signal' | 'quiet' | null;

export function silenceWarning(state: SilenceTracker, now: number): SilenceWarning {
  if (!state.heardSignal) {
    return now - state.startedAt >= SILENCE_WARNING_MS ? 'no-signal' : null;
  }
  if (state.quietSince != null && now - state.quietSince >= SILENCE_WARNING_MS) return 'quiet';
  return null;
}

export function silenceWarningMessage(warning: SilenceWarning): string {
  if (warning === 'no-signal') {
    return 'No audio is reaching the recorder. Check that the mic is not muted and that Agent Hub has microphone access in your system settings.';
  }
  if (warning === 'quiet') {
    return "Not hearing anything. If the meeting plays through headphones, the mic can't pick up the other side; use speakers or move closer.";
  }
  return '';
}
