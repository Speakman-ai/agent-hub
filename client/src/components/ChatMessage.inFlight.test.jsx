import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatMessage from './ChatMessage.jsx';

describe('ChatMessage in-flight user actions', () => {
  const baseMessage = {
    id: 'msg-1',
    role: 'user',
    content: 'Follow up while streaming',
    queued: true,
    created_at: new Date().toISOString(),
  };

  it('shows Edit, Interrupt, and Remove while streaming', () => {
    const onEditInComposer = vi.fn();
    const onInterrupt = vi.fn();
    const onDequeue = vi.fn();

    render(
      <ChatMessage
        message={baseMessage}
        agentColor="#6366f1"
        inFlightWhileStreaming
        onEditInComposer={onEditInComposer}
        onInterrupt={onInterrupt}
        onDequeue={onDequeue}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEditInComposer).toHaveBeenCalledWith('msg-1', baseMessage.content);

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(onInterrupt).toHaveBeenCalledWith(baseMessage);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onDequeue).toHaveBeenCalledWith('msg-1', { cancelStream: true });
  });

  it('keeps inline queued edit when not in-flight', () => {
    render(
      <ChatMessage
        message={baseMessage}
        agentColor="#6366f1"
        onEditQueued={vi.fn()}
        onDequeue={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  // `showInFlightActions` is true for `inFlightWhileStreaming && isUser && (isQueued || isInterrupted)`.
  // A message can be in the interrupted state without being queued (e.g. mid-send when the
  // previous stream was cancelled). Without this case, dropping the `|| isInterrupted` branch
  // would not be caught by the suite.
  it('shows Edit, Interrupt, and Remove for an interrupted message that is not queued', () => {
    const interruptedMessage = {
      id: 'msg-2',
      role: 'user',
      content: 'Sent right before cancel',
      queued: false,
      interrupted: true,
      created_at: new Date().toISOString(),
    };
    const onEditInComposer = vi.fn();
    const onInterrupt = vi.fn();
    const onDequeue = vi.fn();

    render(
      <ChatMessage
        message={interruptedMessage}
        agentColor="#6366f1"
        inFlightWhileStreaming
        onEditInComposer={onEditInComposer}
        onInterrupt={onInterrupt}
        onDequeue={onDequeue}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEditInComposer).toHaveBeenCalledWith('msg-2', interruptedMessage.content);

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(onInterrupt).toHaveBeenCalledWith(interruptedMessage);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onDequeue).toHaveBeenCalledWith('msg-2', { cancelStream: true });
  });
});
