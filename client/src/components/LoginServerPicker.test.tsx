import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/orgs.js', () => ({
  fetchOrgs: vi.fn(),
  switchOrg: vi.fn(),
  updateOrg: vi.fn(),
}));

(vi as any).mock('../utils/connection.js', () => ({
  getConnectionConfig: vi.fn(),
  saveConnectionConfig: vi.fn(),
  reloadForOrgSwitch: vi.fn(),
}));

import LoginServerPicker from './LoginServerPicker';
import { fetchOrgs, switchOrg, updateOrg } from '../utils/orgs';
import { getConnectionConfig, saveConnectionConfig, reloadForOrgSwitch } from '../utils/connection';

function renderPicker(props: Partial<Parameters<typeof LoginServerPicker>[0]> = {}) {
  return render(
    <LoginServerPicker
      onServerChangeStart={vi.fn(() => true)}
      onServerChangeEnd={vi.fn()}
      {...props}
    />,
  );
}

const ORGS = [
  { id: 'a', name: 'Acme', mode: 'remote', color: '#111', remote_url: 'https://acme.example.com' },
  { id: 'b', name: 'Beta', mode: 'remote', color: '#222', remote_url: 'https://beta.example.com' },
];

beforeEach(() => {
  for (const fn of [
    fetchOrgs,
    switchOrg,
    updateOrg,
    getConnectionConfig,
    saveConnectionConfig,
    reloadForOrgSwitch,
  ]) {
    (fn as any).mockReset();
  }
  (getConnectionConfig as any).mockReturnValue({
    mode: 'remote',
    remoteUrl: 'https://acme.example.com',
    apiKey: 'key-1',
  });
  (fetchOrgs as any).mockResolvedValue({ orgs: ORGS, activeOrgId: 'a' });
  (switchOrg as any).mockResolvedValue(undefined);
  (updateOrg as any).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoginServerPicker', () => {
  it('shows which org the login page is pointed at', async () => {
    renderPicker();
    expect(await screen.findByTestId('login-server-name')).toHaveTextContent('Acme');
    expect(screen.getByTestId('login-server-url')).toHaveTextContent('https://acme.example.com');
  });

  it('swaps to another bookmarked org and reloads the window', async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId('login-server-change'));
    fireEvent.click(screen.getByTestId('login-server-org-b'));
    await waitFor(() => expect(switchOrg).toHaveBeenCalledWith('b'));
    expect(reloadForOrgSwitch).toHaveBeenCalledTimes(1);
  });

  async function editUrlTo(value: string) {
    fireEvent.click(await screen.findByTestId('login-server-change'));
    fireEvent.click(screen.getByTestId('login-server-edit'));
    fireEvent.change(screen.getByLabelText(/Server URL/i), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: /Save & connect/i }));
  }

  it('edits the bookmarked URL to a new server, dropping the old server key', async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId('login-server-change'));
    fireEvent.click(screen.getByTestId('login-server-edit'));
    const input = screen.getByLabelText(/Server URL/i) as HTMLInputElement;
    expect(input.value).toBe('https://acme.example.com');
    fireEvent.change(input, { target: { value: 'new-acme.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & connect/i }));
    // Acme's key must never be sent to the new host: the bookmark loses it,
    // so the connection synced from it on switch carries no key either.
    await waitFor(() =>
      expect(updateOrg).toHaveBeenCalledWith('a', {
        remoteUrl: 'https://new-acme.example.com',
        apiKey: '',
      }),
    );
    expect(switchOrg).toHaveBeenCalledWith('a');
    expect(saveConnectionConfig).not.toHaveBeenCalled();
    expect(reloadForOrgSwitch).toHaveBeenCalledTimes(1);
  });

  it('keeps the bookmark key when the edit stays on the same server', async () => {
    renderPicker();
    await editUrlTo('ACME.example.com/hub/');
    await waitFor(() =>
      expect(updateOrg).toHaveBeenCalledWith('a', { remoteUrl: 'https://ACME.example.com/hub' }),
    );
    expect(switchOrg).toHaveBeenCalledWith('a');
  });

  it('rejects an invalid URL without reconnecting', async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId('login-server-change'));
    fireEvent.click(screen.getByTestId('login-server-edit'));
    fireEvent.change(screen.getByLabelText(/Server URL/i), { target: { value: 'https://' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & connect/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(updateOrg).not.toHaveBeenCalled();
    expect(reloadForOrgSwitch).not.toHaveBeenCalled();
  });

  it('writes the connection directly, without the old key, when the URL is not bookmarked', async () => {
    // ConnectFirstScreen stores connection.json without a bookmark; the
    // picker must still let the user fix the URL.
    (getConnectionConfig as any).mockReturnValue({
      mode: 'remote',
      remoteUrl: 'https://solo.example.com',
      apiKey: 'key-9',
    });
    renderPicker();
    expect(await screen.findByTestId('login-server-name')).toHaveTextContent('solo.example.com');
    fireEvent.click(screen.getByTestId('login-server-change'));
    fireEvent.click(screen.getByTestId('login-server-edit'));
    fireEvent.change(screen.getByLabelText(/Server URL/i), {
      target: { value: 'https://other.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save & connect/i }));
    await waitFor(() =>
      expect(saveConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteUrl: 'https://other.example.com',
        apiKey: '',
      }),
    );
    for (const [cfg] of (saveConnectionConfig as any).mock.calls) {
      expect(cfg.apiKey).not.toBe('key-9');
    }
    expect(updateOrg).not.toHaveBeenCalled();
    expect(reloadForOrgSwitch).toHaveBeenCalledTimes(1);
  });

  it('keeps the unbookmarked connection key on a same-server edit', async () => {
    (getConnectionConfig as any).mockReturnValue({
      mode: 'remote',
      remoteUrl: 'https://solo.example.com',
      apiKey: 'key-9',
    });
    renderPicker();
    await editUrlTo('https://solo.example.com/hub');
    await waitFor(() =>
      expect(saveConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteUrl: 'https://solo.example.com/hub',
        apiKey: 'key-9',
      }),
    );
  });

  it('in local mode with a stale remote active id, shows this computer and edits only the connection', async () => {
    (getConnectionConfig as any).mockReturnValue({ mode: 'local', remoteUrl: '', apiKey: '' });
    (fetchOrgs as any).mockResolvedValue({ orgs: ORGS, activeOrgId: 'b' });
    renderPicker();
    expect(await screen.findByTestId('login-server-name')).toHaveTextContent('This computer');
    fireEvent.click(screen.getByTestId('login-server-change'));
    expect(screen.getByTestId('login-server-org-b')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('login-server-edit'));
    fireEvent.change(screen.getByLabelText(/Server URL/i), {
      target: { value: 'https://fresh.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save & connect/i }));
    await waitFor(() =>
      expect(saveConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteUrl: 'https://fresh.example.com',
        apiKey: '',
      }),
    );
    expect(updateOrg).not.toHaveBeenCalled();
  });

  it('falls back to the local server', async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId('login-server-change'));
    fireEvent.click(screen.getByTestId('login-server-local'));
    expect(saveConnectionConfig).toHaveBeenCalledWith({ mode: 'local', remoteUrl: '', apiKey: '' });
    await waitFor(() => expect(reloadForOrgSwitch).toHaveBeenCalledTimes(1));
  });

  it('claims the transition before switching and does nothing when refused', async () => {
    const onServerChangeStart = vi.fn(() => false);
    renderPicker({ onServerChangeStart });
    fireEvent.click(await screen.findByTestId('login-server-change'));
    fireEvent.click(screen.getByTestId('login-server-org-b'));
    expect(onServerChangeStart).toHaveBeenCalledTimes(1);
    expect(switchOrg).not.toHaveBeenCalled();
    expect(reloadForOrgSwitch).not.toHaveBeenCalled();
  });

  it('claims the transition before editing the connection, and hands it back on failure', async () => {
    const onServerChangeStart = vi.fn(() => true);
    const onServerChangeEnd = vi.fn();
    (updateOrg as any).mockRejectedValue(new Error('disk full'));
    renderPicker({ onServerChangeStart, onServerChangeEnd });
    await editUrlTo('https://other.example.com');
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    expect(onServerChangeStart.mock.invocationCallOrder[0]).toBeLessThan(
      (updateOrg as any).mock.invocationCallOrder[0],
    );
    expect(onServerChangeEnd).toHaveBeenCalledTimes(1);
    expect(reloadForOrgSwitch).not.toHaveBeenCalled();
  });

  it('gates "Use local server" through the same transition', async () => {
    const onServerChangeStart = vi.fn(() => false);
    renderPicker({ onServerChangeStart });
    fireEvent.click(await screen.findByTestId('login-server-change'));
    fireEvent.click(screen.getByTestId('login-server-local'));
    expect(saveConnectionConfig).not.toHaveBeenCalled();
  });
});
