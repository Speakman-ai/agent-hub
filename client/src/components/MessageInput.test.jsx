import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import MessageInput, { pickAudioMimeType, baseAudioContentType } from './MessageInput.jsx';

vi.mock('../utils/connection.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test-jwt' })),
  };
});

/**
 * MessageInput — mid-stream submission behavior.
 *
 * Regression tests for the switch from "Enter always interrupts" to
 * "Enter queues by default; Interrupt is an explicit button."
 */
describe('MessageInput mid-stream behavior', () => {
  const baseProps = {
    onCancel: () => {},
    disabled: false,
    queueLength: 0,
    agentColor: '#4F46E5',
    skills: [],
    askMode: false,
  };

  it('queues (interrupt=false) when Enter is pressed while processing', () => {
    const onSend = vi.fn();
    render(<MessageInput {...baseProps} onSend={onSend} isProcessing={true} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'follow-up question' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledTimes(1);
    const [, , options] = onSend.mock.calls[0];
    expect(options).toEqual({ interrupt: false });
  });

  it('interrupts (interrupt=true) when the explicit Interrupt button is clicked', () => {
    const onSend = vi.fn();
    render(<MessageInput {...baseProps} onSend={onSend} isProcessing={true} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'stop and do this instead' } });

    const interruptBtn = screen.getByRole('button', { name: /interrupt/i });
    fireEvent.click(interruptBtn);

    expect(onSend).toHaveBeenCalledTimes(1);
    const [, , options] = onSend.mock.calls[0];
    expect(options).toEqual({ interrupt: true });
  });

  it('clicking the Queue button while processing submits without interrupt', () => {
    const onSend = vi.fn();
    render(<MessageInput {...baseProps} onSend={onSend} isProcessing={true} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'for later' } });

    const queueBtn = screen.getByRole('button', { name: /queue message/i });
    fireEvent.click(queueBtn);

    expect(onSend).toHaveBeenCalledTimes(1);
    const [, , options] = onSend.mock.calls[0];
    expect(options).toEqual({ interrupt: false });
  });

  it('shows both Interrupt and Queue buttons when processing with typed text', () => {
    render(<MessageInput {...baseProps} onSend={() => {}} isProcessing={true} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hi' } });

    expect(screen.getByRole('button', { name: /interrupt/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /queue message/i })).toBeInTheDocument();
  });

  it('when not processing, Enter sends normally (interrupt=false)', () => {
    const onSend = vi.fn();
    render(<MessageInput {...baseProps} onSend={onSend} isProcessing={false} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledTimes(1);
    const [content, , options] = onSend.mock.calls[0];
    expect(content).toBe('hello');
    expect(options).toEqual({ interrupt: false });
  });
});

