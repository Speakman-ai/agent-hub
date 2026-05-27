import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionTail from './SessionTail.jsx';

describe('SessionTail streaming interrupt', () => {
  const baseMessage = {
    id: 'asst-1',
    role: 'assistant',
    content: 'Partial output',
    engine: 'claude-code',
  };

  it('renders Interrupt control while streaming and forwards the click', () => {
    const onInterrupt = vi.fn();
    render(
      <SessionTail
        message={baseMessage}
        events={[]}
        agentColor="#6366f1"
        streaming
        onInterrupt={onInterrupt}
      />,
    );

    fireEvent.click(screen.getByTestId('session-tail-interrupt'));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  // Negative coverage for the `showWorking && typeof onInterrupt === 'function'`
  // guard in SessionTail.jsx Header. Without these the guard could regress
  // silently and start rendering the interrupt button on persisted messages
  // or even when no handler is wired up.
  it('does not render Interrupt control when streaming is false', () => {
    const onInterrupt = vi.fn();
    render(
      <SessionTail
        message={baseMessage}
        events={[]}
        agentColor="#6366f1"
        streaming={false}
        onInterrupt={onInterrupt}
      />,
    );

    expect(screen.queryByTestId('session-tail-interrupt')).toBeNull();
  });

  it('does not render Interrupt control when onInterrupt is omitted', () => {
    render(<SessionTail message={baseMessage} events={[]} agentColor="#6366f1" streaming />);

    expect(screen.queryByTestId('session-tail-interrupt')).toBeNull();
  });
});
