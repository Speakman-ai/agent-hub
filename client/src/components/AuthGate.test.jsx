import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/auth.js', () => ({
  getAuthStatus: vi.fn(),
  isAuthenticated: vi.fn(),
}));

vi.mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getConnectionConfig: vi.fn(),
  saveConnectionConfig: vi.fn(),
}));

vi.mock('./LoginScreen.jsx', () => ({
  default: () => <div data-testid="login-screen">login</div>,
}));

import AuthGate from './AuthGate.jsx';
import { getAuthStatus, isAuthenticated } from '../utils/auth.js';
import { getConnectionConfig, saveConnectionConfig } from '../utils/connection.js';

const Child = () => <div data-testid="app-child">app</div>;

beforeEach(() => {
  getAuthStatus.mockReset();
  isAuthenticated.mockReset();
  getConnectionConfig.mockReset();
  saveConnectionConfig.mockReset();
  getConnectionConfig.mockReturnValue({ mode: 'local', remoteUrl: '', apiKey: '' });
  isAuthenticated.mockReturnValue(false);
  delete window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

describe('AuthGate — local mode', () => {
  it('renders children when auth is not configured', async () => {
    getAuthStatus.mockResolvedValue({ authConfigured: false });
    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
  });

  it('renders LoginScreen when auth is configured and user not authenticated', async () => {
    getAuthStatus.mockResolvedValue({ authConfigured: true });
    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('login-screen')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('app-child')).toBeNull();
  });

  it('falls through when /auth/status errors in local mode (legacy behavior)', async () => {
    // Local-mode unreachable = don't hard-block; the main app surfaces it.
    getAuthStatus.mockRejectedValue(new Error('boom'));
    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('remote-unreachable-screen')).toBeNull();
  });
});

describe('AuthGate — remote unreachable', () => {
  beforeEach(() => {
    getConnectionConfig.mockReturnValue({
      mode: 'remote',
      remoteUrl: 'https://hub.example.com',
      apiKey: '',
    });
  });

  it('renders RemoteUnreachableScreen when remote /auth/status fails', async () => {
    getAuthStatus.mockRejectedValue(new Error('fetch failed'));
    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('remote-unreachable-screen')).toBeInTheDocument();
    });
    expect(screen.getByText('https://hub.example.com')).toBeInTheDocument();
    expect(screen.getByText(/fetch failed/i)).toBeInTheDocument();
    expect(screen.queryByTestId('app-child')).toBeNull();
  });

  it('"Switch to local server" clears remote config and reloads', async () => {
    getAuthStatus.mockRejectedValue(new Error('timeout'));
    const reload = vi.fn();
    const originalLocation = window.location;
    // jsdom's window.location.reload is locked down — redefine the whole
    // object for the duration of the test.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('remote-unreachable-screen')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /switch to local/i }));

    expect(saveConnectionConfig).toHaveBeenCalledWith({
      mode: 'local',
      remoteUrl: '',
      apiKey: '',
    });
    expect(reload).toHaveBeenCalled();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('"Edit connection" navigates via Electron when available', async () => {
    getAuthStatus.mockRejectedValue(new Error('timeout'));
    window.electronAPI = { navigateToOrg: vi.fn() };

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('remote-unreachable-screen')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /edit connection/i }));

    expect(saveConnectionConfig).toHaveBeenCalledWith({
      mode: 'local',
      remoteUrl: '',
      apiKey: '',
    });
    expect(window.electronAPI.navigateToOrg).toHaveBeenCalled();
  });
});

// ─── Active-org local bypass (card 3d72338d) ────────────────────────
// Matrix covered here:
//   authConfigured | activeOrgIsLocal | token? | expected
//   ---------------+------------------+--------+-----------------
//   true           | true             | no     | children render (local bypass)
//   true           | false            | no     | <LoginScreen /> renders
//   false          | false            | no     | children render (legacy flow)
describe('AuthGate — active-org local bypass', () => {
  it('renders children (not LoginScreen) when the active org is local, even with authConfigured=true', async () => {
    getAuthStatus.mockResolvedValue({
      authConfigured: true,
      username: 'owner',
      role: 'Owner',
      activeOrgIsLocal: true,
    });
    isAuthenticated.mockReturnValue(false);

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('login-screen')).toBeNull();
  });

  it('renders LoginScreen when auth is configured, org is NOT local, and no token is stored', async () => {
    getAuthStatus.mockResolvedValue({
      authConfigured: true,
      username: 'owner',
      role: null,
      activeOrgIsLocal: false,
    });
    isAuthenticated.mockReturnValue(false);

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('login-screen')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('app-child')).toBeNull();
  });

  it('renders children when auth is not configured at all (legacy unchanged flow)', async () => {
    getAuthStatus.mockResolvedValue({
      authConfigured: false,
      username: null,
      role: null,
      activeOrgIsLocal: false,
    });
    isAuthenticated.mockReturnValue(false);

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('login-screen')).toBeNull();
  });
});
