import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReleasesView from './ReleasesView';

(vi as any).mock('../utils/connection.js', () => ({
  getServerBase: () => 'http://localhost:3051',
  getAuthHeaders: () => ({}),
}));

describe('ReleasesView', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          ({
            repo: 'Speakman-ai/agent-hub',
            currentVersion: '1.30.0',
            source: 'github',
            selected: {
              version: '1.30.0',
              tag: 'v1.30.0',
              publishedAt: '2025-05-01T00:00:00Z',
              url: 'https://github.com/example/releases/tag/v1.30.0',
              summary: 'Added Release page.',
              sections: [
                {
                  title: "What's new",
                  items: [{ text: 'Added Release page', hash: 'abc1234' }],
                },
              ],
            },
            releases: [
              {
                version: '1.30.0',
                tag: 'v1.30.0',
                publishedAt: '2025-05-01T00:00:00Z',
                url: 'https://github.com/example/releases/tag/v1.30.0',
                summary: 'Added Release page.',
              },
              {
                version: '1.29.0',
                tag: 'v1.29.0',
                publishedAt: '2025-04-01T00:00:00Z',
                url: null,
                summary: 'Bug fixes.',
              },
            ],
          }) as any,
      }),
    );
  });

  it('renders the selected release with user-facing sections', async () => {
    render(<ReleasesView />);
    await waitFor(() => {
      expect(screen.getByText("What's new")).toBeInTheDocument();
    });
    expect(screen.getByText('Added Release page')).toBeInTheDocument();
    expect(screen.getByText(/you're on/i)).toBeInTheDocument();
  });

  it('keeps the rendered list when a refresh fails', async () => {
    render(<ReleasesView />);
    await screen.findByText('v1.29.0');

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: 'Upstream down' }),
    } as any);

    fireEvent.click(screen.getByRole('button', { name: /refresh/i } as any) as any);
    await waitFor(() => {
      expect(screen.getByText('Upstream down')).toBeInTheDocument();
    });
    // The previously-rendered list is still on screen — the error banner
    // doesn't wipe it.
    expect(screen.getByText('v1.29.0')).toBeInTheDocument();
    expect(screen.getByText('Added Release page')).toBeInTheDocument();
  });

  it('loads another version when selected from the list', async () => {
    render(<ReleasesView />);
    await screen.findByText('v1.29.0');

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        repo: 'Speakman-ai/agent-hub',
        currentVersion: '1.30.0',
        source: 'github',
        selected: {
          version: '1.29.0',
          tag: 'v1.29.0',
          publishedAt: '2025-04-01T00:00:00Z',
          url: null,
          summary: 'Bug fixes.',
          sections: [
            { title: 'Bug fixes', items: [{ text: 'Fixed webhook timeout', hash: null }] },
          ],
        },
        releases: [],
      }),
    } as any);

    fireEvent.click(screen.getByRole('button', { name: /v1\.29\.0/i } as any) as any);
    await waitFor(() => {
      expect(screen.getByText('Fixed webhook timeout')).toBeInTheDocument();
    });
  });
});
