import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionDesignPane from './SessionDesignPane.jsx';

/**
 * SessionDesignPane — the in-session linked-design preview pane. It reuses
 * DesignCanvas (which fetches the design's index.html and feeds it to an
 * iframe via srcdoc), so we stub fetch. The pane's own responsibilities are:
 * render nothing without a design, show the design name + controls, and wire
 * the unlink / open-studio / reload callbacks.
 */
describe('SessionDesignPane', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Wide viewport so the hook's viewport-aware cap doesn't clip these
    // width assertions; the cap has dedicated coverage below + in the hook.
    window.innerWidth = 3000;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<html><head></head><body></body></html>'),
      }),
    );
  });

  it('renders nothing when no design is linked', () => {
    const { container } = render(<SessionDesignPane design={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the linked design name and the pane container', () => {
    render(<SessionDesignPane design={{ id: 'd1', name: 'Hero mockup' }} />);
    expect(screen.getByTestId('session-design-pane')).toBeInTheDocument();
    expect(screen.getByText('Hero mockup')).toBeInTheDocument();
    expect(screen.getByText('Linked design')).toBeInTheDocument();
  });

  it('fires onUnlink when the unlink button is clicked', () => {
    const onUnlink = vi.fn();
    render(<SessionDesignPane design={{ id: 'd1', name: 'X' }} onUnlink={onUnlink} />);
    fireEvent.click(screen.getByTestId('session-design-unlink'));
    expect(onUnlink).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenStudio when the Studio button is clicked', () => {
    const onOpenStudio = vi.fn();
    render(<SessionDesignPane design={{ id: 'd1', name: 'X' }} onOpenStudio={onOpenStudio} />);
    fireEvent.click(screen.getByTestId('session-design-open-studio'));
    expect(onOpenStudio).toHaveBeenCalledTimes(1);
  });

  it('omits the unlink and studio buttons when their callbacks are absent', () => {
    render(<SessionDesignPane design={{ id: 'd1', name: 'X' }} />);
    expect(screen.queryByTestId('session-design-unlink')).toBeNull();
    expect(screen.queryByTestId('session-design-open-studio')).toBeNull();
  });

  it('renders a resize handle and applies the default width', () => {
    const { container } = render(
      <SessionDesignPane sessionId="s-1" design={{ id: 'd1', name: 'X' }} />,
    );
    const pane = container.querySelector('[data-testid="session-design-pane"]');
    expect(pane.style.width).toBe('520px');
    expect(screen.getByTestId('session-design-pane-resize-handle')).toBeInTheDocument();
  });

  it('reads a persisted width from localStorage on mount', () => {
    window.localStorage.setItem('designPaneWidth:linked:s-1', '760');
    const { container } = render(
      <SessionDesignPane sessionId="s-1" design={{ id: 'd1', name: 'X' }} />,
    );
    const pane = container.querySelector('[data-testid="session-design-pane"]');
    expect(pane.style.width).toBe('760px');
  });

  it('widens and persists when the resize handle is dragged left', () => {
    const { container } = render(
      <SessionDesignPane sessionId="s-1" design={{ id: 'd1', name: 'X' }} />,
    );
    const pane = container.querySelector('[data-testid="session-design-pane"]');
    const handle = screen.getByTestId('session-design-pane-resize-handle');
    fireEvent.pointerDown(handle, { clientX: 600, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    // 520 + (600 - 500) = 620
    expect(pane.style.width).toBe('620px');
    expect(window.localStorage.getItem('designPaneWidth:linked:s-1')).toBe('620');
  });

  it('caps a wide persisted width to the viewport on a narrow screen', () => {
    // A width persisted on a big monitor must not overflow a laptop viewport.
    window.localStorage.setItem('designPaneWidth:linked:s-1', '1100');
    window.innerWidth = 1100; // 1100 * 0.6 = 660 effective cap
    const { container } = render(
      <SessionDesignPane sessionId="s-1" design={{ id: 'd1', name: 'X' }} />,
    );
    const pane = container.querySelector('[data-testid="session-design-pane"]');
    expect(pane.style.width).toBe('660px');
    // Preference preserved for when the user returns to a wide monitor.
    expect(window.localStorage.getItem('designPaneWidth:linked:s-1')).toBe('1100');
  });
});
