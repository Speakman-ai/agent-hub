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
});
