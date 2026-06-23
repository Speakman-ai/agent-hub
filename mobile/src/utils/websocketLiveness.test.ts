import { describe, it, expect } from 'vitest';
import { pingTickAction } from './websocketLiveness';

// Half-open WebSocket detection state machine. A ping-interval tick must:
//   - do nothing while the socket is not OPEN,
//   - send a ping when no ping is outstanding,
//   - force a close when the previous ping was never answered (the link is
//     dead but the OS hasn't fired onclose — the "tests don't show" half-open
//     case that strands streamed finalize state).
describe('pingTickAction', () => {
  it('is a noop when the socket is not open', () => {
    expect(pingTickAction(false, false)).toBe('noop');
    expect(pingTickAction(false, true)).toBe('noop');
  });

  it('sends a ping when open and no ping is outstanding', () => {
    expect(pingTickAction(true, false)).toBe('ping');
  });

  it('force-closes when open but the previous ping went unanswered', () => {
    expect(pingTickAction(true, true)).toBe('close');
  });
});
