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
});
