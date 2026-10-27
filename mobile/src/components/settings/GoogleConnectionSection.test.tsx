import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Linking: { openURL: vi.fn() },
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('../../utils/api', () => ({ api: {} }));

import {
  ALL_SURFACE_SCOPES,
  GOOGLE_SURFACES,
  GoogleConnectionContent,
  openGoogleOAuth,
  scopeLabel,
} from './GoogleConnectionSection';

// Route↔consent contract (mobile parity): the /api/google/* proxy routes gate
// on specific scopes; the mobile consent surface must keep offering them, or
// connected users can never satisfy the gate. Pins the exact scope strings the
// server Sheets/Drive routes require so the wiring can't drift.
describe('GOOGLE_SURFACES consent ↔ proxy-route scope contract', () => {
  const surfaceScopes = (key: string) => GOOGLE_SURFACES.find((s) => s.key === key)?.scopes ?? [];

  it('offers the spreadsheets scope the Sheets proxy routes require', () => {
    expect(surfaceScopes('sheets')).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(ALL_SURFACE_SCOPES).toContain('https://www.googleapis.com/auth/spreadsheets');
  });

  it('offers drive.file (and NOT a restricted Drive scope) for Drive / Docs access', () => {
    expect(surfaceScopes('drive')).toContain('https://www.googleapis.com/auth/drive.file');
    expect(ALL_SURFACE_SCOPES).toContain('https://www.googleapis.com/auth/drive.file');
    expect(ALL_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(ALL_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
  });
});

describe('GoogleConnectionSection mobile rendering', () => {
  const noop = () => undefined;
  const handlers = {
    onConnect: noop,
    onAddAccount: noop,
    onEnableSurface: noop,
    onMakeDefault: noop,
    onDisconnect: noop,
  };

  it('renders a single connected account with per-surface enable buttons', () => {
    const html = renderToStaticMarkup(
      <GoogleConnectionContent
        loading={false}
        busy={false}
        error={null}
        {...handlers}
        status={{
          connected: true,
          email: 'person@example.com',
          grantedScopes: [
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
            'https://www.googleapis.com/auth/gmail.modify',
          ],
          connectedAt: '2026-06-30T17:00:00.000Z',
          tokenExpiresAt: '2026-06-30T18:00:00.000Z',
          serverConfigured: true,
        }}
      />,
    );

    expect(html).toContain('Google Account');
    expect(html).toContain('Connected as');
    expect(html).toContain('person@example.com');
    expect(html).toContain('calendar.events');
    expect(html).toContain('gmail.modify');
    // Calendar already granted; Gmail only half-granted (no send) so still offered.
    expect(html).not.toContain('Enable Calendar for person@example.com');
    expect(html).toContain('Enable Gmail (send + modify) for person@example.com');
    expect(html).toContain('Add another account');
    expect(html).toContain('Disconnect');
    expect(html).not.toContain('Make default');
  });

  it('lists every account with default badge, Make default, and per-account disconnect', () => {
    const html = renderToStaticMarkup(
      <GoogleConnectionContent
        loading={false}
        busy={false}
        error={null}
        {...handlers}
        status={{
          connected: true,
          email: 'work@example.com',
          grantedScopes: ['openid'],
          connectedAt: null,
          tokenExpiresAt: null,
          serverConfigured: true,
          defaultAccountId: 'acc-work',
          accounts: [
            {
              accountId: 'acc-work',
              email: 'work@example.com',
              grantedScopes: ['openid'],
              isDefault: true,
              connectedAt: null,
            },
            {
              accountId: 'acc-home',
              email: 'home@example.com',
              grantedScopes: ['https://www.googleapis.com/auth/spreadsheets'],
              isDefault: false,
              connectedAt: null,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('Google Accounts');
    expect(html).toContain('2 connected');
    expect(html).toContain('Default');
    expect(html).toContain('Make home@example.com the default');
    expect(html).not.toContain('Make work@example.com the default');
    expect(html).toContain('Disconnect work@example.com');
    expect(html).toContain('Disconnect home@example.com');
    expect(html).toContain('Enable Sheets for work@example.com');
    expect(html).not.toContain('Enable Sheets for home@example.com');
  });

  it('passes add intent and account id through to the start endpoint', async () => {
    const apiClient = {
      startGoogleOAuth: vi.fn().mockResolvedValue({ authorizeUrl: 'https://g/x' }),
    };
    const openURL = vi.fn().mockResolvedValue(true);
    await openGoogleOAuth({ apiClient, openURL, intent: 'add' });
    expect(apiClient.startGoogleOAuth).toHaveBeenLastCalledWith({
      returnTo: '/settings?tab=account',
      intent: 'add',
    });
    await openGoogleOAuth({ apiClient, openURL, scopes: ['s1'], accountId: 'acc-home' });
    expect(apiClient.startGoogleOAuth).toHaveBeenLastCalledWith({
      returnTo: '/settings?tab=account',
      scopes: ['s1'],
      accountId: 'acc-home',
    });
  });

  it('opens the server-generated OAuth URL with the account return path', async () => {
    const apiClient = {
      startGoogleOAuth: vi.fn().mockResolvedValue({
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      }),
    };
    const openURL = vi.fn().mockResolvedValue(true);

    await expect(openGoogleOAuth({ apiClient, openURL, scopes: ALL_SURFACE_SCOPES })).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
    );

    expect(apiClient.startGoogleOAuth).toHaveBeenCalledWith({
      returnTo: '/settings?tab=account',
      scopes: ALL_SURFACE_SCOPES,
    });
    expect(openURL).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=abc');
  });

  it('shortens Google OAuth scope URLs for native chips', () => {
    expect(scopeLabel('https://www.googleapis.com/auth/drive.file')).toBe('drive.file');
  });
});
