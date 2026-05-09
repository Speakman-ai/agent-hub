import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import SessionSummarySidebar from './SessionSummarySidebar.jsx';

vi.mock('../utils/api.js', () => ({
  api: {
    getSessionSummary: vi.fn(() => Promise.resolve(null)),
    getProjectPullDetail: vi.fn(() => Promise.resolve(null)),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionSummarySidebar variant prop', () => {
  it('default (panel) variant uses hidden lg:flex outer class', () => {
    const { container } = render(<SessionSummarySidebar sessionId="s1" isLive={false} />);
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    // panel mode must include `hidden` so it's desktop-only
    expect(aside.className).toMatch(/hidden/);
    // and the right-column width class
    expect(aside.className).toMatch(/lg:flex/);
  });

  it('sidebar variant uses flex flex-col w-full (no hidden)', () => {
    const { container } = render(
      <SessionSummarySidebar sessionId="s2" isLive={false} variant="sidebar" />,
    );
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    // sidebar mode must NOT hide on small screens
    expect(aside.className).not.toMatch(/hidden/);
    // sidebar mode must include w-full
    expect(aside.className).toMatch(/w-full/);
  });
});
