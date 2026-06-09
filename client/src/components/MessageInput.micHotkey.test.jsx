import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import MessageInput from './MessageInput.jsx';

// Minimal fake MediaStream — only getTracks()/track.stop() are exercised.
function makeFakeStream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], _track: track };
}

// Stand-in for the browser MediaRecorder. Synchronous start/stop is enough to
// drive the component's recording state without real audio plumbing.
class MockMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = opts?.mimeType || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    // No chunks were pushed, so the component reports "couldn't capture" and
    // flips out of the recording state — no /api/transcribe fetch happens.
    if (typeof this.onstop === 'function') this.onstop();
  }
}

let getUserMedia;

beforeEach(() => {
  getUserMedia = vi.fn().mockResolvedValue(makeFakeStream());
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete globalThis.navigator.mediaDevices;
});

describe('MessageInput microphone hotkey wiring', () => {
  it('exposes a toggleRecording imperative handle that starts and stops recording', async () => {
    const ref = createRef();
    render(<MessageInput ref={ref} onSend={() => {}} disabled={false} isProcessing={false} />);

    const micButton = screen.getByLabelText('Start voice input');
    expect(micButton).toHaveAttribute('aria-pressed', 'false');

    // Start via the imperative handle, exactly as the global hotkey would.
    let started;
    await act(async () => {
      started = ref.current.toggleRecording();
    });
    expect(started).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(screen.getByLabelText('Stop recording')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(ref.current.isRecording()).toBe(true);

    // Toggle again → stop.
    await act(async () => {
      ref.current.toggleRecording();
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Start voice input')).toHaveAttribute('aria-pressed', 'false'),
    );
  });

  it('is a no-op when the composer is disabled and not mid-stream', async () => {
    const ref = createRef();
    render(<MessageInput ref={ref} onSend={() => {}} disabled={true} isProcessing={false} />);

    let result;
    await act(async () => {
      result = ref.current.toggleRecording();
    });
    expect(result).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('advertises the keyboard chord in the mic button tooltip', () => {
    const ref = createRef();
    render(<MessageInput ref={ref} onSend={() => {}} disabled={false} isProcessing={false} />);
    // jsdom resolves to the non-mac profile, so the chord renders as Ctrl+Alt+M.
    expect(screen.getByLabelText('Start voice input')).toHaveAttribute(
      'title',
      expect.stringContaining('Ctrl+Alt+M'),
    );
  });
});
