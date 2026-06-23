import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionDesignPane from './SessionDesignPane';

describe('SessionDesignPane', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.innerWidth = 3000;
    (globalThis as any).fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<html><head></head><body></body></html>'),
      }),
    );
  });

  it('renders nothing when no design is linked', () => {
    const { container } = render(<SessionDesignPane design={null} />);
    expect(container!.firstChild).toBeNull();
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
    const pane = container.querySelector('[data-testid="session-design-pane"]') as HTMLElement;
    expect(pane.style.width).toBe('520px');
    expect(screen.getByTestId('session-design-pane-resize-handle')).toBeInTheDocument();
  });

  it('reads a persisted width from localStorage on mount', () => {
    window.localStorage.setItem('designPaneWidth:linked:s-1', '760');
    const { container } = render(
      <SessionDesignPane sessionId="s-1" design={{ id: 'd1', name: 'X' }} />,
    );
    const pane = container.querySelector('[data-testid="session-design-pane"]') as HTMLElement;
    expect(pane.style.width).toBe('760px');
  });

  it('widens and persists when the resize handle is dragged left', () => {
    const { container } = render(
      <SessionDesignPane sessionId="s-1" design={{ id: 'd1', name: 'X' }} />,
    );
    const pane = container.querySelector('[data-testid="session-design-pane"]') as HTMLElement;
    const handle = screen.getByTestId('session-design-pane-resize-handle');
    fireEvent.pointerDown(handle, { clientX: 600, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(pane.style.width).toBe('620px');
    expect(window.localStorage.getItem('designPaneWidth:linked:s-1')).toBe('620');
  });

  it('caps a wide persisted width to the viewport on a narrow screen', () => {
    window.localStorage.setItem('designPaneWidth:linked:s-1', '1100');
    window.innerWidth = 1100;
    const { container } = render(
      <SessionDesignPane sessionId="s-1" design={{ id: 'd1', name: 'X' }} />,
    );
    const pane = container.querySelector('[data-testid="session-design-pane"]') as HTMLElement;
    expect(pane.style.width).toBe('660px');
    expect(window.localStorage.getItem('designPaneWidth:linked:s-1')).toBe('1100');
  });
});
