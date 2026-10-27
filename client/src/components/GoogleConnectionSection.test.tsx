import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Plain `vi.mock(...)` so vitest's hoisting transform lifts it above the static
// import below.
vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    startGoogleOAuth: vi.fn(),
    disconnectGoogle: vi.fn(),
    disconnectGoogleAccount: vi.fn(),
    setDefaultGoogleAccount: vi.fn(),
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
  disconnectGoogleAccount: ReturnType<typeof vi.fn>;
  setDefaultGoogleAccount: ReturnType<typeof vi.fn>;
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
  mockApi.disconnectGoogleAccount.mockReset();
  mockApi.setDefaultGoogleAccount.mockReset();
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

  it('still offers Enable Calendar when only calendar.events was granted', async () => {
    // Without the calendar-list scope only the primary calendar shows, so the
    // surface is not fully enabled and the button asks for the missing scope.
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'user@example.com',
      grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
      connectedAt: '2026-06-01T00:00:00.000Z',
      serverConfigured: true,
    });

    render(<GoogleConnectionSection />);

    expect(await screen.findByRole('button', { name: /Enable Calendar/i })).toBeInTheDocument();
  });

  it('renders the connected state with email and granted scopes', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'user@example.com',
      grantedScopes: [
        'openid',
        'email',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      ],
      connectedAt: '2026-06-01T00:00:00.000Z',
      serverConfigured: true,
    });

    render(<GoogleConnectionSection />);

    await waitFor(() => {
      expect(screen.getByText('user@example.com')).toBeInTheDocument();
    });
    expect(screen.getByText('calendar.events')).toBeInTheDocument();
    // Calendar is granted, so only the other surfaces get an enable button.
    expect(screen.queryByRole('button', { name: /Enable Calendar/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enable Sheets/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add another account/i })).toBeInTheDocument();
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

  const MULTI = {
    connected: true,
    email: 'work@example.com',
    grantedScopes: ['openid'],
    connectedAt: '2026-06-01T00:00:00.000Z',
    tokenExpiresAt: null,
    serverConfigured: true,
    defaultAccountId: 'acc-work',
    accounts: [
      {
        accountId: 'acc-work',
        email: 'work@example.com',
        grantedScopes: ['openid'],
        isDefault: true,
        connectedAt: '2026-06-01T00:00:00.000Z',
      },
      {
        accountId: 'acc-home',
        email: 'home@example.com',
        grantedScopes: [
          'openid',
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        ],
        isDefault: false,
        connectedAt: '2026-06-02T00:00:00.000Z',
      },
    ],
  };

  it('lists every linked account with its own scopes and a default badge', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce(MULTI);
    render(<GoogleConnectionSection />);
    await waitFor(() => {
      expect(screen.getAllByTestId('google-account-row')).toHaveLength(2);
    });
    expect(screen.getByText('work@example.com')).toBeInTheDocument();
    expect(screen.getByText('home@example.com')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    // Only the non-default account offers Make default.
    expect(
      screen.getByRole('button', { name: 'Make home@example.com the default' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Make work@example.com the default' }),
    ).not.toBeInTheDocument();
    // Per-account incremental buttons: home already has Calendar, work doesn't.
    expect(
      screen.getByRole('button', { name: 'Enable Calendar for work@example.com' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enable Calendar for home@example.com' }),
    ).not.toBeInTheDocument();
  });

  it('starts add-account OAuth with intent=add', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce(MULTI);
    mockApi.startGoogleOAuth.mockResolvedValueOnce({ authorizeUrl: 'https://g/add' });
    const locationMock = mockWindowLocation('/settings');
    render(<GoogleConnectionSection />);
    await waitFor(() => screen.getByRole('button', { name: /Add another account/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add another account/i }));
    await waitFor(() => expect(locationMock.hrefSetter).toHaveBeenCalledWith('https://g/add'));
    expect(mockApi.startGoogleOAuth).toHaveBeenCalledWith({ returnTo: '/settings', intent: 'add' });
    locationMock.restore();
  });

  it('requests one surface for one account', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce(MULTI);
    mockApi.startGoogleOAuth.mockResolvedValueOnce({ authorizeUrl: 'https://g/sheets' });
    const locationMock = mockWindowLocation('/settings', '?tab=account', '#google');
    render(<GoogleConnectionSection />);
    const btn = await screen.findByRole('button', { name: 'Enable Sheets for home@example.com' });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockApi.startGoogleOAuth).toHaveBeenCalledWith({
        returnTo: '/settings?tab=account#google',
        scopes: GOOGLE_SURFACES.find((s) => s.key === 'sheets')!.scopes,
        accountId: 'acc-home',
      });
    });
    locationMock.restore();
  });

  it('makes an account the default and refetches', async () => {
    mockApi.getGoogleStatus.mockResolvedValue(MULTI);
    mockApi.setDefaultGoogleAccount.mockResolvedValueOnce({ ok: true });
    render(<GoogleConnectionSection />);
    const btn = await screen.findByRole('button', { name: 'Make home@example.com the default' });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockApi.setDefaultGoogleAccount).toHaveBeenCalledWith('acc-home');
      expect(mockApi.getGoogleStatus).toHaveBeenCalledTimes(2);
    });
  });

  it('disconnects only the chosen account', async () => {
    mockApi.getGoogleStatus.mockResolvedValue(MULTI);
    mockApi.disconnectGoogleAccount.mockResolvedValueOnce({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    render(<GoogleConnectionSection />);
    const btn = await screen.findByRole('button', { name: 'Disconnect home@example.com' });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockApi.disconnectGoogleAccount).toHaveBeenCalledWith('acc-home');
    });
    expect(mockApi.disconnectGoogle).not.toHaveBeenCalled();
  });
});
