import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getConnectionConfig: vi.fn(),
  saveConnectionConfig: vi.fn(),
  testConnection: vi.fn(),
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
}));

vi.mock('../utils/auth.js', () => ({
  isAuthenticated: vi.fn(),
}));

import ConnectFirstScreen from './ConnectFirstScreen.jsx';
import { getConnectionConfig, saveConnectionConfig, testConnection } from '../utils/connection.js';
import { isAuthenticated } from '../utils/auth.js';

const Child = () => <div data-testid="app-child">app</div>;

beforeEach(() => {
  getConnectionConfig.mockReset();
  saveConnectionConfig.mockReset();
  testConnection.mockReset();
  isAuthenticated.mockReset();
  getConnectionConfig.mockReturnValue({ mode: 'local', remoteUrl: '', apiKey: '' });
  isAuthenticated.mockReturnValue(false);
  delete window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

describe('ConnectFirstScreen — gating', () => {
  it('passes through when NOT running in Electron', async () => {
    // No window.electronAPI → browser environment. Should render children
    // unchanged; the remote-connect flow is only meaningful in desktop.
    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('connect-first-screen')).toBeNull();
  });

  it('passes through when connection config is already remote', async () => {
    window.electronAPI = { isElectron: true };
    getConnectionConfig.mockReturnValue({
      mode: 'remote',
      remoteUrl: 'https://hub.example.com',
      apiKey: '',
    });

    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('connect-first-screen')).toBeNull();
  });

  it('passes through when user is already authenticated', async () => {
    window.electronAPI = { isElectron: true };
    isAuthenticated.mockReturnValue(true);

    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
  });

  it('passes through when setup is already complete (firstRun=false)', async () => {
    window.electronAPI = { isElectron: true };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ firstRun: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
  });

  it('passes through when /api/setup/status is unreachable', async () => {
    // Defensive: if we can't determine setup state, never strand the user.
    window.electronAPI = { isElectron: true };
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
  });

  it('shows the chooser when Electron + local + no auth + firstRun=true', async () => {
    window.electronAPI = { isElectron: true };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ firstRun: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('connect-first-screen')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('app-child')).toBeNull();
    expect(screen.getByTestId('use-local-btn')).toBeInTheDocument();
    expect(screen.getByTestId('use-remote-btn')).toBeInTheDocument();
  });
});

describe('ConnectFirstScreen — actions', () => {
  beforeEach(() => {
    window.electronAPI = {
      isElectron: true,
      navigateToOrg: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ firstRun: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  it('"Use this computer" falls through to children (SetupWizard)', async () => {
    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('connect-first-screen')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('use-local-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
    // No connection config was written — default (local) is fine as-is.
    expect(saveConnectionConfig).not.toHaveBeenCalled();
  });

  it('"Connect to existing server" shows the remote form', async () => {
    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('use-remote-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('use-remote-btn'));
    expect(screen.getByLabelText(/server url/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect & sign in/i })).toBeDisabled();
  });

  it('successful test enables Connect; clicking saves config and navigates', async () => {
    testConnection.mockResolvedValue({ ok: true, message: 'Connected' });

    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('use-remote-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('use-remote-btn'));

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'https://hub.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/connected/i);
    });
    const connectBtn = screen.getByRole('button', { name: /connect & sign in/i });
    expect(connectBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(connectBtn);
    });

    expect(saveConnectionConfig).toHaveBeenCalledWith({
      mode: 'remote',
      remoteUrl: 'https://hub.example.com',
      apiKey: '',
    });
    expect(window.electronAPI.navigateToOrg).toHaveBeenCalled();
  });

  it('failed test surfaces error and keeps Connect disabled', async () => {
    testConnection.mockResolvedValue({ ok: false, message: 'Connection refused' });

    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('use-remote-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('use-remote-btn'));

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'https://wrong.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/connection refused/i);
    });
    expect(screen.getByRole('button', { name: /connect & sign in/i })).toBeDisabled();
    expect(saveConnectionConfig).not.toHaveBeenCalled();
  });

  it('strips trailing slashes from the server URL before saving', async () => {
    testConnection.mockResolvedValue({ ok: true, message: 'ok' });

    render(
      <ConnectFirstScreen>
        <Child />
      </ConnectFirstScreen>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('use-remote-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('use-remote-btn'));
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: '  https://hub.example.com///  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /connect & sign in/i }));
    });

    expect(saveConnectionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: 'https://hub.example.com' }),
    );
  });
});
