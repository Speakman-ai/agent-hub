import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import BrowserProfilesSection, { formatLastUsed } from './BrowserProfilesSection';
import { api, type BrowserProfileWire } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getMyBrowserProfiles: vi.fn(),
    clearBrowserProfileDomain: vi.fn(),
    deleteBrowserProfile: vi.fn(),
    setBrowserDomainPolicy: vi.fn(),
    deleteBrowserDomainPolicy: vi.fn(),
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
    domainPolicies: [],
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

  describe('site policies', () => {
    it('adds a policy from typed input, normalizing the domain', async () => {
      mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile()] });
      mocked.setBrowserDomainPolicy.mockResolvedValue(
        profile({ domainPolicies: [{ domain: 'bank.com', policy: 'block' }] }),
      );
      render(<BrowserProfilesSection />);
      fireEvent.change(await screen.findByLabelText('New site policy domain for Agent A'), {
        target: { value: 'https://Bank.com/login' },
      });
      fireEvent.change(screen.getByLabelText('New site policy'), { target: { value: 'block' } });
      fireEvent.click(screen.getByText('Add'));
      await waitFor(() =>
        expect(mocked.setBrowserDomainPolicy).toHaveBeenCalledWith('p1', 'bank.com', 'block'),
      );
      expect(
        ((await screen.findByLabelText('Policy for bank.com')) as HTMLSelectElement).value,
      ).toBe('block');
    });

    it('refuses input that is not a site', async () => {
      mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile()] });
      render(<BrowserProfilesSection />);
      fireEvent.change(await screen.findByLabelText('New site policy domain for Agent A'), {
        target: { value: 'localhost' },
      });
      fireEvent.click(screen.getByText('Add'));
      expect(
        await screen.findByText(
          'Enter a site such as example.com, or desktop:chromium for a desktop app',
        ),
      ).toBeTruthy();
      expect(mocked.setBrowserDomainPolicy).not.toHaveBeenCalled();
    });

    it('changes and removes an existing policy', async () => {
      const withAsk = profile({ domainPolicies: [{ domain: 'shop.com', policy: 'ask' }] });
      mocked.getMyBrowserProfiles.mockResolvedValue({ profiles: [withAsk] });
      mocked.setBrowserDomainPolicy.mockResolvedValue(
        profile({ domainPolicies: [{ domain: 'shop.com', policy: 'allow' }] }),
      );
      mocked.deleteBrowserDomainPolicy.mockResolvedValue(profile());
      render(<BrowserProfilesSection />);
      fireEvent.change(await screen.findByLabelText('Policy for shop.com'), {
        target: { value: 'allow' },
      });
      await waitFor(() =>
        expect(mocked.setBrowserDomainPolicy).toHaveBeenCalledWith('p1', 'shop.com', 'allow'),
      );
      fireEvent.click(await screen.findByLabelText('Remove policy for shop.com'));
      await waitFor(() => expect(screen.queryByLabelText('Policy for shop.com')).toBeNull());
      expect(mocked.deleteBrowserDomainPolicy).toHaveBeenCalledWith('p1', 'shop.com');
    });
  });
});
