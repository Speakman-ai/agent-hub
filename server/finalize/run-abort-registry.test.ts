import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFinalizeRunSignal,
  registerFinalizeRunAbort,
  unregisterFinalizeRunAbort,
  abortFinalizeRunInProcess,
  __clearFinalizeRunAbortRegistry,
} from './run-abort-registry.js';

describe('run-abort-registry', () => {
  beforeEach(() => {
    __clearFinalizeRunAbortRegistry();
  });

  describe('createFinalizeRunSignal', () => {
    it('starts un-aborted and flips on abort()', () => {
      const { signal, abort } = createFinalizeRunSignal();
      expect(signal.aborted).toBe(false);
      abort();
      expect(signal.aborted).toBe(true);
    });

    it('fires registered listeners exactly once on abort', () => {
      const { signal, abort } = createFinalizeRunSignal();
      let calls = 0;
      signal.onAbort(() => {
        calls++;
      });
      abort();
      abort(); // idempotent — listeners only fire on the first trip
      expect(calls).toBe(1);
    });

    it('fires a listener immediately if already aborted', () => {
      const { signal, abort } = createFinalizeRunSignal();
      abort();
      let fired = false;
      signal.onAbort(() => {
        fired = true;
      });
      expect(fired).toBe(true);
    });

    it('unsubscribe stops a listener from firing', () => {
      const { signal, abort } = createFinalizeRunSignal();
      let fired = false;
      const off = signal.onAbort(() => {
        fired = true;
      });
      off();
      abort();
      expect(fired).toBe(false);
    });

    it('one throwing listener does not block the others', () => {
      const { signal, abort } = createFinalizeRunSignal();
      const fired: string[] = [];
      signal.onAbort(() => {
        throw new Error('boom');
      });
      signal.onAbort(() => {
        fired.push('second');
      });
      abort();
      expect(fired).toEqual(['second']);
    });
  });

  describe('abortFinalizeRunInProcess', () => {
    it('returns false when no run is registered', () => {
      expect(abortFinalizeRunInProcess('missing')).toBe(false);
    });

    it('trips the registered run signal and reports true', () => {
      const { signal, abort } = createFinalizeRunSignal();
      registerFinalizeRunAbort('run-1', abort);
      expect(abortFinalizeRunInProcess('run-1')).toBe(true);
      expect(signal.aborted).toBe(true);
    });

    it('drops the registration after firing (second cancel is a no-op)', () => {
      const { abort } = createFinalizeRunSignal();
      registerFinalizeRunAbort('run-1', abort);
      expect(abortFinalizeRunInProcess('run-1')).toBe(true);
      expect(abortFinalizeRunInProcess('run-1')).toBe(false);
    });

    it('does not fire a run after it is unregistered', () => {
      const { signal, abort } = createFinalizeRunSignal();
      registerFinalizeRunAbort('run-1', abort);
      unregisterFinalizeRunAbort('run-1');
      expect(abortFinalizeRunInProcess('run-1')).toBe(false);
      expect(signal.aborted).toBe(false);
    });
  });
});
