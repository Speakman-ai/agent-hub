import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api.js';
import { relativeTime } from '../utils/time.js';
import PreviewPanel from './PreviewPanel.jsx';
import {
  Container,
  Play,
  Square,
  RefreshCw,
  Trash2,
  ExternalLink,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Plus,
  X,
  GitPullRequest,
  Server,
  PanelRightOpen,
} from 'lucide-react';

const STATUS_CONFIG = {
  building: {
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/20',
    icon: Loader2,
    iconClass: 'animate-spin',
    label: 'Building',
  },
  running: {
    color: 'text-green-400',
    bg: 'bg-green-500/10',
    border: 'border-green-500/20',
    icon: CheckCircle2,
    iconClass: '',
    label: 'Running',
  },
  stopping: {
    color: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
    icon: Loader2,
    iconClass: 'animate-spin',
    label: 'Stopping',
  },
  stopped: {
    color: 'text-gray-400',
    bg: 'bg-gray-500/10',
    border: 'border-gray-500/20',
    icon: Square,
    iconClass: '',
    label: 'Stopped',
  },
  error: {
    color: 'text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/20',
    icon: AlertCircle,
    iconClass: '',
    label: 'Error',
  },
};

function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.error;
  const Icon = config.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.color} ${config.border} border`}
    >
      <Icon size={12} className={config.iconClass} />
      {config.label}
    </span>
  );
}

function CreatePreviewModal({ projectId, onClose, onCreated }) {
  const [prNumber, setPrNumber] = useState('');
  const [branch, setBranch] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [ttlMinutes, setTtlMinutes] = useState('60');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError(null);

    try {
      const preview = await api.createPreview(projectId, {
        prNumber: Number(prNumber),
        branch,
        prUrl: prUrl || undefined,
        repoUrl: repoUrl || undefined,
        ttlMinutes: Number(ttlMinutes),
      });
      onCreated(preview);
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
            <Container size={20} />
            New Preview Container
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
            <label className="block text-sm text-gray-400 mb-1.5">PR URL</label>
            <input
              type="url"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              placeholder="https://github.com/org/repo/pull/123"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">
              Repository URL{' '}
              <span className="text-gray-500">(auto-detected from project if blank)</span>
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
            <label className="block text-sm text-gray-400 mb-1.5">TTL (minutes)</label>
            <input
              type="number"
              value={ttlMinutes}
              onChange={(e) => setTtlMinutes(e.target.value)}
              min="5"
              max="1440"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
            />
            <p className="text-xs text-gray-500 mt-1">
              Container auto-stops after this period. Max 24 hours (1440 min).
            </p>
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
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {creating ? 'Creating...' : 'Create Preview'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LogViewer({ projectId, previewId, onClose }) {
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);
  const logRef = useRef(null);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await api.getPreviewLogs(projectId, previewId);
      setLogs(data.logs || 'No logs available');
    } catch (err) {
      setLogs(`Error fetching logs: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [projectId, previewId]);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <FileText size={20} />
            Container Logs
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchLogs}
              className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700 transition-colors"
              title="Refresh logs"
            >
              <RefreshCw size={16} />
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
              <X size={18} />
            </button>
          </div>
        </div>
        <div
          ref={logRef}
          className="flex-1 overflow-y-auto p-4 font-mono text-xs text-gray-300 bg-gray-950 whitespace-pre-wrap"
        >
          {loading ? (
            <div className="flex items-center gap-2 text-gray-500">
              <Loader2 size={14} className="animate-spin" />
              Loading logs...
            </div>
          ) : (
            logs
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewCard({ preview, projectId, onAction, onOpenPanel }) {
  const [acting, setActing] = useState(null);
  const config = STATUS_CONFIG[preview.status] || STATUS_CONFIG.error;

  const handleAction = async (action) => {
    setActing(action);
    try {
      if (action === 'stop') {
        await api.stopPreview(projectId, preview.id);
      } else if (action === 'rebuild') {
        await api.rebuildPreview(projectId, preview.id);
      } else if (action === 'delete') {
        await api.deletePreview(projectId, preview.id);
      }
      onAction();
    } catch (err) {
      console.error(`Preview ${action} failed:`, err.message);
    } finally {
      setActing(null);
    }
  };

  return (
    <div className={`${config.bg} ${config.border} border rounded-xl p-4`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <GitPullRequest size={18} className={config.color} />
            <span className="text-white font-semibold text-lg">#{preview.pr_number}</span>
          </div>
          <StatusBadge status={preview.status} />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onOpenPanel(preview)}
            className="text-blue-400 hover:text-blue-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
            title="Open preview panel"
          >
            <PanelRightOpen size={16} />
          </button>
          {preview.url && preview.status === 'running' && (
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
              title="Open in new tab"
            >
              <ExternalLink size={16} />
            </a>
          )}
          <button
            onClick={() => onAction('logs', preview.id)}
            className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
            title="View logs"
          >
            <FileText size={16} />
          </button>
          {(preview.status === 'running' || preview.status === 'building') && (
            <button
              onClick={() => handleAction('stop')}
              disabled={!!acting}
              className="text-orange-400 hover:text-orange-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors disabled:opacity-50"
              title="Stop"
            >
              {acting === 'stop' ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Square size={16} />
              )}
            </button>
          )}
          {(preview.status === 'stopped' || preview.status === 'error') && (
            <button
              onClick={() => handleAction('rebuild')}
              disabled={!!acting}
              className="text-blue-400 hover:text-blue-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors disabled:opacity-50"
              title="Rebuild"
            >
              {acting === 'rebuild' ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
            </button>
          )}
          {preview.status !== 'building' && preview.status !== 'running' && (
            <button
              onClick={() => handleAction('delete')}
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
          )}
        </div>
      </div>

      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-2 text-gray-400">
          <span className="text-gray-500 w-16 shrink-0">Branch:</span>
          <code className="text-gray-300 bg-gray-800/50 px-1.5 py-0.5 rounded text-xs">
            {preview.branch}
          </code>
        </div>
        {preview.url && preview.status === 'running' && (
          <div className="flex items-center gap-2 text-gray-400">
            <span className="text-gray-500 w-16 shrink-0">URL:</span>
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 text-xs underline"
            >
              {preview.url}
            </a>
          </div>
        )}
        {preview.port && preview.status === 'running' && (
          <div className="flex items-center gap-2 text-gray-400">
            <span className="text-gray-500 w-16 shrink-0">Port:</span>
            <span className="text-gray-300 text-xs">{preview.port}</span>
          </div>
        )}
        {preview.expires_at && preview.status === 'running' && (
          <div className="flex items-center gap-2 text-gray-400">
            <Clock size={12} className="text-gray-500" />
            <span className="text-xs">Expires {relativeTime(preview.expires_at)}</span>
          </div>
        )}
        {preview.error_message && (
          <div className="mt-2 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <p className="text-red-400 text-xs font-mono whitespace-pre-wrap">
              {preview.error_message}
            </p>
          </div>
        )}
        {preview.pr_url && (
          <div className="flex items-center gap-2 text-gray-400 pt-1">
            <a
              href={preview.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-gray-300 text-xs underline"
            >
              View PR on GitHub
            </a>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-700/50 text-xs text-gray-500">
        <span>Created {relativeTime(preview.created_at)}</span>
        {preview.commit_sha && (
          <code className="bg-gray-800/50 px-1.5 py-0.5 rounded">
            {preview.commit_sha.slice(0, 7)}
          </code>
        )}
      </div>
    </div>
  );
}

export default function PreviewsPage({ projectId }) {
  const [previews, setPreviews] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showLogs, setShowLogs] = useState(null);
  const [panelPreview, setPanelPreview] = useState(null);

  const fetchPreviews = useCallback(async () => {
    try {
      const [previewList, previewStatus] = await Promise.all([
        api.getProjectPreviews(projectId),
        api.getPreviewStatus(),
      ]);
      setPreviews(previewList);
      setStatus(previewStatus);
    } catch (err) {
      console.error('Failed to fetch previews:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchPreviews();
    const interval = setInterval(fetchPreviews, 10000);
    return () => clearInterval(interval);
  }, [fetchPreviews]);

  // Listen for WebSocket updates
  useEffect(() => {
    const handler = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'preview_update' && data.projectId === projectId) {
          fetchPreviews();
        }
      } catch {
        // ignore non-JSON messages
      }
    };
    // The WebSocket is managed globally; we piggyback on the existing connection
    window.addEventListener('ws_message', handler);
    return () => window.removeEventListener('ws_message', handler);
  }, [projectId, fetchPreviews]);

  const handleAction = (action, previewId) => {
    if (action === 'logs') {
      setShowLogs(previewId);
    } else {
      fetchPreviews();
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-gray-500" />
      </div>
    );
  }

  const running = previews.filter((p) => p.status === 'running' || p.status === 'building');
  const inactive = previews.filter((p) => p.status !== 'running' && p.status !== 'building');

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <Container size={28} />
              Preview Environments
            </h2>
            <p className="text-sm text-gray-400 mt-1">Isolated Docker containers for PR branches</p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            disabled={!status?.dockerAvailable}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            <Plus size={16} />
            New Preview
          </button>
        </div>

        {/* Docker status banner */}
        {status && !status.dockerAvailable && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 mb-6">
            <div className="flex items-center gap-3">
              <Server size={20} className="text-yellow-400" />
              <div>
                <p className="text-yellow-400 font-medium text-sm">Docker not available</p>
                <p className="text-gray-400 text-xs mt-0.5">
                  Docker must be installed and running on the server to create preview containers.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Stats bar */}
        {status?.dockerAvailable && (
          <div className="flex items-center gap-4 mb-6 text-sm text-gray-400">
            <span className="flex items-center gap-1.5">
              <Container size={14} className="text-green-400" />
              {status.runningCount} / {status.maxConcurrent} running
            </span>
            <span className="flex items-center gap-1.5">
              <Clock size={14} />
              Default TTL: {status.defaultTtlMinutes}m
            </span>
          </div>
        )}

        {/* Active previews */}
        {running.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
              Active ({running.length})
            </h3>
            <div className="space-y-3">
              {running.map((p) => (
                <PreviewCard
                  key={p.id}
                  preview={p}
                  projectId={projectId}
                  onAction={(action, id) => handleAction(action, id)}
                  onOpenPanel={(prev) => setPanelPreview(prev)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Inactive previews */}
        {inactive.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
              History ({inactive.length})
            </h3>
            <div className="space-y-3">
              {inactive.map((p) => (
                <PreviewCard
                  key={p.id}
                  preview={p}
                  projectId={projectId}
                  onAction={(action, id) => handleAction(action, id)}
                  onOpenPanel={(prev) => setPanelPreview(prev)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {previews.length === 0 && (
          <div className="text-center py-16">
            <Container size={48} className="mx-auto text-gray-600 mb-4" />
            <h3 className="text-lg font-medium text-gray-300 mb-2">No preview environments</h3>
            <p className="text-gray-500 text-sm max-w-md mx-auto mb-6">
              Create an isolated Docker container to preview a PR branch. Each container runs the
              full Agent Hub stack and auto-stops after TTL expires.
            </p>
            {status?.dockerAvailable && (
              <button
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
              >
                <Plus size={16} />
                Create First Preview
              </button>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreate && (
        <CreatePreviewModal
          projectId={projectId}
          onClose={() => setShowCreate(false)}
          onCreated={() => fetchPreviews()}
        />
      )}
      {showLogs && (
        <LogViewer projectId={projectId} previewId={showLogs} onClose={() => setShowLogs(null)} />
      )}
      {panelPreview && (
        <PreviewPanel
          preview={panelPreview}
          projectId={projectId}
          onClose={() => setPanelPreview(null)}
        />
      )}
    </div>
  );
}
