import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import RecordingLevelMeter from './RecordingLevelMeter';
import { LEVEL_POLL_MS } from '../hooks/useAudioLevel';
import { SILENCE_WARNING_MS } from '@shared/utils/audioLevel';

// Amplitude the fake analyser reports; 0 mimics a blocked mic (all zeros).
let amplitude = 0;
const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  closed = false;
  disconnected = false;
  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource() {
    return {
      connect: () => undefined,
      disconnect: () => {
        this.disconnected = true;
      },
    };
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      getFloatTimeDomainData: (buf: Float32Array) => {
        for (let i = 0; i < buf.length; i++) buf[i] = i % 2 ? amplitude : -amplitude;
      },
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

const stream = {} as MediaStream;

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('RecordingLevelMeter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    amplitude = 0;
    contexts.length = 0;
    (window as any).AudioContext = FakeAudioContext;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).AudioContext;
  });

  it('shows the live input level while audio arrives', () => {
    amplitude = 0.1; // -20 dBFS
    render(<RecordingLevelMeter stream={stream} />);
    advance(LEVEL_POLL_MS);
    const meter = screen.getByRole('meter', { name: 'Microphone level' });
    expect(Number(meter.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
    advance(SILENCE_WARNING_MS * 2);
    expect(screen.queryByTestId('recording-silence-warning')).toBeNull();
  });

  it('warns when the mic delivers nothing, so an empty take is caught before Stop', () => {
    render(<RecordingLevelMeter stream={stream} />);
    advance(SILENCE_WARNING_MS - LEVEL_POLL_MS);
    expect(screen.queryByTestId('recording-silence-warning')).toBeNull();
    advance(LEVEL_POLL_MS * 2);
    expect(screen.getByTestId('recording-silence-warning').textContent).toMatch(
      /No audio is reaching the recorder/,
    );
  });

  it('warns about a quiet input and clears once sound returns', () => {
    amplitude = 0.0001; // -80 dBFS: a live but silent mic
    render(<RecordingLevelMeter stream={stream} />);
    advance(SILENCE_WARNING_MS + LEVEL_POLL_MS);
    expect(screen.getByTestId('recording-silence-warning').textContent).toMatch(
      /Not hearing anything/,
    );
    amplitude = 0.1;
    advance(LEVEL_POLL_MS);
    expect(screen.queryByTestId('recording-silence-warning')).toBeNull();
  });

  it('releases the audio graph when the stream goes away', () => {
    const { rerender } = render(<RecordingLevelMeter stream={stream} />);
    expect(contexts).toHaveLength(1);
    rerender(<RecordingLevelMeter stream={null} />);
    expect(contexts[0].closed).toBe(true);
    expect(contexts[0].disconnected).toBe(true);
  });
});
