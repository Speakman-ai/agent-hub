import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Exercise the actual saved-connection helpers, not a mocked switchOrg.
describe('Server picker with legacy saved connections', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    delete window.electronAPI;
  });

  it('switches and refreshes an existing bookmark, then signs out without losing connections', async () => {
    const servers = [
      {
        id: 'old-a',
        name: 'Alpha',
        mode: 'remote',
        remote_url: 'https://a.test',
        api_key: 'a-key',
      },
      { id: 'old-b', name: 'Beta', mode: 'remote', remote_url: 'https://b.test', api_key: 'b-key' },
    ];
    localStorage.setItem('agent-hub-remote-orgs', JSON.stringify(servers));
    localStorage.setItem('agent-hub-active-org', 'old-a');
    localStorage.setItem(
      'agent-hub-connection',
      JSON.stringify({ mode: 'remote', remoteUrl: 'https://a.test', apiKey: 'a-key' }),
    );
    // Electron uses this bridge to load the selected origin; browser reloads
    // remount the same application and re-read the same persisted keys.
    const navigateToOrg = vi.fn();
    window.electronAPI = { navigateToOrg } as any;
    const orgs = await import('../utils/orgs');
    await orgs.fetchOrgs();
    const { default: OrgSwitcher } = await import('./OrgSwitcher');
    const onNavigateSettings = vi.fn();
    const view = render(<OrgSwitcher onNavigateSettings={onNavigateSettings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage Servers' }));
    expect(onNavigateSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    await waitFor(() => expect(navigateToOrg).toHaveBeenCalledOnce());
    expect(localStorage.getItem('agent-hub-active-org')).toBe('old-b');
    const connection = await import('../utils/connection');
    expect(connection.getApiBase()).toBe('https://b.test/api');
    expect(connection.getAuthHeaders()).toEqual({ 'X-API-Key': 'b-key' });
    expect(orgs.getActiveOrgApiId()).toBe('active');
    view.unmount();

    vi.resetModules();
    const refreshed = await import('../utils/orgs');
    expect(await refreshed.fetchOrgs()).toEqual({ orgs: servers, activeOrgId: 'old-b' });
    const auth = await import('../utils/auth');
    auth.setToken({ token: 'b-jwt', user: { id: 'b-user' } });
    await auth.logout();
    expect(auth.getToken()).toBeNull();
    expect(refreshed.getActiveOrg()?.id).toBe('old-b');
    expect(JSON.parse(localStorage.getItem('agent-hub-remote-orgs')!)).toEqual(servers);
    delete window.electronAPI;
  });
});
