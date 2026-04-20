import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DesignView from './DesignView.jsx';

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
});