describe('MessageInput composer prefill (edit queued)', () => {
  const baseProps = {
    onSend: vi.fn(),
    onCancel: () => {},
    disabled: false,
    isProcessing: true,
    queueLength: 1,
    agentColor: '#4F46E5',
    skills: [],
    askMode: false,
  };

  it('replaces queued text via onReplaceQueuedMessage and shows text-only banner', () => {
    const onReplaceQueuedMessage = vi.fn();
    const onComposerPrefillClear = vi.fn();
    render(
      <MessageInput
        {...baseProps}
        composerPrefill={{ messageId: 'q-1', content: 'original' }}
        onReplaceQueuedMessage={onReplaceQueuedMessage}
        onComposerPrefillClear={onComposerPrefillClear}
      />,
    );

    expect(screen.getByTestId('composer-edit-queued-banner')).toBeInTheDocument();
    const textarea = screen.getByRole('textbox');
    expect(textarea.value).toBe('original');

    fireEvent.change(textarea, { target: { value: 'revised prompt' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onReplaceQueuedMessage).toHaveBeenCalledWith('q-1', 'revised prompt');
    expect(baseProps.onSend).not.toHaveBeenCalled();
    expect(onComposerPrefillClear).toHaveBeenCalled();
  });

  it('disables the attach button while editing a queued message', () => {
    render(
      <MessageInput
        {...baseProps}
        composerPrefill={{ messageId: 'q-1', content: 'original' }}
        onReplaceQueuedMessage={vi.fn()}
        onComposerPrefillClear={vi.fn()}
      />,
    );

    expect(
      screen.getByTitle('Attachments are not supported when editing a queued message'),
    ).toBeDisabled();
  });
});

describe('MessageInput per-session drafts', () => {
  const baseProps = {
    onSend: () => {},
    onCancel: () => {},
    disabled: false,
    isProcessing: false,
    queueLength: 0,
    agentColor: '#4F46E5',
    skills: [],
    askMode: false,
  };

  it('preserves drafts per draftKey when switching sessions', () => {
    const { rerender } = render(<MessageInput {...baseProps} draftKey="session-A" />);

    // Type on session A, don't submit
    let textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'draft for A' } });
    expect(textarea.value).toBe('draft for A');

    // Switch to session B — composer should be empty
    rerender(<MessageInput {...baseProps} draftKey="session-B" />);
    textarea = screen.getByRole('textbox');
    expect(textarea.value).toBe('');

    // Type on session B
    fireEvent.change(textarea, { target: { value: 'draft for B' } });
    expect(textarea.value).toBe('draft for B');

    // Switch back to session A — original draft restored
    rerender(<MessageInput {...baseProps} draftKey="session-A" />);
    textarea = screen.getByRole('textbox');
    expect(textarea.value).toBe('draft for A');

    // Switch back to B — B's draft still intact
    rerender(<MessageInput {...baseProps} draftKey="session-B" />);
    textarea = screen.getByRole('textbox');
    expect(textarea.value).toBe('draft for B');
  });

  it('submitting clears the draft for the active session only', () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <MessageInput {...baseProps} onSend={onSend} draftKey="session-A" />,
    );

    // Draft on A, then switch to B and leave a draft there
    let textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'A draft' } });

    rerender(<MessageInput {...baseProps} onSend={onSend} draftKey="session-B" />);
    textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'B draft' } });

    // Submit on B — B's draft should clear
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('B draft');
    expect(textarea.value).toBe('');

    // Switch back to A — A's draft must still be intact
    rerender(<MessageInput {...baseProps} onSend={onSend} draftKey="session-A" />);
    textarea = screen.getByRole('textbox');
    expect(textarea.value).toBe('A draft');

    // Back to B — draft was cleared by submit
    rerender(<MessageInput {...baseProps} onSend={onSend} draftKey="session-B" />);
    textarea = screen.getByRole('textbox');
    expect(textarea.value).toBe('');
  });

  it('closes the slash-autocomplete popup when draftKey changes', () => {
    // jsdom doesn't implement scrollIntoView; stub so the popup's effect doesn't throw
    const origScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {};

    try {
      const skills = [
        { id: 'commit', name: 'commit', description: 'Create a git commit' },
        { id: 'review-pr', name: 'review-pr', description: 'Review a pull request' },
      ];
      const { rerender } = render(
        <MessageInput {...baseProps} skills={skills} draftKey="session-A" />,
      );

      // Open the slash popup on session A — the change handler reads
      // e.target.selectionStart, so pass it explicitly
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, {
        target: { value: '/co', selectionStart: 3, selectionEnd: 3 },
      });
      // Popup header renders "Skills" when the slash popup is open
      expect(screen.getByText('Skills')).toBeInTheDocument();

      // Switch to session B — popup must close
      rerender(<MessageInput {...baseProps} skills={skills} draftKey="session-B" />);
      expect(screen.queryByText('Skills')).not.toBeInTheDocument();
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView;
    }
  });
});

