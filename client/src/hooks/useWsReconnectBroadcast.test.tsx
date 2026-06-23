import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useWsReconnectBroadcast } from './useWsReconnectBroadcast';

function Harness({ connected, dispatch }: any) {
  useWsReconnectBroadcast(connected, dispatch);
  return null;
}

describe('useWsReconnectBroadcast', () => {
  it('does NOT fire when the socket is already open at mount and never drops', () => {
    // Degenerate case: no disconnected window was ever observed, so the
    // consumer's mount-time fetch already reflects current truth.
    const dispatch = vi.fn();
    const { rerender } = render(<Harness connected={true} dispatch={dispatch} />);
    rerender(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fires on the FIRST successful connection when the app mounted disconnected', () => {
    // Regression for the reviewer gap: useWebSocket always starts
    // `connected === false`, so the first connection is a real false->true
    // transition. The mount fetch predates the socket open, so events in the
    // [mount, first-connect] gap are missed unless we reconcile here.
    const dispatch = vi.fn();
    const { rerender } = render(<Harness connected={false} dispatch={dispatch} />);
    expect(dispatch).not.toHaveBeenCalled();

    rerender(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('fires on a re-connect (connected → dropped → connected)', () => {
    const dispatch = vi.fn();
    // Mount already connected → no fire yet (no disconnected window observed).
    const { rerender } = render(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).not.toHaveBeenCalled();

    rerender(<Harness connected={false} dispatch={dispatch} />);
    expect(dispatch).not.toHaveBeenCalled();

    rerender(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('fires again on each subsequent reconnect', () => {
    const dispatch = vi.fn();
    // Mount disconnected → first connect fires (1).
    const { rerender } = render(<Harness connected={false} dispatch={dispatch} />);
    rerender(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // Drop and reconnect → fires again (2).
    rerender(<Harness connected={false} dispatch={dispatch} />);
    rerender(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).toHaveBeenCalledTimes(2);
    // And again (3).
    rerender(<Harness connected={false} dispatch={dispatch} />);
    rerender(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('does not re-fire while staying connected with no intervening drop', () => {
    const dispatch = vi.fn();
    const { rerender } = render(<Harness connected={false} dispatch={dispatch} />);
    rerender(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // Re-render with the same connected=true value — no transition, no fire.
    rerender(<Harness connected={true} dispatch={dispatch} />);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('never fires while the socket only flaps closed', () => {
    const dispatch = vi.fn();
    const { rerender } = render(<Harness connected={false} dispatch={dispatch} />);
    rerender(<Harness connected={false} dispatch={dispatch} />);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('defaults to dispatching a real agenthub:ws_reconnected window event', () => {
    const listener = vi.fn();
    window.addEventListener('agenthub:ws_reconnected', listener);
    try {
      // Real-app shape: mount disconnected, then connect.
      const { rerender } = render(<Harness connected={false} />);
      rerender(<Harness connected={true} />);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('agenthub:ws_reconnected', listener);
    }
  });
});
