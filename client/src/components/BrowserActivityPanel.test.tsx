import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BrowserActivityPanel from './BrowserActivityPanel';

describe('BrowserActivityPanel', () => {
  it('shows collapsible browser activity timeline', () => {
    const timeline = [
      {
        seq: 1,
        event: {
          type: 'browser_tool_activity',
          actionId: 'a1',
          phase: 'started',
          op: 'navigate',
          label: 'Navigating to example.com…',
          startedAtMs: 1,
        },
      },
      {
        seq: 2,
        event: {
          type: 'browser_tool_activity',
          actionId: 'a1',
          phase: 'ended',
          op: 'navigate',
          label: 'Navigating to example.com…',
          startedAtMs: 1,
          ok: true,
          summary: 'Opened example.com',
          durationMs: 12,
        },
      },
    ];
    render(<BrowserActivityPanel timelineEntries={timeline} streaming={false} screenshots={{}} />);
    expect(screen.getByTestId('browser-activity-panel')).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Browser Activity/i });
    expect(btn!.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/Browser Activity/)).toBeTruthy();
    fireEvent.click(btn as any);
    expect(btn!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/Opened example\.com/)).toBeTruthy();
  });
});
