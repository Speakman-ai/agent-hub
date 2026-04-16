import { useState, useEffect, useCallback, useRef } from 'react';
import { getApiBase, getServerBase, getAuthHeaders } from '../utils/connection.js';
import { relativeTime } from '../utils/time.js';
import {
  Camera,
  RefreshCw,
  Trash2,
  ExternalLink,
  AlertTriangle,
  Video,
  Image,
  CheckCircle2,
  XCircle,
  Clock,
  MessageSquare,
  Loader2,
  Plus,
  X,
  GitPullRequest,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';

// ─── Helpers ────────────────────────────────────────────────────

async function fetchJSON(path, options = {}) {
  const base = getApiBase();
  const authHeaders = getAuthHeaders();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...options.headers,
    },
  });
  if (options.method === 'DELETE' && res.status === 204) return null;
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || body.message || '';
    } catch {}
    throw new Error(detail || `API error: ${res.status}`);
  }
  return res.json();
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadsUrl(captureId, filename) {
  const base = getServerBase();
  return `${base}/uploads/captures/${captureId}/${filename}`;
}

// ─── Status Badge ───────────────────────────────────────────────

const STATUS_CONFIG = {
  queued: {
    color: 'text-gray-400',
    bg: 'bg-gray-500/10',
    border: 'border-gray-500/20',
    label: 'Queued',
    icon: Clock,
  },
  building: {
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/20',
    label: 'Building',
    icon: Loader2,
    spin: true,
  },
  capturing: {
    color: 'text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    label: 'Capturing',
    icon: Camera,
    spin: true,
  },
  done: {
    color: 'text-green-400',
    bg: 'bg-green-500/10',
    border: 'border-green-500/20',
    label: 'Done',
    icon: CheckCircle2,
  },
  error: {
    color: 'text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/20',
    label: 'Error',
    icon: XCircle,
  },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.error;
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.color} ${cfg.border} border`}
    >
      <Icon size={12} className={cfg.spin ? 'animate-spin' : ''} />
      {cfg.label}
    </span>
  );
}

// ─── Screenshot Lightbox ────────────────────────────────────────

function ScreenshotLightbox({ screenshots, initialIndex, captureId, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const current = screenshots[index];
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1);
      if (e.key === 'ArrowRight' && index < screenshots.length - 1) setIndex(index + 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [index, screenshots.length]);

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
          src={uploadsUrl(captureId, current.filename)}
          alt={current.label}
          className="w-full rounded-lg border border-gray-700 shadow-2xl"
        />
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
        {screenshots.length > 1 && (
          <div className="flex gap-2 mt-3 justify-center">
            {screenshots.map((ss, i) => (
              <button
                key={ss.id}
                onClick={() => setIndex(i)}
                className={`rounded-md overflow-hidden border-2 transition-all ${i === index ? 'border-blue-500 opacity-100' : 'border-transparent opacity-50 hover:opacity-80'}`}
              >
                <img
                  src={uploadsUrl(captureId, ss.filename)}
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

// ─── New Capture Modal ──────────────────────────────────────────

function NewCaptureModal({ projectId, onClose, onCreated }) {
  const [prNumber, setPrNumber] = useState('');
  const [branch, setBranch] = useState('');
  const [commitSha, setCommitSha] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const capture = await fetchJSON(`/projects/${projectId}/captures`, {
        method: 'POST',
        body: JSON.stringify({
          prNumber: Number(prNumber),
          branch,
          commitSha: commitSha || undefined,
          repoUrl: repoUrl || undefined,
          prUrl: prUrl || undefined,
        }),
      });
      onCreated(capture);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Camera size={20} />
            New PR Capture
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">PR Number *</label>
              <input
                type="number"
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                placeholder="123"
                required
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Branch *</label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="feature/my-branch"
                required
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">
              Commit SHA <span className="text-gray-500">(optional)</span>
            </label>
            <input
              type="text"
              value={commitSha}
              onChange={(e) => setCommitSha(e.target.value)}
              placeholder="abc1234"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">
              Repository URL <span className="text-gray-500">(uses project default if blank)</span>
            </label>
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">
              PR URL <span className="text-gray-500">(optional)</span>
            </label>
            <input
              type="url"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              placeholder="https://github.com/org/repo/pull/123"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !prNumber || !branch}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
              {creating ? 'Creating...' : 'Start Capture'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Capture Detail (expanded inline) ───────────────────────────

function CaptureDetail({ capture, projectId, onRefresh }) {
  const [artifacts, setArtifacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [showBuildLog, setShowBuildLog] = useState(false);
  const [posting, setPosting] = useState(false);

  const fetchDetail = useCallback(async () => {
    setDetailError(null);
    try {
      const data = await fetchJSON(`/projects/${projectId}/captures/${capture.id}`);
      setArtifacts(data.artifacts || []);
    } catch (err) {
      console.error('Failed to fetch capture detail:', err.message);
      setDetailError(err.message || 'Failed to load capture detail');
    } finally {
      setLoading(false);
    }
  }, [projectId, capture.id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const screenshots = artifacts.filter((a) => a.type === 'screenshot');
  const videos = artifacts.filter((a) => a.type === 'video');
  const consoleErrors = artifacts
    .filter((a) => a.console_errors)
    .flatMap((a) => {
      try {
        return JSON.parse(a.console_errors).map((err) => ({
          route: a.route || a.label,
          error: err,
        }));
      } catch {
        return [{ route: a.route || a.label, error: a.console_errors }];
      }
    });

  const handlePostToGitHub = async () => {
    setPosting(true);
    setActionError(null);
    try {
      const result = await fetchJSON(`/projects/${projectId}/captures/${capture.id}/comment`, {
        method: 'POST',
      });
      if (result.commentUrl) onRefresh();
    } catch (err) {
      console.error('Failed to post comment:', err.message);
      setActionError(err.message || 'Failed to post PR comment');
    } finally {
      setPosting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-xs py-4">
        <Loader2 size={14} className="animate-spin" />
        Loading capture details...
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-700/50 space-y-4">
      {/* Inline errors — surface fetch/comment failures so they don't silently disappear */}
      {detailError && (
        <div className="rounded-md bg-red-500/10 border border-red-500/30 px-3 py-2 flex items-start gap-2">
          <AlertCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 text-xs text-red-300">
            <strong>Could not load detail:</strong> {detailError}
          </div>
          <button
            onClick={fetchDetail}
            className="text-xs text-red-300 hover:text-red-100 underline"
          >
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <div className="rounded-md bg-red-500/10 border border-red-500/30 px-3 py-2 flex items-start gap-2">
          <AlertCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 text-xs text-red-300">
            <strong>Action failed:</strong> {actionError}
          </div>
          <button
            onClick={() => setActionError(null)}
            className="text-xs text-red-300 hover:text-red-100"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Screenshot gallery */}
      {screenshots.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Image size={12} /> Screenshots ({screenshots.length})
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {screenshots.map((ss, i) => (
              <button
                key={ss.id}
                onClick={() => setLightboxIndex(i)}
                className="group relative rounded-lg overflow-hidden border border-gray-700 hover:border-blue-500/50 transition-all"
              >
                <img
                  src={uploadsUrl(capture.id, ss.filename)}
                  alt={ss.label}
                  className="w-full h-24 object-cover object-top"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                  <Image
                    size={16}
                    className="text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5">
                  <span className="text-[10px] text-gray-200">{ss.label}</span>
                </div>
                {ss.console_errors && (
                  <div className="absolute top-1 right-1 bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                    <AlertTriangle size={8} />
                    {(() => {
                      try {
                        return JSON.parse(ss.console_errors).length;
                      } catch {
                        return '!';
                      }
                    })()}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Video player */}
      {videos.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Video size={12} /> Video Walkthrough
          </h4>
          {videos.map((vid) => (
            <div key={vid.id} className="rounded-lg overflow-hidden border border-gray-700">
              <video
                src={uploadsUrl(capture.id, vid.filename)}
                controls
                className="w-full"
                style={{ maxHeight: '50vh' }}
                preload="metadata"
              >
                <track kind="captions" />
              </video>
              <div className="bg-gray-800/50 px-2.5 py-1.5 flex items-center gap-2 text-xs text-gray-400">
                <Video size={12} />
                <span>{vid.label || vid.name}</span>
                {vid.file_size > 0 && (
                  <span className="text-gray-500">{formatFileSize(vid.file_size)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Console errors */}
      {consoleErrors.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-red-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <AlertTriangle size={12} /> Console Errors ({consoleErrors.length})
          </h4>
          <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3 space-y-2 max-h-48 overflow-y-auto">
            {consoleErrors.map((ce, i) => (
              <div key={i} className="text-xs">
                <span className="text-gray-500">[{ce.route}]</span>{' '}
                <span className="text-red-300 font-mono">
                  {typeof ce.error === 'string' ? ce.error : JSON.stringify(ce.error)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Build log */}
      {capture.build_log && (
        <div>
          <button
            onClick={() => setShowBuildLog(!showBuildLog)}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-300 transition-colors"
          >
            {showBuildLog ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Build Log
          </button>
          {showBuildLog && (
            <pre className="mt-2 bg-gray-950 border border-gray-700 rounded-lg p-3 text-xs text-gray-400 font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
              {capture.build_log}
            </pre>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        {!capture.comment_url && capture.status === 'done' && capture.pr_url && (
          <button
            onClick={handlePostToGitHub}
            disabled={posting}
            className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors"
          >
            {posting ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
            {posting ? 'Posting...' : 'Post to GitHub PR'}
          </button>
        )}
        {capture.comment_url && (
          <a
            href={capture.comment_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-green-400 hover:text-green-300 transition-colors"
          >
            <ExternalLink size={14} />
            View PR Comment
          </a>
        )}
      </div>

      {/* Screenshot lightbox */}
      {lightboxIndex !== null && (
        <ScreenshotLightbox
          screenshots={screenshots}
          initialIndex={lightboxIndex}
          captureId={capture.id}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

// ─── Capture Card ───────────────────────────────────────────────

function CaptureCard({ capture, projectId, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [acting, setActing] = useState(null);
  const cfg = STATUS_CONFIG[capture.status] || STATUS_CONFIG.error;

  const handleRerun = async () => {
    setActing('rerun');
    try {
      await fetchJSON(`/projects/${projectId}/captures/${capture.id}/rerun`, { method: 'POST' });
      onRefresh();
    } catch (err) {
      console.error('Rerun failed:', err.message);
    } finally {
      setActing(null);
    }
  };

  const handleDelete = async () => {
    setActing('delete');
    try {
      await fetchJSON(`/projects/${projectId}/captures/${capture.id}`, { method: 'DELETE' });
      onRefresh();
    } catch (err) {
      console.error('Delete failed:', err.message);
    } finally {
      setActing(null);
    }
  };

  return (
    <div className={`${cfg.bg} ${cfg.border} border rounded-xl p-4`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <GitPullRequest size={18} className={cfg.color} />
            <span className="text-white font-semibold text-lg">#{capture.pr_number}</span>
          </div>
          <StatusBadge status={capture.status} />
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          <button
            onClick={handleRerun}
            disabled={!!acting}
            className="text-blue-400 hover:text-blue-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors disabled:opacity-50"
            title="Rerun capture"
          >
            {acting === 'rerun' ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
          </button>
          <button
            onClick={handleDelete}
            disabled={!!acting}
            className="text-red-400 hover:text-red-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors disabled:opacity-50"
            title="Delete"
          >
            {acting === 'delete' ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Trash2 size={16} />
            )}
          </button>
          {capture.pr_url && (
            <a
              href={capture.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
              title="View PR"
            >
              <ExternalLink size={16} />
            </a>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center gap-2 text-gray-400">
          <span className="text-gray-500 w-16 shrink-0">Branch:</span>
          <code className="text-gray-300 bg-gray-800/50 px-1.5 py-0.5 rounded text-xs">
            {capture.branch}
          </code>
        </div>
        {capture.status === 'done' && (
          <div className="flex items-center gap-4 text-gray-400">
            {capture.screenshot_count > 0 && (
              <span className="flex items-center gap-1 text-xs">
                <Image size={12} /> {capture.screenshot_count} screenshot
                {capture.screenshot_count !== 1 ? 's' : ''}
              </span>
            )}
            {capture.has_video === 1 && (
              <span className="flex items-center gap-1 text-xs text-purple-400">
                <Video size={12} /> Video
              </span>
            )}
            {capture.duration_ms > 0 && (
              <span className="flex items-center gap-1 text-xs">
                <Clock size={12} /> {formatDuration(capture.duration_ms)}
              </span>
            )}
          </div>
        )}
        {capture.status === 'error' && capture.error_message && (
          <div className="mt-2 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <p className="text-red-400 text-xs font-mono whitespace-pre-wrap">
              {capture.error_message}
            </p>
          </div>
        )}
        {capture.comment_url && (
          <a
            href={capture.comment_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-green-400 hover:text-green-300 text-xs mt-1"
          >
            <MessageSquare size={12} /> Posted to PR
          </a>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-700/50 text-xs text-gray-500">
        <span>Created {relativeTime(capture.created_at)}</span>
        {capture.commit_sha && (
          <code className="bg-gray-800/50 px-1.5 py-0.5 rounded">
            {capture.commit_sha.slice(0, 7)}
          </code>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && capture.status === 'done' && (
        <CaptureDetail capture={capture} projectId={projectId} onRefresh={onRefresh} />
      )}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────

export default function CapturesPage({ projectId }) {
  const [captures, setCaptures] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const fetchCaptures = useCallback(async () => {
    try {
      const [captureList, captureStatus] = await Promise.all([
        fetchJSON(`/projects/${projectId}/captures`),
        fetchJSON('/captures/status'),
      ]);
      setCaptures(captureList);
      setStatus(captureStatus);
    } catch (err) {
      console.error('Failed to fetch captures:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchCaptures();
    const interval = setInterval(fetchCaptures, 15000);
    return () => clearInterval(interval);
  }, [fetchCaptures]);

  // WebSocket real-time updates
  useEffect(() => {
    const handler = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (
          (data.type === 'capture_status' || data.type === 'capture_complete') &&
          (!data.projectId || data.projectId === projectId)
        ) {
          fetchCaptures();
        }
      } catch {
        // ignore non-JSON
      }
    };
    window.addEventListener('ws_message', handler);
    return () => window.removeEventListener('ws_message', handler);
  }, [projectId, fetchCaptures]);

  const active = captures.filter(
    (c) => c.status === 'queued' || c.status === 'building' || c.status === 'capturing',
  );
  const completed = captures.filter((c) => c.status === 'done' || c.status === 'error');

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <Camera size={28} />
              PR Captures
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              Playwright-based screenshots and video walkthroughs of PR branches
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            disabled={status && !status.enabled}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            <Plus size={16} />
            New Capture
          </button>
        </div>

        {/* Status banners */}
        {status && !status.enabled && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 mb-6">
            <div className="flex items-center gap-3">
              <AlertCircle size={20} className="text-yellow-400" />
              <div>
                <p className="text-yellow-400 font-medium text-sm">Captures disabled</p>
                <p className="text-gray-400 text-xs mt-0.5">
                  PR capture functionality is currently disabled in server configuration.
                </p>
              </div>
            </div>
          </div>
        )}

        {status && status.enabled && !status.playwrightAvailable && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 mb-6">
            <div className="flex items-center gap-3">
              <AlertTriangle size={20} className="text-yellow-400" />
              <div>
                <p className="text-yellow-400 font-medium text-sm">Playwright not available</p>
                <p className="text-gray-400 text-xs mt-0.5">
                  Playwright must be installed on the server to run captures. Run{' '}
                  <code className="bg-gray-800 px-1 rounded">npx playwright install chromium</code>.
                </p>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-gray-500" />
          </div>
        ) : (
          <>
            {/* Active captures */}
            {active.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
                  In Progress ({active.length})
                </h3>
                <div className="space-y-3">
                  {active.map((c) => (
                    <CaptureCard
                      key={c.id}
                      capture={c}
                      projectId={projectId}
                      onRefresh={fetchCaptures}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Completed captures */}
            {completed.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
                  {active.length > 0 ? 'Completed' : 'Captures'} ({completed.length})
                </h3>
                <div className="space-y-3">
                  {completed.map((c) => (
                    <CaptureCard
                      key={c.id}
                      capture={c}
                      projectId={projectId}
                      onRefresh={fetchCaptures}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {captures.length === 0 && (
              <div className="text-center py-16">
                <Camera size={48} className="mx-auto text-gray-600 mb-4" />
                <h3 className="text-lg font-medium text-gray-300 mb-2">No captures yet</h3>
                <p className="text-gray-500 text-sm max-w-md mx-auto mb-6">
                  Capture screenshots and video walkthroughs of PR branches using Playwright.
                  Results can be posted directly to the GitHub PR as a comment.
                </p>
                {status?.enabled && status?.playwrightAvailable && (
                  <button
                    onClick={() => setShowCreate(true)}
                    className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
                  >
                    <Plus size={16} />
                    Create First Capture
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* New capture modal */}
      {showCreate && (
        <NewCaptureModal
          projectId={projectId}
          onClose={() => setShowCreate(false)}
          onCreated={() => fetchCaptures()}
        />
      )}
    </div>
  );
}
