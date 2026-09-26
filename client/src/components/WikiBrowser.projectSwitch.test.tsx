import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import WikiBrowser from './WikiBrowser';

(vi as any).mock('../utils/connection', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test-jwt' }),
}));

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

const page = (title: string) => ({
  id: title,
  project_id: 'p',
  title,
  slug: title.toLowerCase(),
  category: 'general',
  updated_by: 'user',
  created_at: '2026-09-26 00:00:00',
  updated_at: '2026-09-26 00:00:00',
});

describe('WikiBrowser project switch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('a slow page list for the project you left cannot replace the new project', async () => {
    const pendingOld: ((r: unknown) => void)[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/projects/old/wiki')) return new Promise((r) => pendingOld.push(r));
      if (u.includes('/projects/new/wiki')) return json([page('New Page')]);
      return json([]);
    });

    const { rerender } = render(<WikiBrowser projectId="old" apiBase="/api" />);
    await waitFor(() => expect(pendingOld.length).toBeGreaterThan(0));
    rerender(<WikiBrowser projectId="new" apiBase="/api" />);
    expect(await screen.findByText('New Page')).toBeTruthy();

    pendingOld.forEach((resolve) => resolve(json([page('Old Page')])));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Old Page')).toBeNull();
    expect(screen.getByText('New Page')).toBeTruthy();
  });
});
