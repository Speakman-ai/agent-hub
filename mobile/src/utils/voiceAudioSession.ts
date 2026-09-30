import { Audio } from 'expo-av';

/**
 * App-wide coordinator for the native recording resources voice input uses.
 *
 * iOS audio mode (`allowsRecordingIOS`) is process-global, and expo-av allows
 * one prepared Recording at a time. Every voice-input hook instance (chat
 * composer, notes editor) and every dictation attempt shares them, so all
 * transitions run through one serialized queue and the recording mode is
 * owned by exactly one attempt. A stale attempt's cleanup can release its own
 * recorder but can only reset the audio mode while it still owns it, and
 * because steps never interleave, a newer attempt can't take ownership halfway
 * through an older attempt's cleanup.
 */

export type VoiceOwner = object;

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

async function unloadQuietly(recording: any) {
  if (!recording) return;
  try {
    await recording.stopAndUnloadAsync();
  } catch {
    /* already stopped / unloaded */
  }
}

// Must run inside the queue.
async function resetIfOwner(attempt: VoiceOwner) {
  if (owner !== attempt) return;
  owner = null;
  try {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
  } catch {
    /* non-fatal: failing to reset only leaves audio routed for recording */
  }
}

/**
 * Takes recording ownership for `attempt` and starts a recorder. Resolves to
 * null (with everything released) if `isLive()` turns false before the
 * recorder is handed back; rejects (with everything released) on failure.
 */
export function acquireRecording(attempt: VoiceOwner, isLive: () => boolean): Promise<any | null> {
  return enqueue(async () => {
    if (!isLive()) return null;
    // Another attempt (e.g. the chat composer while the notes editor starts)
    // still holds a prepared recorder. expo-av allows only one, so refuse
    // before touching ownership or the mode; the holder's state is untouched.
    if (owner !== null && owner !== attempt) throw new VoiceRecordingBusyError();
    owner = attempt;
    let recording: any = null;
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      ({ recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      ));
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
export function finishRecording(attempt: VoiceOwner, recording: any): Promise<string | null> {
  return enqueue(async () => {
    try {
      await recording.stopAndUnloadAsync();
      return recording.getURI() ?? null;
    } finally {
      await resetIfOwner(attempt);
    }
  });
}

/** Discards `recording` (if any) and releases the mode if `attempt` owns it. */
export function releaseRecording(attempt: VoiceOwner | null, recording: any): Promise<void> {
  return enqueue(async () => {
    await unloadQuietly(recording);
    if (attempt) await resetIfOwner(attempt);
  });
}

/** Test hook: the current recording-mode owner. */
export function currentVoiceOwner(): VoiceOwner | null {
  return owner;
}
