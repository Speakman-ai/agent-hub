import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SessionDesignModePane from './SessionDesignModePane.jsx';

// Mock the PDF export util so we can assert the pane reuses it against the
// session worktree mount without standing up html2canvas/jsPDF under jsdom.
const exportDesignPdfMock = vi.fn();
vi.mock('../utils/exportDesignPdf.js', () => ({
  exportDesignPdf: (...args) => exportDesignPdfMock(...args),
}));
vi.mock('../utils/connection.js', () => ({
  getServerBase: () => 'http://localhost:3000',
}));

/**
 * SessionDesignModePane — the in-session Design-mode canvas. It reuses
 * DesignCanvas, which fetches the artifact index.html and feeds it to a
 * sandboxed iframe via srcdoc. The pane's own contract: render nothing without
 * a sessionId, and point DesignCanvas at the *worktree* mount
 * `/session-files/<sessionId>/design/` rather than the standalone
 * `/design-files/` mount.
 */
describe('SessionDesignModePane', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Wide viewport so the hook's viewport-aware cap doesn't clip these
    // width assertions; the cap is covered in the hook's own suite.
    window.innerWidth = 3000;
    exportDesignPdfMock.mockReset();
    exportDesignPdfMock.mockResolvedValue(undefined);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<html><head></head><body>hi</body></html>'),
      }),
    );
  });

  it('renders nothing without a sessionId', () => {
    const { container } = render(<SessionDesignModePane sessionId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the design-mode pane container and header', () => {
    render(<SessionDesignModePane sessionId="sess-1" />);
    expect(screen.getByTestId('session-design-mode-pane')).toBeInTheDocument();
    expect(screen.getByText('Design canvas')).toBeInTheDocument();
    expect(screen.getByText('Design mode')).toBeInTheDocument();
  });

  it('fetches the canvas from the session worktree mount', async () => {
    render(<SessionDesignModePane sessionId="sess-1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const url = globalThis.fetch.mock.calls[0][0];
    expect(url).toContain('/session-files/sess-1/design/index.html');
    // Must NOT fall back to the standalone Design Studio mount.
    expect(url).not.toContain('/design-files/');
  });

  it('exports a PDF from the session worktree mount, reusing exportDesignPdf', async () => {
    render(<SessionDesignModePane sessionId="sess-1" />);
    fireEvent.click(screen.getByTestId('session-design-export-pdf'));
    await waitFor(() => expect(exportDesignPdfMock).toHaveBeenCalledTimes(1));
    const arg = exportDesignPdfMock.mock.calls[0][0];
    expect(arg.srcBase).toBe('/session-files/sess-1/design');
    expect(arg.designId).toBe('session-sess-1');
    expect(arg.base).toBe('http://localhost:3000');
    // Not coupled to the standalone Design Studio mount.
    expect(arg.srcBase).not.toContain('/design-files/');
  });

  it('encodes URL-significant characters in the session id (canvas + export)', async () => {
    // A session id with `#`, space and `?` must not corrupt the artifact path.
    render(<SessionDesignModePane sessionId="a b#1?x" />);

    // Canvas fetch uses the encoded segment.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(globalThis.fetch.mock.calls[0][0]).toContain(
      '/session-files/a%20b%231%3Fx/design/index.html',
    );

    // Export passes the same encoded srcBase to the util.
    fireEvent.click(screen.getByTestId('session-design-export-pdf'));
    await waitFor(() => expect(exportDesignPdfMock).toHaveBeenCalledTimes(1));
    expect(exportDesignPdfMock.mock.calls[0][0].srcBase).toBe(
      '/session-files/a%20b%231%3Fx/design',
    );
  });

  it('disables PDF export while the agent is busy', () => {
    render(<SessionDesignModePane sessionId="sess-1" busy />);
    const btn = screen.getByTestId('session-design-export-pdf');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(exportDesignPdfMock).not.toHaveBeenCalled();
  });

  it('surfaces an export failure message', async () => {
    exportDesignPdfMock.mockRejectedValueOnce(new Error('disk full'));
    render(<SessionDesignModePane sessionId="sess-1" />);
    fireEvent.click(screen.getByTestId('session-design-export-pdf'));
    await waitFor(() => expect(screen.getByText('disk full')).toBeInTheDocument());
  });

  it('renders a resize handle at the default width and persists drags', () => {
    const { container } = render(<SessionDesignModePane sessionId="sess-1" />);
    const pane = container.querySelector('[data-testid="session-design-mode-pane"]');
    expect(pane.style.width).toBe('520px');
    const handle = screen.getByTestId('session-design-mode-pane-resize-handle');
    fireEvent.pointerDown(handle, { clientX: 600, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    // 520 + (600 - 500) = 620
    expect(pane.style.width).toBe('620px');
    expect(window.localStorage.getItem('designPaneWidth:mode:sess-1')).toBe('620');
  });

  it('reads a persisted width from localStorage on mount', () => {
    window.localStorage.setItem('designPaneWidth:mode:sess-1', '880');
    const { container } = render(<SessionDesignModePane sessionId="sess-1" />);
    const pane = container.querySelector('[data-testid="session-design-mode-pane"]');
    expect(pane.style.width).toBe('880px');
  });
});
