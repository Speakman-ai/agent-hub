import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useVoiceRecorder,
  joinSegmentTranscripts,
  RECORDING_BITS_PER_SECOND,
  SEGMENT_DURATION_MS,
} from './useVoiceRecorder';

vi.mock('../utils/connection', () => ({ getAuthHeaders: () => ({}) }));

const events: string[] = [];
let recorders: FakeMediaRecorder[] = [];
const failStartFor = new Set<number>();

class FakeMediaRecorder {
  static isTypeSupported = (t: string) => t.startsWith('audio/webm');
  mimeType: string;
  opts: any;
  state = 'inactive';
  id: number;
  ondataavailable: any = null;
  onstop: any = null;
  onerror: any = null;
  constructor(_stream: any, opts: any = {}) {
    this.opts = opts;
    this.mimeType = opts.mimeType || 'audio/webm';
    this.id = recorders.length;
    recorders.push(this);
  }
  start() {
    if (failStartFor.has(this.id)) throw new Error('stream inactive');
    this.state = 'recording';
    events.push(`start:${this.id}`);
  }
  stop() {
    this.state = 'inactive';
    events.push(`stop:${this.id}`);
    this.ondataavailable?.({ data: new Blob([`seg${this.id}`], { type: this.mimeType }) });
    this.onstop?.();
  }
}

let fetchResolvers: Array<(r: Response) => void>;
const origMR = (window as any).MediaRecorder;

beforeEach(() => {
  events.length = 0;
  recorders = [];
  failStartFor.clear();
  fetchResolvers = [];
  (window as any).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => fetchResolvers.push(resolve))),
  );
});

afterEach(() => {
  (window as any).MediaRecorder = origMR;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ok = (transcript: string) => new Response(JSON.stringify({ transcript }), { status: 200 });

function setup() {
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useVoiceRecorder({ onTranscript, onError }));
  return { hook, onTranscript, onError };
}

describe('joinSegmentTranscripts', () => {
  it('joins trimmed non-empty parts in order', () => {
    expect(joinSegmentTranscripts([' one ', null, '', 'two', undefined, 'three'])).toBe(
      'one two three',
    );
  });
});

describe('useVoiceRecorder', () => {
  it('records at the speech bitrate', async () => {
    const { hook } = setup();
    await act(() => hook.result.current.start());
    expect(recorders[0].opts.audioBitsPerSecond).toBe(RECORDING_BITS_PER_SECOND);
  });

  it('splits long recordings into segments and delivers one joined transcript in order', async () => {
    vi.useFakeTimers();
    const { hook, onTranscript, onError } = setup();
    await act(() => hook.result.current.start());

    act(() => {
      vi.advanceTimersByTime(SEGMENT_DURATION_MS);
    });
    // The next segment starts before the previous one stops, so no audio is dropped.
    expect(events).toEqual(['start:0', 'start:1', 'stop:0']);
    // The first segment uploads while recording continues.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.isRecording).toBe(true);

    act(() => hook.result.current.stop());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hook.result.current.isRecording).toBe(false);
    expect(hook.result.current.isTranscribing).toBe(true);

    // Resolve out of order; the transcript still follows recording order.
    await act(async () => {
      fetchResolvers[1](ok('second half'));
      fetchResolvers[0](ok('first half'));
    });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('first half second half');
    expect(onError).not.toHaveBeenCalled();
    expect(hook.result.current.isTranscribing).toBe(false);
  });

  it('delivers the segments that succeeded and reports the one that failed', async () => {
    vi.useFakeTimers();
    const { hook, onTranscript, onError } = setup();
    await act(() => hook.result.current.start());
    act(() => {
      vi.advanceTimersByTime(SEGMENT_DURATION_MS);
    });
    act(() => hook.result.current.stop());
    await act(async () => {
      fetchResolvers[0](ok('kept'));
      fetchResolvers[1](new Response(JSON.stringify({ error: 'boom' }), { status: 502 }));
    });
    expect(onTranscript).toHaveBeenCalledWith('kept');
    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/^Part of the recording couldn't be transcribed: .*boom/),
    );
  });

  it('surfaces the server 413 message instead of a generic "too long"', async () => {
    const { hook, onError } = setup();
    await act(() => hook.result.current.start());
    act(() => hook.result.current.stop());
    await act(async () => {
      fetchResolvers[0](
        new Response(
          JSON.stringify({ error: 'Audio exceeds the OpenAI Whisper upload limit of 25 MB' }),
          { status: 413 },
        ),
      );
    });
    expect(onError).toHaveBeenCalledWith('Audio exceeds the OpenAI Whisper upload limit of 25 MB.');
  });

  it('regression: a replacement recorder that fails to start still delivers earlier audio', async () => {
    vi.useFakeTimers();
    failStartFor.add(1);
    const { hook, onTranscript, onError } = setup();
    await act(() => hook.result.current.start());
    act(() => {
      vi.advanceTimersByTime(SEGMENT_DURATION_MS);
    });
    expect(onError).toHaveBeenCalledWith('Could not continue recording: stream inactive');
    expect(hook.result.current.isRecording).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      fetchResolvers[0](ok('before the failure'));
    });
    expect(onTranscript).toHaveBeenCalledWith('before the failure');
    expect(hook.result.current.isTranscribing).toBe(false);
  });

  it('regression: finalizes when the browser ends the recording on its own', async () => {
    vi.useFakeTimers();
    const { hook, onTranscript } = setup();
    await act(() => hook.result.current.start());
    // All input tracks ended (e.g. mic unplugged): MediaRecorder stops
    // without the hook's stop() being called.
    act(() => recorders[0].stop());
    expect(hook.result.current.isRecording).toBe(false);
    expect(hook.result.current.isTranscribing).toBe(true);
    act(() => {
      vi.advanceTimersByTime(SEGMENT_DURATION_MS * 2);
    });
    expect(recorders).toHaveLength(1);
    await act(async () => {
      fetchResolvers[0](ok('cut short'));
    });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('cut short');
    expect(hook.result.current.isTranscribing).toBe(false);
  });

  it('cancel drops in-flight segments without delivering a transcript', async () => {
    vi.useFakeTimers();
    const { hook, onTranscript, onError } = setup();
    await act(() => hook.result.current.start());
    act(() => {
      vi.advanceTimersByTime(SEGMENT_DURATION_MS);
    });
    act(() => hook.result.current.cancel());
    await act(async () => {
      fetchResolvers[0](ok('stale'));
    });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(hook.result.current.isRecording).toBe(false);
  });
});
