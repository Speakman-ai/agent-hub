import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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

/** Wait until preview config fetch resolves and the ready iframe URL is wired. */
async function waitForReadyPreviewUrl() {
  await waitFor(() => {
    expect(screen.getByTestId('session-preview-pane-url')).toHaveValue(
      'http://localhost:4101/board',
    );
  });
}

async function renderReady(props = {}) {
  const view = render(
    <SessionPreviewPane sessionId="s-1" event={readyEvent} onClose={() => {}} {...props} />,
  );
  await waitForReadyPreviewUrl();
  return view;
}

describe('SessionPreviewPane', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const u = String(input);
        if (u.includes('/config')) {
          return { ok: true, json: async () => ({ previewSubdomainBase: null }) };
        }
        if (u.includes('/preview/ticket')) {
          return { ok: true, json: async () => ({ ticket: 'test-ticket' }) };
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders the URL and iframe when a `ready` event arrives', async () => {
    await renderReady();
    expect(screen.getByTestId('session-preview-pane-status')).toHaveTextContent(/ready/i);
    const iframe = screen.getByTestId('session-preview-pane-iframe');
    expect(iframe.getAttribute('src')).toBe('http://localhost:4101/board?_ah=0');
  });

  it('clicking refresh bumps the iframe key (forcing a reload)', async () => {
    await renderReady();
    const iframe = screen.getByTestId('session-preview-pane-iframe');
    const before = Number(iframe.getAttribute('data-iframe-key'));
    fireEvent.click(screen.getByTestId('session-preview-pane-refresh'));
    // After the click React re-renders; the same DOM element stays mounted
    // (same React key prefix from previewId) but iframeKey increments,
    // which is reflected in data-iframe-key and forces the browser to
    // re-navigate the iframe's src.
    const after = Number(
      screen.getByTestId('session-preview-pane-iframe').getAttribute('data-iframe-key'),
    );
    expect(after).toBe(before + 1);
  });

  it('reloads iframe when event.refreshAt changes', async () => {
    const { rerender } = await renderReady();
    const before = Number(
      screen.getByTestId('session-preview-pane-iframe').getAttribute('data-iframe-key'),
    );
    rerender(
      <SessionPreviewPane
        sessionId="s-1"
        event={{ ...readyEvent, refreshAt: 1_700_000_000_000 }}
        onClose={() => {}}
      />,
    );
    const after = Number(
      screen.getByTestId('session-preview-pane-iframe').getAttribute('data-iframe-key'),
    );
    expect(after).toBeGreaterThan(before);
  });

  it('renders idle placeholder when no event is supplied', () => {
    render(<SessionPreviewPane sessionId="s-1" event={null} onClose={() => {}} />);
    expect(screen.getByTestId('session-preview-pane-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('session-preview-pane-iframe')).toBeNull();
  });

  it('renders the live log tail during `starting` so users see boot progress', () => {
    const event = {
      kind: 'preview_starting',
      previewId: 'p-3',
      previewUrl: 'http://localhost:4102',
      port: 4102,
      logTail: ['vite v5.0.0 starting', 'optimizing deps…'],
    };
    render(<SessionPreviewPane sessionId="s-1" event={event} onClose={() => {}} />);
    expect(screen.getByTestId('session-preview-pane-starting')).toBeInTheDocument();
    const log = screen.getByTestId('session-preview-pane-starting-log');
    expect(log).toHaveTextContent('vite v5.0.0 starting');
    expect(log).toHaveTextContent('optimizing deps…');
    // Port hint surfaces so the user can verify which port the runtime
    // picked while it's still booting.
    expect(screen.getByText(/port 4102/i)).toBeInTheDocument();
  });

  it('shows a placeholder line in `starting` when no log output has arrived yet', () => {
    const event = {
      kind: 'preview_starting',
      previewId: 'p-3',
      logTail: [],
    };
    render(<SessionPreviewPane sessionId="s-1" event={event} onClose={() => {}} />);
    expect(screen.getByTestId('session-preview-pane-starting-log')).toHaveTextContent(
      /waiting for first log line/i,
    );
  });

  it('enables Stop while preview is still starting', () => {
    const onStop = vi.fn();
    const event = {
      kind: 'preview_starting',
      previewId: 'p-boot',
      logTail: ['==> [preview] Waiting for postgres'],
    };
    render(<SessionPreviewPane sessionId="s-1" event={event} onClose={() => {}} onStop={onStop} />);
    const stopBtn = screen.getByTestId('session-preview-pane-stop');
    expect(stopBtn).not.toBeDisabled();
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledWith({ sessionId: 's-1', previewId: 'p-boot' });
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

  it('pop-out opens a window with the expected URL and switches to reattach placeholder', async () => {
    const popOut = vi.fn(() => ({ closed: false, close: vi.fn() }));
    await renderReady({ popOut, electronApi: null });
    fireEvent.click(screen.getByTestId('session-preview-pane-popout'));
    expect(popOut).toHaveBeenCalledTimes(1);
    expect(popOut.mock.calls[0][0]).toBe('http://localhost:4101/board');
    expect(popOut.mock.calls[0][1]).toBe('agent-hub-preview-s-1');
    expect(popOut.mock.calls[0][2]).toMatch(/width=1280/);
    expect(screen.getByTestId('session-preview-pane-popped')).toBeInTheDocument();
    expect(screen.queryByTestId('session-preview-pane-iframe')).toBeNull();
  });

  it('pop-out uses the Electron IPC bridge when available', async () => {
    const electronApi = { popOutPreview: vi.fn(), isElectron: true };
    const popOut = vi.fn();
    await renderReady({ popOut, electronApi });
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

  it('Electron pop-out does not snap back to inline after 1s (no window handle to poll)', async () => {
    const electronApi = { popOutPreview: vi.fn(), isElectron: true };
    await renderReady({ electronApi });
    vi.useFakeTimers();
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });

  it('browser pop-out auto-reattaches when the window closes', async () => {
    const fakeWindow = { closed: false, close: vi.fn() };
    const popOut = vi.fn(() => fakeWindow);
    await renderReady({ popOut, electronApi: null });
    vi.useFakeTimers();
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });

  it('reattach restores the iframe view', async () => {
    const fakeWindow = { closed: false, close: vi.fn() };
    const popOut = vi.fn(() => fakeWindow);
    await renderReady({ popOut, electronApi: null });
    fireEvent.click(screen.getByTestId('session-preview-pane-popout'));
    expect(screen.getByTestId('session-preview-pane-popped')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-preview-pane-reattach'));
    expect(fakeWindow.close).toHaveBeenCalled();
    expect(screen.getByTestId('session-preview-pane-iframe')).toBeInTheDocument();
  });

  it('touch handler is throttled to at most once per 30 s under rapid activity', async () => {
    const onTouch = vi.fn();
    const dateNow = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    dateNow.mockImplementation(() => t);
    try {
      await renderReady({ onTouch });
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

  it('Close button invokes onClose', async () => {
    const onClose = vi.fn();
    await renderReady({ onClose });
    fireEvent.click(screen.getByTestId('session-preview-pane-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('persists pane width to localStorage under the per-session key', async () => {
    await renderReady();
    // Default width persists on first render.
    expect(window.localStorage.getItem('previewPaneWidth:s-1')).toBe('560');
  });

  it('reads pane width from localStorage on mount', async () => {
    window.localStorage.setItem('previewPaneWidth:s-1', '800');
    const { container } = await renderReady();
    const aside = container.querySelector('aside[data-testid="session-preview-pane"]');
    expect(aside.style.width).toBe('800px');
  });

  it('widens the pane when the resize handle is dragged left', async () => {
    const { container } = await renderReady();
    const aside = container.querySelector('aside[data-testid="session-preview-pane"]');
    const handle = screen.getByTestId('session-preview-pane-resize-handle');
    expect(aside.style.width).toBe('560px');

    fireEvent.pointerDown(handle, { clientX: 600, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(aside.style.width).toBe('660px');
    expect(window.localStorage.getItem('previewPaneWidth:s-1')).toBe('660');
  });

  it('loads per-session width when sessionId changes', async () => {
    window.localStorage.setItem('previewPaneWidth:s-a', '420');
    window.localStorage.setItem('previewPaneWidth:s-b', '900');
    const { container, rerender } = render(
      <SessionPreviewPane sessionId="s-a" event={readyEvent} onClose={() => {}} />,
    );
    await waitForReadyPreviewUrl();
    let aside = container.querySelector('aside[data-testid="session-preview-pane"]');
    expect(aside.style.width).toBe('420px');

    rerender(<SessionPreviewPane sessionId="s-b" event={readyEvent} onClose={() => {}} />);
    aside = container.querySelector('aside[data-testid="session-preview-pane"]');
    expect(aside.style.width).toBe('900px');
  });
});
