import { Platform } from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  type RecordingOptions,
} from 'expo-audio';

/**
 * App-wide coordinator for the native recording resources voice input uses.
 *
 * iOS audio mode (`allowsRecording`) is process-global, and this session allows
 * one prepared recorder at a time. Every voice-input hook instance (chat
 * composer, notes editor) and every dictation attempt shares them, so all
 * transitions run through one serialized queue and the recording mode is
 * owned by exactly one attempt. A stale attempt's cleanup can release its own
 * recorder but can only reset the audio mode while it still owns it, and
 * because steps never interleave, a newer attempt can't take ownership halfway
 * through an older attempt's cleanup.
 */

export type VoiceOwner = object;

/** The recorder surface this session drives. Structural so tests can stub it. */
export interface VoiceRecorder {
  uri: string | null;
  isRecording?: boolean;
  stop(): Promise<void>;
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  /** Present on the native recorder; optional so a stub can omit it. */
  release?(): void;
  getStatus?(): { isRecording?: boolean; metering?: number };
}

// Mono AAC at 32 kbps / 16 kHz: speech stays fully intelligible and an hour of
// audio is ~14 MB instead of ~58 MB at the stereo 128 kbps HIGH_QUALITY preset.
export const SPEECH_RECORDING_BITRATE = 32_000;

export function speechRecordingOptions(): RecordingOptions {
  const base = RecordingPresets.HIGH_QUALITY;
  return {
    ...base,
    sampleRate: 16_000,
    numberOfChannels: 1,
    bitRate: SPEECH_RECORDING_BITRATE,
    // Live input level for the recording meter (status.metering, in dBFS).
    isMeteringEnabled: true,
    android: { ...base.android },
    ios: { ...base.ios },
    web: { ...base.web, bitsPerSecond: SPEECH_RECORDING_BITRATE },
  };
}

/**
 * `useAudioRecorder` flattens `RecordingOptions` per platform before constructing
 * `AudioModule.AudioRecorder`. This session is not a component, so it does the
 * same flatten: native reads sample rate, channel count, and bitrate from the
 * top-level fields, and platform blocks override those when they set them.
 */
function platformRecordingOptions(options: RecordingOptions): Partial<RecordingOptions> {
  const common = {
    extension: options.extension,
    sampleRate: options.sampleRate,
    numberOfChannels: options.numberOfChannels,
    bitRate: options.bitRate,
    isMeteringEnabled: options.isMeteringEnabled ?? false,
    directory: options.directory,
  };
  if (Platform.OS === 'android') return { ...common, ...options.android };
  if (Platform.OS === 'ios') return { ...common, ...options.ios };
  return { ...common, ...options.web };
}

export class VoiceRecordingBusyError extends Error {
  constructor() {
    super('Another voice recording is in progress. Stop it first.');
    this.name = 'VoiceRecordingBusyError';
  }
}

let chain: Promise<unknown> = Promise.resolve();
let owner: VoiceOwner | null = null;

function enqueue<T>(step: () => Promise<T>): Promise<T> {
  const run = chain.then(step, step);
  chain = run.catch(() => {});
  return run;
}

async function unloadQuietly(recording: VoiceRecorder | null) {
  if (!recording) return;
  try {
    await recording.stop();
  } catch {
    /* already stopped / unloaded */
  }
  try {
    recording.release?.();
  } catch {
    /* already released */
  }
}

// Must run inside the queue.
async function resetIfOwner(attempt: VoiceOwner) {
  if (owner !== attempt) return;
  owner = null;
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } catch {
    /* non-fatal: failing to reset only leaves audio routed for recording */
  }
}

/**
 * Takes recording ownership for `attempt` and starts a recorder. Resolves to
 * null (with everything released) if `isLive()` turns false before the
 * recorder is handed back; rejects (with everything released) on failure.
 */
export function acquireRecording(
  attempt: VoiceOwner,
  isLive: () => boolean,
): Promise<VoiceRecorder | null> {
  return enqueue(async () => {
    if (!isLive()) return null;
    // Another attempt (e.g. the chat composer while the notes editor starts)
    // still holds a prepared recorder. Only one voice take runs at a time, so
    // refuse before touching ownership or the mode; the holder's state is untouched.
    if (owner !== null && owner !== attempt) throw new VoiceRecordingBusyError();
    owner = attempt;
    let recording: VoiceRecorder | null = null;
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      recording = new AudioModule.AudioRecorder(platformRecordingOptions(speechRecordingOptions()));
      await recording.prepareToRecordAsync();
      recording.record();
    } catch (err) {
      await unloadQuietly(recording);
      await resetIfOwner(attempt);
      throw err;
    }
    if (!isLive()) {
      await unloadQuietly(recording);
      await resetIfOwner(attempt);
      return null;
    }
    return recording;
  });
}

/**
 * Stops `recording` for the user's "stop" and hands back its file URI.
 * Rejects if the native stop fails; the audio mode is released either way.
 */
export function finishRecording(
  attempt: VoiceOwner,
  recording: VoiceRecorder,
): Promise<string | null> {
  return enqueue(async () => {
    try {
      await recording.stop();
      return recording.uri ?? null;
    } finally {
      try {
        recording.release?.();
      } catch {
        /* already released */
      }
      await resetIfOwner(attempt);
    }
  });
}

/** Discards `recording` (if any) and releases the mode if `attempt` owns it. */
export function releaseRecording(
  attempt: VoiceOwner | null,
  recording: VoiceRecorder | null,
): Promise<void> {
  return enqueue(async () => {
    await unloadQuietly(recording);
    if (attempt) await resetIfOwner(attempt);
  });
}

/** Test hook: the current recording-mode owner. */
export function currentVoiceOwner(): VoiceOwner | null {
  return owner;
}
