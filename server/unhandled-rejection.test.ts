import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { installUnhandledRejectionLogger } from './unhandled-rejection.js';

describe('installUnhandledRejectionLogger', () => {
  it('logs the rejection reason instead of leaving Node to exit', () => {
    const proc = new EventEmitter();
    const log = vi.fn();
    installUnhandledRejectionLogger(proc, log);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    const err = new Error('database is locked');
    proc.emit('unhandledRejection', err);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unhandled promise rejection'), err);
  });
});
