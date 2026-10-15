import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import BrowserProfilesSection, { formatLastUsed } from './BrowserProfilesSection';
import { api, type BrowserProfileWire } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getMyBrowserProfiles: vi.fn(),
    clearBrowserProfileDomain: vi.fn(),
    deleteBrowserProfile: vi.fn(),
  },
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function profile(over: Partial<BrowserProfileWire> = {}): BrowserProfileWire {
  return {
    id: 'p1',
    agentId: 'agent-a',
    agentName: 'Agent A',
    projectId: 'proj-1',
    projectName: 'Project One',
    domains: ['github.com', 'google.com'],
    hasState: true,
    inUse: false,
    lastUsedAt: '2026-10-15 12:00:00',
    createdAt: '2026-10-01 00:00:00',
    updatedAt: '2026-10-15 12:00:00',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => cleanup());

describe('BrowserProfilesSection', () => {
  it('lists profiles grouped by agent with domains and last used', async () => {
    mocked.getMyBrowserProfiles.mockResolvedValue({
      profiles: [
        profile(),
        profile({ id: 'p2', projectId: 'proj-2', projectName: 'Project Two', domains: [] }),
        profile({ id: 'p3', agentId: 'agent-b', agentName: 'Agent B', lastUsedAt: null }),
      ],
    });
    render(<BrowserProfilesSection />);
    const groupA = await screen.findByTestId('browser-profiles-agent-agent-a');
    expect(groupA.textContent).toContain('Project One');
    expect(groupA.textContent).toContain('Project Two');
    expect(groupA.textContent).toContain('github.com');
    expect(groupA.textContent).toContain('Not signed into any sites.');
    expect(screen.getByTestId('browser-profile-p3').textContent).toContain('Last used Never');
  });

  it('shows the empty state', async () => {
    mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [] });
    render(<BrowserProfilesSection />);
    expect(await screen.findByTestId('browser-profiles-empty')).toBeTruthy();
  });

  it('clears one domain and renders the updated profile', async () => {
    mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile()] });
    mocked.clearBrowserProfileDomain.mockResolvedValue(profile({ domains: ['google.com'] }));
    render(<BrowserProfilesSection />);
    fireEvent.click(await screen.findByLabelText('Clear github.com from Agent A'));
    await waitFor(() => expect(screen.queryByText('github.com')).toBeNull());
    expect(mocked.clearBrowserProfileDomain).toHaveBeenCalledWith('p1', 'github.com');
    expect(screen.getByText('google.com')).toBeTruthy();
  });

  it('disables domain clearing while a session holds the profile', async () => {
    mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile({ inUse: true })] });
    render(<BrowserProfilesSection />);
    const btn = (await screen.findByLabelText(
      'Clear github.com from Agent A',
    )) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('In use by a running session')).toBeTruthy();
  });

  it('deletes a profile after confirmation', async () => {
    mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile()] });
    mocked.deleteBrowserProfile.mockResolvedValue({ ok: true });
    render(<BrowserProfilesSection />);
    fireEvent.click(
      await screen.findByLabelText('Delete browser profile for Agent A in Project One'),
    );
    await waitFor(() => expect(screen.queryByTestId('browser-profile-p1')).toBeNull());
    expect(mocked.deleteBrowserProfile).toHaveBeenCalledWith('p1');
  });

  it('does nothing when the delete is not confirmed', async () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile()] });
    render(<BrowserProfilesSection />);
    fireEvent.click(
      await screen.findByLabelText('Delete browser profile for Agent A in Project One'),
    );
    expect(mocked.deleteBrowserProfile).not.toHaveBeenCalled();
  });

  it('surfaces a server error', async () => {
    mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile()] });
    mocked.clearBrowserProfileDomain.mockRejectedValue(
      new Error('A running session is using this profile.'),
    );
    render(<BrowserProfilesSection />);
    fireEvent.click(await screen.findByLabelText('Clear github.com from Agent A'));
    expect((await screen.findByRole('alert')).textContent).toContain('running session');
  });

  it('parses SQLite UTC timestamps', () => {
    expect(formatLastUsed(null)).toBe('Never');
    expect(formatLastUsed('2026-10-15 12:00:00')).toBe(
      new Date('2026-10-15T12:00:00Z').toLocaleString(),
    );
  });
});
