import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;
const create = TestRenderer.create as (element: any) => any;

const recording = vi.hoisted(() => ({
  stopAndUnloadAsync: vi.fn(async () => {}),
  getURI: vi.fn(() => 'file:///rec.m4a'),
}));
vi.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    setAudioModeAsync: vi.fn(async () => {}),
    Recording: { createAsync: vi.fn(async () => ({ recording })) },
    RecordingOptionsPresets: { HIGH_QUALITY: {} },
  },
}));
const transcribe = vi.hoisted(() => ({ resolve: null as null | ((v: any) => void) }));
vi.mock('../utils/transcribeAudio', () => ({
  transcribeAudio: vi.fn(
    () =>
      new Promise((resolve) => {
        transcribe.resolve = resolve;
      }),
  ),
}));

const { useVoiceTranscription } = await import('./useVoiceTranscription');

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

// Ownership of the native recorder is app-wide, so every harness is
// unmounted after each test to release anything it still holds.
const mounted: Array<() => void> = [];

function mount(initialKey: number, onError: any = vi.fn(), prepareTranscript?: any) {
  const state: any = { value: 'hello', key: initialKey, hook: null };
  const cursorRef = { current: 5 };
  function Harness() {
    const [value, setValue] = React.useState('hello');
    state.value = value;
    state.setValue = setValue;
    state.hook = useVoiceTranscription({
      value,
      setValue,
      cursorRef,
      disabled: false,
      isProcessing: false,
      sessionKey: state.key,
      onError,
      prepareTranscript,
    });
    return null;
  }
  let renderer: any;
  mounted.push(() => {
    if (renderer) renderer.unmount();
    renderer = null;
  });
  return {
    state,
    unmount() {
      if (renderer) renderer.unmount();
      renderer = null;
    },
    async render() {
      await act(async () => {
        if (renderer) renderer.update(React.createElement(Harness));
        else renderer = create(React.createElement(Harness));
      });
    },
  };
}

async function recordThenStop(h: ReturnType<typeof mount>) {
  await act(async () => {
    h.state.hook.handleMicClick();
    await flush();
  });
  await act(async () => {
    h.state.hook.handleMicClick();
    await flush();
  });
  expect(transcribe.resolve).toBeTruthy();
}

afterEach(async () => {
  await act(async () => {
    while (mounted.length) mounted.pop()!();
    await flush();
  });
});

