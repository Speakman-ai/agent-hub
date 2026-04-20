import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DesignView from './DesignView.jsx';

// PDF export utility is side-effecty (DOM iframe + html2canvas + jsPDF). The
// component-level tests mock it to a resolved promise so they can assert
// wiring (button rendered, disabled states, click → util called) without
// touching jsdom's limited canvas/PDF support. A dedicated unit test for the
// util lives in ../utils/exportDesignPdf.test.js.
vi.mock('../utils/exportDesignPdf.js', () => ({
  exportDesignPdf: vi.fn(() => Promise.resolve()),
}));
import { exportDesignPdf } from '../utils/exportDesignPdf.js';

/**
 * DesignView — split-pane behavior.
 *
 * The Design canvas fetches index.html as text and feeds it to the iframe
 * via `srcdoc` (to bypass the nginx-deployed `X-Frame-Options: DENY`).
 * `reloadToken` is appended to the fetch URL as a cache-buster; bumping it
 * must trigger a fresh fetch so the canvas stays in sync with agent writes
 * (server emits `design_updated`, App.jsx bumps the token).
 */
describe('DesignView', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<html><head></head><body></body></html>'),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseDesign = {
    id: 'd-1',
    name: 'Sales dashboard',
    linkedProjects: [],
  };

  const baseProps = {
    design: baseDesign,
    messages: [],
    streaming: null,
    thinking: false,
    processing: false,
    reloadToken: 0,
    send: () => {},
    onBack: () => {},
    onManualReload: () => {},
  };

  it('renders the design name in the header', () => {
    render(<DesignView {...baseProps} />);
    expect(screen.getByText('Sales dashboard')).toBeInTheDocument();
  });

  it('fetches index.html with the reloadToken cache-buster and renders a sandboxed srcdoc iframe', async () => {
    const { container } = render(<DesignView {...baseProps} reloadToken={0} />);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    const fetchUrl = globalThis.fetch.mock.calls[0][0];
    expect(fetchUrl).toContain('/design-files/d-1/index.html');
    expect(fetchUrl).toContain('v=0');

    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe).toBeTruthy();
      // Security: must be sandboxed
      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    });
  });

  // Regression: `/design-files/` is NOT behind authMiddleware (which only
  // guards `/api/*`), and `cors-config.ts` sets `credentials: false`. Using
  // `credentials: 'include'` here causes the browser to reject the response
  // in remote mode (Vite client on localhost:3050 → hub on EC2) with
  // "Access-Control-Allow-Credentials must be 'true'". Keep credentials off.
  it('does not send fetch with credentials: include (would break cross-origin remote mode)', async () => {
    render(<DesignView {...baseProps} />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    const initArg = globalThis.fetch.mock.calls[0][1];
    // Either no init object at all, or an init without credentials set.
    if (initArg) {
      expect(initArg.credentials).not.toBe('include');
    }
  });

  it('re-fetches index.html when reloadToken increments', async () => {
    const { rerender } = render(<DesignView {...baseProps} reloadToken={0} />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    expect(globalThis.fetch.mock.calls[0][0]).toContain('v=0');

    rerender(<DesignView {...baseProps} reloadToken={1} />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
    expect(globalThis.fetch.mock.calls[1][0]).toContain('v=1');
  });

  it('renders past messages in the chat pane', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'Make a hero', created_at: new Date().toISOString() },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Done — index.html updated.',
        created_at: new Date().toISOString(),
      },
    ];
    render(<DesignView {...baseProps} messages={messages} />);
    expect(screen.getByText('Make a hero')).toBeInTheDocument();
    expect(screen.getByText('Done — index.html updated.')).toBeInTheDocument();
  });

  it('sends a design_chat WS message when the user submits the composer', () => {
    const send = vi.fn();
    render(<DesignView {...baseProps} send={send} />);
    const textbox = screen.getByPlaceholderText(/describe what to build/i);
    fireEvent.change(textbox, { target: { value: 'purple gradient hero' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: false });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'design_chat',
      designId: 'd-1',
      content: 'purple gradient hero',
    });
  });

  it('shows a Cancel button that emits design_cancel while processing', () => {
    const send = vi.fn();
    render(<DesignView {...baseProps} send={send} processing={true} />);
    const cancelBtn = screen.getByText('Cancel');
    fireEvent.click(cancelBtn);
    expect(send).toHaveBeenCalledWith({ type: 'design_cancel', designId: 'd-1' });
  });

  describe('PDF export', () => {
    beforeEach(() => {
      exportDesignPdf.mockClear();
    });

    it('renders a Download PDF button in the header', () => {
      render(<DesignView {...baseProps} />);
      expect(screen.getByLabelText(/download design as pdf/i)).toBeInTheDocument();
    });

    it('invokes exportDesignPdf with the design id and name when clicked', async () => {
      render(<DesignView {...baseProps} />);
      const btn = screen.getByLabelText(/download design as pdf/i);
      fireEvent.click(btn);

      await waitFor(() => {
        expect(exportDesignPdf).toHaveBeenCalledTimes(1);
      });
      const call = exportDesignPdf.mock.calls[0][0];
      expect(call.designId).toBe('d-1');
      expect(call.filename).toBe('Sales dashboard');
      expect(typeof call.base).toBe('string');
    });

    it('disables the PDF button while the agent is processing', () => {
      render(<DesignView {...baseProps} processing={true} />);
      const btn = screen.getByLabelText(/download design as pdf/i);
      expect(btn).toBeDisabled();
    });

    it('disables the PDF button while the agent is streaming', () => {
      render(<DesignView {...baseProps} streaming={{ content: 'partial' }} />);
      const btn = screen.getByLabelText(/download design as pdf/i);
      expect(btn).toBeDisabled();
    });

    it('does not call exportDesignPdf when clicked while disabled', () => {
      render(<DesignView {...baseProps} processing={true} />);
      const btn = screen.getByLabelText(/download design as pdf/i);
      fireEvent.click(btn);
      expect(exportDesignPdf).not.toHaveBeenCalled();
    });
  });
});
