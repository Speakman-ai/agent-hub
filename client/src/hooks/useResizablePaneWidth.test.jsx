import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useResizablePaneWidth } from './useResizablePaneWidth.js';

/** Set the jsdom viewport width and (optionally) fire a resize event so a
 *  mounted hook recomputes its viewport-aware cap. */
function setViewport(width, { fireResize = false } = {}) {
  window.innerWidth = width;
  if (fireResize) {
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  }
}

/**
 * Thin harness component that renders a pane whose width is driven by the
 * hook, plus a resize handle wired to the returned handleProps. Lets us
 * assert width math, clamping, and localStorage persistence without a real
 * pane component.
 */
function Harness({
  storageKey = 'k',
  defaultWidth = 520,
  min = 320,
  max = 1200,
  maxViewportFraction = 0.6,
}) {
  const { width, isResizing, handleProps } = useResizablePaneWidth({
    storageKey,
    defaultWidth,
    min,
    max,
    maxViewportFraction,
  });
  return (
    <div data-testid="pane" style={{ width: `${width}px` }} data-resizing={String(isResizing)}>
      <div data-testid="handle" {...handleProps} />
    </div>
  );
}

describe('useResizablePaneWidth', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.style.userSelect = '';
    // Wide viewport so the absolute [min, max] math is exercised without the
    // viewport-aware cap interfering. Viewport-cap behavior has its own tests.
    setViewport(3000);
  });

  it('initializes to the default width and persists it', () => {
    render(<Harness storageKey="k1" defaultWidth={520} />);
    expect(screen.getByTestId('pane').style.width).toBe('520px');
    expect(window.localStorage.getItem('k1')).toBe('520');
  });

  it('reads a stored width on mount', () => {
    window.localStorage.setItem('k2', '700');
    render(<Harness storageKey="k2" />);
    expect(screen.getByTestId('pane').style.width).toBe('700px');
  });

  it('widens when the handle is dragged left (pane is right-anchored)', () => {
    render(<Harness storageKey="k3" defaultWidth={520} />);
    const handle = screen.getByTestId('handle');
    fireEvent.pointerDown(handle, { clientX: 600, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 480, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    // 520 + (600 - 480) = 640
    expect(screen.getByTestId('pane').style.width).toBe('640px');
    expect(window.localStorage.getItem('k3')).toBe('640');
  });

  it('clamps to the max bound while dragging', () => {
    render(<Harness storageKey="k4" defaultWidth={520} max={1200} />);
    const handle = screen.getByTestId('handle');
    fireEvent.pointerDown(handle, { clientX: 600, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -5000, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(screen.getByTestId('pane').style.width).toBe('1200px');
  });

  it('clamps to the min bound while dragging', () => {
    render(<Harness storageKey="k5" defaultWidth={520} min={320} />);
    const handle = screen.getByTestId('handle');
    fireEvent.pointerDown(handle, { clientX: 600, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(screen.getByTestId('pane').style.width).toBe('320px');
  });

  it('ignores non-primary (e.g. right-click) pointer-downs', () => {
    render(<Harness storageKey="k6" defaultWidth={520} />);
    const handle = screen.getByTestId('handle');
    fireEvent.pointerDown(handle, { clientX: 600, button: 2, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    expect(screen.getByTestId('pane').style.width).toBe('520px');
  });

  it('exposes the width range via aria-value* attributes and is focusable', () => {
    render(<Harness storageKey="k7" defaultWidth={520} min={320} max={1200} />);
    const handle = screen.getByTestId('handle');
    expect(handle).toHaveAttribute('role', 'separator');
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-valuenow', '520');
    expect(handle).toHaveAttribute('aria-valuemin', '320');
    expect(handle).toHaveAttribute('aria-valuemax', '1200');
  });

  it('widens on ArrowLeft/ArrowUp and narrows on ArrowRight/ArrowDown', () => {
    render(<Harness storageKey="k9" defaultWidth={520} />);
    const handle = screen.getByTestId('handle');
    const pane = screen.getByTestId('pane');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(pane.style.width).toBe('536px'); // +16
    expect(handle).toHaveAttribute('aria-valuenow', '536');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(pane.style.width).toBe('520px'); // -16

    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(pane.style.width).toBe('536px'); // +16

    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(pane.style.width).toBe('520px'); // -16
  });

  it('uses the larger page step for PageUp/PageDown', () => {
    render(<Harness storageKey="k10" defaultWidth={520} />);
    const handle = screen.getByTestId('handle');
    const pane = screen.getByTestId('pane');

    fireEvent.keyDown(handle, { key: 'PageUp' });
    expect(pane.style.width).toBe('584px'); // +64

    fireEvent.keyDown(handle, { key: 'PageDown' });
    expect(pane.style.width).toBe('520px'); // -64
  });

  it('snaps to min on Home and max on End', () => {
    render(<Harness storageKey="k11" defaultWidth={520} min={320} max={1200} />);
    const handle = screen.getByTestId('handle');
    const pane = screen.getByTestId('pane');

    fireEvent.keyDown(handle, { key: 'End' });
    expect(pane.style.width).toBe('1200px');

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(pane.style.width).toBe('320px');
  });

  it('clamps keyboard adjustments to the bounds and persists them', () => {
    window.localStorage.setItem('k12', '330');
    render(<Harness storageKey="k12" defaultWidth={520} min={320} max={1200} />);
    const handle = screen.getByTestId('handle');
    const pane = screen.getByTestId('pane');

    // 330 - 16 = 314 → clamped to the 320 floor.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(pane.style.width).toBe('320px');
    expect(window.localStorage.getItem('k12')).toBe('320');
  });

  it('ignores unrelated keys', () => {
    render(<Harness storageKey="k13" defaultWidth={520} />);
    const handle = screen.getByTestId('handle');
    fireEvent.keyDown(handle, { key: 'Enter' });
    fireEvent.keyDown(handle, { key: 'a' });
    expect(screen.getByTestId('pane').style.width).toBe('520px');
  });

  it('toggles body user-select while resizing', () => {
    render(<Harness storageKey="k8" />);
    const handle = screen.getByTestId('handle');
    fireEvent.pointerDown(handle, { clientX: 600, button: 0, pointerId: 1 });
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(document.body.style.userSelect).toBe('');
  });

  describe('viewport-aware cap', () => {
    it('caps a too-wide persisted width to a fraction of the viewport on mount', () => {
      // Persisted 1000px on a now-narrow 900px viewport. 900 * 0.6 = 540.
      window.localStorage.setItem('vp1', '1000');
      setViewport(900);
      render(<Harness storageKey="vp1" max={1200} maxViewportFraction={0.6} />);
      const pane = screen.getByTestId('pane');
      expect(pane.style.width).toBe('540px');
      // The stored *preference* is preserved — not shrunk to the cap — so it
      // returns at full width on a wide monitor again.
      expect(window.localStorage.getItem('vp1')).toBe('1000');
    });

    it('reports the operable range via aria-valuemax = effective cap', () => {
      setViewport(900);
      window.localStorage.setItem('vp2', '1000');
      render(<Harness storageKey="vp2" min={320} max={1200} maxViewportFraction={0.6} />);
      const handle = screen.getByTestId('handle');
      expect(handle).toHaveAttribute('aria-valuemax', '540');
      expect(handle).toHaveAttribute('aria-valuenow', '540');
      expect(handle).toHaveAttribute('aria-valuemin', '320');
    });

    it('recomputes the cap when the window is resized', () => {
      window.localStorage.setItem('vp3', '1000');
      setViewport(2000); // 2000 * 0.6 = 1200 → capped only by absolute max 1200
      render(<Harness storageKey="vp3" max={1200} maxViewportFraction={0.6} />);
      const pane = screen.getByTestId('pane');
      expect(pane.style.width).toBe('1000px');

      setViewport(900, { fireResize: true }); // 900 * 0.6 = 540
      expect(pane.style.width).toBe('540px');

      setViewport(2000, { fireResize: true }); // preference restored
      expect(pane.style.width).toBe('1000px');
    });

    it('keyboard widen cannot exceed the viewport cap', () => {
      setViewport(900); // cap 540
      render(<Harness storageKey="vp4" defaultWidth={520} max={1200} maxViewportFraction={0.6} />);
      const handle = screen.getByTestId('handle');
      const pane = screen.getByTestId('pane');
      fireEvent.keyDown(handle, { key: 'End' }); // snap to operable max
      expect(pane.style.width).toBe('540px');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // try to widen past cap
      expect(pane.style.width).toBe('540px');
    });

    it('never caps below the minimum width', () => {
      setViewport(400); // 400 * 0.6 = 240 < min 320 → floored at min
      window.localStorage.setItem('vp5', '1000');
      render(<Harness storageKey="vp5" min={320} max={1200} maxViewportFraction={0.6} />);
      expect(screen.getByTestId('pane').style.width).toBe('320px');
    });
  });
});
