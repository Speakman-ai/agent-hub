/**
 * Unit tests for the pure helpers in design-chat.ts. The chat handler itself
 * spawns a real CLI and is exercised through integration tests; here we just
 * cover the state-inspection surface that the `/status` endpoint relies on.
 */
import { getDesignStatus, activeDesignProcesses } from './design-chat.js';

describe('getDesignStatus', () => {
  afterEach(() => {
    // Keep the shared map clean between cases so test order doesn't matter.
    activeDesignProcesses.clear();
  });

  it('returns the no-turn sentinel when no process is registered', () => {
    expect(getDesignStatus('design-xyz')).toEqual({
      inFlight: false,
      messageId: null,
      streaming: '',
    });
  });

  it('reports the message id and latest cumulative stream when a turn is live', () => {
    activeDesignProcesses.set('design-abc', {
      proc: null,
      cancelled: false,
      messageId: 'msg-7',
      lastStream: 'hello world',
    } as unknown as Parameters<typeof activeDesignProcesses.set>[1]);

    expect(getDesignStatus('design-abc')).toEqual({
      inFlight: true,
      messageId: 'msg-7',
      streaming: 'hello world',
    });
  });

  it('treats a live entry with no streamed output yet as inFlight with empty text', () => {
    activeDesignProcesses.set('design-quiet', {
      proc: null,
      cancelled: false,
      messageId: 'msg-0',
      lastStream: '',
    } as unknown as Parameters<typeof activeDesignProcesses.set>[1]);

    expect(getDesignStatus('design-quiet')).toEqual({
      inFlight: true,
      messageId: 'msg-0',
      streaming: '',
    });
  });
});
