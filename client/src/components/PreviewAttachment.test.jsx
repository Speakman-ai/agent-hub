import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PreviewAttachment from './PreviewAttachment.jsx';

describe('PreviewAttachment', () => {
  it('renders the live preview variant with route + port chips', () => {
    const event = {
      kind: 'preview',
      previewId: 'p1',
      previewUrl: 'http://localhost:4200',
      fullUrl: 'http://localhost:4200/board',
      route: '/board',
      target: 'client',
      port: 4200,
      screenshotPath: '/uploads/p1.png',
    };
    render(<PreviewAttachment event={event} />);
    expect(screen.getByText(/Preview ready/i)).toBeInTheDocument();
    expect(screen.getByText('/board')).toBeInTheDocument();
    expect(screen.getByText(':4200')).toBeInTheDocument();
    // "Open in new tab" link points at fullUrl
    const link = screen.getByRole('link', { name: /Open in new tab/i });
    expect(link.getAttribute('href')).toBe('http://localhost:4200/board');
  });

  it('toggles the iframe on Open/Hide click', () => {
    const event = {
      kind: 'preview',
      previewId: 'p1',
      previewUrl: 'http://localhost:4200',
      fullUrl: 'http://localhost:4200/x',
      route: '/x',
    };
    const { container } = render(<PreviewAttachment event={event} />);
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open in iframe/i }));
    expect(container.querySelector('iframe')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Hide iframe/i }));
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('renders the unavailable variant with the legacy focus-appended wizard link when only wizardUrl is present', () => {
    const event = {
      kind: 'preview_unavailable',
      previewId: '',
      wizardUrl: '/projects/agent-hub/settings/projects',
      unavailableReason: 'no-runtime',
      agentReason: 'show me the new badge',
    };
    render(<PreviewAttachment event={event} />);
    expect(screen.getByText(/aren\u2019t set up/i)).toBeInTheDocument();
    expect(screen.getByText(/show me the new badge/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Configure preview/i });
    // Legacy wizardUrl should carry `focus=preview` so older fallback
    // wiring scrolls to the preview sub-section on open.
    expect(link.getAttribute('href')).toBe('/projects/agent-hub/settings/projects?focus=preview');
  });

  it('appends focus=preview correctly when wizardUrl already has a query string', () => {
    const event = {
      kind: 'preview_unavailable',
      previewId: '',
      wizardUrl: '/projects/agent-hub/settings/projects?tab=runtime',
      unavailableReason: 'preview-disabled',
    };
    render(<PreviewAttachment event={event} />);
    const link = screen.getByRole('link', { name: /Configure preview/i });
    expect(link.getAttribute('href')).toBe(
      '/projects/agent-hub/settings/projects?tab=runtime&focus=preview',
    );
  });

  it('does not duplicate focus=preview when the wizardUrl already carries it', () => {
    const event = {
      kind: 'preview_unavailable',
      previewId: '',
      wizardUrl: '/projects/agent-hub/settings/preview?focus=preview',
      unavailableReason: 'preview-disabled',
    };
    render(<PreviewAttachment event={event} />);
    const link = screen.getByRole('link', { name: /Configure preview/i });
    expect(link.getAttribute('href')).toBe('/projects/agent-hub/settings/preview?focus=preview');
  });

  it('renders the CTA when only the new wizard intent is present (no legacy URL)', () => {
    const event = {
      kind: 'preview_unavailable',
      previewId: '',
      wizard: { view: 'settings:preview', projectId: 'agent-hub' },
      unavailableReason: 'preview-disabled',
    };
    render(<PreviewAttachment event={event} />);
    // Without a legacy URL, the CTA falls back to an empty href ("#")
    // — the click is meant to be intercepted by onConfigure.
    const link = screen.getByRole('link', { name: /Configure preview/i });
    expect(link.getAttribute('href')).toBe('#');
  });

  it('forwards the full event (including wizard intent) to onConfigure', () => {
    const onConfigure = vi.fn();
    const event = {
      kind: 'preview_unavailable',
      previewId: '',
      wizard: { view: 'settings:preview', projectId: 'agent-hub' },
      wizardUrl: '/projects/agent-hub/settings/preview',
      unavailableReason: 'preview-disabled',
    };
    render(<PreviewAttachment event={event} onConfigure={onConfigure} />);
    fireEvent.click(screen.getByRole('link', { name: /Configure preview/i }));
    expect(onConfigure).toHaveBeenCalledTimes(1);
    const passed = onConfigure.mock.calls[0][0];
    expect(passed.wizard).toEqual({ view: 'settings:preview', projectId: 'agent-hub' });
  });

  it('hides the teach-moment card when the user clicks Skip', () => {
    const onSkip = vi.fn();
    const event = {
      kind: 'preview_unavailable',
      previewId: '',
      wizardUrl: '/projects/agent-hub/settings/projects',
      unavailableReason: 'preview-disabled',
    };
    const { container } = render(<PreviewAttachment event={event} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole('button', { name: /Skip/i }));
    expect(onSkip).toHaveBeenCalledWith(event);
    expect(container.firstChild).toBeNull();
  });

  it('routes the Configure click through onConfigure when supplied', () => {
    const onConfigure = vi.fn();
    const event = {
      kind: 'preview_unavailable',
      previewId: '',
      wizardUrl: '/projects/agent-hub/settings/projects',
      unavailableReason: 'preview-disabled',
    };
    render(<PreviewAttachment event={event} onConfigure={onConfigure} />);
    fireEvent.click(screen.getByRole('link', { name: /Configure preview/i }));
    expect(onConfigure).toHaveBeenCalledWith(event);
  });

  it('renders the failed variant with a log tail and Retry click', () => {
    const onRetry = vi.fn();
    const event = {
      kind: 'preview_failed',
      previewId: 'p2',
      error: 'health check timed out',
      logTail: ['boot 1', 'boot 2', 'npm ERR! foo'],
    };
    render(<PreviewAttachment event={event} onRetry={onRetry} />);
    expect(screen.getByText(/Preview failed to boot/i)).toBeInTheDocument();
    expect(screen.getByText('health check timed out')).toBeInTheDocument();
    // The log tail is rendered in a single <pre>; assert via partial match.
    expect(screen.getByText(/npm ERR! foo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledWith(event);
  });

  it('returns null when given a falsy event', () => {
    const { container } = render(<PreviewAttachment event={null} />);
    expect(container.firstChild).toBeNull();
  });
});
