import { describe, it, expect, vi, afterEach } from 'vitest';
import { attachTailPinResizeObserver } from './chatScrollResizeObserver.js';

describe('attachTailPinResizeObserver', () => {
  const origRO = globalThis.ResizeObserver;

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.ResizeObserver = origRO;
  });

  it('returns noop cleanup when ResizeObserver is undefined', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const pinScroll = vi.fn();
    const el = document.createElement('div');
    const cleanup = attachTailPinResizeObserver({
      observedElement: el,
      shouldPin: () => true,
      pinScroll,
    });
    cleanup();
    expect(pinScroll).not.toHaveBeenCalled();
  });

  it('returns noop cleanup when observedElement is null', () => {
    const RO = vi.fn();
    globalThis.ResizeObserver = RO;
    const cleanup = attachTailPinResizeObserver({
      observedElement: null,
      shouldPin: () => true,
      pinScroll: () => {},
    });
    cleanup();
    expect(RO).not.toHaveBeenCalled();
  });

  it('invokes pinScroll on resize when shouldPin returns true', () => {
    let roCallback = () => {};
    globalThis.ResizeObserver = class {
      constructor(cb) {
        roCallback = cb;
      }
      observe() {}
      disconnect() {}
    };
    const pinScroll = vi.fn();
    const shouldPin = vi.fn(() => true);
    const el = document.createElement('div');
    attachTailPinResizeObserver({ observedElement: el, shouldPin, pinScroll });
    roCallback();
    expect(shouldPin).toHaveBeenCalled();
    expect(pinScroll).toHaveBeenCalledTimes(1);
  });

  it('does not invoke pinScroll when shouldPin returns false', () => {
    let roCallback = () => {};
    globalThis.ResizeObserver = class {
      constructor(cb) {
        roCallback = cb;
      }
      observe() {}
      disconnect() {}
    };
    const pinScroll = vi.fn();
    attachTailPinResizeObserver({
      observedElement: document.createElement('div'),
      shouldPin: () => false,
      pinScroll,
    });
    roCallback();
    expect(pinScroll).not.toHaveBeenCalled();
  });

  it('cleanup disconnects the observer', () => {
    const disconnectSpy = vi.fn();
    globalThis.ResizeObserver = class {
      constructor() {}
      observe() {}
      disconnect() {
        disconnectSpy();
      }
    };
    const el = document.createElement('div');
    const cleanup = attachTailPinResizeObserver({
      observedElement: el,
      shouldPin: () => true,
      pinScroll: () => {},
    });
    cleanup();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});
