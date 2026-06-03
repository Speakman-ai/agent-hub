import { describe, it, expect, vi } from 'vitest';
import { RemoteSpawnedStep } from './remote-spawned-step.js';

const sink = { cancelStep: () => {} };

describe('RemoteSpawnedStep', () => {
  it('fires close to a listener attached BEFORE exit', () => {
    const step = new RemoteSpawnedStep(0, sink);
    const onClose = vi.fn();
    step.on('close', onClose);
    step.exit(0);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('fires close to a listener attached AFTER exit (the race that hung runs)', () => {
    const step = new RemoteSpawnedStep(0, sink);
    // Agent reported the result before step-runner attached its listener.
    step.exit(7);
    const onClose = vi.fn();
    step.on('close', onClose);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('buffers a pre-listener fail() as error', () => {
    const step = new RemoteSpawnedStep(0, sink);
    const err = new Error('agent lost');
    step.fail(err);
    const onErr = vi.fn();
    step.on('error', onErr);
    expect(onErr).toHaveBeenCalledExactlyOnceWith(err);
  });

  it('settles exactly once (second exit is a no-op)', () => {
    const step = new RemoteSpawnedStep(0, sink);
    const onClose = vi.fn();
    step.on('close', onClose);
    step.exit(0);
    step.exit(1);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(0);
  });
});
