import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Must be mocked before importing the component under test.
vi.mock('../utils/api.js', () => ({
  api: {
    clawhubSearch: vi.fn(),
    clawhubListSkills: vi.fn(),
    clawhubGetVersions: vi.fn(),
    clawhubInstall: vi.fn(),
  },
}));

import ClawHubBrowser from './ClawHubBrowser.jsx';
import { api } from '../utils/api.js';

describe('ClawHubBrowser', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    api.clawhubSearch.mockResolvedValue([]);
    api.clawhubListSkills.mockResolvedValue([
      {
        slug: 'postgres-helper',
        name: 'Postgres Helper',
        description: 'Postgres-aware skill',
        latest_version: '0.4.1',
        category: 'development',
      },
    ]);
    api.clawhubGetVersions.mockResolvedValue([{ version: '0.4.1' }, { version: '0.4.0' }]);
    api.clawhubInstall.mockResolvedValue({
      slug: 'postgres-helper',
      installedAt: '2026-04-17T00:00:00Z',
      path: '/tmp/skills/postgres-helper',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Advance timers (debounce) AND flush pending promises. */
  async function settle(ms = 260) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('lists skills from clawhubListSkills on mount when query is empty', async () => {
    render(
      <ClawHubBrowser
        activeAgent={{ id: 'hub-frontend', name: 'Hub Frontend' }}
        installedSlugs={new Set()}
      />,
    );

    await settle();
    expect(api.clawhubListSkills).toHaveBeenCalled();
    expect(screen.getByText('Postgres Helper')).toBeInTheDocument();
  });

  it('switches to clawhubSearch with debounced query when the user types', async () => {
    render(
      <ClawHubBrowser
        activeAgent={{ id: 'hub-frontend', name: 'Hub Frontend' }}
        installedSlugs={new Set()}
      />,
    );

    // Initial list call.
    await settle();
    expect(api.clawhubListSkills).toHaveBeenCalled();

    const input = screen.getByLabelText('Search ClawHub registry');
    fireEvent.change(input, { target: { value: 'postgres' } });

    // Before debounce expires, no new search yet.
    expect(api.clawhubSearch).not.toHaveBeenCalled();

    await settle();
    expect(api.clawhubSearch).toHaveBeenCalledWith('postgres', 50);
  });
});
