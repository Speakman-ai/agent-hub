import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionTail from './SessionTail.jsx';

describe('SessionTail streaming interrupt', () => {
  it('renders Interrupt control while streaming and forwards the click', () => {
    const onInterrupt = vi.fn();
    render(
      <SessionTail
        message={{
          id: 'asst-1',
          role: 'assistant',
          content: 'Partial output',
          engine: 'claude-code',
        }}
        events={[]}
        agentColor="#6366f1"
        streaming
        onInterrupt={onInterrupt}
      />,
    );

    fireEvent.click(screen.getByTestId('session-tail-interrupt'));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});
