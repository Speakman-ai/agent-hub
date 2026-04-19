import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DesignView from './DesignView.jsx';

/**
 * DesignView — split-pane behavior.
 *
 * The iframe src must include the current `reloadToken` as a cache-buster;
 * incrementing the token must cause the iframe to re-fetch index.html. This
 * is how the Design canvas stays in sync with agent file writes (the server
 * emits `design_updated`, App.jsx bumps the token).
 */
describe('DesignView', () => {
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

  it('renders the iframe with reloadToken as the cache-buster', () => {
    const { container } = render(<DesignView {...baseProps} reloadToken={0} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('src')).toContain('/design-files/d-1/index.html');
    expect(iframe.getAttribute('src')).toContain('v=0');
    // Security: must be sandboxed
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('iframe src updates when reloadToken increments', () => {
    const { container, rerender } = render(<DesignView {...baseProps} reloadToken={1} />);
    const firstSrc = container.querySelector('iframe').getAttribute('src');
    expect(firstSrc).toContain('v=1');

    rerender(<DesignView {...baseProps} reloadToken={2} />);
    const secondSrc = container.querySelector('iframe').getAttribute('src');
    expect(secondSrc).toContain('v=2');
    expect(secondSrc).not.toBe(firstSrc);
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
