import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api.js';
import { getServerBase } from '../utils/connection.js';
import { relativeTime } from '../utils/time.js';
import {
  X,
  ExternalLink,
  Image,
  Video,
  Camera,
  Loader2,
  GitMerge,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Monitor,
  Film,
  FileText,
  GitPullRequest,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

const TABS = [
  { id: 'preview', label: 'Live Preview', icon: Monitor },
  { id: 'screenshots', label: 'Screenshots', icon: Image },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'actions', label: 'PR Actions', icon: GitPullRequest },
];

// ─── Screenshot Lightbox ─────────────────────────────────────────

function ScreenshotLightbox({ screenshots, initialIndex, uploadsPrefix, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const current = screenshots[index];

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1);
      if (e.key === 'ArrowRight' && index < screenshots.length - 1) setIndex(index + 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [index, screenshots.length, onClose]);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div className="relative max-w-6xl w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white font-medium text-sm">
            {current.label}{' '}
            <span className="text-gray-500">
              ({index + 1}/{screenshots.length})
            </span>
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <X size={18} />
          </button>
        </div>
        <img
          src={`${uploadsPrefix}${current.file_path}`}
          alt={current.label}
          className="w-full rounded-lg border border-gray-700 shadow-2xl"
        />
        {/* Navigation arrows */}
        {index > 0 && (
          <button
            onClick={() => setIndex(index - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/60 hover:bg-black/80 text-white p-2 rounded-full transition-colors"
          >
            <ChevronLeft size={24} />
          </button>
        )}
        {index < screenshots.length - 1 && (
          <button
            onClick={() => setIndex(index + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/60 hover:bg-black/80 text-white p-2 rounded-full transition-colors"
          >
            <ChevronRight size={24} />
          </button>
        )}
        {/* Thumbnail strip */}
        {screenshots.length > 1 && (
          <div className="flex gap-2 mt-3 justify-center">
            {screenshots.map((ss, i) => (
              <button
                key={ss.id}
                onClick={() => setIndex(i)}
                className={`rounded-md overflow-hidden border-2 transition-all ${
                  i === index
                    ? 'border-blue-500 opacity-100'
                    : 'border-transparent opacity-50 hover:opacity-80'
                }`}
              >
                <img
                  src={`${uploadsPrefix}${ss.file_path}`}
                  alt={ss.label}
                  className="w-16 h-10 object-cover object-top"
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Live Preview Tab ────────────────────────────────────────────

function LivePreviewTab({ preview }) {
  const [iframeError, setIframeError] = useState(false);

  if (!preview.url || preview.status !== 'running') {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <Monitor size={48} className="mb-4 text-gray-600" />
        <p className="text-lg font-medium text-gray-400">Preview not available</p>
        <p className="text-sm mt-1">
          {preview.status === 'building'
            ? 'Container is still building...'
            : preview.status === 'stopped'
              ? 'Container has stopped'
              : 'No preview URL available'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Monitor size={14} />
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline"
          >
            {preview.url}
          </a>
          <ExternalLink size={12} className="text-gray-500" />
        </div>
        <button
          onClick={() => setIframeError(false)}
          className="text-gray-500 hover:text-gray-300 p-1 rounded transition-colors"
          title="Reload preview"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {iframeError ? (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6 text-center">
          <AlertTriangle size={32} className="mx-auto text-yellow-400 mb-3" />
          <p className="text-yellow-400 font-medium">Could not load preview in iframe</p>
          <p className="text-gray-500 text-sm mt-1">
            The preview may have CORS restrictions or require authentication.
          </p>
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 mt-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <ExternalLink size={14} />
            Open in New Tab
          </a>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-gray-700 bg-gray-950">
          <iframe
            src={preview.url}
            title={`Preview PR #${preview.pr_number}`}
            className="w-full border-0"
            style={{ height: '70vh' }}
            onError={() => setIframeError(true)}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          />
        </div>
      )}
    </div>
  );
}

// ─── Screenshots Tab ─────────────────────────────────────────────

function ScreenshotsTab({ captures, uploadsPrefix, onCapture, capturing, preview }) {
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const screenshots = captures.filter((c) => c.type === 'screenshot');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          {screenshots.length} screenshot{screenshots.length !== 1 ? 's' : ''}
        </p>
        {preview.status === 'running' && (
          <button
            onClick={onCapture}
            disabled={capturing}
            className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors"
          >
            {capturing ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
            {capturing ? 'Capturing...' : 'Capture Now'}
          </button>
        )}
      </div>

      {screenshots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-gray-500">
          <Image size={48} className="mb-4 text-gray-600" />
          <p className="text-lg font-medium text-gray-400">No screenshots yet</p>
          <p className="text-sm mt-1">
            {preview.status === 'running'
              ? 'Click "Capture Now" to take screenshots'
              : 'Screenshots are captured from running previews'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {screenshots.map((ss, i) => (
            <button
              key={ss.id}
              onClick={() => setLightboxIndex(i)}
              className="group relative rounded-xl overflow-hidden border border-gray-700 hover:border-blue-500/50 transition-all hover:shadow-lg hover:shadow-blue-500/10"
            >
              <img
                src={`${uploadsPrefix}${ss.file_path}`}
                alt={ss.label}
                className="w-full h-32 object-cover object-top"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                <Image
                  size={20}
                  className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg"
                />
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2.5 py-2">
                <span className="text-xs text-gray-200 font-medium">{ss.label}</span>
                {ss.route && <span className="text-[10px] text-gray-400 block">{ss.route}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {lightboxIndex !== null && (
        <ScreenshotLightbox
          screenshots={screenshots}
          initialIndex={lightboxIndex}
          uploadsPrefix={uploadsPrefix}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

// ─── Video Tab ───────────────────────────────────────────────────

function VideoTab({ captures, uploadsPrefix, onCapture, capturing, preview }) {
  const videos = captures.filter((c) => c.type === 'video');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          {videos.length} video{videos.length !== 1 ? 's' : ''}
        </p>
        {preview.status === 'running' && (
          <button
            onClick={onCapture}
            disabled={capturing}
            className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors"
          >
            {capturing ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
            {capturing ? 'Recording...' : 'Record Walkthrough'}
          </button>
        )}
      </div>

      {videos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-gray-500">
          <Film size={48} className="mb-4 text-gray-600" />
          <p className="text-lg font-medium text-gray-400">No videos yet</p>
          <p className="text-sm mt-1">
            {preview.status === 'running'
              ? 'Click "Record Walkthrough" to capture a video'
              : 'Videos are recorded from running previews'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {videos.map((vid) => (
            <div
              key={vid.id}
              className="rounded-xl overflow-hidden border border-gray-700 bg-gray-950"
            >
              <video
                src={`${uploadsPrefix}${vid.file_path}`}
                controls
                className="w-full"
                style={{ maxHeight: '60vh' }}
              />
              <div className="flex items-center justify-between px-3 py-2 bg-gray-900/80 text-xs text-gray-400">
                <span className="flex items-center gap-1.5">
                  <Video size={12} />
                  {vid.label || vid.name}
                </span>
                <span>{formatFileSize(vid.file_size)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── PR Actions Tab ──────────────────────────────────────────────

function PrActionsTab({ preview }) {
  const [prStatus, setPrStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(null);
  const [result, setResult] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);

  const fetchPrStatus = useCallback(async () => {
    if (!preview.pr_url) return;
    setLoading(true);
    try {
      const status = await api.getPrStatus(preview.pr_url);
      setPrStatus(status);
    } catch (err) {
      console.error('Failed to fetch PR status:', err.message);
    } finally {
      setLoading(false);
    }
  }, [preview.pr_url]);

  useEffect(() => {
    fetchPrStatus();
  }, [fetchPrStatus]);

  const handleMerge = async () => {
    setActing('merge');
    setResult(null);
    setConfirmAction(null);
    try {
      await api.mergePr(preview.pr_url);
      setResult({ type: 'success', message: `PR #${preview.pr_number} merged successfully` });
      fetchPrStatus();
    } catch (err) {
      setResult({ type: 'error', message: err.message });
    } finally {
      setActing(null);
    }
  };

  const handleClose = async () => {
    setActing('close');
    setResult(null);
    setConfirmAction(null);
    try {
      await api.closePr(preview.pr_url);
      setResult({ type: 'success', message: `PR #${preview.pr_number} closed` });
      fetchPrStatus();
    } catch (err) {
      setResult({ type: 'error', message: err.message });
    } finally {
      setActing(null);
    }
  };

  if (!preview.pr_url) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <GitPullRequest size={48} className="mb-4 text-gray-600" />
        <p className="text-lg font-medium text-gray-400">No PR linked</p>
        <p className="text-sm mt-1">This preview has no associated pull request URL.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* PR Info */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-white font-medium flex items-center gap-2">
            <GitPullRequest size={16} />
            PR #{preview.pr_number}
          </h4>
          <a
            href={preview.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 text-sm flex items-center gap-1"
          >
            View on GitHub <ExternalLink size={12} />
          </a>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <Loader2 size={14} className="animate-spin" />
            Loading PR status...
          </div>
        ) : prStatus ? (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-gray-500">State:</span>{' '}
              <span
                className={
                  prStatus.state === 'open'
                    ? 'text-green-400'
                    : prStatus.state === 'closed'
                      ? 'text-red-400'
                      : 'text-purple-400'
                }
              >
                {prStatus.state === 'open'
                  ? 'Open'
                  : prStatus.state === 'closed'
                    ? 'Closed'
                    : 'Merged'}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Mergeable:</span>{' '}
              <span className={prStatus.mergeable ? 'text-green-400' : 'text-yellow-400'}>
                {prStatus.mergeable ? 'Yes' : 'No'}
              </span>
            </div>
            {prStatus.title && (
              <div className="col-span-2">
                <span className="text-gray-500">Title:</span>{' '}
                <span className="text-gray-300">{prStatus.title}</span>
              </div>
            )}
            {prStatus.head && (
              <div>
                <span className="text-gray-500">Branch:</span>{' '}
                <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded text-xs">
                  {prStatus.head}
                </code>
              </div>
            )}
            {(prStatus.additions !== undefined || prStatus.deletions !== undefined) && (
              <div>
                <span className="text-gray-500">Changes:</span>{' '}
                <span className="text-green-400">+{prStatus.additions || 0}</span>{' '}
                <span className="text-red-400">-{prStatus.deletions || 0}</span>{' '}
                <span className="text-gray-500">
                  ({prStatus.changed_files || 0} file{prStatus.changed_files !== 1 ? 's' : ''})
                </span>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Result banner */}
      {result && (
        <div
          className={`rounded-xl p-4 flex items-center gap-3 ${
            result.type === 'success'
              ? 'bg-green-500/10 border border-green-500/20'
              : 'bg-red-500/10 border border-red-500/20'
          }`}
        >
          {result.type === 'success' ? (
            <CheckCircle2 size={20} className="text-green-400 shrink-0" />
          ) : (
            <AlertTriangle size={20} className="text-red-400 shrink-0" />
          )}
          <p className={`text-sm ${result.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
            {result.message}
          </p>
        </div>
      )}

      {/* Action buttons */}
      {prStatus?.state === 'open' && (
        <div className="flex flex-col gap-4">
          {/* Confirmation dialogs */}
          {confirmAction === 'merge' ? (
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4">
              <p className="text-green-400 text-sm font-medium mb-3">
                Merge PR #{preview.pr_number}?
              </p>
              <p className="text-gray-400 text-xs mb-4">
                This will squash-merge and delete the branch. This action cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleMerge}
                  disabled={!!acting}
                  className="flex items-center gap-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {acting === 'merge' ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <GitMerge size={14} />
                  )}
                  {acting === 'merge' ? 'Merging...' : 'Confirm Merge'}
                </button>
                <button
                  onClick={() => setConfirmAction(null)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : confirmAction === 'close' ? (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
              <p className="text-red-400 text-sm font-medium mb-3">
                Close PR #{preview.pr_number}?
              </p>
              <p className="text-gray-400 text-xs mb-4">
                This will close the PR without merging. The branch will remain.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleClose}
                  disabled={!!acting}
                  className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {acting === 'close' ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <XCircle size={14} />
                  )}
                  {acting === 'close' ? 'Closing...' : 'Confirm Close'}
                </button>
                <button
                  onClick={() => setConfirmAction(null)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmAction('merge')}
                disabled={!!acting || (prStatus && !prStatus.mergeable)}
                className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-4 py-3 rounded-xl transition-colors"
              >
                <GitMerge size={16} />
                Approve & Merge
              </button>
              <button
                onClick={() => setConfirmAction('close')}
                disabled={!!acting}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 text-red-400 hover:text-red-300 disabled:bg-gray-700 disabled:text-gray-500 disabled:border-gray-600 text-sm font-medium px-4 py-3 rounded-xl transition-colors"
              >
                <XCircle size={16} />
                Reject & Close
              </button>
            </div>
          )}

          {prStatus && !prStatus.mergeable && !confirmAction && (
            <p className="text-yellow-400 text-xs flex items-center gap-1.5">
              <AlertTriangle size={12} />
              PR has merge conflicts or is not in a mergeable state
            </p>
          )}
        </div>
      )}

      {prStatus?.state === 'closed' && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 text-center">
          <p className="text-gray-400 text-sm">This PR has been closed.</p>
        </div>
      )}
    </div>
  );
}

// ─── Utilities ───────────────────────────────────────────────────

export function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildUploadsUrl(serverBase, filePath) {
  return `${serverBase}/uploads/${filePath}`;
}

export function separateCaptures(captures) {
  return {
    screenshots: captures.filter((c) => c.type === 'screenshot'),
    videos: captures.filter((c) => c.type === 'video'),
  };
}

// ─── Main Panel ──────────────────────────────────────────────────

export default function PreviewPanel({ preview, projectId, onClose }) {
  const [activeTab, setActiveTab] = useState('preview');
  const [captures, setCaptures] = useState([]);
  const [capturesLoading, setCapturesLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);

  const serverBase = getServerBase();
  const uploadsPrefix = `${serverBase}/uploads/`;

  const fetchCaptures = useCallback(async () => {
    try {
      const data = await api.getPreviewCaptures(projectId, preview.id);
      setCaptures(data);
    } catch (err) {
      console.error('Failed to fetch captures:', err.message);
    } finally {
      setCapturesLoading(false);
    }
  }, [projectId, preview.id]);

  useEffect(() => {
    fetchCaptures();
  }, [fetchCaptures]);

  // Listen for capture complete events via WebSocket
  useEffect(() => {
    const handler = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'preview_capture_complete' && data.previewId === preview.id) {
          setCapturing(false);
          fetchCaptures();
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener('ws_message', handler);
    return () => window.removeEventListener('ws_message', handler);
  }, [preview.id, fetchCaptures]);

  const handleCapture = async () => {
    setCapturing(true);
    try {
      await api.triggerPreviewCapture(projectId, preview.id);
    } catch (err) {
      console.error('Capture trigger failed:', err.message);
      setCapturing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <GitPullRequest size={20} className="text-blue-400" />
            <div>
              <h2 className="text-white font-semibold text-lg">PR #{preview.pr_number} Preview</h2>
              <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                <code className="bg-gray-800 px-1.5 py-0.5 rounded">{preview.branch}</code>
                {preview.commit_sha && (
                  <code className="bg-gray-800 px-1.5 py-0.5 rounded">
                    {preview.commit_sha.slice(0, 7)}
                  </code>
                )}
                <span>Created {relativeTime(preview.created_at)}</span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-gray-700 px-6">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const count =
              tab.id === 'screenshots'
                ? captures.filter((c) => c.type === 'screenshot').length
                : tab.id === 'video'
                  ? captures.filter((c) => c.type === 'video').length
                  : null;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                <Icon size={14} />
                {tab.label}
                {count > 0 && (
                  <span className="bg-gray-700 text-gray-300 text-xs px-1.5 py-0.5 rounded-full">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'preview' && <LivePreviewTab preview={preview} />}
          {activeTab === 'screenshots' && (
            <ScreenshotsTab
              captures={captures}
              uploadsPrefix={uploadsPrefix}
              onCapture={handleCapture}
              capturing={capturing}
              preview={preview}
            />
          )}
          {activeTab === 'video' && (
            <VideoTab
              captures={captures}
              uploadsPrefix={uploadsPrefix}
              onCapture={handleCapture}
              capturing={capturing}
              preview={preview}
            />
          )}
          {activeTab === 'actions' && <PrActionsTab preview={preview} />}
        </div>
      </div>
    </div>
  );
}
