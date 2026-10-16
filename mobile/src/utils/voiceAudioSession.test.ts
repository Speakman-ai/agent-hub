import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const audio = vi.hoisted(() => ({
  setAudioModeAsync: vi.fn(async () => {}),
  AudioRecorder: vi.fn(),
}));
vi.mock('expo-audio', () => ({
  setAudioModeAsync: audio.setAudioModeAsync,
  RecordingPresets: {
    HIGH_QUALITY: {
      extension: '.m4a',
      sampleRate: 44100,
      numberOfChannels: 2,
      bitRate: 128000,
      android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
      ios: { outputFormat: 'aac ', audioQuality: 127 },
      web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
    },
  },
  AudioModule: { AudioRecorder: audio.AudioRecorder },
}));

const session = await import('./voiceAudioSession');

function fakeRecording() {
  return {
    stop: vi.fn(async () => {}),
    uri: 'file:///a.m4a',
    isRecording: true,
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
    release: vi.fn(),
    getStatus: vi.fn(() => ({ isRecording: true })),
  };
}

describe('voiceAudioSession ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audio.AudioRecorder.mockImplementation(function () {
      return fakeRecording();
    });
  });

  it('refuses a competing acquisition while another attempt holds the recorder', async () => {
    const a = {};
    const b = {};
    const recA = await session.acquireRecording(a, () => true);
    expect(recA).toBeTruthy();
    audio.setAudioModeAsync.mockClear();
    audio.AudioRecorder.mockClear();

    await expect(session.acquireRecording(b, () => true)).rejects.toBeInstanceOf(
      session.VoiceRecordingBusyError,
    );
    // B changed nothing: no second recorder, no mode reset, A still owns it.
    expect(audio.AudioRecorder).not.toHaveBeenCalled();
    expect(audio.setAudioModeAsync).not.toHaveBeenCalled();
    expect(session.currentVoiceOwner()).toBe(a);
    if (!recA) throw new Error('expected a recorder');
    expect(recA.stop).not.toHaveBeenCalled();

    // Once A releases, B can take over.
    await session.releaseRecording(a, recA);
    expect(session.currentVoiceOwner()).toBeNull();
    const recB = await session.acquireRecording(b, () => true);
    expect(recB).toBeTruthy();
    expect(session.currentVoiceOwner()).toBe(b);
    if (!recB) throw new Error('expected a recorder');
    await session.finishRecording(b, recB);
    expect(session.currentVoiceOwner()).toBeNull();
  });

  it('a stale release never resets a mode owned by someone else', async () => {
    const a = {};
    const b = {};
    const recB = await session.acquireRecording(b, () => true);
    if (!recB) throw new Error('expected a recorder');
    audio.setAudioModeAsync.mockClear();
    await session.releaseRecording(a, fakeRecording());
    expect(audio.setAudioModeAsync).not.toHaveBeenCalled();
    expect(session.currentVoiceOwner()).toBe(b);
    await session.releaseRecording(b, recB);
  });
});

describe('voiceAudioSession recording options', () => {
  it('records mono speech-quality audio at 32 kbps', async () => {
    const preset = session.speechRecordingOptions();
    expect(preset).toMatchObject({
      bitRate: 32_000,
      numberOfChannels: 1,
      sampleRate: 16_000,
      isMeteringEnabled: true,
    });
    expect(preset.web.bitsPerSecond).toBe(32_000);

    const owner = {};
    const rec = await session.acquireRecording(owner, () => true);
    expect(audio.AudioRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        bitRate: 32_000,
        numberOfChannels: 1,
        sampleRate: 16_000,
        isMeteringEnabled: true,
      }),
    );
    await session.releaseRecording(owner, rec);
  });
});
