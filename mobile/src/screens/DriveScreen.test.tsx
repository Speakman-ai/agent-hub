import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem }: any) => (
    <div>{(data || []).map((item: any, index: number) => renderItem({ item, index }))}</div>
  ),
  Linking: { openURL: vi.fn() },
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../utils/api', () => ({ api: {} }));

import {
  DriveContent,
  DRIVE_SURFACE_SCOPES,
  driveReturnTo,
  formatSize,
  openDriveOAuth,
} from './DriveScreen';
import { DRIVE_FILE_SCOPE, SHEETS_SCOPE } from '../utils/googleSurface';

const noop = () => undefined;

const baseProps = {
  loading: false,
  error: null,
  files: [],
  filesLoading: false,
  onOpenFile: noop,
  onRefreshFiles: noop,
  onConnect: noop,
  onOpenSettings: noop,
};

describe('DriveScreen helpers', () => {
  it('formats byte sizes into human-readable units', () => {
    expect(formatSize(null)).toBe('');
    expect(formatSize('512')).toBe('512 B');
    expect(formatSize('2048')).toBe('2 KB');
  });

  it('DRIVE_SURFACE_SCOPES requests only the non-restricted drive.file scope', () => {
    expect(DRIVE_SURFACE_SCOPES).toEqual([DRIVE_FILE_SCOPE]);
    expect(DRIVE_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(DRIVE_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
  });
});

describe('DriveScreen mobile parity', () => {
  it('renders the not-linked route to connect Google', () => {
    const html = renderToStaticMarkup(
      <DriveContent
        {...baseProps}
        status={{ connected: false, grantedScopes: [], serverConfigured: true }}
      />,
    );
    expect(html).toContain('Connect Google to use Drive');
    expect(html).toContain('Connect Google');
  });

  it('renders the inline Enable Drive affordance when connected but missing consent', () => {
    const html = renderToStaticMarkup(
      <DriveContent
        {...baseProps}
        status={{
          connected: true,
          email: 'person@example.com',
          grantedScopes: [SHEETS_SCOPE],
          serverConfigured: true,
        }}
      />,
    );
    expect(html).toContain('Enable Drive access');
    expect(html).toContain('Enable Drive');
  });

  it('renders the file list when connected with the drive.file scope', () => {
    const html = renderToStaticMarkup(
      <DriveContent
        {...baseProps}
        status={{
          connected: true,
          grantedScopes: [DRIVE_FILE_SCOPE],
          serverConfigured: true,
        }}
        files={[{ id: 'file-1', name: 'Quarterly Plan', size: '2048' }]}
      />,
    );
    expect(html).toContain('Quarterly Plan');
    expect(html).toContain('drive-file-file-1');
  });

  it('shows the listing error only while it is set, and a recovered list with no banner', () => {
    const connected = {
      connected: true,
      grantedScopes: [DRIVE_FILE_SCOPE],
      serverConfigured: true,
    };
    // A failed refresh surfaces the error banner.
    const failed = renderToStaticMarkup(
      <DriveContent {...baseProps} status={connected} error="Failed to list Drive files" />,
    );
    expect(failed).toContain('Failed to list Drive files');

    // After a successful retry the container clears `error`, so the recovered
    // list renders without any stale failure text. (The container's loadFiles
    // resets error at the start of every retry — see DriveScreen.)
    const recovered = renderToStaticMarkup(
      <DriveContent
        {...baseProps}
        status={connected}
        error={null}
        files={[{ id: 'file-1', name: 'Recovered Doc' }]}
      />,
    );
    expect(recovered).toContain('Recovered Doc');
    expect(recovered).not.toContain('Failed to list Drive files');
  });

  it('starts OAuth with the GLOBAL drive hash route and the drive.file scope', async () => {
    const apiClient = {
      startGoogleOAuth: vi.fn().mockResolvedValue({
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      }),
    };
    const openURL = vi.fn().mockResolvedValue(true);

    await expect(openDriveOAuth({ apiClient, openURL })).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
    );

    expect(apiClient.startGoogleOAuth).toHaveBeenCalledWith({
      returnTo: '/#/drive',
      scopes: DRIVE_SURFACE_SCOPES,
    });
    expect(driveReturnTo()).toBe('/#/drive');
    expect(openURL).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=abc');
  });
});
