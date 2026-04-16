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
