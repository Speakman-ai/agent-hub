import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SessionDesignModePane from './SessionDesignModePane.jsx';

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
});
