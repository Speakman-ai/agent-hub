import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BrowserActivityPanel from './BrowserActivityPanel.jsx';

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
    expect(screen.getByText(/Browser Activity/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/Opened example\.com/)).toBeTruthy();
  });
});
