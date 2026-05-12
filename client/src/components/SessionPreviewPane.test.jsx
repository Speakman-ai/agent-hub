import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import SessionPreviewPane from './SessionPreviewPane.jsx';

const readyEvent = {
  type: 'agenthub_preview',
  kind: 'preview',
  sessionId: 's-1',
  previewId: 'p-1',
  previewUrl: 'http://localhost:4101',
  fullUrl: 'http://localhost:4101/board',
  port: 4101,
  route: '/board',
  target: 'web',
};

describe('SessionPreviewPane', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the URL and iframe when a `ready` event arrives', () => {
    render(<SessionPreviewPane sessionId="s-1" event={readyEvent} onClose={() => {}} />);
    expect(screen.getByTestId('session-preview-pane-status')).toHaveTextContent(/ready/i);
    const url = screen.getByTestId('session-preview-pane-url');
    expect(url).toHaveValue('http://localhost:4101/board');
    const iframe = screen.getByTestId('session-preview-pane-iframe');
    expect(iframe.getAttribute('src')).toBe('http://localhost:4101/board');
  });

  it('clicking refresh bumps the iframe key (forcing a reload)', () => {
    render(<SessionPreviewPane sessionId="s-1" event={readyEvent} onClose={() => {}} />);
    const iframe = screen.getByTestId('session-preview-pane-iframe');
    const before = Number(iframe.getAttribute('data-iframe-key'));
    fireEvent.click(screen.getByTestId('session-preview-pane-refresh'));
    // After the click React re-renders; the same DOM element stays mounted
    // (same React key prefix from previewId) but iframeKey increments,
    // which is reflected in data-iframe-key and forces the browser to
    // re-navigate the iframe's src.
    const after = Number(screen.getByTestId('session-preview-pane-iframe').getAttribute('data-iframe-key'));
    expect(after).toBe(before + 1);
  });

  it('renders idle placeholder when no event is supplied', () => {
    render(<SessionPreviewPane sessionId="s-1" event={null} onClose={() => {}} />);
    expect(screen.getByTestId('session-preview-pane-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('session-preview-pane-iframe')).toBeNull();
  });

  it('renders failed state with the error message and log tail', () => {
    const event = {
      kind: 'preview_failed',
      previewId: 'p-2',
      error: 'health check timed out',
      logTail: ['vite starting', 'EADDRINUSE'],
    };
    render(<SessionPreviewPane sessionId="s-1" event={event} onClose={() => {}} />);
    expect(screen.getByTestId('session-preview-pane-failed')).toBeInTheDocument();
    expect(screen.getByText(/health check timed out/i)).toBeInTheDocument();
    expect(screen.getByText(/EADDRINUSE/)).toBeInTheDocument();
  });

  it('renders unavailable state with a Configure button wired to onConfigure', () => {
    const onConfigure = vi.fn();
    const event = {
      kind: 'preview_unavailable',
      unavailableReason: 'preview-disabled',
      wizard: { view: 'settings:preview', projectId: 'agent-hub' },
    };
    render(
      <SessionPreviewPane
        sessionId="s-1"
        event={event}
        onClose={() => {}}
        onConfigure={onConfigure}
      />,
    );
    expect(screen.getByTestId('session-preview-pane-unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-preview-pane-configure'));
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(onConfigure).toHaveBeenCalledWith(event);
  });

  it('pop-out opens a window with the expected URL and switches to reattach placeholder', () => {
    const popOut = vi.fn(() => ({ closed: false, close: vi.fn() }));
    render(
      <SessionPreviewPane
        sessionId="s-1"
        event={readyEvent}
        onClose={() => {}}
        popOut={popOut}
        // Force the browser fallback path even if a stray test-env
        // electronAPI is present.
        electronApi={null}
      />,
    );
    fireEvent.click(screen.getByTestId('session-preview-pane-popout'));
    expect(popOut).toHaveBeenCalledTimes(1);
    expect(popOut.mock.calls[0][0]).toBe('http://localhost:4101/board');
    expect(popOut.mock.calls[0][1]).toBe('agent-hub-preview-s-1');
    expect(popOut.mock.calls[0][2]).toMatch(/width=1280/);
    expect(screen.getByTestId('session-preview-pane-popped')).toBeInTheDocument();
    expect(screen.queryByTestId('session-preview-pane-iframe')).toBeNull();
  });

  it('pop-out uses the Electron IPC bridge when available', () => {
    const electronApi = { popOutPreview: vi.fn(), isElectron: true };
    const popOut = vi.fn();
    render(
      <SessionPreviewPane
        sessionId="s-1"
        event={readyEvent}
        onClose={() => {}}
        popOut={popOut}
        electronApi={electronApi}
      />,
    );
    fireEvent.click(screen.getByTestId('session-preview-pane-popout'));
    expect(electronApi.popOutPreview).toHaveBeenCalledTimes(1);
    expect(electronApi.popOutPreview).toHaveBeenCalledWith({
      sessionId: 's-1',
      url: 'http://localhost:4101/board',
    });
    // Browser fallback must NOT be invoked when Electron IPC handled it.
    expect(popOut).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-preview-pane-popped')).toBeInTheDocument();
  });

  it('Electron pop-out does not snap back to inline after 1s (no window handle to poll)', () => {
    vi.useFakeTimers();
    const electronApi = { popOutPreview: vi.fn(), isElectron: true };
    render(
      <SessionPreviewPane
        sessionId="s-1"
        event={readyEvent}
        onClose={() => {}}
        electronApi={electronApi}
      />,
    );
    fireEvent.click(screen.getByTestId('session-preview-pane-popout'));
    expect(screen.getByTestId('session-preview-pane-popped')).toBeInTheDocument();
    // Advance past the 1s poll tick — the Electron path must NOT reset the
    // pane back to inline mode because there is no JS window handle to check.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Still in popped state, not reverted to iframe.
    expect(screen.getByTestId('session-preview-pane-popped')).toBeInTheDocument();
    expect(screen.queryByTestId('session-preview-pane-iframe')).toBeNull();
    vi.useRealTimers();
  });

  it('browser pop-out auto-reattaches when the window closes', () => {
    vi.useFakeTimers();
    const fakeWindow = { closed: false, close: vi.fn() };
    const popOut = vi.fn(() => fakeWindow);
    render(
      <SessionPreviewPane
        sessionId="s-1"
        event={readyEvent}
        onClose={() => {}}
        popOut={popOut}
        electronApi={null}
      />,
    );
    fireEvent.click(screen.getByTestId('session-preview-pane-popout'));
    expect(screen.getByTestId('session-preview-pane-popped')).toBeInTheDocument();
    // Simulate the user closing the detached window.
    fakeWindow.closed = true;
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // Poll loop should have detected closed=true and auto-reattached.
    expect(screen.getByTestId('session-preview-pane-iframe')).toBeInTheDocument();
    expect(screen.queryByTestId('session-preview-pane-popped')).toBeNull();
    vi.useRealTimers();
  });

  it('reattach restores the iframe view', () => {
    const fakeWindow = { closed: false, close: vi.fn() };
    const popOut = vi.fn(() => fakeWindow);
    render(
      <SessionPreviewPane
        sessionId="s-1"
        event={readyEvent}
        onClose={() => {}}
        popOut={popOut}
        electronApi={null}
      />,
    );
    fireEvent.click(screen.getByTestId('session-preview-pane-popout'));
    expect(screen.getByTestId('session-preview-pane-popped')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-preview-pane-reattach'));
    expect(fakeWindow.close).toHaveBeenCalled();
    expect(screen.getByTestId('session-preview-pane-iframe')).toBeInTheDocument();
  });

  it('touch handler is throttled to at most once per 30 s under rapid activity', () => {
    const onTouch = vi.fn();
    const dateNow = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    dateNow.mockImplementation(() => t);
    try {
      render(
        <SessionPreviewPane
          sessionId="s-1"
          event={readyEvent}
          onClose={() => {}}
          onTouch={onTouch}
        />,
      );
      const iframe = screen.getByTestId('session-preview-pane-iframe');
      // Burst of mousemoves inside the same 30s window.
      for (let i = 0; i < 20; i++) {
        t += 100;
        fireEvent.mouseMove(iframe);
      }
      expect(onTouch).toHaveBeenCalledTimes(1);
      // Past the 30s mark — next mousemove fires.
      t += 31_000;
      fireEvent.mouseMove(iframe);
      expect(onTouch).toHaveBeenCalledTimes(2);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('Close button invokes onClose', () => {
    const onClose = vi.fn();
    render(<SessionPreviewPane sessionId="s-1" event={readyEvent} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('session-preview-pane-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('persists pane width to localStorage under the per-session key', () => {
    render(<SessionPreviewPane sessionId="s-1" event={readyEvent} onClose={() => {}} />);
    // Default width persists on first render.
    expect(window.localStorage.getItem('previewPaneWidth:s-1')).toBe('560');
  });

  it('reads pane width from localStorage on mount', () => {
    window.localStorage.setItem('previewPaneWidth:s-1', '800');
    const { container } = render(
      <SessionPreviewPane sessionId="s-1" event={readyEvent} onClose={() => {}} />,
    );
    const aside = container.querySelector('aside[data-testid="session-preview-pane"]');
    expect(aside.style.width).toBe('800px');
  });
});