describe('MessageInput media attachments across sessions', () => {
  const baseProps = {
    onSend: () => {},
    onCancel: () => {},
    disabled: false,
    isProcessing: false,
    queueLength: 0,
    agentColor: '#4F46E5',
    skills: [],
    askMode: false,
  };

  it('clears image previews when draftKey changes', async () => {
    const { rerender } = render(<MessageInput {...baseProps} draftKey="session-A" />);

    // Simulate attaching an image via the hidden file input
    const file = new File(['stub'], 'hello.png', { type: 'image/png' });
    // Stub FileReader — jsdom's implementation is enough but we want deterministic
    // data URLs without waiting on async canvas resizing.
    const origFileReader = globalThis.FileReader;
    class StubReader {
      readAsDataURL() {
        this.result = 'data:image/png;base64,AAAA';
        queueMicrotask(() => this.onload && this.onload());
      }
    }
    globalThis.FileReader = StubReader;
    // Stub Image onload to short-circuit the resize path
    const origImage = globalThis.Image;
    class StubImage {
      set src(_v) {
        this.width = 10;
        this.height = 10;
        queueMicrotask(() => this.onload && this.onload());
      }
    }
    globalThis.Image = StubImage;

    try {
      const fileInput = document.querySelector('input[type="file"]');
      await fireEvent.change(fileInput, { target: { files: [file] } });
      // Let microtasks flush so the image shows up in previews
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByAltText('hello.png')).toBeInTheDocument();

      // Switch sessions — preview should be gone so it doesn't leak to B
      rerender(<MessageInput {...baseProps} draftKey="session-B" />);
      expect(screen.queryByAltText('hello.png')).not.toBeInTheDocument();
    } finally {
      globalThis.FileReader = origFileReader;
      globalThis.Image = origImage;
    }
  });
});

// ─── Voice transcription / mic button ─────────────────────────────

