import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    startGoogleOAuth: vi.fn(),
    listGoogleDriveFiles: vi.fn(),
  },
}));

import DriveViewerPage, { DRIVE_SURFACE_SCOPES, formatSize, iconForMime } from './DriveViewerPage';
import { DRIVE_FILE_SCOPE, SHEETS_SCOPE } from '../utils/googleSurface';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DriveViewerPage helpers', () => {
  it('formats byte sizes into human-readable units', () => {
    expect(formatSize(null)).toBe('');
    expect(formatSize('0')).toBe('');
    expect(formatSize('512')).toBe('512 B');
    expect(formatSize('2048')).toBe('2 KB');
    expect(formatSize(String(5 * 1024 * 1024))).toBe('5 MB');
  });

  it('maps mimeTypes to an icon component without throwing', () => {
    expect(iconForMime('application/vnd.google-apps.folder')).toBeTruthy();
    expect(iconForMime('application/vnd.google-apps.spreadsheet')).toBeTruthy();
    expect(iconForMime('image/png')).toBeTruthy();
    expect(iconForMime(null)).toBeTruthy();
  });

  it('DRIVE_SURFACE_SCOPES requests only the non-restricted drive.file scope', () => {
    expect(DRIVE_SURFACE_SCOPES).toEqual([DRIVE_FILE_SCOPE]);
    expect(DRIVE_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(DRIVE_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
  });
});

describe('DriveViewerPage', () => {
  it('renders a connect route when Google is not linked', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: false,
      grantedScopes: [],
      serverConfigured: true,
    });

    render(<DriveViewerPage />);

    expect(await screen.findByText('Connect Google to use Drive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
    expect(mockApi.listGoogleDriveFiles).not.toHaveBeenCalled();
  });

  it('shows an inline Enable Drive affordance when connected but missing the drive.file scope', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [SHEETS_SCOPE],
      serverConfigured: true,
    });

    render(<DriveViewerPage />);

    expect(await screen.findByText('Enable Drive access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enable Drive/i })).toBeInTheDocument();
    // No file listing without the drive.file scope.
    expect(mockApi.listGoogleDriveFiles).not.toHaveBeenCalled();
  });

  it('requests exactly the drive.file surface scope when enabling consent', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [],
      serverConfigured: true,
    });
    mockApi.startGoogleOAuth.mockResolvedValueOnce({ authorizeUrl: 'https://accounts.google/x' });

    render(<DriveViewerPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Enable Drive/i }));

    await waitFor(() => {
      expect(mockApi.startGoogleOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: DRIVE_SURFACE_SCOPES }),
      );
    });
    expect(DRIVE_SURFACE_SCOPES).toEqual([DRIVE_FILE_SCOPE]);
  });

  it('lists app Drive files when the drive.file scope is granted', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [DRIVE_FILE_SCOPE],
      serverConfigured: true,
    });
    mockApi.listGoogleDriveFiles.mockResolvedValueOnce({
      files: [
        {
          id: 'file-1',
          name: 'Quarterly Plan',
          mimeType: 'application/pdf',
          iconLink: null,
          webViewLink: 'https://drive.google.com/file/d/file-1/view',
          modifiedTime: '2026-06-01T00:00:00Z',
          createdTime: null,
          size: '2048',
          owners: null,
          trashed: false,
        },
      ],
    });

    render(<DriveViewerPage />);

    const fileRow = await screen.findByTestId('drive-file-file-1');
    expect(fileRow).toBeInTheDocument();
    expect(screen.getByText('Quarterly Plan')).toBeInTheDocument();
    // The file links out to Google Drive (read-only v1).
    expect(fileRow).toHaveAttribute('href', 'https://drive.google.com/file/d/file-1/view');
    // The proxy is queried for non-trashed files only.
    expect(mockApi.listGoogleDriveFiles).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'trashed = false' }),
    );
  });

  it('clears a prior listing error when a later refresh succeeds', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [DRIVE_FILE_SCOPE],
      serverConfigured: true,
    });
    // First (initial) listing fails, leaving an error banner.
    mockApi.listGoogleDriveFiles.mockRejectedValueOnce(new Error('Failed to list Drive files'));
    // The Refresh retry succeeds and must clear the stale banner.
    mockApi.listGoogleDriveFiles.mockResolvedValueOnce({
      files: [
        {
          id: 'file-1',
          name: 'Recovered Doc',
          mimeType: 'application/pdf',
          iconLink: null,
          webViewLink: null,
          modifiedTime: null,
          createdTime: null,
          size: null,
          owners: null,
          trashed: false,
        },
      ],
    });

    render(<DriveViewerPage />);

    // The initial failure surfaces an error banner.
    expect(await screen.findByText('Failed to list Drive files')).toBeInTheDocument();

    // Retry via the Refresh button; the recovered list replaces the banner.
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));

    expect(await screen.findByText('Recovered Doc')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Failed to list Drive files')).not.toBeInTheDocument();
    });
  });
});
