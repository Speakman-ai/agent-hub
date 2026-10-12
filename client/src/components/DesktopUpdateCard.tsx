import { Download, ExternalLink } from 'lucide-react';
import { RELEASE_BUCKET_ROOT } from '../utils/version';

export interface DesktopUpdateInfo {
  serverVersion: string | null;
  clientVersion: string | null;
  downloadUrl: string | null;
  onDownload?: () => void;
}

/**
 * Settings → General card offering the newer desktop build. The sidebar
 * pointer leads here. Without a platform DMG (non-darwin, or no release
 * bucket) it falls back to the bucket root when one is configured.
 */
export default function DesktopUpdateCard({
  serverVersion,
  clientVersion,
  downloadUrl,
  onDownload,
}: DesktopUpdateInfo) {
  // Intel build translated by Rosetta: the preload already reports arm64, so
  // `downloadUrl` is the native DMG. Say why this update is worth taking.
  const runningUnderRosetta = Boolean(
    typeof window !== 'undefined' && window.electronAPI?.runningUnderArm64Translation,
  );

  return (
    <div
      className="bg-gray-800 rounded-xl p-4 space-y-3 border border-emerald-500/30"
      data-testid="desktop-update-card"
    >
      <div className="flex items-center gap-2">
        <Download size={16} className="text-emerald-400 shrink-0" />
        <h4 className="text-sm font-medium text-gray-300">Desktop update available</h4>
      </div>
      <p className="text-xs text-gray-400">
        You&apos;re on <span className="font-mono text-gray-200">{clientVersion || 'unknown'}</span>
        ; the latest is <span className="font-mono text-gray-200">{serverVersion}</span>. Download
        the newest build to stay in sync with the server.
      </p>
      {runningUnderRosetta && downloadUrl && (
        <p className="text-xs text-amber-200/90" data-testid="update-rosetta-hint">
          You&apos;re running the Intel build under Rosetta on an Apple Silicon Mac. This download
          is the native Apple Silicon build, which is noticeably faster.
        </p>
      )}
      {downloadUrl ? (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onDownload}
          className="inline-flex items-center gap-1.5 text-sm font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 transition-colors"
        >
          <Download size={14} />
          Download {serverVersion}
          <ExternalLink size={11} />
        </a>
      ) : (
        RELEASE_BUCKET_ROOT && (
          <p className="text-xs text-gray-500">
            Direct download isn&apos;t published for your platform yet. You can browse the releases
            at{' '}
            <a
              href={RELEASE_BUCKET_ROOT}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:underline break-all"
            >
              {RELEASE_BUCKET_ROOT}
            </a>
            .
          </p>
        )
      )}
    </div>
  );
}
