import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/auth.js', () => ({
  getAuthStatus: vi.fn(),
  getAuthRecord: vi.fn(),
  isAuthenticated: vi.fn(),
  needsEmailUpdate: vi.fn(),
  updateEmail: vi.fn(),
  setActiveOrgIsLocal: vi.fn(),
}));

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getConnectionConfig: vi.fn(),
  saveConnectionConfig: vi.fn(),
}));

(vi as any).mock('./LoginScreen.jsx', () => ({
  default: () => <div data-testid="login-screen">login</div>,
}));

import AuthGate, { shouldShowEmailUpdatePrompt } from './AuthGate';
import {
  getAuthStatus,
  getAuthRecord,
  isAuthenticated,
  needsEmailUpdate,
  updateEmail,
} from '../utils/auth';
import { getConnectionConfig, saveConnectionConfig } from '../utils/connection';

const Child = () => <div data-testid="app-child">app</div>;

beforeEach(() => {
  (getAuthStatus as any).mockReset();
  (getAuthRecord as any).mockReset();
  (isAuthenticated as any).mockReset();
  (needsEmailUpdate as any).mockReset();
  (updateEmail as any).mockReset();
  (getConnectionConfig as any).mockReset();
  (saveConnectionConfig as any).mockReset();
  (getConnectionConfig as any).mockReturnValue({ mode: 'local', remoteUrl: '', apiKey: '' });
  (isAuthenticated as any).mockReturnValue(false);
  (getAuthRecord as any).mockReturnValue(null);
  (needsEmailUpdate as any).mockReturnValue(false);
  delete (window as any).electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).electronAPI;
});

describe('AuthGate — local mode', () => {
  it('renders children when auth is not configured', async () => {
    (getAuthStatus as any).mockResolvedValue({ authConfigured: false });
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
    (getAuthStatus as any).mockResolvedValue({ authConfigured: true });
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
    (getAuthStatus as any).mockRejectedValue(new Error('boom'));
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
    (getConnectionConfig as any).mockReturnValue({
      mode: 'remote',
      remoteUrl: 'https://hub.example.com',
      apiKey: '',
    });
  });

  it('renders RemoteUnreachableScreen when remote /auth/status fails', async () => {
    (getAuthStatus as any).mockRejectedValue(new Error('fetch failed'));
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
    (getAuthStatus as any).mockRejectedValue(new Error('timeout'));
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

    fireEvent.click(screen.getByRole('button', { name: /switch to local/i } as any) as any);

    expect(saveConnectionConfig!).toHaveBeenCalledWith({
      mode: 'local',
      remoteUrl: '',
      apiKey: '',
    });
    expect(reload!).toHaveBeenCalled();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('"Edit connection" navigates via Electron when available', async () => {
    (getAuthStatus as any).mockRejectedValue(new Error('timeout'));
    window.electronAPI = { navigateToOrg: vi.fn() };

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('remote-unreachable-screen')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /edit connection/i } as any) as any);

    expect(saveConnectionConfig!).toHaveBeenCalledWith({
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
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      username: 'owner',
      role: 'Owner',
      activeOrgIsLocal: true,
    });
    (isAuthenticated as any).mockReturnValue(false);

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

  it('still prompts authenticated local users whose token needs an email update', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      activeOrgIsLocal: true,
      needsEmailUpdate: true,
    });
    (isAuthenticated as any).mockReturnValue(true);
    (needsEmailUpdate as any).mockReturnValue(true);
    (getAuthRecord as any).mockReturnValue({
      user: { email: null, needsEmailUpdate: true, role: 'Owner' },
    });

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Set your email/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('app-child')).toBeNull();
    expect(screen.queryByTestId('login-screen')).toBeNull();
  });

  it('advances past the email prompt after a successful save even when status is still stale', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      activeOrgIsLocal: true,
      needsEmailUpdate: true,
    });
    (isAuthenticated as any).mockReturnValue(true);
    (needsEmailUpdate as any).mockReturnValue(true);
    (getAuthRecord as any).mockReturnValue({
      user: { email: null, needsEmailUpdate: true, role: 'Owner' },
    });
    (updateEmail as any).mockImplementation(async () => {
      (needsEmailUpdate as any).mockReturnValue(false);
      (getAuthRecord as any).mockReturnValue({
        token: 'fresh',
        user: { email: 'owner@example.com', needsEmailUpdate: false, role: 'Owner' },
      });
    });

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Set your email/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: 'owner@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save email/i }));

    await waitFor(() => {
      expect(screen.getByTestId('app-child')).toBeInTheDocument();
    });
    expect(updateEmail).toHaveBeenCalledWith({
      baseUrl: '/api',
      email: 'owner@example.com',
    });
  });

  it('prompts local users when server status reports a legacy auth record before a token exists', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      activeOrgIsLocal: true,
      needsEmailUpdate: true,
    });
    (isAuthenticated as any).mockReturnValue(false);
    (needsEmailUpdate as any).mockReturnValue(false);

    render(
      <AuthGate>
        <Child />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Set your email/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('app-child')).toBeNull();
    expect(screen.queryByTestId('login-screen')).toBeNull();
  });

  it('renders LoginScreen when auth is configured, org is NOT local, and no token is stored', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      username: 'owner',
      role: null,
      activeOrgIsLocal: false,
    });
    (isAuthenticated as any).mockReturnValue(false);

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
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: false,
      username: null,
      role: null,
      activeOrgIsLocal: false,
    });
    (isAuthenticated as any).mockReturnValue(false);

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

describe('shouldShowEmailUpdatePrompt', () => {
  it('does not prompt when the refreshed token explicitly cleared needsEmailUpdate', () => {
    (isAuthenticated as any).mockReturnValue(true);
    (getAuthRecord as any).mockReturnValue({
      user: { email: 'owner@example.com', needsEmailUpdate: false, role: 'Owner' },
    });
    (needsEmailUpdate as any).mockReturnValue(false);

    expect(
      shouldShowEmailUpdatePrompt({
        required: true,
        needsEmailUpdate: true,
        activeOrgIsLocal: true,
      }),
    ).toBe(false);
  });

  it('still prompts authenticated users when the token and status both require migration', () => {
    (isAuthenticated as any).mockReturnValue(true);
    (getAuthRecord as any).mockReturnValue({
      user: { email: null, needsEmailUpdate: true, role: 'Owner' },
    });
    (needsEmailUpdate as any).mockReturnValue(true);

    expect(
      shouldShowEmailUpdatePrompt({
        required: true,
        needsEmailUpdate: true,
        activeOrgIsLocal: true,
      }),
    ).toBe(true);
  });

  it('does not prompt when auth.json is migrated but the cached JWT is stale', () => {
    (isAuthenticated as any).mockReturnValue(true);
    (getAuthRecord as any).mockReturnValue({
      user: { email: null, needsEmailUpdate: true, role: 'Owner' },
    });
    (needsEmailUpdate as any).mockReturnValue(true);

    expect(
      shouldShowEmailUpdatePrompt({
        required: true,
        needsEmailUpdate: false,
        activeOrgIsLocal: true,
      }),
    ).toBe(false);
  });
});
