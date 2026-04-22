import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api.js';
import { getServerBase } from '../utils/connection.js';
import { relativeTime } from '../utils/time.js';
import {
  IOS_BUILD_STATUS_CONFIG,
  buildArtifactGroups,
  formatBuildDuration,
  isBuildActive,
  getBuildStepDescription,
} from '../utils/iosBuild.js';
import { formatCaptureSize, buildUploadsUrl } from '../utils/capture.js';
import {
  Smartphone,
  Play,
  X,
  XCircle,
  Trash2,
  ExternalLink,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Plus,
  GitPullRequest,
  Download,
  Film,
  Image,
  QrCode,
  ChevronDown,
  ChevronUp,
  Cpu,
  RefreshCw,
} from 'lucide-react';

// ─── Status Badge ────────────────────────────────────────────────

function IosBuildStatusBadge({ status }) {
  const config = IOS_BUILD_STATUS_CONFIG[status] || IOS_BUILD_STATUS_CONFIG.error;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.color} ${config.border} border`}
    >
      {config.animate && <Loader2 size={12} className="animate-spin" />}
      {!config.animate && status === 'ready' && <CheckCircle2 size={12} />}
      {!config.animate && status === 'error' && <AlertCircle size={12} />}
      {!config.animate && status === 'cancelled' && <XCircle size={12} />}
      {!config.animate && status === 'queued' && <Clock size={12} />}
      {config.label}
    </span>
  );
}

// ─── Build Progress Steps ────────────────────────────────────────

const BUILD_STEPS = ['queued', 'provisioning', 'building', 'archiving', 'uploading', 'ready'];

function BuildProgress({ currentStatus }) {
  const currentIndex = BUILD_STEPS.indexOf(currentStatus);
  const isError = currentStatus === 'error' || currentStatus === 'cancelled';

  return (
    <div className="flex items-center gap-1 mt-3 mb-1">
      {BUILD_STEPS.map((step, i) => {
        let color = 'bg-gray-700';
        if (isError && i <= currentIndex) color = 'bg-red-500/50';
        else if (i < currentIndex) color = 'bg-green-500';
        else if (i === currentIndex) color = 'bg-blue-500';

        return (
          <div
            key={step}
            className={`h-1.5 flex-1 rounded-full transition-colors ${color}`}
            title={IOS_BUILD_STATUS_CONFIG[step]?.label || step}
          />
        );
      })}
    </div>
  );
}

// ─── Build Log Viewer ────────────────────────────────────────────

function IosBuildLogViewer({ projectId, buildId, onClose }) {
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);
  const logRef = useRef(null);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await api.getIosBuildLogs(projectId, buildId);
      setLogs(data.logs || 'No logs available');
    } catch (err) {
      setLogs(`Error fetching logs: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [projectId, buildId]);

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
            iOS Build Logs
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

// ─── Create Build Modal ──────────────────────────────────────────

