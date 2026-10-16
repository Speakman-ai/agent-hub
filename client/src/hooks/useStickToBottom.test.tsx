import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { isNearBottom, useStickToBottom } from './useStickToBottom';

// jsdom has no layout, so heights are driven by hand.
let height = 1000;
const CLIENT = 400;
let resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  constructor(cb: () => void) {
    resizeCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function grow(to: number) {
  height = to;
  act(() => resizeCallbacks.forEach((cb) => cb()));
}

function Harness({ openKey, newestKey }: { openKey: string; newestKey: string }) {
  const stick = useStickToBottom(openKey, newestKey);
  return (
    <div ref={stick.scrollRef} data-testid="list">
      <button type="button" onClick={stick.release}>
        older
      </button>
      <button type="button" onClick={stick.follow}>
        send
      </button>
    </div>
  );
}

function list(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="list"]') as HTMLElement;
}

describe('useStickToBottom', () => {
  beforeEach(() => {
    height = 1000;
    resizeCallbacks = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => height,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => CLIENT,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as any).scrollHeight;
    delete (HTMLElement.prototype as any).clientHeight;
  });

  it('opens at the newest message', () => {
    const { container } = render(<Harness openKey="a" newestKey="m1" />);
    expect(list(container).scrollTop).toBe(1000);
  });

  it('stays on the newest message when content grows after opening', () => {
    const { container } = render(<Harness openKey="a" newestKey="m1" />);
    grow(1600);
    expect(list(container).scrollTop).toBe(1600);
  });

  it('stops following once the user scrolls up, and resumes on a new channel', () => {
    const { container, rerender } = render(<Harness openKey="a" newestKey="m1" />);
    const el = list(container);
    el.scrollTop = 100;
    fireEvent.scroll(el);
    grow(1600);
    expect(el.scrollTop).toBe(100);

    rerender(<Harness openKey="b" newestKey="m1" />);
    expect(el.scrollTop).toBe(1600);
  });

  it('follows a new message while the reader is at the bottom', () => {
    const { container, rerender } = render(<Harness openKey="a" newestKey="m1" />);
    const el = list(container);
    fireEvent.scroll(el);
    height = 1200;
    rerender(<Harness openKey="a" newestKey="m2" />);
    expect(el.scrollTop).toBe(1200);
  });

  it('keeps the place of a reader who scrolled up when a new message arrives', () => {
    const { container, rerender } = render(<Harness openKey="a" newestKey="m1" />);
    const el = list(container);
    el.scrollTop = 100;
    fireEvent.scroll(el);
    height = 1200;
    rerender(<Harness openKey="a" newestKey="m2" />);
    expect(el.scrollTop).toBe(100);
  });

  it('follow jumps back to the bottom after the reader scrolled up', () => {
    const { container, getByText } = render(<Harness openKey="a" newestKey="m1" />);
    const el = list(container);
    el.scrollTop = 100;
    fireEvent.scroll(el);
    fireEvent.click(getByText('send'));
    expect(el.scrollTop).toBe(1000);
    grow(1300);
    expect(el.scrollTop).toBe(1300);
  });

  it('release keeps the position while an older page is prepended', () => {
    const { container, getByText } = render(<Harness openKey="a" newestKey="m1" />);
    const el = list(container);
    el.scrollTop = 600; // at the bottom: 1000 - 400
    fireEvent.click(getByText('older'));
    grow(1800);
    expect(el.scrollTop).toBe(600);
  });
});

describe('isNearBottom', () => {
  it('treats a small gap as the bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false);
  });
});
