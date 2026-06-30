import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ExternalLink,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Presentation,
  RefreshCw,
} from 'lucide-react';
import { api } from '../utils/api';
import {
  DRIVE_SURFACE_SCOPES,
  hasDriveFileScope,
  type GoogleStatusLike,
} from '../utils/googleSurface';

export { DRIVE_SURFACE_SCOPES };

type GoogleStatus = NonNullable<GoogleStatusLike>;

type DriveFile = {
  id: string | null;
  name: string | null;
  mimeType: string | null;
  iconLink: string | null;
  webViewLink: string | null;
  modifiedTime: string | null;
  createdTime: string | null;
  size: string | null;
  owners: { displayName: string | null; emailAddress: string | null }[] | null;
  trashed: boolean | null;
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Pick a lucide icon for a Drive mimeType so the list reads at a glance. */
export function iconForMime(mimeType: string | null) {
  const m = mimeType || '';
  if (m === FOLDER_MIME) return Folder;
  if (m === 'application/vnd.google-apps.spreadsheet' || m.includes('spreadsheet'))
    return FileSpreadsheet;
  if (m === 'application/vnd.google-apps.presentation' || m.includes('presentation'))
    return Presentation;
  if (
    m === 'application/vnd.google-apps.document' ||
    m === 'application/pdf' ||
    m.startsWith('text/')
  )
    return FileText;
  if (m.startsWith('image/')) return ImageIcon;
  return FileIcon;
}

function formatDriveTime(value: string | null) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

/** Human-readable byte size for the Drive `size` string (bytes, may be null). */
export function formatSize(size: string | null): string {
  if (!size) return '';
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  const rounded = u > 0 && n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return `${rounded} ${units[u]}`;
}

/**
 * DriveViewerPage — the global, per-user Google Drive surface.
 *
 * Lives in the Dashboard navigation tier (NOT per-project) and is connection-
 * gated upstream: the nav entry only renders when `/api/auth/google/status`
 * reports connected=true. v1 lists app-accessible files only via the NON-
 * restricted `drive.file` scope (files the Hub created or the user opened with
 * it) — never `drive.readonly` or full `drive`. When connected but missing the
 * drive.file scope, the pane shows an inline "Enable Drive" affordance for
 * incremental consent. Files open in Google Drive in a new tab (read-only v1).
 */
export default function DriveViewerPage({
  onOpenAccountSettings,
}: {
  onOpenAccountSettings?: () => void;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  const [files, setFiles] = useState<DriveFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const driveEnabled = hasDriveFileScope(status);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    // Clear any prior listing error so a successful retry never leaves a stale
    // failure banner alongside the freshly loaded files.
    setError(null);
    try {
      const body = await api.listGoogleDriveFiles({
        q: 'trashed = false',
        orderBy: 'modifiedTime desc',
        pageSize: 50,
      });
      setFiles(body.files || []);
    } catch (err: any) {
      setError(err.message || 'Failed to list Drive files');
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextStatus = await api.getGoogleStatus();
      setStatus(nextStatus);
      if (nextStatus.connected && hasDriveFileScope(nextStatus)) {
        await loadFiles();
      } else {
        setFiles([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load Drive');
    } finally {
      setLoading(false);
    }
  }, [loadFiles]);

  useEffect(() => {
    load();
  }, [load]);

  const startOAuth = async () => {
    setOauthBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const body = await api.startGoogleOAuth({ returnTo, scopes: DRIVE_SURFACE_SCOPES });
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err.message || 'Failed to start Google consent');
      setOauthBusy(false);
    }
  };

  let emptyState: {
    title: string;
    body: string;
    action: string | null;
    onAction?: () => void;
  } | null = null;
  if (!configured && !connected) {
    emptyState = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Drive can connect.',
      action: onOpenAccountSettings ? 'Open Account settings' : null,
      onAction: onOpenAccountSettings,
    };
  } else if (!connected) {
    emptyState = {
      title: 'Connect Google to use Drive',
      body: 'Files stay server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: startOAuth,
    };
  } else if (!driveEnabled) {
    emptyState = {
      title: 'Enable Drive access',
      body: `Connected as ${status?.email || 'Google account'}, but Drive access has not been granted yet. Drive only ever lists files created or opened with the Hub (drive.file), never your full Drive.`,
      action: 'Enable Drive',
      onAction: startOAuth,
    };
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950 p-4 md:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-blue-300">
              <HardDrive size={14} />
              Drive
            </div>
            <h2 className="mt-1 text-2xl font-semibold text-white">Drive</h2>
            <p className="mt-1 text-sm text-gray-400">
              App files in your Google Drive, listed through the Google proxy (drive.file).
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {connected && driveEnabled && (
              <button
                type="button"
                onClick={loadFiles}
                disabled={filesLoading}
                className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
              >
                <RefreshCw size={14} className={filesLoading ? 'animate-spin' : ''} />
                Refresh
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin" />
            Loading Drive...
          </div>
        ) : emptyState ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
            <h3 className="text-lg font-semibold text-white">{emptyState.title}</h3>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">{emptyState.body}</p>
            {emptyState.action && (
              <button
                type="button"
                onClick={emptyState.onAction}
                disabled={oauthBusy}
                className="mt-4 inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {oauthBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ExternalLink size={14} />
                )}
                {emptyState.action}
              </button>
            )}
          </div>
        ) : filesLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin" />
            Loading files...
          </div>
        ) : files.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-sm text-gray-400">
            No files found. Drive only lists files created or opened with the Hub (drive.file).
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
            {files.map((file) => {
              const Icon = iconForMime(file.mimeType);
              const meta = [formatSize(file.size), formatDriveTime(file.modifiedTime)]
                .filter(Boolean)
                .join(' · ');
              const inner = (
                <>
                  <Icon size={16} className="flex-shrink-0 text-blue-300" />
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
                    {file.name || '(untitled)'}
                  </span>
                  {meta && <span className="flex-shrink-0 text-xs text-gray-500">{meta}</span>}
                  {file.webViewLink && (
                    <ExternalLink size={13} className="flex-shrink-0 text-gray-500" />
                  )}
                </>
              );
              return file.webViewLink ? (
                <a
                  key={file.id || file.name}
                  href={file.webViewLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`drive-file-${file.id}`}
                  className="flex w-full items-center gap-3 border-b border-gray-800 p-4 text-left last:border-b-0 hover:bg-gray-800/50"
                >
                  {inner}
                </a>
              ) : (
                <div
                  key={file.id || file.name}
                  data-testid={`drive-file-${file.id}`}
                  className="flex w-full items-center gap-3 border-b border-gray-800 p-4 text-left last:border-b-0"
                >
                  {inner}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