export function CreateIosBuildModal({ projectId, onClose, onCreated }) {
  const [prNumber, setPrNumber] = useState('');
  const [branch, setBranch] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError(null);

    try {
      const build = await api.createIosBuild(projectId, {
        prNumber: Number(prNumber),
        branch,
        prUrl: prUrl || undefined,
        repoUrl: repoUrl || undefined,
      });
      onCreated(build);
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
            <Smartphone size={20} />
            New iOS Build
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Info banner */}
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 flex items-start gap-2.5">
            <Cpu size={16} className="text-blue-400 mt-0.5 shrink-0" />
            <div className="text-xs text-blue-300">
              <p className="font-medium mb-1">EC2 Mac Instance Build</p>
              <p className="text-blue-400/80">
                Builds your Expo/React Native app on a macOS VM with Xcode. Generates a simulator
                recording and TestFlight-style install link.
              </p>
            </div>
          </div>

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
              {creating ? 'Queuing...' : 'Queue Build'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Artifact Gallery ────────────────────────────────────────────

function ArtifactGallery({ projectId, buildId }) {
  const [artifacts, setArtifacts] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchArtifacts = useCallback(async () => {
    try {
      const data = await api.getIosBuildArtifacts(projectId, buildId);
      setArtifacts(data);
    } catch (err) {
      console.error('Failed to fetch artifacts:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, buildId]);

  useEffect(() => {
    fetchArtifacts();
  }, [fetchArtifacts]);

  // Listen for build complete events
  useEffect(() => {
    const handler = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (
          data.type === 'ios_build_update' &&
          data.buildId === buildId &&
          data.status === 'ready'
        ) {
          fetchArtifacts();
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener('ws_message', handler);
    return () => window.removeEventListener('ws_message', handler);
  }, [buildId, fetchArtifacts]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-xs py-2">
        <Loader2 size={12} className="animate-spin" />
        Loading artifacts...
      </div>
    );
  }

  if (artifacts.length === 0) return null;

  const { ipas, recordings, screenshots } = buildArtifactGroups(artifacts);
  const serverBase = getServerBase();

  return (
    <div className="mt-3 pt-3 border-t border-gray-700/50">
      <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Download size={12} />
        Build Artifacts ({artifacts.length})
      </h4>

      {/* IPA files */}
      {ipas.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {ipas.map((ipa) => (
            <a
              key={ipa.id}
              href={buildUploadsUrl(serverBase, ipa.file_path)}
              download
              className="flex items-center gap-2 p-2 rounded-lg bg-gray-800/50 border border-gray-700 hover:border-blue-500/50 transition-colors group"
            >
              <Smartphone size={14} className="text-blue-400" />
              <span className="text-xs text-gray-300 flex-1">{ipa.label}</span>
              <span className="text-[10px] text-gray-500">{formatCaptureSize(ipa.file_size)}</span>
              <Download
                size={12}
                className="text-gray-500 group-hover:text-blue-400 transition-colors"
              />
            </a>
          ))}
        </div>
      )}

      {/* Simulator recordings */}
      {recordings.length > 0 && (
        <div className="space-y-2 mb-2">
          {recordings.map((vid) => (
            <div key={vid.id} className="rounded-lg overflow-hidden border border-gray-700">
              <video
                src={buildUploadsUrl(serverBase, vid.file_path)}
                controls
                className="w-full"
                preload="metadata"
              >
                <track kind="captions" />
              </video>
              <div className="bg-gray-800/50 px-2 py-1 flex items-center gap-1.5">
                <Film size={12} className="text-gray-400" />
                <span className="text-[10px] text-gray-400">
                  {vid.label} — {formatCaptureSize(vid.file_size)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {screenshots.map((ss) => (
            <div
              key={ss.id}
              className="rounded-lg overflow-hidden border border-gray-700 hover:border-blue-500/50 transition-colors"
            >
              <img
                src={buildUploadsUrl(serverBase, ss.file_path)}
                alt={ss.label}
                className="w-full h-24 object-cover object-top"
              />
              <div className="bg-black/60 px-1.5 py-0.5">
                <span className="text-[10px] text-gray-300">{ss.label}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Build Card ─────────────────────────────────────────────

export default function IosBuildCard({ build, projectId, onAction }) {
  const [acting, setActing] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [showQrCode, setShowQrCode] = useState(false);
  const config = IOS_BUILD_STATUS_CONFIG[build.status] || IOS_BUILD_STATUS_CONFIG.error;
  const active = isBuildActive(build.status);

  const handleCancel = async () => {
    setActing('cancel');
    try {
      await api.cancelIosBuild(projectId, build.id);
      onAction();
    } catch (err) {
      console.error('Cancel failed:', err.message);
    } finally {
      setActing(null);
    }
  };

  const handleDelete = async () => {
    setActing('delete');
    try {
      await api.deleteIosBuild(projectId, build.id);
      onAction();
    } catch (err) {
      console.error('Delete failed:', err.message);
    } finally {
      setActing(null);
    }
  };

  return (
    <div className={`${config.bg} ${config.border} border rounded-xl p-4`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Smartphone size={18} className={config.color} />
            <span className="text-white font-semibold text-lg">#{build.pr_number}</span>
          </div>
          <IosBuildStatusBadge status={build.status} />
          {build.xcode_version && (
            <span className="text-[10px] text-gray-500 bg-gray-800/50 px-1.5 py-0.5 rounded">
              Xcode {build.xcode_version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Install link */}
          {build.install_url && build.status === 'ready' && (
            <a
              href={build.install_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-green-400 hover:text-green-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
              title="Install on device"
            >
              <Download size={16} />
            </a>
          )}
          {/* QR code */}
          {build.qr_code_url && build.status === 'ready' && (
            <button
              onClick={() => setShowQrCode(true)}
              className="text-purple-400 hover:text-purple-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
              title="Show QR code for install"
            >
              <QrCode size={16} />
            </button>
          )}
          {/* Artifacts toggle */}
          <button
            onClick={() => setShowArtifacts((prev) => !prev)}
            className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
            title="Toggle artifacts"
          >
            {showArtifacts ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {/* Logs */}
          <button
            onClick={() => setShowLogs(true)}
            className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors"
            title="View build logs"
          >
            <FileText size={16} />
          </button>
          {/* Cancel */}
          {active && (
            <button
              onClick={handleCancel}
              disabled={!!acting}
              className="text-orange-400 hover:text-orange-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors disabled:opacity-50"
              title="Cancel build"
            >
              {acting === 'cancel' ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <XCircle size={16} />
              )}
            </button>
          )}
          {/* Delete */}
          {!active && (
            <button
              onClick={handleDelete}
              disabled={!!acting}
              className="text-red-400 hover:text-red-300 p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors disabled:opacity-50"
              title="Delete build"
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

      {/* Progress bar */}
      <BuildProgress currentStatus={build.status} />
      <p className="text-xs text-gray-500 mt-1 mb-3">{getBuildStepDescription(build.status)}</p>

      {/* Details */}
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-2 text-gray-400">
          <span className="text-gray-500 w-16 shrink-0">Branch:</span>
          <code className="text-gray-300 bg-gray-800/50 px-1.5 py-0.5 rounded text-xs">
            {build.branch}
          </code>
        </div>
        {build.install_url && build.status === 'ready' && (
          <div className="flex items-center gap-2 text-gray-400">
            <span className="text-gray-500 w-16 shrink-0">Install:</span>
            <a
              href={build.install_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-green-400 hover:text-green-300 text-xs underline"
            >
              {build.install_url}
            </a>
          </div>
        )}
        {build.simulator_recording_url && build.status === 'ready' && (
          <div className="flex items-center gap-2 text-gray-400">
            <span className="text-gray-500 w-16 shrink-0">Video:</span>
            <a
              href={build.simulator_recording_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 text-xs underline"
            >
              Simulator recording
            </a>
          </div>
        )}
        {build.error_message && (
          <div className="mt-2 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <p className="text-red-400 text-xs font-mono whitespace-pre-wrap">
              {build.error_message}
            </p>
          </div>
        )}
        {build.pr_url && (
          <div className="flex items-center gap-2 text-gray-400 pt-1">
            <a
              href={build.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-gray-300 text-xs underline"
            >
              View PR on GitHub
            </a>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-700/50 text-xs text-gray-500">
        <span>Queued {relativeTime(build.created_at)}</span>
        {build.commit_sha && (
          <code className="bg-gray-800/50 px-1.5 py-0.5 rounded">
            {build.commit_sha.slice(0, 7)}
          </code>
        )}
        {build.duration_seconds != null && (
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {formatBuildDuration(build.duration_seconds)}
          </span>
        )}
        {build.vm_instance_id && (
          <span className="flex items-center gap-1" title="EC2 instance ID">
            <Cpu size={10} />
            {build.vm_instance_id}
          </span>
        )}
      </div>

      {/* Expandable artifacts */}
      {showArtifacts && <ArtifactGallery projectId={projectId} buildId={build.id} />}

      {/* Log viewer modal */}
      {showLogs && (
        <IosBuildLogViewer
          projectId={projectId}
          buildId={build.id}
          onClose={() => setShowLogs(false)}
        />
      )}

      {/* QR code modal */}
      {showQrCode && build.qr_code_url && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => setShowQrCode(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl max-w-sm w-full text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold text-sm flex items-center gap-2">
                <QrCode size={16} className="text-purple-400" />
                Install on Device
              </h3>
              <button
                onClick={() => setShowQrCode(false)}
                className="text-gray-400 hover:text-white p-1"
              >
                <X size={18} />
              </button>
            </div>
            <img
              src={build.qr_code_url}
              alt="QR code for install"
              className="mx-auto w-48 h-48 rounded-lg border border-gray-700 bg-white p-2"
            />
            <p className="text-xs text-gray-400 mt-3">
              Scan with your device camera to install PR #{build.pr_number}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