describe('useVoiceTranscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcribe.resolve = null;
  });

  it('splices the transcript at the captured cursor', async () => {
    const h = mount(1);
    await h.render();
    await recordThenStop(h);
    await act(async () => {
      transcribe.resolve!({ transcript: 'world' });
      await flush();
    });
    expect(h.state.value).toBe('hello world');
  });

  it('inserts a prepared transcript as its own block, tracking edits made while preparing', async () => {
    let finish: (v: string) => void = () => {};
    const prepare = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const h = mount(1, vi.fn(), prepare);
    await h.render();
    await recordThenStop(h);
    await act(async () => {
      transcribe.resolve!({ transcript: 'world' });
      await flush();
    });
    expect(prepare).toHaveBeenCalledWith('world');
    expect(h.state.hook.isPreparing).toBe(true);
    expect(h.state.hook.micDisabled).toBe(true);
    await act(async () => {
      h.state.hook.trackEdit('hello', '> hello');
      h.state.setValue('> hello');
    });
    await act(async () => {
      finish('SUMMARY');
      await flush();
    });
    expect(h.state.value).toBe('> hello\n\nSUMMARY');
    expect(h.state.hook.isPreparing).toBe(false);
  });

  it('cancel() while preparing drops the prepared text', async () => {
    let finish: (v: string) => void = () => {};
    const prepare = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const h = mount(1, vi.fn(), prepare);
    await h.render();
    await recordThenStop(h);
    await act(async () => {
      transcribe.resolve!({ transcript: 'world' });
      await flush();
    });
    await act(async () => {
      h.state.hook.cancel();
      finish('SUMMARY');
      await flush();
    });
    expect(h.state.value).toBe('hello');
    expect(h.state.hook.isPreparing).toBe(false);
  });

  it('drops the transcript when the session key changed mid-upload', async () => {
    const h = mount(1);
    await h.render();
    await recordThenStop(h);
    h.state.key = 2;
    await h.render();
    await act(async () => {
      transcribe.resolve!({ transcript: 'stale' });
      await flush();
    });
    expect(h.state.value).toBe('hello');
  });

  it('cancel() discards an in-flight transcription', async () => {
    const h = mount(1);
    await h.render();
    await recordThenStop(h);
    await act(async () => {
      h.state.hook.cancel();
      await flush();
    });
    await act(async () => {
      transcribe.resolve!({ transcript: 'stale' });
      await flush();
    });
    expect(h.state.value).toBe('hello');
    expect(h.state.hook.isTranscribing).toBe(false);
  });

  it('keeps the anchor aligned with edits made during the upload', async () => {
    const h = mount(1);
    await h.render();
    await recordThenStop(h);
    // User prepends text before the captured cursor (5) while uploading.
    await act(async () => {
      h.state.hook.trackEdit('hello', '> hello');
      h.state.setValue('> hello');
    });
    await act(async () => {
      transcribe.resolve!({ transcript: 'world' });
      await flush();
    });
    expect(h.state.value).toBe('> hello world');
  });

  it('a cancelled upload settling does not clear a newer upload busy state', async () => {
    const h = mount(1);
    await h.render();
    await recordThenStop(h);
    const first = transcribe.resolve!;
    await act(async () => {
      h.state.hook.cancel();
      await flush();
    });
    await recordThenStop(h);
    expect(h.state.hook.isTranscribing).toBe(true);
    await act(async () => {
      first({ transcript: 'stale' });
      await flush();
    });
    expect(h.state.hook.isTranscribing).toBe(true);
    expect(h.state.value).toBe('hello');
  });

  it('does not start recording when cancelled during the permission prompt', async () => {
    const { Audio } = (await import('expo-av')) as any;
    let grant: (v: any) => void = () => {};
    Audio.requestPermissionsAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const h = mount(1);
    await h.render();
    await act(async () => {
      h.state.hook.handleMicClick();
      await flush();
    });
    await act(async () => {
      h.state.hook.cancel();
      await flush();
    });
    await act(async () => {
      grant({ status: 'granted' });
      await flush();
    });
    expect(Audio.Recording.createAsync).not.toHaveBeenCalled();
    expect(h.state.hook.isRecording).toBe(false);
  });

  it('cancel while stopAndUnloadAsync is pending starts no upload and leaves the mic usable', async () => {
    const { transcribeAudio } = (await import('../utils/transcribeAudio')) as any;
    let finishUnload: () => void = () => {};
    const h = mount(1);
    await h.render();
    await act(async () => {
      h.state.hook.handleMicClick();
      await flush();
    });
    recording.stopAndUnloadAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUnload = resolve;
        }),
    );
    await act(async () => {
      h.state.hook.handleMicClick();
      await flush();
    });
    expect(h.state.hook.isTranscribing).toBe(true);
    await act(async () => {
      h.state.hook.cancel();
      await flush();
    });
    await act(async () => {
      finishUnload();
      await flush();
    });
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(h.state.hook.isTranscribing).toBe(false);
    expect(h.state.hook.micDisabled).toBe(false);
  });

  it('a stale start failing after cancel never resets the newer recording audio mode', async () => {
    const { Audio } = (await import('expo-av')) as any;
    let failStart: (e: any) => void = () => {};
    Audio.Recording.createAsync.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failStart = reject;
        }),
    );
    const onError = vi.fn();
    const h = mount(1, onError);
    await h.render();
    // Attempt A: parks inside createAsync.
    await act(async () => {
      h.state.hook.handleMicClick();
      await flush();
    });
    await act(async () => {
      h.state.hook.cancel();
      await flush();
    });
    // Attempt B: queued behind A's native transition.
    await act(async () => {
      h.state.hook.handleMicClick();
      await flush();
    });
    await act(async () => {
      failStart(new Error('late failure'));
      await flush();
      await flush();
    });
    expect(h.state.hook.isRecording).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    // A's cleanup reset happens before B takes the mode; nothing resets after.
    const modes = Audio.setAudioModeAsync.mock.calls.map((c: any[]) => c[0].allowsRecordingIOS);
    expect(modes).toEqual([true, false, true]);
  });

  it('unmounting one instance does not reset another instance that is recording', async () => {
    const { Audio } = (await import('expo-av')) as any;
    const a = mount(1);
    await a.render();
    await act(async () => {
      a.state.hook.handleMicClick();
      await flush();
    });
    await act(async () => {
      a.state.hook.cancel();
      await flush();
    });
    const b = mount(1);
    await b.render();
    await act(async () => {
      b.state.hook.handleMicClick();
      await flush();
    });
    expect(b.state.hook.isRecording).toBe(true);
    Audio.setAudioModeAsync.mockClear();
    await act(async () => {
      a.unmount();
      await flush();
    });
    expect(Audio.setAudioModeAsync).not.toHaveBeenCalled();
  });

  it('a second instance cannot start while another is recording, and leaves it untouched', async () => {
    const { Audio } = (await import('expo-av')) as any;
    const composerError = vi.fn();
    const notesError = vi.fn();
    const composer = mount(1, composerError);
    await composer.render();
    await act(async () => {
      composer.state.hook.handleMicClick();
      await flush();
    });
    expect(composer.state.hook.isRecording).toBe(true);
    Audio.setAudioModeAsync.mockClear();
    Audio.Recording.createAsync.mockClear();

    const notes = mount(1, notesError);
    await notes.render();
    await act(async () => {
      notes.state.hook.handleMicClick();
      await flush();
    });
    expect(notes.state.hook.isRecording).toBe(false);
    expect(notesError).toHaveBeenCalledWith(
      'Another voice recording is in progress. Stop it first.',
    );
    expect(Audio.Recording.createAsync).not.toHaveBeenCalled();
    expect(Audio.setAudioModeAsync).not.toHaveBeenCalled();
    expect(composer.state.hook.isRecording).toBe(true);
    await act(async () => {
      composer.state.hook.cancel();
      await flush();
    });
  });
});