describe('MessageInput voice transcription', () => {
  const baseProps = {
    onSend: () => {},
    onCancel: () => {},
    disabled: false,
    isProcessing: false,
    queueLength: 0,
    agentColor: '#4F46E5',
    skills: [],
    askMode: false,
  };

  // ── Helper: install a deterministic fake MediaRecorder ───────────
  function installFakeMediaRecorder({ supportedTypes = ['audio/webm;codecs=opus'] } = {}) {
    const instances = [];
    class FakeMediaRecorder {
      constructor(stream, opts = {}) {
        this.stream = stream;
        this.mimeType = opts.mimeType || 'audio/webm;codecs=opus';
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onstop = null;
        this.onerror = null;
        instances.push(this);
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        // Synchronously deliver one chunk, then fire onstop.
        if (this.ondataavailable) {
          this.ondataavailable({ data: new Blob(['fake-audio-bytes'], { type: this.mimeType }) });
        }
        if (this.onstop) this.onstop();
      }
    }
    FakeMediaRecorder.isTypeSupported = (t) =>
      supportedTypes.some((s) => t.toLowerCase().startsWith(s.split(';')[0]));
    const orig = globalThis.MediaRecorder;
    globalThis.MediaRecorder = FakeMediaRecorder;
    window.MediaRecorder = FakeMediaRecorder;
    return {
      instances,
      restore: () => {
        globalThis.MediaRecorder = orig;
        window.MediaRecorder = orig;
      },
    };
  }

  function installFakeGetUserMedia({ deny = false } = {}) {
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
    const originalMd = navigator.mediaDevices;
    const getUserMedia = vi.fn(async () => {
      if (deny) {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        throw err;
      }
      return fakeStream;
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      writable: true,
      value: { getUserMedia },
    });
    return {
      getUserMedia,
      restore: () => {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          writable: true,
          value: originalMd,
        });
      },
    };
  }

  function installFetchOk(transcript) {
    const fetchSpy = vi.fn(async (_url, init) => {
      // Capture the body type for assertions: we expect a Blob, NOT FormData.
      fetchSpy.lastBody = init?.body;
      fetchSpy.lastContentType = init?.headers?.['Content-Type'];
      fetchSpy.lastAuth = init?.headers?.Authorization;
      return new Response(JSON.stringify({ transcript }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    return { fetchSpy, restore: () => (globalThis.fetch = orig) };
  }

  function installFetchStatus(status, bodyObj = {}) {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(bodyObj), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const orig = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    return { fetchSpy, restore: () => (globalThis.fetch = orig) };
  }

  let mr, gum, ft;
  beforeEach(() => {
    mr = installFakeMediaRecorder();
    gum = installFakeGetUserMedia();
  });
  afterEach(() => {
    ft?.restore();
    gum.restore();
    mr.restore();
    vi.restoreAllMocks();
  });

  it('pickAudioMimeType prefers webm/opus when supported', () => {
    expect(pickAudioMimeType()).toBe('audio/webm;codecs=opus');
  });

  it('pickAudioMimeType falls back to audio/mp4 when only mp4 is supported (Safari)', () => {
    mr.restore();
    mr = installFakeMediaRecorder({ supportedTypes: ['audio/mp4'] });
    expect(pickAudioMimeType()).toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('pickAudioMimeType returns null when MediaRecorder is unavailable', () => {
    mr.restore();
    delete window.MediaRecorder;
    delete globalThis.MediaRecorder;
    expect(pickAudioMimeType()).toBeNull();
  });

  it('baseAudioContentType strips codec parameters', () => {
    expect(baseAudioContentType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseAudioContentType('AUDIO/MP4 ; codecs=mp4a.40.2')).toBe('audio/mp4');
    expect(baseAudioContentType('')).toBe('audio/webm');
  });

  it('renders the mic button', () => {
    render(<MessageInput {...baseProps} />);
    expect(screen.getByRole('button', { name: /start voice input/i })).toBeInTheDocument();
  });

  it('records, posts a raw audio blob, and inserts the transcript', async () => {
    ft = installFetchOk('hello world');
    const onFileError = vi.fn();
    render(<MessageInput {...baseProps} onFileError={onFileError} />);

    const textarea = screen.getByRole('textbox');

    const micBtn = screen.getByRole('button', { name: /start voice input/i });
    await act(async () => {
      fireEvent.click(micBtn);
    });
    expect(gum.getUserMedia).toHaveBeenCalledWith({ audio: true });

    // Button label flips to "Stop recording"
    expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument();

    const stopBtn = screen.getByRole('button', { name: /stop recording/i });
    await act(async () => {
      fireEvent.click(stopBtn);
    });

    await waitFor(() => expect(ft.fetchSpy).toHaveBeenCalledTimes(1));

    // The endpoint expects a raw audio blob, not FormData.
    expect(ft.fetchSpy.lastBody).toBeInstanceOf(Blob);
    expect(ft.fetchSpy.lastContentType).toBe('audio/webm');
    expect(ft.fetchSpy.lastAuth).toBe('Bearer test-jwt');

    await waitFor(() => expect(textarea.value).toBe('hello world'));
    expect(onFileError).not.toHaveBeenCalled();
  });

  it('appends the transcript with a leading space when text exists', async () => {
    ft = installFetchOk('hello world');
    render(<MessageInput {...baseProps} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'preface' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });

    // The caret defaults to end-of-text after React's controlled setter
    // commits in JSDOM, so we assert the splice-with-leading-space
    // behavior at end-of-buffer rather than mid-text.
    await waitFor(() => expect(textarea.value).toContain('hello world'));
    expect(textarea.value).toBe('preface hello world');
  });

  it('handles 501 with the "not configured" toast and does not insert text', async () => {
    ft = installFetchStatus(501, { error: 'Transcription not configured' });
    const onFileError = vi.fn();
    render(<MessageInput {...baseProps} onFileError={onFileError} />);

    const micBtn = screen.getByRole('button', { name: /start voice input/i });
    await act(async () => {
      fireEvent.click(micBtn);
    });
    const stopBtn = screen.getByRole('button', { name: /stop recording/i });
    await act(async () => {
      fireEvent.click(stopBtn);
    });

    await waitFor(() => expect(onFileError).toHaveBeenCalledTimes(1));
    expect(onFileError.mock.calls[0][0]).toMatch(/not configured/i);
    expect(screen.getByRole('textbox').value).toBe('');
  });

  it('handles 413 (too large) with a retry-able toast', async () => {
    ft = installFetchStatus(413, { error: 'Audio too large' });
    const onFileError = vi.fn();
    render(<MessageInput {...baseProps} onFileError={onFileError} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });

    await waitFor(() => expect(onFileError).toHaveBeenCalledTimes(1));
    expect(onFileError.mock.calls[0][0]).toMatch(/too long|too large/i);
  });

  it('surfaces the server hint on 415 (provider cannot read this format)', async () => {
    ft = installFetchStatus(415, {
      error: 'Gemini cannot transcribe audio/webm audio',
      provider: 'gemini',
      hint: 'Switch the transcription provider to OpenAI, or record in OGG / MP3 / WAV / FLAC.',
    });
    const onFileError = vi.fn();
    render(<MessageInput {...baseProps} onFileError={onFileError} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });

    await waitFor(() => expect(onFileError).toHaveBeenCalledTimes(1));
    expect(onFileError.mock.calls[0][0]).toMatch(/switch the transcription provider/i);
    expect(screen.getByRole('textbox').value).toBe('');
  });

  it('handles network errors with a retry-able toast', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    ft = { restore: () => (globalThis.fetch = origFetch), fetchSpy };

    const onFileError = vi.fn();
    render(<MessageInput {...baseProps} onFileError={onFileError} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });

    await waitFor(() => expect(onFileError).toHaveBeenCalledTimes(1));
    expect(onFileError.mock.calls[0][0]).toMatch(/failed to fetch|network|retry/i);
  });

  it('shows a friendly toast when mic permission is denied', async () => {
    gum.restore();
    gum = installFakeGetUserMedia({ deny: true });
    const onFileError = vi.fn();
    render(<MessageInput {...baseProps} onFileError={onFileError} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    });

    await waitFor(() => expect(onFileError).toHaveBeenCalledTimes(1));
    expect(onFileError.mock.calls[0][0]).toMatch(/permission denied/i);
    // Button should NOT flip to recording state when permission was denied.
    expect(screen.queryByRole('button', { name: /stop recording/i })).not.toBeInTheDocument();
  });

  it('does NOT auto-send the message after inserting transcript', async () => {
    ft = installFetchOk('hello world');
    const onSend = vi.fn();
    render(<MessageInput {...baseProps} onSend={onSend} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });

    await waitFor(() => expect(screen.getByRole('textbox').value).toContain('hello world'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('drops the transcript when draftKey changes while the upload is in-flight', async () => {
    // Set up a fetch that we can resolve manually so we can flip draftKey
    // between stopRecording() and the server response arriving. The mock
    // must also respect the AbortSignal so the in-flight request is
    // properly cancelled when the draftKey cleanup fires.
    let resolveUpload;
    const uploadPromise = new Promise((resolve) => {
      resolveUpload = resolve;
    });
    const fetchSpy = vi.fn(async (_url, init) => {
      await new Promise((resolve, reject) => {
        if (init?.signal?.aborted) {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
          return;
        }
        const onAbort = () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        };
        init?.signal?.addEventListener('abort', onAbort);
        uploadPromise.then(() => {
          init?.signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      return new Response(JSON.stringify({ transcript: 'should not land' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    ft = { restore: () => (globalThis.fetch = origFetch), fetchSpy };

    const onFileError = vi.fn();
    const { rerender } = render(
      <MessageInput {...baseProps} onFileError={onFileError} draftKey="session-A" />,
    );

    // Start and stop recording — onstop fires, fetch starts, upload is now in-flight.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });

    // Fetch is now in-flight. Switch to session B before the response arrives.
    await act(async () => {
      rerender(<MessageInput {...baseProps} onFileError={onFileError} draftKey="session-B" />);
    });

    // Now let the upload resolve.
    await act(async () => {
      resolveUpload();
    });

    // Transcript must NOT appear in session-B's composer.
    const textarea = screen.getByRole('textbox');
    expect(textarea.value).toBe('');
    // And the "not configured" / error toast must NOT have fired (AbortError is silent).
    expect(onFileError).not.toHaveBeenCalled();
  });
});

describe('MessageInput readOnly (reviewer thread) mode', () => {
  const baseProps = {
    onSend: () => {},
    onCancel: () => {},
    disabled: false,
    queueLength: 0,
    agentColor: '#4F46E5',
    skills: [],
    askMode: false,
  };

  it('renders only the read-only banner when readOnly is true', () => {
    render(<MessageInput {...baseProps} readOnly={true} />);
    const banner = screen.getByTestId('reviewer-readonly-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toMatch(/Reviewer thread/i);
    expect(banner.textContent).toMatch(/read-only/i);
    // Composer affordances must NOT render in read-only mode.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the normal composer when readOnly is false', () => {
    render(<MessageInput {...baseProps} readOnly={false} />);
    expect(screen.queryByTestId('reviewer-readonly-banner')).toBeNull();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('readOnly takes precedence over askMode (no composer either way)', () => {
    // A reviewer agent that is also in ask mode should still surface
    // the reviewer banner, not the ask-mode composer.
    render(<MessageInput {...baseProps} readOnly={true} askMode={true} />);
    expect(screen.getByTestId('reviewer-readonly-banner')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
