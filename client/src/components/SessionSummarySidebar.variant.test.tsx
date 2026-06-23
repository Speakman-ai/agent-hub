import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionSummarySidebar from './SessionSummarySidebar';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getSessionSummary: vi.fn(() => Promise.resolve(null)),
    getProjectPullDetail: vi.fn(() => Promise.resolve(null)),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('SessionSummarySidebar variant prop', () => {
  it('default (top) variant spans full width under chat header', () => {
    const { container } = render(<SessionSummarySidebar sessionId="s1" isLive={false} />);
    const aside = container.querySelector('aside');
    expect(aside!).not.toBeNull();
    expect(aside!.className).toMatch(/w-full/);
    expect(aside!.className).toMatch(/border-b/);
    expect(aside!.className).not.toMatch(/hidden/);
    expect(aside!.className).not.toMatch(/border-t/);
  });

  it('starts collapsed by default and expands on toggle', async () => {
    render(<SessionSummarySidebar sessionId="s2" isLive={false} />);
    expect(screen.getByTestId('session-summary-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('session-linked-pr')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
    expect(screen.getByTestId('session-summary-toggle')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
    expect(screen.getByTestId('session-summary-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('sidebar variant uses flex flex-col w-full (no hidden)', () => {
    const { container } = render(
      <SessionSummarySidebar sessionId="s3" isLive={false} variant="sidebar" />,
    );
    const aside = container.querySelector('aside');
    expect(aside!).not.toBeNull();
    expect(aside!.className).not.toMatch(/hidden/);
    expect(aside!.className).toMatch(/w-full/);
  });
});
