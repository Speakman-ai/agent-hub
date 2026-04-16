import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MessageInput from './MessageInput.jsx';

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
