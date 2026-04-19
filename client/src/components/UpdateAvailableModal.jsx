import { useEffect } from 'react';
import { Download, X } from 'lucide-react';

/**
 * Modal shown on startup when the Electron desktop app detects that the
 * server it's connected to is running a newer version than this client
 * bundle. Dismissible; one-per-session via `useVersionCheck`'s sessionStorage
 * bookkeeping.
 *
 * When `downloadUrl` is null (non-darwin Electron builds — which we don't
 * publish to S3 today) we still render the modal so the user isn't left in
 * the dark, but we swap the Download button for a plain pointer at the
 * release bucket root.
 */
const RELEASE_BUCKET_ROOT = 'https://agent-hub-prod-releases.s3.us-east-2.amazonaws.com/';

export default function UpdateAvailableModal({
  serverVersion,
  clientVersion,
  downloadUrl,
  onDismiss,
}) {
  // Close on Escape, matching ShortcutsHelpModal.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh] bg-black/60"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Download size={18} className="text-emerald-400" />
            <h2 id="update-modal-title" className="text-sm font-semibold text-gray-200">
              Update available
            </h2>
          </div>
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 text-sm text-gray-300 space-y-3">
          <p>A newer version of Agent Hub is available.</p>
          <p className="text-gray-400">
            You&apos;re on{' '}
            <span className="font-mono text-gray-200">{clientVersion || 'unknown'}</span>; the
            latest is <span className="font-mono text-gray-200">{serverVersion}</span>. Download the
            newest build to stay in sync with the server.
          </p>
          {!downloadUrl && (
            <p className="text-xs text-gray-500">
              Direct download isn&apos;t published for your platform yet. You can browse the
              releases at{' '}
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
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-gray-950/50 border-t border-gray-800">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-sm text-gray-300 hover:text-white transition-colors"
          >
            Not now
          </button>
          {downloadUrl && (
            <a
              href={downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onDismiss}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center gap-1.5 transition-colors"
            >
              <Download size={14} />
              Download
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
