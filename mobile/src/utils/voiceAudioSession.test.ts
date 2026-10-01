import { describe, it, expect, vi, beforeEach } from 'vitest';

const audio = vi.hoisted(() => ({
  setAudioModeAsync: vi.fn(async () => {}),
  createAsync: vi.fn(),
}));
vi.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: audio.setAudioModeAsync,
    Recording: { createAsync: audio.createAsync },
    RecordingOptionsPresets: { HIGH_QUALITY: {} },
  },
}));

const session = await import('./voiceAudioSession');

function fakeRecording() {
  return { stopAndUnloadAsync: vi.fn(async () => {}), getURI: () => 'file:///a.m4a' };
}

describe('voiceAudioSession ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audio.createAsync.mockImplementation(async () => ({ recording: fakeRecording() }));
  });

  it('refuses a competing acquisition while another attempt holds the recorder', async () => {
    const a = {};
    const b = {};
    const recA = await session.acquireRecording(a, () => true);
    expect(recA).toBeTruthy();
    audio.setAudioModeAsync.mockClear();
    audio.createAsync.mockClear();

    await expect(session.acquireRecording(b, () => true)).rejects.toBeInstanceOf(
      session.VoiceRecordingBusyError,
    );
    // B changed nothing: no second recorder, no mode reset, A still owns it.
    expect(audio.createAsync).not.toHaveBeenCalled();
    expect(audio.setAudioModeAsync).not.toHaveBeenCalled();
    expect(session.currentVoiceOwner()).toBe(a);
    expect(recA.stopAndUnloadAsync).not.toHaveBeenCalled();

    // Once A releases, B can take over.
    await session.releaseRecording(a, recA);
    expect(session.currentVoiceOwner()).toBeNull();
    const recB = await session.acquireRecording(b, () => true);
    expect(recB).toBeTruthy();
    expect(session.currentVoiceOwner()).toBe(b);
    await session.finishRecording(b, recB);
    expect(session.currentVoiceOwner()).toBeNull();
  });

  it('a stale release never resets a mode owned by someone else', async () => {
    const a = {};
    const b = {};
    const recB = await session.acquireRecording(b, () => true);
    audio.setAudioModeAsync.mockClear();
    await session.releaseRecording(a, fakeRecording());
    expect(audio.setAudioModeAsync).not.toHaveBeenCalled();
    expect(session.currentVoiceOwner()).toBe(b);
    await session.releaseRecording(b, recB);
  });
});

describe('voiceAudioSession recording options', () => {
  it('records mono speech-quality audio at 32 kbps', async () => {
    audio.createAsync.mockImplementation(async () => ({ recording: fakeRecording() }));
    const owner = {};
    const rec = await session.acquireRecording(owner, () => true);
    const opts = audio.createAsync.mock.calls.at(-1)?.[0];
    for (const platform of ['android', 'ios'] as const) {
      expect(opts[platform]).toMatchObject({ bitRate: 32_000, numberOfChannels: 1 });
    }
    await session.releaseRecording(owner, rec);
  });
});
