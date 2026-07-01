import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Plain `vi.mock(...)` so vitest's hoisting transform lifts it above the static
// import below.
vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    startGoogleOAuth: vi.fn(),
    disconnectGoogle: vi.fn(),
  },
}));

import GoogleConnectionSection, {
  ALL_SURFACE_SCOPES,
  GOOGLE_SURFACES,
  scopeLabel,
} from './GoogleConnectionSection';
import { api } from '../utils/api';

const mockApi = api as unknown as {
  getGoogleStatus: ReturnType<typeof vi.fn>;
  startGoogleOAuth: ReturnType<typeof vi.fn>;
  disconnectGoogle: ReturnType<typeof vi.fn>;
};

function mockWindowLocation(pathname = '/settings', search = '', hash = '') {
  const original = window.location;
  const hrefSetter = vi.fn();

  delete (window as any).location;
  (window as any).location = {
    pathname,
    search,
    hash,
    set href(v: string) {
      hrefSetter(v);
    },
    get href() {
      return '';
    },
  };

  return {
    hrefSetter,
    restore: () => {
      (window as any).location = original;
    },
  };
}

beforeEach(() => {
  mockApi.getGoogleStatus.mockReset();
  mockApi.startGoogleOAuth.mockReset();
  mockApi.disconnectGoogle.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scopeLabel', () => {
  it('strips the googleapis auth prefix', () => {
    expect(scopeLabel('https://www.googleapis.com/auth/calendar.events')).toBe('calendar.events');
    expect(scopeLabel('openid')).toBe('openid');
  });
});

// Route↔consent contract: the /api/google/* proxy routes gate on specific
// scopes; if the consent surface stops offering them, normally-connected users
// can never satisfy the gate and every call 403s. These assertions pin the
// exact scope strings the server routes require (server/routes/google-sheets.ts
// SHEETS_SCOPE and google-drive.ts DRIVE_FILE_SCOPE) so the wiring can't drift.
describe('GOOGLE_SURFACES consent ↔ proxy-route scope contract', () => {
  const surfaceScopes = (key: string) => GOOGLE_SURFACES.find((s) => s.key === key)?.scopes ?? [];

  it('offers the spreadsheets scope the Sheets proxy routes require', () => {
    const scopes = surfaceScopes('sheets');
    expect(scopes).toContain('https://www.googleapis.com/auth/spreadsheets');
    // The upgrade button requests the union, so the scope must be in it too.
    expect(ALL_SURFACE_SCOPES).toContain('https://www.googleapis.com/auth/spreadsheets');
  });

  it('offers drive.file (and NOT a restricted Drive scope) for Drive / Docs access', () => {
    const scopes = surfaceScopes('drive');
    expect(scopes).toContain('https://www.googleapis.com/auth/drive.file');
    expect(ALL_SURFACE_SCOPES).toContain('https://www.googleapis.com/auth/drive.file');
    // v1 must never request the restricted Drive scopes (CASA avoidance).
    expect(ALL_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(ALL_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
  });
});

describe('GoogleConnectionSection', () => {
  it('renders the connect button when not connected and the server is configured', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: false,
      email: null,
      grantedScopes: [],
      serverConfigured: true,
    });

    render(<GoogleConnectionSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
    });
    expect(mockApi.getGoogleStatus).toHaveBeenCalled();
  });

  it('renders the connected state with email and granted scopes', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'user@example.com',
      grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
      connectedAt: '2026-06-01T00:00:00.000Z',
      serverConfigured: true,
    });

    render(<GoogleConnectionSection />);

    await waitFor(() => {
      expect(screen.getByText('user@example.com')).toBeInTheDocument();
    });
    expect(screen.getByText('calendar.events')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Re-consent \/ upgrade access/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument();
    // No connect button while connected.
    expect(screen.queryByRole('button', { name: /^Connect Google/i })).not.toBeInTheDocument();
  });

  it('degrades to a "not configured" message and hides connect when no OAuth client is set', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: false,
      email: null,
      grantedScopes: [],
      serverConfigured: false,
    });

    render(<GoogleConnectionSection />);

    await waitFor(() => {
      expect(screen.getByText(/Google is not configured on this server/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Connect Google/i })).not.toBeInTheDocument();
  });

  it('redirects to the authorize URL on connect', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: false,
      email: null,
      grantedScopes: [],
      serverConfigured: true,
    });
    mockApi.startGoogleOAuth.mockResolvedValueOnce({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    });

    const locationMock = mockWindowLocation();

    render(<GoogleConnectionSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Connect Google/i }));

    await waitFor(() => {
      expect(locationMock.hrefSetter).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      );
    });
    expect(mockApi.startGoogleOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: '/settings' }),
    );

    locationMock.restore();
  });

  it('requests every surface scope when upgrading access', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'user@example.com',
      grantedScopes: ['openid', 'email'],
      connectedAt: '2026-06-01T00:00:00.000Z',
      serverConfigured: true,
    });
    mockApi.startGoogleOAuth.mockResolvedValueOnce({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?upgrade=1',
    });
    const locationMock = mockWindowLocation('/settings', '?tab=account', '#google');

    render(<GoogleConnectionSection />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Re-consent \/ upgrade access/i }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Re-consent \/ upgrade access/i }));

    await waitFor(() => {
      expect(mockApi.startGoogleOAuth).toHaveBeenCalledWith({
        returnTo: '/settings?tab=account#google',
        scopes: ALL_SURFACE_SCOPES,
      });
    });
    expect(locationMock.hrefSetter).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?upgrade=1',
    );

    locationMock.restore();
  });

  it('disconnects and refetches status when confirmed', async () => {
    mockApi.getGoogleStatus
      .mockResolvedValueOnce({
        connected: true,
        email: 'user@example.com',
        grantedScopes: ['openid'],
        connectedAt: '2026-06-01T00:00:00.000Z',
        serverConfigured: true,
      })
      .mockResolvedValueOnce({
        connected: false,
        email: null,
        grantedScopes: [],
        connectedAt: null,
        serverConfigured: true,
      });
    mockApi.disconnectGoogle.mockResolvedValueOnce(undefined);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    render(<GoogleConnectionSection />);
    await waitFor(() => {
      expect(screen.getByText('user@example.com')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/i }));

    await waitFor(() => {
      expect(mockApi.disconnectGoogle).toHaveBeenCalledTimes(1);
      expect(mockApi.getGoogleStatus).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
  });

  it('refetches status on window focus', async () => {
    mockApi.getGoogleStatus
      .mockResolvedValueOnce({ connected: false, grantedScopes: [], serverConfigured: true })
      .mockResolvedValueOnce({
        connected: true,
        email: 'late@example.com',
        grantedScopes: [],
        serverConfigured: true,
      });

    render(<GoogleConnectionSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
    });

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      expect(screen.getByText('late@example.com')).toBeInTheDocument();
    });
    expect(mockApi.getGoogleStatus).toHaveBeenCalledTimes(2);
  });
});
