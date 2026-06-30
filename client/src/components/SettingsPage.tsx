import { useState, useEffect, useRef, useMemo, useCallback, Component } from 'react';
import { api } from '../utils/api';
import {
  buildOrchestrationBudgetsPayload,
  orchestrationFieldsFromProject,
  ORCHESTRATION_FIELD_META,
} from '../utils/orchestrationBudgets';
import { relativeTime, relativeFuture, formatDateTime, formatTime } from '../utils/time';
import { hasRole, isLocalMode } from '../utils/auth';
import humanCron from '@shared/utils/humanCron';
import CronSchedulePicker from './CronSchedulePicker';
import AgentAvatar from './AgentAvatar';
import AccountSection from './AccountSection';
import GithubConnectionSection from './GithubConnectionSection';
import PersonalOAuthConfigSection from './PersonalOAuthConfigSection';
import AuthUpgradeBanner from './AuthUpgradeBanner';
import GlobalSkillsSection from './GlobalSkillsSection';
import PerUserModelSelect from './PerUserModelSelect';
import PerUserEngineSelect from './PerUserEngineSelect';
import { effectiveEngine, modelOverrideIsStale } from '../utils/perUserModelOverride';
import ProjectSecretsEditor from './ProjectSecretsEditor';
import GitHostSettingsSection from './GitHostSettingsSection';
import ProjectDefaultAutomationSection from './finalize/ProjectDefaultAutomationSection';
import { AVATAR_ICON_NAMES, buildIconAvatar, isIconAvatar } from '../utils/avatar';
import { isWorkflowProject } from '../utils/projectMode';
import {
  agentAcceptsAutonomousTickets,
  isAutonomyLocked,
  isAutonomyLockedOn,
} from '../utils/agentAutonomy';
import { isElectron } from '../utils/isElectron';
import { RELEASE_BUCKET_ROOT } from '../utils/version';
import * as LucideIcons from 'lucide-react';

/** Error boundary to catch render crashes in individual settings tabs */
class SettingsErrorBoundary extends Component<any, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <p className="text-red-400 text-sm font-medium mb-1">Something went wrong</p>
          <p className="text-xs text-gray-400 mb-3">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import {
  testConnection,
  getAuthHeaders,
  getApiBase,
  getServerBase,
  reloadForOrgSwitch,
} from '../utils/connection';
import { getOrgs, getActiveOrg, createOrg, updateOrg, deleteOrg, switchOrg } from '../utils/orgs';
import {
  Settings as SettingsIcon,
  Building2,
  Bot,
  HeartPulse,
  Clock,
  MessageSquare,
  BarChart3,
  Activity,
  HardDrive,
  Monitor,
  Cloud,
  Loader2,
  Plug,
  Play,
  Pencil,
  RefreshCw,
  Plus,
  Trash2,
  ArrowRightLeft,
  GitBranch,
  Server,
  Terminal,
  Globe,
  ChevronDown,
  ChevronRight,
  X,
  Key,
  Shield,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  ScrollText,
  FileText,
  UserCircle,
  AlertTriangle,
  Info,
  Menu,
  FolderGit2,
  Download,
  Package,
  ClipboardCheck,
} from 'lucide-react';

/** Grid of Lucide icon chips used as quick-pick agent avatars. */
function IconPickerGrid({ selected, color = '#6b7280', onSelect }: any) {
  return (
    <div className="mt-3">
      <p className="text-[11px] text-gray-500 mb-1.5">Or pick an icon:</p>
      <div className="grid grid-cols-10 gap-1.5">
        {AVATAR_ICON_NAMES.map((name: any) => {
          const IconComponent = (LucideIcons as any)[name];
          if (!IconComponent) return null;
          const isSelected = selected === buildIconAvatar(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => onSelect(name)}
              title={name}
              aria-label={`Use ${name} icon as avatar`}
              className={`w-8 h-8 rounded-md flex items-center justify-center border transition-colors ${
                isSelected
                  ? 'border-indigo-400 bg-indigo-500/10'
                  : 'border-gray-700 hover:border-gray-500 bg-gray-900/50'
              }`}
              style={isSelected ? { color } : undefined}
            >
              <IconComponent size={16} className={isSelected ? '' : 'text-gray-400'} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Web clients are served *by* the Agent Hub server they talk to, so the
// page's origin is the server URL — there is no other server they could
// sensibly point at. The Local/Remote toggle is meaningful only on
// Electron (which can spawn a bundled local server *or* HTTP/WS to a
// remote one). Hiding the toggle on web prevents users from flipping a
// knob that has no coherent meaning here, and removes a footgun that
// would let them put their own org into a state where the configured
// `remoteUrl` disagrees with the actual page origin.
const isElectronShell = () =>
  typeof window !== 'undefined' && window.electronAPI?.isElectron === true;

export function OrganizationsSection() {
  const [orgsState, setOrgsState] = useState(() => getOrgs());
  const [expandedOrgId, setExpandedOrgId] = useState<any>(null);
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState({
    name: '',
    mode: 'local',
    color: '#6366f1',
    remoteUrl: '',
    apiKey: '',
  });

  const activeOrg = getActiveOrg();
  const orgs = orgsState?.orgs || [];
  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const COLOR_OPTIONS = [
    '#6366f1',
    '#ef4444',
    '#f59e0b',
    '#10b981',
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
    '#14b8a6',
  ];

  const refreshOrgs = () => setOrgsState(getOrgs());

  const handleExpand = (orgId: any) => {
    if (expandedOrgId === orgId) {
      setExpandedOrgId(null);
      return;
    }
    const org = orgs.find((o: any) => o.id === orgId);
    setEditForm({
      name: org.name,
      mode: org.mode,
      color: org.color,
      remoteUrl: org.remote_url || org.remoteUrl || '',
      apiKey: org.api_key || org.apiKey || '',
    });
    setExpandedOrgId(orgId);
    setTestResult(null);
  };

  const handleSaveEdit = async (orgId: any) => {
    await updateOrg(orgId, editForm);
    refreshOrgs();
    setExpandedOrgId(null);
    if (activeOrg?.id === orgId) {
      reloadForOrgSwitch();
    }
  };

  const handleDelete = async (orgId: any) => {
    if (await deleteOrg(orgId)) {
      refreshOrgs();
      setExpandedOrgId(null);
      if (activeOrg?.id === orgId) {
        reloadForOrgSwitch();
      }
    }
  };

  const handleSwitch = async (orgId: any) => {
    await switchOrg(orgId);
    reloadForOrgSwitch();
  };

  const handleTest = async (url: any, apiKey: any) => {
    if (!url) {
      setTestResult({ ok: false, message: 'Enter a server URL first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const result = await testConnection(url, apiKey);
    setTestResult(result);
    setTesting(false);
  };

  const handleCreateOrg = async () => {
    if (!newForm.name.trim()) return;
    await createOrg(newForm);
    refreshOrgs();
    setShowNewForm(false);
    setNewForm({ name: '', mode: 'local', color: '#6366f1', remoteUrl: '', apiKey: '' });
  };

  const renderModeToggle = (mode: any, onChange: any) => (
    <div className="flex gap-3">
      <button
        onClick={() => onChange('local')}
        className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all text-sm font-medium ${
          mode === 'local'
            ? 'border-blue-500 bg-blue-500/10 text-blue-400'
            : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'
        }`}
      >
        <div className="text-base mb-1 flex items-center gap-1.5">
          <Monitor size={18} /> Local
        </div>
        <div className="text-xs text-gray-500">Server runs on this machine</div>
      </button>
      <button
        onClick={() => onChange('remote')}
        className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all text-sm font-medium ${
          mode === 'remote'
            ? 'border-blue-500 bg-blue-500/10 text-blue-400'
            : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'
        }`}
      >
        <div className="text-base mb-1 flex items-center gap-1.5">
          <Cloud size={18} /> Remote
        </div>
        <div className="text-xs text-gray-500">Connect to a remote server</div>
      </button>
    </div>
  );

  const renderRemoteFields = (form: any, setForm: any, showTest: any = true) => (
    <div className="space-y-3 mt-3">
      <div>
        <label className={labelClass}>Server URL</label>
        <input
          value={form.remoteUrl}
          onChange={(e: any) => setForm((prev: any) => ({ ...prev, remoteUrl: e.target.value }))}
          className={inputClass}
          placeholder="https://my-server.example.com:3051"
        />
      </div>
      <div>
        <label className={labelClass}>API Key (optional)</label>
        <input
          type="text"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          value={form.apiKey}
          onChange={(e: any) => setForm((prev: any) => ({ ...prev, apiKey: e.target.value }))}
          className={`${inputClass} font-mono text-xs`}
          placeholder="Enter API key if server requires authentication"
        />
      </div>
      {showTest && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleTest(form.remoteUrl, form.apiKey)}
            disabled={testing}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            <span className="flex items-center gap-1.5">
              {testing ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Testing...
                </>
              ) : (
                <>
                  <Plug size={14} /> Test
                </>
              )}
            </span>
          </button>
          {testResult && (
            <span className={`text-sm ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult.ok ? '✓' : '✕'} {testResult.message}
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Organizations</h3>
        <p className="text-xs text-gray-500 mb-4">
          Organizations are connection profiles. Each org points to a different Agent Hub server
          (local or remote). Switching orgs changes which server the client talks to.
        </p>
      </div>

      {/* Org list */}
      <div className="space-y-3">
        {orgs.map((org: any) => {
          const isActive = activeOrg?.id === org.id;
          const isExpanded = expandedOrgId === org.id;

          return (
            <div key={org.id} className="bg-gray-800 rounded-xl overflow-hidden">
              {/* Org row */}
              <div
                className="flex items-center gap-3 p-4 cursor-pointer hover:bg-gray-750 transition-colors"
                onClick={() => handleExpand(org.id)}
              >
                <span
                  className="w-4 h-4 rounded flex-shrink-0"
                  style={{ backgroundColor: org.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-white">{org.name}</span>
                    <span className="flex items-center gap-1 text-xs text-gray-500">
                      {org.mode === 'remote' ? <Cloud size={12} /> : <Monitor size={12} />}
                      {org.mode}
                    </span>
                    {isActive && (
                      <span className="text-xs bg-emerald-900/50 text-emerald-400 px-1.5 py-0.5 rounded">
                        Active
                      </span>
                    )}
                  </div>
                  {org.mode === 'remote' && org.remoteUrl && (
                    <p className="text-xs text-gray-500 truncate mt-0.5 font-mono">
                      {org.remoteUrl}
                    </p>
                  )}
                </div>
                {!isActive && (
                  <button
                    onClick={(e: any) => {
                      e.stopPropagation();
                      handleSwitch(org.id);
                    }}
                    className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                  >
                    <ArrowRightLeft size={12} /> Switch
                  </button>
                )}
                <span className="text-gray-600 text-2xl leading-none flex items-center">
                  {isExpanded ? '▲' : '▼'}
                </span>
              </div>

              {/* Expanded edit form */}
              {isExpanded && (
                <div className="border-t border-gray-700 p-4 space-y-4">
                  <div>
                    <label className={labelClass}>Name</label>
                    <input
                      value={editForm.name || ''}
                      onChange={(e: any) =>
                        setEditForm((prev: any) => ({ ...prev, name: e.target.value }))
                      }
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Color</label>
                    <div className="flex gap-2">
                      {COLOR_OPTIONS.map((c: any) => (
                        <button
                          key={c}
                          onClick={() => setEditForm((prev: any) => ({ ...prev, color: c }))}
                          className={`w-7 h-7 rounded-lg transition-all ${
                            editForm.color === c
                              ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-800'
                              : 'hover:scale-110'
                          }`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </div>

                  {isElectronShell() && (
                    <div>
                      <label className={labelClass}>Connection Mode</label>
                      {renderModeToggle(editForm.mode, (mode: any) => {
                        setEditForm((prev: any) => ({ ...prev, mode }));
                        setTestResult(null);
                      })}
                    </div>
                  )}

                  {isElectronShell() &&
                    editForm.mode === 'remote' &&
                    renderRemoteFields(editForm, setEditForm)}

                  <div className="flex items-center justify-between pt-2">
                    <button
                      onClick={() => handleDelete(org.id)}
                      disabled={orgs.length <= 1}
                      className="text-xs text-red-400 hover:text-red-300 disabled:text-gray-600 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                    <button
                      onClick={() => handleSaveEdit(org.id)}
                      className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
                    >
                      Save Changes
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Organization */}
      {showNewForm ? (
        <div className="bg-gray-800 rounded-xl p-4 space-y-4 border border-dashed border-gray-600">
          <h4 className="text-sm font-medium text-gray-300">New Organization</h4>
          <div>
            <label className={labelClass}>Name</label>
            <input
              value={newForm.name}
              onChange={(e: any) => setNewForm((prev: any) => ({ ...prev, name: e.target.value }))}
              className={inputClass}
              placeholder="e.g. Work, Production, Home Lab"
            />
          </div>

          <div>
            <label className={labelClass}>Color</label>
            <div className="flex gap-2">
              {COLOR_OPTIONS.map((c: any) => (
                <button
                  key={c}
                  onClick={() => setNewForm((prev: any) => ({ ...prev, color: c }))}
                  className={`w-7 h-7 rounded-lg transition-all ${
                    newForm.color === c
                      ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-800'
                      : 'hover:scale-110'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {isElectronShell() && (
            <div>
              <label className={labelClass}>Connection Mode</label>
              {renderModeToggle(newForm.mode, (mode: any) => {
                setNewForm((prev: any) => ({ ...prev, mode }));
                setTestResult(null);
              })}
            </div>
          )}

          {isElectronShell() &&
            newForm.mode === 'remote' &&
            renderRemoteFields(newForm, setNewForm)}

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => setShowNewForm(false)}
              className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm px-4 py-2 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateOrg}
              disabled={!newForm.name.trim()}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed"
            >
              Create Organization
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowNewForm(true)}
          className="w-full py-3 rounded-xl border border-dashed border-gray-700 hover:border-gray-500 text-gray-400 hover:text-gray-200 text-sm transition-colors flex items-center justify-center gap-2"
        >
          <Plus size={16} /> Add Organization
        </button>
      )}
    </div>
  );
}

/* GitHubAppSection removed — merged into unified GitHubSection */

/**
 * Gemini CLI auth panel — host-wide Gemini API key management.
 * Currently exposes API-key management only (GEMINI_API_KEY).  OAuth via
 * `gemini /auth` is still a terminal-only flow; the status endpoint returns
 * `oauth.loggedIn: null` which we surface as "Not managed here" so users know
 * where to look.
 */
function GeminiAuthSection() {
  const [auth, setAuth] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyValidating, setApiKeyValidating] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<any>(null);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';

  const fetchAuth = async () => {
    setError(null);
    try {
      const data = await api.getGeminiAuth();
      setAuth(data);
    } catch (err: any) {
      setAuth(null);
      setError(err.message || 'Failed to load Gemini auth status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuth();
  }, []);

  const handleSaveApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      const result = await api.setGeminiApiKey(apiKeyInput);
      if (result.ok) {
        setApiKeyStatus({
          type: 'success',
          msg: result.masked ? `Saved: ${result.masked}` : 'API key cleared',
        });
        setApiKeyInput('');
        await fetchAuth();
      }
    } catch (err: any) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeySaving(false);
  };

  const handleClearApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      await api.setGeminiApiKey('');
      setApiKeyStatus({ type: 'success', msg: 'API key cleared' });
      await fetchAuth();
    } catch (err: any) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeySaving(false);
  };

  const handleValidateApiKey = async () => {
    if (!apiKeyInput) return;
    setApiKeyValidating(true);
    setApiKeyStatus(null);
    try {
      const result = await api.validateGeminiApiKey(apiKeyInput);
      setApiKeyStatus({
        type: result.valid ? 'success' : 'error',
        msg: result.output,
      });
    } catch (err: any) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeyValidating(false);
  };

  if (loading)
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
        <Loader2 size={16} className="animate-spin" />
        <span>Loading Gemini auth status...</span>
      </div>
    );

  if (error && !auth)
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
        <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
          <AlertCircle size={16} />
          <span className="font-medium">Failed to load Gemini auth status</span>
        </div>
        <p className="text-xs text-gray-400">{error}</p>
      </div>
    );

  const apiKeyConfigured = auth?.apiKey?.configured;
  const apiKeySource = auth?.apiKey?.source;
  const masked = auth?.apiKey?.masked;
  const activeMethod = auth?.activeMethod;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">Gemini CLI Authentication</h3>
        <p className="text-xs text-gray-500 mb-3">
          Configure the <code>GEMINI_API_KEY</code> used when Agent Hub spawns the{' '}
          <code>gemini</code> CLI. Google-account OAuth via <code>gemini /auth</code> is still
          managed from the terminal and not driven by this panel.
        </p>
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-200">
          Gemini is used only for memory RAG — it powers the wiki/memory semantic search embeddings.
          It is not used as a chat agent. Without a key, memory search falls back to plain full-text
          search.
        </div>
      </div>

      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <Shield size={16} /> Authentication Status
          </h4>
          <span
            className={`text-xs px-2.5 py-1 rounded-full font-medium ${
              activeMethod === 'api-key'
                ? 'bg-blue-500/15 text-blue-400'
                : 'bg-red-500/15 text-red-400'
            }`}
          >
            {activeMethod === 'api-key' ? 'API Key Active' : 'Not configured'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <span className="text-gray-500">API Key</span>
          <span className="text-gray-300 font-mono">
            {apiKeyConfigured ? masked || '••••••••' : '—'}
          </span>
          <span className="text-gray-500">Source</span>
          <span className="text-gray-300">
            {apiKeySource === 'environment'
              ? 'Environment (GEMINI_API_KEY)'
              : apiKeySource === 'config'
                ? 'Config file'
                : 'Not set'}
          </span>
        </div>
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Key size={16} /> Set or update API key
        </h4>
        <p className="text-xs text-gray-500">
          Paste a Google AI Studio API key. Agent Hub will export it as <code>GEMINI_API_KEY</code>{' '}
          when spawning the Gemini CLI.
        </p>

        <div className="flex items-center gap-2">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKeyInput}
            onChange={(e: any) => setApiKeyInput(e.target.value)}
            placeholder="AIza..."
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => setShowApiKey((v: any) => !v)}
            className="text-xs text-gray-400 hover:text-white px-2 py-1.5"
          >
            {showApiKey ? 'Hide' : 'Show'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleValidateApiKey}
            disabled={!apiKeyInput || apiKeyValidating}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
          >
            {apiKeyValidating && <Loader2 size={12} className="animate-spin" />}
            Validate
          </button>
          <button
            onClick={handleSaveApiKey}
            disabled={!apiKeyInput || apiKeySaving}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
          >
            {apiKeySaving ? 'Saving...' : 'Save'}
          </button>
          {apiKeyConfigured && (
            <button
              onClick={handleClearApiKey}
              disabled={apiKeySaving}
              className="text-xs text-red-400 hover:text-red-300 px-2 py-1.5 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {apiKeyStatus && (
          <p
            className={`text-xs ${
              apiKeyStatus.type === 'success' ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {apiKeyStatus.msg}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Codex CLI auth — API key plus ChatGPT device login (`codex login --device-auth`).
 * See https://developers.openai.com/codex/noninteractive
 */
export function GeneralSection() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<any>(null);

  useEffect(() => {
    api
      .getConfig()
      .then((data: any) => {
        setConfig(data);
        setEdits({
          claudeBin: data.claudeBin,
          cursorBin: data.cursorBin,
          geminiBin: data.geminiBin,
          codexBin: data.codexBin,
          grokBin: data.grokBin,
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const isDirty =
    config &&
    (edits.claudeBin !== config.claudeBin ||
      (edits.cursorBin ?? '') !== (config.cursorBin ?? '') ||
      (edits.geminiBin ?? '') !== (config.geminiBin ?? '') ||
      (edits.codexBin ?? '') !== (config.codexBin ?? '') ||
      (edits.grokBin ?? '') !== (config.grokBin ?? ''));

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        claudeBin: edits.claudeBin,
        cursorBin: edits.cursorBin,
        geminiBin: edits.geminiBin,
        codexBin: edits.codexBin,
        grokBin: edits.grokBin,
      };
      await api.updateConfig(payload);
      setConfig((prev: any) => ({ ...prev, ...payload }));
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  if (loading) return <p className="text-sm text-gray-500">Loading config...</p>;
  if (!config) return <p className="text-sm text-red-400">Failed to load config</p>;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">General Settings</h3>
        <p className="text-xs text-gray-500 mb-4">
          CLI binary paths are saved to <code className="text-gray-400">server/config.json</code>.
          Changes take effect for new agent spawns immediately (no restart needed).
        </p>
        {typeof window !== 'undefined' && window.electronAPI?.isElectron && (
          <div className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90 mb-4">
            <Info className="shrink-0 mt-0.5" size={16} aria-hidden />
            <p>
              <span className="font-medium text-amber-50">Desktop app:</span> the embedded server
              prepends common install locations for Git and GitHub CLI to <code>PATH</code> (and
              uses the correct separator on Windows). If Codex or PR features still cannot find{' '}
              <code>git</code>/<code>gh</code>, install them from git-scm.com or cli.github.com,
              then fully quit and reopen Agent Hub. Read-only checkouts or offline networks can
              still block git and API access.
            </p>
          </div>
        )}
      </div>

      {!isElectron() && (
        <div className="bg-gray-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Monitor size={16} className="text-sky-400 shrink-0" />
            <h4 className="text-sm font-medium text-gray-300">Desktop App</h4>
          </div>
          <p className="text-xs text-gray-500">
            Agent Hub ships a native desktop app (macOS) that bundles its own server and handles
            <code className="text-gray-400"> PATH</code> setup for Git and the GitHub CLI. Grab the
            latest build from the releases bucket.
          </p>
          <a
            href={RELEASE_BUCKET_ROOT}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 transition-colors"
          >
            <Download size={14} />
            Download desktop app
            <ExternalLink size={11} />
          </a>
        </div>
      )}

      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-300">CLI Binary Paths</h4>

        <div>
          <label className={labelClass}>Claude Code CLI</label>
          <input
            value={edits.claudeBin || ''}
            onChange={(e: any) => setEdits((prev: any) => ({ ...prev, claudeBin: e.target.value }))}
            className={inputClass}
            placeholder="/usr/local/bin/claude"
          />
          <p className="text-xs text-gray-600 mt-1">
            Path to the <code>claude</code> binary. Used for all claude-code engine sessions.
          </p>
        </div>

        <div>
          <label className={labelClass}>Cursor Agent CLI</label>
          <input
            value={edits.cursorBin || ''}
            onChange={(e: any) => setEdits((prev: any) => ({ ...prev, cursorBin: e.target.value }))}
            className={inputClass}
            placeholder="/usr/local/bin/agent"
          />
          <p className="text-xs text-gray-600 mt-1">
            Path to the <code>cursor-agent</code> binary (or its <code>agent</code> symlink, install
            via <code>curl -fsSL https://cursor.com/install | bash</code>). Used for all
            cursor-agent engine sessions.
          </p>
        </div>

        <div>
          <label className={labelClass}>Gemini CLI</label>
          <input
            value={edits.geminiBin || ''}
            onChange={(e: any) => setEdits((prev: any) => ({ ...prev, geminiBin: e.target.value }))}
            className={inputClass}
            placeholder="/usr/local/bin/gemini"
          />
          <p className="text-xs text-gray-600 mt-1">
            Path to the <code>gemini</code> binary (install via{' '}
            <code>npm install -g @google/gemini-cli</code>). Used for all gemini-cli engine
            sessions.
          </p>
        </div>

        <div>
          <label className={labelClass}>Codex CLI</label>
          <input
            value={edits.codexBin || ''}
            onChange={(e: any) => setEdits((prev: any) => ({ ...prev, codexBin: e.target.value }))}
            className={inputClass}
            placeholder="/usr/local/bin/codex"
          />
          <p className="text-xs text-gray-600 mt-1">
            Path to the <code>codex</code> binary (install via{' '}
            <code>npm install -g @openai/codex</code>). Used for all codex-cli engine sessions.
          </p>
        </div>

        <div>
          <label className={labelClass}>Grok Build CLI</label>
          <input
            value={edits.grokBin || ''}
            onChange={(e: any) => setEdits((prev: any) => ({ ...prev, grokBin: e.target.value }))}
            className={inputClass}
            placeholder="/usr/local/bin/grok"
          />
          <p className="text-xs text-gray-600 mt-1">
            Path to the <code>grok</code> binary (xAI Grok Build CLI). Used for all grok-cli engine
            sessions. Auth uses <code>XAI_API_KEY</code> or <code>grok login</code>.
          </p>
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            {saveStatus === 'saved' && <span className="text-xs text-emerald-400">✓ Saved</span>}
            {saveStatus === 'error' && (
              <span className="text-xs text-red-400">✕ Failed to save</span>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-2">
        <h4 className="text-sm font-medium text-gray-300">Current Config</h4>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <span className="text-gray-500">Port</span>
          <span className="text-gray-300 font-mono">{config.port}</span>
          <span className="text-gray-500">Default CWD</span>
          <span className="text-gray-300 font-mono truncate">{config.defaultCwd}</span>
          <span className="text-gray-500">Default Model</span>
          <span className="text-gray-300 font-mono">{config.defaultModel}</span>
        </div>
      </div>
    </div>
  );
}

export function GitHubSection() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">GitHub Settings</h3>
        <p className="text-xs text-gray-500 mb-4">
          Two independent pieces: <span className="text-gray-300">your GitHub account</span>{' '}
          (sign-in for PR actions) and <span className="text-gray-300">an OAuth App</span>{' '}
          (server-wide; powers &ldquo;Sign in with GitHub&rdquo; without PATs). Per-project repo
          links live on the <span className="text-gray-300">Projects</span> tab.
        </p>
      </div>

      {/* Personal GitHub OAuth — the connected account used for PR actions. */}
      <GithubConnectionSection />

      {/* Server-level OAuth App credentials. */}
      <PersonalOAuthConfigSection />
    </div>
  );
}

/**
 * ProjectsSection — per-project repository, workflow, and lifecycle settings.
 *
 * Split out of GitHubSection so the sidebar can navigate to "Projects" as its
 * own surface, separate from the personal GitHub account / GitHub App config
 * on the GitHub tab. The deep-link from the per-project Workflows page
 * (settings:projects) still expands a single project card on mount.
 */
export function ProjectsSection({
  projects = [],
  onProjectsChange,
  showToast,
  /** When set (e.g. deep-link from Workflows page), expand this project card on load. */
  initialExpandedProjectId = null,
  /** When set, show only this project's settings (sidebar Project settings view). */
  projectId = null,
}: any) {
  const visibleProjects = useMemo(
    () => (projectId ? projects.filter((p: any) => p.id === projectId) : projects),
    [projects, projectId],
  );
  const singleProjectMode = !!projectId;
  const [expandedProject, setExpandedProject] = useState<any>(null);
  /** One-shot deep-link expand — do not re-expand on `projects` identity churn after manual collapse. */
  const lastDeepLinkExpandIdRef = useRef<any>(null);

  // Per-project repo test
  const [repoTesting, setRepoTesting] = useState<Record<string, any>>({});
  const [repoTestResult, setRepoTestResult] = useState<Record<string, any>>({});

  // Per-project AWS-enabled toggle (in-flight guard while persisting).
  const [awsSaving, setAwsSaving] = useState<Record<string, any>>({});

  // Project delete confirmation (inline toggle pattern)
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<any>(null);

  useEffect(() => {
    if (!initialExpandedProjectId) {
      lastDeepLinkExpandIdRef.current = null;
      return;
    }
    if (!projects.some((p: any) => p.id === initialExpandedProjectId)) return;
    if (lastDeepLinkExpandIdRef.current === initialExpandedProjectId) return;
    setExpandedProject(initialExpandedProjectId);
    lastDeepLinkExpandIdRef.current = initialExpandedProjectId;
  }, [initialExpandedProjectId, projects]);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  // --- Per-project handlers ---

  const toggleAwsEnabled = async (project: any) => {
    const next = !project.awsEnabled;
    setAwsSaving((prev: any) => ({ ...prev, [project.id]: true }));
    try {
      await api.updateProject(project.id, { awsEnabled: next });
      if (onProjectsChange) onProjectsChange();
    } catch (err: any) {
      const msg = String(err?.message || err || 'Failed to update');
      if (showToast) showToast(msg, 'error');
      else alert(msg);
    } finally {
      setAwsSaving((prev: any) => ({ ...prev, [project.id]: false }));
    }
  };

  const testProjectConnection = async (project: any) => {
    setRepoTesting((prev: any) => ({ ...prev, [project.id]: true }));
    setRepoTestResult((prev: any) => ({ ...prev, [project.id]: null }));
    try {
      const repo = project.githubRepo;
      if (!repo) {
        setRepoTestResult((prev: any) => ({
          ...prev,
          [project.id]: { ok: false, error: 'No repo configured' },
        }));
        return;
      }
      const [owner, repoName] = repo.split('/');
      const testRes = await fetch(`${getApiBase()}/github/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ owner, repo: repoName }),
      });
      const result = await testRes.json();
      setRepoTestResult((prev: any) => ({
        ...prev,
        [project.id]: result.ok
          ? { ok: true, detail: `${repo} (${result.repoInfo.private ? 'private' : 'public'})` }
          : { ok: false, error: result.error },
      }));
    } catch {
      setRepoTestResult((prev: any) => ({
        ...prev,
        [project.id]: { ok: false, error: 'Request failed' },
      }));
    } finally {
      setRepoTesting((prev: any) => ({ ...prev, [project.id]: false }));
    }
  };

  const handleDeleteProject = async (projectId: any) => {
    if (confirmDeleteProject === projectId) {
      try {
        await api.deleteProject(projectId);
        if (onProjectsChange) onProjectsChange();
      } catch (err: any) {
        console.error('Failed to delete project:', err);
      }
      setConfirmDeleteProject(null);
    } else {
      setConfirmDeleteProject(projectId);
      setTimeout(() => setConfirmDeleteProject(null), 3000);
    }
  };

  const projectSettingsBody = (p: any) => (
    <div className={singleProjectMode ? 'space-y-4' : 'pl-8 pt-3 space-y-4'}>
      <ProjectSecretsEditor projectId={p.id} />

      {/* Per-user default Finalize automation level for new sessions in this
          project. Scoped to the signed-in user. */}
      <ProjectDefaultAutomationSection projectId={p.id} />

      {/* Agent Hub git hosting — host the repo on the Hub itself; GitHub
          becomes an optional downstream mirror. Self-contained: fetches
          its own status and hides when the endpoint is unavailable. */}
      <GitHostSettingsSection
        project={p}
        showToast={showToast}
        onProjectsChange={onProjectsChange}
      />

      {/* AWS toggle — when enabled, an "AWS" entry appears in the
                        per-project sidebar where SSO profiles are managed. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <span className="text-sm text-gray-200">AWS</span>
          <p className="text-xs text-gray-500">
            Enable AWS IAM Identity Center (SSO) for this project. When on, an <strong>AWS</strong>{' '}
            entry appears under the project in the sidebar for managing SSO profiles.
          </p>
        </div>
        <button
          onClick={() => toggleAwsEnabled(p)}
          disabled={awsSaving[p.id]}
          data-testid={`project-aws-enabled-${p.id}`}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
            p.awsEnabled ? 'bg-emerald-600' : 'bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              p.awsEnabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div className="space-y-2" data-testid={`project-visibility-${p.id}`}>
        <label className={labelClass}>Visibility</label>
        <p className="text-xs text-gray-500">
          <strong>Shared</strong> (default): every member of your org can see and enter this
          project. <strong>Private</strong>: visible only to you; org Owners retain a delete-only
          kill switch from the admin list. Flipping a shared project private is restricted to org
          Owners (it hides the project from collaborators); the current owner or any org Owner can
          publish a private project back to shared.
        </p>
        <select
          value={p.visibility === 'private' ? 'private' : 'shared'}
          data-testid={`project-visibility-select-${p.id}`}
          onChange={async (e: any) => {
            const visibility = e.target.value;
            try {
              await api.updateProject(p.id, { visibility });
              if (onProjectsChange) onProjectsChange();
            } catch (err: any) {
              const msg = String(err.message || err);
              if (showToast) showToast(msg, 'error');
              else alert(msg);
            }
          }}
          className={inputClass}
        >
          <option value="shared">Shared (org-wide)</option>
          <option value="private">Private (only me)</option>
        </select>
      </div>

      <div className="space-y-2">
        <label className={labelClass}>Project mode</label>
        <p className="text-xs text-gray-500">
          <strong>Dev</strong> (default): kanban lifecycle, per-session worktrees, and GitHub PR
          flows. <strong>Workflow</strong>: work in the project checkout; session PR flows stay off.
          For a <strong>tasks-only project</strong> (just wiki, board, sessions, crons, heartbeats —
          no git or GitHub), pick <em>Workflow</em>.
        </p>
        <select
          value={isWorkflowProject(p) ? 'workflow' : 'dev'}
          onChange={async (e: any) => {
            const mode = e.target.value;
            try {
              await api.updateProject(p.id, { mode });
              if (onProjectsChange) onProjectsChange();
            } catch (err: any) {
              const msg = String(err.message || err);
              if (showToast) showToast(msg, 'error');
              else alert(msg);
            }
          }}
          className={inputClass}
        >
          <option value="dev">Dev (GitHub-connected)</option>
          <option value="workflow">Workflow / Tasks-only (no PR automation)</option>
        </select>
      </div>

      {/* Test Connection */}
      <div className="pt-2 border-t border-gray-800">
        <div className="flex items-center gap-3">
          <button
            onClick={() => testProjectConnection(p)}
            disabled={repoTesting[p.id]}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
          >
            {repoTesting[p.id] ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Plug size={12} />
            )}
            {repoTesting[p.id] ? 'Testing...' : 'Test Connection'}
          </button>
          {repoTestResult[p.id] && (
            <span
              className={`text-xs ${repoTestResult[p.id].ok ? 'text-emerald-400' : 'text-red-400'}`}
            >
              {repoTestResult[p.id].ok
                ? `Connected to ${repoTestResult[p.id].detail}`
                : repoTestResult[p.id].error}
            </span>
          )}
        </div>
      </div>

      {/* Delete Project */}
      <div className="pt-2 border-t border-gray-800">
        <button
          onClick={() => handleDeleteProject(p.id)}
          className={`text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
            confirmDeleteProject === p.id
              ? 'bg-red-600 text-white'
              : 'text-gray-500 hover:text-red-400 hover:bg-gray-800'
          }`}
          title={
            confirmDeleteProject === p.id
              ? 'Click again to confirm deletion'
              : 'Delete this project and all associated data'
          }
        >
          <Trash2 size={12} />
          {confirmDeleteProject === p.id ? 'Confirm Delete Project' : 'Delete Project'}
        </button>
        {confirmDeleteProject === p.id && (
          <p className="text-xs text-red-400 mt-1">
            This will permanently delete all agents, sessions, board, wiki, and other data.
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">
          {singleProjectMode ? 'Project settings' : 'Projects'}
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          {singleProjectMode
            ? 'Configure secrets, visibility, and lifecycle settings for this project.'
            : 'Configure secrets, visibility, and lifecycle settings for each project.'}
        </p>
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        {!singleProjectMode && (
          <>
            <h4 className="text-sm font-medium text-gray-300">Project Settings</h4>
            <p className="text-xs text-gray-500">
              The GitHub repository is linked automatically when a project is created or connected.
            </p>
          </>
        )}

        {visibleProjects.length === 0 && (
          <p className="text-xs text-gray-600 italic">No projects configured yet.</p>
        )}

        <div className="space-y-2">
          {visibleProjects.map((p: any) => {
            const isExpanded = singleProjectMode || expandedProject === p.id;
            const repo = p.githubRepo || '';

            if (singleProjectMode) {
              return (
                <div key={p.id} className="space-y-4">
                  {projectSettingsBody(p)}
                </div>
              );
            }

            return (
              <div key={p.id} className="bg-gray-900/50 rounded-lg p-3">
                <div
                  className="flex items-center gap-3 cursor-pointer"
                  onClick={() => setExpandedProject(isExpanded ? null : p.id)}
                >
                  {isExpanded ? (
                    <ChevronDown size={16} className="text-gray-500 flex-shrink-0" />
                  ) : (
                    <ChevronRight size={16} className="text-gray-500 flex-shrink-0" />
                  )}
                  <div
                    className="w-3 h-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: p.color }}
                  />
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {repo ? (
                      <>
                        <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
                        <span className="text-xs text-gray-400 font-mono">{repo}</span>
                      </>
                    ) : (
                      <span className="text-xs text-gray-600">No repo linked</span>
                    )}
                  </span>
                </div>
                {isExpanded && projectSettingsBody(p)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function HeartbeatSection({
  onNavigate,
  showToast,
  projectId = null,
  refreshMs = 60_000,
}: any) {
  const [heartbeats, setHeartbeats] = useState<any[]>([]);
  const [expandedAgent, setExpandedAgent] = useState<any>(null);
  const [logs, setLogs] = useState<Record<string, any>>({});
  const [running, setRunning] = useState<Record<string, any>>({});
  const [editingId, setEditingId] = useState<any>(null);
  const [editForm, setEditForm] = useState({
    interval: '',
    prompt: '',
    model: '',
    shared: false,
  });
  // Heartbeats always spawn the Claude CLI, so the picker is locked to the
  // claude-code engine catalog from /api/config/models. We fetch it lazily
  // on mount; an empty list means Claude is unauthenticated and the picker
  // hides itself.
  const [claudeModels, setClaudeModels] = useState<any[]>([]);
  // Tick every 30s so the "next run in Xm" badges decrement live without
  // hitting the network. Server is re-polled every 60s for fresh state.
  const [, setTick] = useState(0);

  const visibleHeartbeats = useMemo(
    () => (projectId ? heartbeats.filter((hb: any) => hb.projectId === projectId) : heartbeats),
    [heartbeats, projectId],
  );

  useEffect(() => {
    const refresh = () => api.getHeartbeats().then(setHeartbeats).catch(console.error);
    refresh();
    api
      .getModelConfig()
      .then((cfg: any) => setClaudeModels(cfg?.engineValidModels?.['claude-code'] || []))
      .catch((err: any) => console.warn('[HeartbeatSection] getModelConfig failed:', err?.message));
    const pollId = setInterval(refresh, refreshMs);
    const tickId = setInterval(() => setTick((t: any) => t + 1), 30_000);
    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, [refreshMs]);

  useEffect(() => {
    if (!editingId) return;
    const editingHeartbeat = visibleHeartbeats.find((hb: any) => hb.agentId === editingId);
    if (editingHeartbeat && !editingHeartbeat.can_manage) {
      setEditingId(null);
    }
  }, [editingId, visibleHeartbeats]);

  const loadLogs = async (agentId: any) => {
    if (expandedAgent === agentId) {
      setExpandedAgent(null);
      return;
    }
    setExpandedAgent(agentId);
    const data = await api.getHeartbeatLogs(agentId, 20);
    setLogs((prev: any) => ({ ...prev, [agentId]: data }));
  };

  const toggleHeartbeat = async (agentId: any, current: any) => {
    try {
      const updated = await api.updateHeartbeat(agentId, { enabled: !current });
      setHeartbeats((prev: any) =>
        prev.map((h: any) => (h.agentId === agentId ? { ...h, ...updated } : h)),
      );
    } catch (e: any) {
      console.error('Failed to update heartbeat:', e);
      showToast?.(e?.message || 'Failed to update heartbeat.', 'error');
    }
  };

  const triggerRun = async (agentId: any) => {
    setRunning((prev: any) => ({ ...prev, [agentId]: true }));
    try {
      await api.runHeartbeat(agentId);
    } catch (e: any) {
      console.error(e);
    }
    setTimeout(() => setRunning((prev: any) => ({ ...prev, [agentId]: false })), 3000);
  };

  const viewThread = async (hb: any) => {
    if (!onNavigate) return;
    try {
      const { thread } = await api.getHeartbeatThread(hb.agentId);
      if (thread) {
        onNavigate('threads', { projectId: thread.project_id, threadId: thread.id, thread });
      } else {
        showToast?.('No thread yet — run this heartbeat at least once to create a thread.', 'info');
      }
    } catch (e: any) {
      console.error('Failed to fetch heartbeat thread:', e);
      showToast?.('Failed to load heartbeat thread.', 'error');
    }
  };

  const startEdit = (hb: any) => {
    setEditingId(hb.agentId);
    setEditForm({
      interval: hb.heartbeat.interval || '',
      prompt: hb.heartbeat.prompt || '',
      model: hb.heartbeat.model || '',
      shared: !!hb.shared,
    });
  };

  const saveEdit = async (e: any) => {
    e.preventDefault();
    const heartbeat = visibleHeartbeats.find((hb: any) => hb.agentId === editingId);
    if (!heartbeat?.can_manage) {
      setEditingId(null);
      return;
    }
    // Send empty string explicitly so the server can clear an existing
    // model override (PUT route maps "" → undefined).
    try {
      const updated = await api.updateHeartbeat(editingId, {
        interval: editForm.interval,
        prompt: editForm.prompt,
        model: editForm.model || '',
        shared: editForm.shared,
      });
      setHeartbeats((prev: any) =>
        prev.map((h: any) => (h.agentId === editingId ? { ...h, ...updated } : h)),
      );
      setEditingId(null);
    } catch (e: any) {
      console.error('Failed to save heartbeat:', e);
      showToast?.(e?.message || 'Failed to save heartbeat.', 'error');
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Agent Heartbeats</h3>
      <div className="space-y-3">
        {visibleHeartbeats.map((hb: any) => (
          <div key={hb.agentId} className="bg-gray-800 rounded-xl overflow-hidden">
            {editingId === hb.agentId && hb.can_manage ? (
              <form onSubmit={saveEdit} className="p-4 space-y-3">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: hb.color }}
                  />
                  <span className="font-medium text-sm">{hb.agentName}</span>
                </div>
                <input
                  value={editForm.interval}
                  onChange={(e: any) => setEditForm({ ...editForm, interval: e.target.value })}
                  placeholder="Cron schedule (e.g. 0 */12 * * *)"
                  required
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                />
                {editForm.interval && humanCron(editForm.interval) !== editForm.interval && (
                  <p className="text-xs text-blue-400 mt-1 ml-1">
                    ↳ {humanCron(editForm.interval)}
                  </p>
                )}
                <textarea
                  value={editForm.prompt}
                  onChange={(e: any) => setEditForm({ ...editForm, prompt: e.target.value })}
                  placeholder="Heartbeat prompt"
                  required
                  rows={4}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
                />
                {claudeModels.length > 0 && (
                  <div>
                    <label
                      htmlFor={`heartbeat-model-${hb.agentId}`}
                      className="block text-xs font-medium text-gray-400 mb-1"
                    >
                      Model
                    </label>
                    <select
                      id={`heartbeat-model-${hb.agentId}`}
                      value={editForm.model || ''}
                      onChange={(e: any) => setEditForm({ ...editForm, model: e.target.value })}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                    >
                      <option value="">CLI default</option>
                      {claudeModels.map((m: any) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      Forwarded as <code className="font-mono">--model</code> to the Claude CLI for
                      both scheduled and manual runs. Leave on “CLI default” to fall back to the
                      binary’s built-in default.
                    </p>
                  </div>
                )}
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!editForm.shared}
                    onChange={(e: any) => setEditForm({ ...editForm, shared: e.target.checked })}
                    className="mt-0.5 accent-blue-500"
                  />
                  <span className="text-xs text-gray-300">
                    Shared
                    <span className="block text-gray-500">
                      Visible to the org. Runs still use the owner credentials.
                    </span>
                  </span>
                </label>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex items-center gap-3 p-4">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: hb.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{hb.agentName}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                      {hb.shared ? 'Shared' : 'Private'}
                    </span>
                    {hb.owner_username && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-900 text-gray-400 border border-gray-700">
                        Owner: {hb.owner_username}
                      </span>
                    )}
                    <span className="text-xs text-gray-500 font-mono" title={hb.heartbeat.interval}>
                      {hb.heartbeat.interval ? humanCron(hb.heartbeat.interval) : 'not set'}
                    </span>
                    {hb.heartbeat.enabled &&
                      hb.state?.next_run_at &&
                      (() => {
                        const { label, overdue } = relativeFuture(hb.state.next_run_at);
                        return (
                          <span
                            title={`Next run: ${formatDateTime(hb.state.next_run_at)}`}
                            className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                              overdue
                                ? 'bg-amber-900/40 text-amber-400'
                                : 'bg-gray-700/60 text-gray-400'
                            }`}
                          >
                            {label}
                          </span>
                        );
                      })()}
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-0.5">
                    {hb.heartbeat.prompt || 'No prompt configured'}
                  </p>
                  {hb.heartbeat.model && (
                    <p className="text-xs text-gray-500 mt-0.5 font-mono" title="Heartbeat model">
                      model: {hb.heartbeat.model}
                    </p>
                  )}
                  <label className="mt-2 inline-flex items-center gap-2 text-xs text-gray-300">
                    <input
                      type="checkbox"
                      checked={!!hb.shared}
                      disabled={!hb.can_manage}
                      onChange={async (e: any) => {
                        try {
                          const updated = await api.updateHeartbeat(hb.agentId, {
                            shared: e.target.checked,
                          });
                          setHeartbeats((prev: any) =>
                            prev.map((h: any) =>
                              h.agentId === hb.agentId ? { ...h, ...updated } : h,
                            ),
                          );
                        } catch (err: any) {
                          console.error('Failed to update heartbeat sharing:', err);
                          showToast?.(
                            err?.message || 'Failed to update heartbeat sharing.',
                            'error',
                          );
                        }
                      }}
                      className="accent-blue-500 disabled:opacity-40"
                    />
                    Shared
                  </label>
                  {hb.latestLog && (
                    <p className="text-xs text-gray-600 mt-0.5">
                      Last run: {relativeTime(hb.latestLog.timestamp)} —{' '}
                      <span
                        className={
                          hb.latestLog.status === 'success'
                            ? 'text-emerald-500'
                            : hb.latestLog.status === 'error'
                              ? 'text-red-400'
                              : 'text-yellow-400'
                        }
                      >
                        {hb.latestLog.status}
                      </span>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 sm:gap-2">
                  {onNavigate && (
                    <button
                      onClick={() => viewThread(hb)}
                      className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-2 sm:py-1 rounded-md transition-colors min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                      title="View thread"
                    >
                      <ScrollText size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => startEdit(hb)}
                    disabled={!hb.can_manage}
                    aria-label="Edit heartbeat"
                    className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-2 sm:py-1 rounded-md transition-colors min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => triggerRun(hb.agentId)}
                    disabled={running[hb.agentId] || !hb.can_manage}
                    className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-2 sm:py-1 rounded-md transition-colors disabled:opacity-50 min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                  >
                    {running[hb.agentId] ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Play size={14} />
                    )}
                  </button>
                  <button
                    onClick={() => toggleHeartbeat(hb.agentId, hb.heartbeat.enabled)}
                    disabled={!hb.can_manage}
                    className={`text-xs px-2.5 py-2 sm:py-1 rounded-md transition-colors disabled:opacity-40 min-h-[36px] sm:min-h-0 flex items-center ${
                      hb.heartbeat.enabled
                        ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    {hb.heartbeat.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button
                    onClick={() => loadLogs(hb.agentId)}
                    className="text-xs text-gray-400 hover:text-white px-2 py-2 sm:py-1 min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                  >
                    <span className="text-2xl leading-none flex items-center">
                      {expandedAgent === hb.agentId ? '▲' : '▼'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {expandedAgent === hb.agentId && (
              <div className="border-t border-gray-700 p-4 max-h-64 overflow-y-auto">
                {(logs[hb.agentId] || []).length === 0 ? (
                  <p className="text-xs text-gray-500">No logs yet</p>
                ) : (
                  <div className="space-y-2">
                    {(logs[hb.agentId] || []).map((log: any) => (
                      <div key={log.id} className="bg-gray-900 rounded-lg p-3 text-xs">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`px-1.5 py-0.5 rounded text-xs ${
                              log.status === 'success'
                                ? 'bg-emerald-900/50 text-emerald-400'
                                : log.status === 'error'
                                  ? 'bg-red-900/50 text-red-400'
                                  : 'bg-yellow-900/50 text-yellow-400'
                            }`}
                          >
                            {log.status}
                          </span>
                          <span className="text-gray-500">{relativeTime(log.timestamp)}</span>
                        </div>
                        <pre className="text-gray-300 whitespace-pre-wrap text-xs max-h-32 overflow-y-auto">
                          {log.result || '(running...)'}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CronSection({ projects = [], onNavigate, showToast, projectId = null }: any) {
  const scopedProjects = useMemo(
    () => (projectId ? projects.filter((p: any) => p.id === projectId) : projects),
    [projects, projectId],
  );
  const defaultCwd = scopedProjects[0]?.cwd || '';
  const [crons, setCrons] = useState<any[]>([]);
  const [running, setRunning] = useState<Record<string, any>>({});
  const [showForm, setShowForm] = useState(false);
  const [, setTick] = useState(0);
  const [cronLogs, setCronLogs] = useState<Record<string, any>>({}); // { [cronId]: log[] }
  const [expandedLog, setExpandedLog] = useState<any>(null); // "cronId:logId"
  const [editingId, setEditingId] = useState<any>(null);
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  // Model + engine allowlist fetched once from /api/config/models so the
  // dropdowns stay in sync with the server's engineValidModels (config.ts)
  // without us hardcoding the list here. The dropdowns stay hidden until
  // the fetch resolves so we never present an empty <select>.
  const [modelConfig, setModelConfig] = useState<any>(null);
  const [form, setForm] = useState({
    name: '',
    schedule: '*/30 * * * *',
    prompt: '',
    cwd: defaultCwd,
    project_id: projectId || scopedProjects[0]?.id || '',
    enabled: true,
    // Timeout expressed in minutes in the form; '' means "use server default".
    timeoutMinutes: '',
    // Per-cron opt-in for "ran successfully" push notifications. Off by
    // default — historically every cron pinged every device on every tick,
    // which mobile users complained about. Users explicitly enable on the
    // crons they actually want notifications for.
    notify_on_run: false,
    // Empty string = "use the resolved engine's default" (see
    // resolveCronEngine on the server). The blank option is the first
    // entry in the model dropdown so existing crons don't auto-pin to a
    // specific id when an operator opens the form.
    model: '',
    // Empty string = "inherit from skill principal agent at run time,
    // falling back to claude-code". Per-row engine override lets a
    // Codex/Cursor/Gemini cron run under its real engine instead of the
    // historical claude-code default.
    engine: '',
    shared: false,
  });

  const visibleCrons = useMemo(
    () => (projectId ? crons.filter((c: any) => c.project_id === projectId) : crons),
    [crons, projectId],
  );

  /** Fetch last-3 logs for every cron */
  const refreshLogs = async (cronList: any) => {
    const entries = await Promise.all(
      (cronList || crons).map(async (c: any) => {
        try {
          const logs = await api.getCronLogs(c.id, 3);
          return [c.id, logs];
        } catch {
          return [c.id, []];
        }
      }),
    );
    setCronLogs(Object.fromEntries(entries));
  };

  useEffect(() => {
    const refresh = async () => {
      try {
        const data = await api.getCrons();
        setCrons(data);
        await refreshLogs(data);
      } catch (e: any) {
        console.error(e);
      }
    };
    refresh();
    const pollId = setInterval(refresh, 60_000);
    const tickId = setInterval(() => setTick((t: any) => t + 1), 30_000);

    // Fire-and-forget: hydrate the model dropdown from the server's
    // engineValidModels. Failures fall back to a hidden dropdown rather
    // than blocking cron CRUD — operators can still create crons that
    // run with the engine default.
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => {});

    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  /**
   * Default engine for a cron with `engine = ''` (blank/null in DB).
   * Mirrors `DEFAULT_CRON_ENGINE` on the server (`server/cron-engine.ts`)
   * — historically every cron targeted Claude Code, so the model
   * dropdown also falls back to claude-code's allowlist when the engine
   * picker is left blank.
   */
  const DEFAULT_ENGINE = 'claude-code';

  /**
   * Engines surfaced in the picker — sourced from the server's
   * `engineValidModels` keys so new engines appear automatically (same
   * pattern as the bulk agent engine picker in `AgentConfigSection`).
   * Filters out engines with no configured models so we don't present an
   * empty model dropdown after the engine switch.
   */
  const engineChoices = useMemo(() => {
    if (!modelConfig?.engineValidModels) return [];
    return Object.keys(modelConfig.engineValidModels).filter(
      (e: any) => (modelConfig.engineValidModels[e]?.length ?? 0) > 0,
    );
  }, [modelConfig]);

  /**
   * Model allowlist for the engine the cron will run under. When the
   * picker is left blank we render claude-code's allowlist — that's the
   * engine the server resolves to when neither an explicit engine nor a
   * skill principal is set (`resolveCronEngine`).
   */
  const modelsForEngine = (engine: any) => {
    const key = engine || DEFAULT_ENGINE;
    return modelConfig?.engineValidModels?.[key] || [];
  };

  const defaultModelForEngine = (engine: any) => {
    const key = engine || DEFAULT_ENGINE;
    return modelConfig?.engineDefaultModels?.[key] || '';
  };

  /**
   * Raw skill-principal lookup that returns the agent's engine even when it
   * matches `DEFAULT_ENGINE`. `inheritedEngineFromPrincipal` suppresses
   * claude-code matches so the helper text only fires for non-default
   * inheritance, but the model-dropdown filter must still use the real
   * engine in both cases (otherwise switching the project's principal to a
   * claude-code agent would expose every engine's models in the dropdown).
   */
  const resolvedSkillPrincipalEngine = (formState: any) => {
    const project = projects.find((p: any) => p.id === formState?.project_id);
    if (!project) return null;
    const principalId =
      (formState?.skill_principal_agent_id || '').trim() ||
      (project.cronSkillPrincipalAgentId || '').trim() ||
      (project.agents?.length === 1 ? project.agents[0].id : '');
    if (!principalId) return null;
    const agent = (project.agents || []).find((a: any) => a.id === principalId);
    return agent?.engine || null;
  };

  /**
   * Engine the cron will actually run under given the form state — the
   * explicit picker value when set, otherwise the inherited engine from
   * the skill principal, finally falling back to claude-code. The model
   * dropdown filters on this so the operator can't accidentally save a
   * Cursor id under a cron whose project resolves to Codex.
   */
  const effectiveEngineForModels = (formState: any) =>
    formState?.engine || resolvedSkillPrincipalEngine(formState) || DEFAULT_ENGINE;

  /**
   * When the engine is left blank, the server resolves it via the cron's
   * skill principal agent (`resolveCronEngine` → `resolveCronSkillPrincipalAgentId`).
   * Mirror that resolution order so the operator sees the same engine
   * the server would actually pick at run time:
   *   1. cron.skill_principal_agent_id
   *   2. project.cronSkillPrincipalAgentId
   *   3. project.agents (sole-agent fallback)
   * Returns null when nothing resolves — the dropdown then advertises the
   * historical claude-code default.
   */
  const inheritedEngineFromPrincipal = (formState: any) => {
    if (formState?.engine) return null;
    const project = projects.find((p: any) => p.id === formState?.project_id);
    if (!project) return null;
    const principalId =
      (formState.skill_principal_agent_id || '').trim() ||
      (project.cronSkillPrincipalAgentId || '').trim() ||
      (project.agents?.length === 1 ? project.agents[0].id : '');
    if (!principalId) return null;
    const agent = (project.agents || []).find((a: any) => a.id === principalId);
    return agent?.engine && agent.engine !== DEFAULT_ENGINE ? agent.engine : null;
  };

  const viewThread = async (cronJob: any) => {
    if (!onNavigate) return;
    try {
      const { thread } = await api.getCronThread(cronJob.id);
      if (thread) {
        onNavigate('threads', { projectId: thread.project_id, threadId: thread.id, thread });
      } else {
        showToast?.('No thread yet — run this cron job at least once to create a thread.', 'info');
      }
    } catch (e: any) {
      console.error('Failed to fetch cron thread:', e);
      showToast?.('Failed to load cron thread.', 'error');
    }
  };

  const toggleCron = async (cronJob: any) => {
    const updated = await api.updateCron(cronJob.id, {
      enabled: !cronJob.enabled,
    });
    setCrons((prev: any) => prev.map((c: any) => (c.id === updated.id ? updated : c)));
  };

  const triggerRun = async (id: any) => {
    setRunning((prev: any) => ({ ...prev, [id]: true }));
    try {
      await api.runCron(id);
    } catch (e: any) {
      console.error(e);
    }
    setTimeout(() => setRunning((prev: any) => ({ ...prev, [id]: false })), 3000);
  };

  const deleteCron = async (id: any) => {
    await api.deleteCron(id);
    setCrons((prev: any) => prev.filter((c: any) => c.id !== id));
  };

  /**
   * Convert the form's minutes field into the API's `timeout_ms` contract:
   *   - blank → null (use server default)
   *   - positive integer → minutes * 60_000
   * Returns `undefined` when the field is invalid so the caller can surface an
   * error instead of silently wiping the existing override.
   */
  const minutesToTimeoutMs = (minutes: any) => {
    if (minutes === '' || minutes === null || minutes === undefined) return null;
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.round(n * 60_000);
  };

  const createCron = async (e: any) => {
    e.preventDefault();
    const timeout_ms = minutesToTimeoutMs(form.timeoutMinutes);
    if (timeout_ms === undefined) {
      showToast?.('Timeout must be a positive number of minutes.', 'error');
      return;
    }
    const payload: Record<string, any> = { ...form, timeout_ms };
    delete payload.timeoutMinutes;
    // The API's normalizeModel / normalizeCronEngine treat '' as null (=
    // "use engine default" / "inherit from skill principal"). Passing the
    // empty string explicitly keeps the round-trip stable: the row stores
    // NULL, the dropdown stays on "Default" when the cron is re-opened
    // for editing.
    const created = await api.createCron(payload);
    setCrons((prev: any) => [...prev, created]);
    setShowForm(false);
    setForm({
      name: '',
      schedule: '*/30 * * * *',
      prompt: '',
      cwd: defaultCwd,
      project_id: projectId || scopedProjects[0]?.id || '',
      enabled: true,
      timeoutMinutes: '',
      notify_on_run: false,
      model: '',
      engine: '',
      shared: false,
    });
  };

  const startEditing = (cronJob: any) => {
    setEditingId(cronJob.id);
    setEditForm({
      name: cronJob.name,
      schedule: cronJob.schedule,
      prompt: cronJob.prompt,
      cwd: cronJob.cwd || '',
      project_id: cronJob.project_id || '',
      timeoutMinutes: cronJob.timeout_ms ? String(Math.round(cronJob.timeout_ms / 60_000)) : '',
      notify_on_run: !!cronJob.notify_on_run,
      // Null in the DB = "use engine default" — render as the empty option.
      model: cronJob.model || '',
      engine: cronJob.engine || '',
      shared: !!cronJob.shared,
      // Preserve the skill principal id so the helper text can compute
      // the inherited engine. The form itself doesn't expose this field
      // (it's set via the project's principal agent), but PUT /api/crons
      // preserves the field when it's omitted from the payload.
      skill_principal_agent_id: cronJob.skill_principal_agent_id || '',
    });
  };

  const saveEdit = async (e: any) => {
    e.preventDefault();
    const timeout_ms = minutesToTimeoutMs(editForm.timeoutMinutes);
    if (timeout_ms === undefined) {
      showToast?.('Timeout must be a positive number of minutes.', 'error');
      return;
    }
    const payload: Record<string, any> = { ...editForm, timeout_ms };
    delete payload.timeoutMinutes;
    // skill_principal_agent_id is stashed in editForm purely so the helper
    // text can compute inherited-engine display — it's not editable from
    // the cron form. Omitting it from the PUT payload preserves the
    // existing DB value (the server's present-key tristate).
    delete payload.skill_principal_agent_id;
    const updated = await api.updateCron(editingId, payload);
    setCrons((prev: any) => prev.map((c: any) => (c.id === updated.id ? updated : c)));
    setEditingId(null);
    setEditForm({});
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Cron Jobs</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors"
        >
          {showForm ? 'Cancel' : '+ New Cron'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={createCron} className="bg-gray-800 rounded-xl p-4 mb-4 space-y-3">
          <input
            value={form.name}
            onChange={(e: any) => setForm({ ...form, name: e.target.value })}
            placeholder="Name"
            required
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />
          <CronSchedulePicker
            value={form.schedule}
            onChange={(schedule: any) => setForm({ ...form, schedule })}
          />
          <textarea
            value={form.prompt}
            onChange={(e: any) => setForm({ ...form, prompt: e.target.value })}
            placeholder="Prompt"
            required
            rows={3}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
          />
          {!projectId && scopedProjects.length > 0 && (
            <select
              value={form.project_id}
              onChange={(e: any) => {
                const proj = scopedProjects.find((p: any) => p.id === e.target.value);
                setForm({ ...form, project_id: e.target.value, cwd: proj?.cwd || form.cwd });
              }}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
            >
              <option value="">No project</option>
              {scopedProjects.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <input
            value={form.cwd}
            onChange={(e: any) => setForm({ ...form, cwd: e.target.value })}
            placeholder="Working directory"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Timeout (minutes) <span className="text-gray-600">— blank uses server default</span>
            </label>
            <input
              type="number"
              min="1"
              step="1"
              value={form.timeoutMinutes}
              onChange={(e: any) => setForm({ ...form, timeoutMinutes: e.target.value })}
              placeholder="e.g. 30"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
            />
          </div>
          {engineChoices.length > 0 && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Engine{' '}
                <span className="text-gray-600">
                  — blank inherits from skill principal or falls back to claude-code
                </span>
              </label>
              <select
                value={form.engine}
                onChange={(e: any) =>
                  // Switching engines clears any stale model so we never
                  // POST a Claude id under a Cursor engine (and vice
                  // versa). The server would reject it; clearing here
                  // makes the intent obvious in the dropdown.
                  setForm({ ...form, engine: e.target.value, model: '' })
                }
                data-testid="cron-engine-select"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
              >
                <option value="">Default (claude-code)</option>
                {engineChoices.map((e: any) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
              {(() => {
                const inherited = inheritedEngineFromPrincipal(form);
                if (!inherited) return null;
                return (
                  <p className="text-xs text-amber-400/80 mt-1">
                    Will run as {inherited} — inherited from skill principal.
                  </p>
                );
              })()}
            </div>
          )}
          {modelsForEngine(effectiveEngineForModels(form)).length > 0 && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Model{' '}
                <span className="text-gray-600">
                  — blank uses the engine default
                  {defaultModelForEngine(effectiveEngineForModels(form))
                    ? ` (${defaultModelForEngine(effectiveEngineForModels(form))})`
                    : ''}
                </span>
              </label>
              <select
                value={form.model}
                onChange={(e: any) => setForm({ ...form, model: e.target.value })}
                data-testid="cron-model-select"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
              >
                <option value="">
                  Default
                  {defaultModelForEngine(effectiveEngineForModels(form))
                    ? ` (${defaultModelForEngine(effectiveEngineForModels(form))})`
                    : ''}
                </option>
                {modelsForEngine(effectiveEngineForModels(form)).map((m: any) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!form.notify_on_run}
              onChange={(e: any) => setForm({ ...form, notify_on_run: e.target.checked })}
              className="mt-0.5 accent-blue-500"
            />
            <span className="text-xs text-gray-300">
              Send a push notification on every run
              <span className="block text-gray-500">
                Off by default — thread/heartbeat logs are written either way.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!form.shared}
              onChange={(e: any) => setForm({ ...form, shared: e.target.checked })}
              className="mt-0.5 accent-blue-500"
            />
            <span className="text-xs text-gray-300">
              Shared
              <span className="block text-gray-500">
                Visible to the org. Runs still use your credentials.
              </span>
            </span>
          </label>
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Create
          </button>
        </form>
      )}

      <div className="space-y-3">
        {visibleCrons.map((cronJob: any) => (
          <div key={cronJob.id} className="bg-gray-800 rounded-xl p-4">
            {editingId === cronJob.id ? (
              <form onSubmit={saveEdit} className="space-y-3">
                <input
                  value={editForm.name}
                  onChange={(e: any) => setEditForm({ ...editForm, name: e.target.value })}
                  placeholder="Name"
                  required
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                />
                <CronSchedulePicker
                  value={editForm.schedule}
                  onChange={(schedule: any) => setEditForm({ ...editForm, schedule })}
                />
                <textarea
                  value={editForm.prompt}
                  onChange={(e: any) => setEditForm({ ...editForm, prompt: e.target.value })}
                  placeholder="Prompt"
                  required
                  rows={3}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
                />
                {!projectId && scopedProjects.length > 0 && (
                  <select
                    value={editForm.project_id}
                    onChange={(e: any) => {
                      const proj = scopedProjects.find((p: any) => p.id === e.target.value);
                      setEditForm({
                        ...editForm,
                        project_id: e.target.value,
                        cwd: proj?.cwd || editForm.cwd,
                      });
                    }}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                  >
                    <option value="">No project</option>
                    {scopedProjects.map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  value={editForm.cwd}
                  onChange={(e: any) => setEditForm({ ...editForm, cwd: e.target.value })}
                  placeholder="Working directory"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                />
                <div>
                  <label className="block text-xs text-gray-400 mb-1">
                    Timeout (minutes){' '}
                    <span className="text-gray-600">— blank uses server default</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={editForm.timeoutMinutes ?? ''}
                    onChange={(e: any) =>
                      setEditForm({ ...editForm, timeoutMinutes: e.target.value })
                    }
                    placeholder="e.g. 30"
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                  />
                </div>
                {engineChoices.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Engine{' '}
                      <span className="text-gray-600">
                        — blank inherits from skill principal or falls back to claude-code
                      </span>
                    </label>
                    <select
                      value={editForm.engine ?? ''}
                      onChange={(e: any) =>
                        setEditForm({ ...editForm, engine: e.target.value, model: '' })
                      }
                      data-testid="cron-engine-select-edit"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                    >
                      <option value="">Default (claude-code)</option>
                      {engineChoices.map((e: any) => (
                        <option key={e} value={e}>
                          {e}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const inherited = inheritedEngineFromPrincipal(editForm);
                      if (!inherited) return null;
                      return (
                        <p className="text-xs text-amber-400/80 mt-1">
                          Will run as {inherited} — inherited from skill principal.
                        </p>
                      );
                    })()}
                  </div>
                )}
                {modelsForEngine(effectiveEngineForModels(editForm)).length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Model{' '}
                      <span className="text-gray-600">
                        — blank uses the engine default
                        {defaultModelForEngine(effectiveEngineForModels(editForm))
                          ? ` (${defaultModelForEngine(effectiveEngineForModels(editForm))})`
                          : ''}
                      </span>
                    </label>
                    <select
                      value={editForm.model ?? ''}
                      onChange={(e: any) => setEditForm({ ...editForm, model: e.target.value })}
                      data-testid="cron-model-select-edit"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                    >
                      <option value="">
                        Default
                        {defaultModelForEngine(effectiveEngineForModels(editForm))
                          ? ` (${defaultModelForEngine(effectiveEngineForModels(editForm))})`
                          : ''}
                      </option>
                      {modelsForEngine(effectiveEngineForModels(editForm)).map((m: any) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!editForm.notify_on_run}
                    onChange={(e: any) =>
                      setEditForm({ ...editForm, notify_on_run: e.target.checked })
                    }
                    className="mt-0.5 accent-blue-500"
                  />
                  <span className="text-xs text-gray-300">
                    Send a push notification on every run
                    <span className="block text-gray-500">
                      Off by default — thread/heartbeat logs are written either way.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!editForm.shared}
                    onChange={(e: any) => setEditForm({ ...editForm, shared: e.target.checked })}
                    className="mt-0.5 accent-blue-500"
                  />
                  <span className="text-xs text-gray-300">
                    Shared
                    <span className="block text-gray-500">
                      Visible to the org. Runs still use the owner credentials.
                    </span>
                  </span>
                </label>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{cronJob.name}</span>
                    <span className="text-xs text-gray-500" title={cronJob.schedule}>
                      {humanCron(cronJob.schedule)}
                    </span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                      {cronJob.shared ? 'Shared' : 'Private'}
                    </span>
                    {cronJob.owner_username && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-900 text-gray-400 border border-gray-700">
                        Owner: {cronJob.owner_username}
                      </span>
                    )}
                    {cronJob.enabled &&
                      cronJob.next_run_at &&
                      (() => {
                        const { label, overdue } = relativeFuture(cronJob.next_run_at);
                        return (
                          <span
                            title={`Next run: ${formatDateTime(cronJob.next_run_at)}`}
                            className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                              overdue
                                ? 'bg-amber-900/40 text-amber-400'
                                : 'bg-gray-700/60 text-gray-400'
                            }`}
                          >
                            {label}
                          </span>
                        );
                      })()}
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{cronJob.prompt}</p>
                  <p className="text-xs text-gray-600 mt-0.5">
                    cwd: {cronJob.cwd}
                    {cronJob.timeout_ms ? (
                      <> · Timeout: {Math.round(cronJob.timeout_ms / 60_000)}m</>
                    ) : null}
                    {cronJob.engine ? <> · Engine: {cronJob.engine}</> : null}
                    {cronJob.model ? <> · Model: {cronJob.model}</> : null}
                    {cronJob.notify_on_run ? <> · 🔔 Notifies on run</> : null}
                    {cronJob.last_run && <> · Last: {relativeTime(cronJob.last_run)}</>}
                  </p>
                  <label className="mt-2 inline-flex items-center gap-2 text-xs text-gray-300">
                    <input
                      type="checkbox"
                      checked={!!cronJob.shared}
                      disabled={!cronJob.can_manage}
                      onChange={async (e: any) => {
                        const updated = await api.updateCron(cronJob.id, {
                          shared: e.target.checked,
                        });
                        setCrons((prev: any) =>
                          prev.map((c: any) => (c.id === updated.id ? updated : c)),
                        );
                      }}
                      className="accent-blue-500 disabled:opacity-40"
                    />
                    Shared
                  </label>
                  {/* Recent runs — clickable status dots */}
                  {cronLogs[cronJob.id]?.length > 0 && (
                    <div className="mt-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-500 mr-0.5">Runs:</span>
                        {cronLogs[cronJob.id].map((log: any) => {
                          const key = `${cronJob.id}:${log.id}`;
                          const isExpanded = expandedLog === key;
                          const statusColor =
                            log.status === 'success'
                              ? 'bg-emerald-500'
                              : log.status === 'error'
                                ? 'bg-red-500'
                                : log.status === 'running'
                                  ? 'bg-amber-400 animate-pulse'
                                  : 'bg-gray-500';
                          const durationLabel =
                            log.duration_ms != null
                              ? `${(log.duration_ms / 1000).toFixed(1)}s`
                              : '';
                          return (
                            <button
                              key={log.id}
                              onClick={() => setExpandedLog(isExpanded ? null : key)}
                              title={`${log.status} — ${formatDateTime(log.timestamp)}${durationLabel ? ` (${durationLabel})` : ''}`}
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors ${
                                isExpanded
                                  ? 'bg-gray-700 ring-1 ring-gray-500'
                                  : 'bg-gray-800 hover:bg-gray-700'
                              }`}
                            >
                              <span
                                className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`}
                              />
                              <span className="text-gray-400">{relativeTime(log.timestamp)}</span>
                            </button>
                          );
                        })}
                      </div>
                      {/* Expanded log result */}
                      {cronLogs[cronJob.id].map((log: any) => {
                        const key = `${cronJob.id}:${log.id}`;
                        if (expandedLog !== key) return null;
                        return (
                          <div
                            key={`detail-${log.id}`}
                            className="mt-2 bg-gray-900 rounded-lg p-3 border border-gray-700/50"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`text-xs font-medium ${
                                    log.status === 'success'
                                      ? 'text-emerald-400'
                                      : log.status === 'error'
                                        ? 'text-red-400'
                                        : log.status === 'running'
                                          ? 'text-amber-400'
                                          : 'text-gray-400'
                                  }`}
                                >
                                  {log.status === 'success'
                                    ? '✓ Success'
                                    : log.status === 'error'
                                      ? '✗ Error'
                                      : log.status === 'running'
                                        ? 'Running'
                                        : log.status}
                                </span>
                                <span className="text-xs text-gray-500">
                                  {formatDateTime(log.timestamp)}
                                </span>
                                {log.duration_ms != null && (
                                  <span className="text-xs text-gray-500 font-mono">
                                    {(log.duration_ms / 1000).toFixed(1)}s
                                  </span>
                                )}
                              </div>
                              <button
                                onClick={() => setExpandedLog(null)}
                                className="text-xs text-gray-500 hover:text-gray-300"
                              >
                                ✕
                              </button>
                            </div>
                            {log.result ? (
                              <pre className="text-xs text-gray-400 whitespace-pre-wrap max-h-40 overflow-y-auto">
                                {log.result}
                              </pre>
                            ) : (
                              <p className="text-xs text-gray-600 italic">No output yet</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
                  {onNavigate && (
                    <button
                      onClick={() => viewThread(cronJob)}
                      className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-2 sm:py-1 rounded-md transition-colors min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                      title="View thread"
                    >
                      <ScrollText size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => triggerRun(cronJob.id)}
                    disabled={running[cronJob.id] || !cronJob.can_manage}
                    className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-2 sm:py-1 rounded-md transition-colors disabled:opacity-50 min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                  >
                    {running[cronJob.id] ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Play size={14} />
                    )}
                  </button>
                  <button
                    onClick={() => toggleCron(cronJob)}
                    disabled={!cronJob.can_manage}
                    className={`text-xs px-2.5 py-2 sm:py-1 rounded-md transition-colors min-h-[36px] sm:min-h-0 flex items-center ${
                      cronJob.enabled
                        ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    {cronJob.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button
                    onClick={() => startEditing(cronJob)}
                    disabled={!cronJob.can_manage}
                    className="text-xs text-gray-500 hover:text-blue-400 px-2 py-2 sm:px-1 sm:py-1 transition-colors disabled:opacity-40 min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => deleteCron(cronJob.id)}
                    disabled={!cronJob.can_manage}
                    className="text-xs text-gray-500 hover:text-red-400 px-2 py-2 sm:px-1 sm:py-1 transition-colors disabled:opacity-40 min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {crons.length === 0 && <p className="text-sm text-gray-500">No cron jobs configured</p>}
      </div>
    </div>
  );
}

/* WebhookSection removed — GitHub webhooks are no longer used */

// ─── Slack Setup Wizard ───────────────────────────────────────────────────────

const WIZARD_STEPS = [
  { id: 'intro', label: 'Create App' },
  { id: 'tokens', label: 'Get Tokens' },
  { id: 'configure', label: 'Configure' },
  { id: 'test', label: 'Test & Save' },
];

function SlackSetupWizard({ agents, onSaved, onCancel, existingBot }: any) {
  const [step, setStep] = useState(existingBot ? 2 : 0);
  const [form, setForm] = useState({
    name: existingBot?.name || '',
    bot_token: existingBot ? '****masked****' : '',
    app_token: existingBot ? '****masked****' : '',
    agent_id: existingBot?.agent_id || agents[0]?.id || '',
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null); // null | { ok, team, user, error }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<any>(null);

  // Masked-token sentinel: the API returns either the literal '****masked****'
  // (legacy callers) or a partially-masked form like 'xoxb-****…-ab12cd' that
  // begins with the prefix + leading '****'. The leading '****' check is
  // intentional — real Slack tokens never start with '****', so it's a safe
  // sentinel for "user did not edit this token field; preserve the stored
  // value." Don't soften this to .includes('****') — that would also match
  // legitimate tokens that happen to contain the substring.
  const isMasked = (v: any) => v === '****masked****' || v?.startsWith('****');

  const handleChange = (field: any) => (e: any) => {
    setForm((prev: any) => ({ ...prev, [field]: e.target.value }));
    if (field === 'bot_token' || field === 'app_token') setTestResult(null);
  };

  const handleTestTokens = async () => {
    if (!form.bot_token || isMasked(form.bot_token)) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testSlackTokens({ bot_token: form.bot_token });
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.agent_id) {
      setError('Name and agent are required');
      return;
    }
    // Require tokens if creating new; allow masked for updates
    if (!existingBot && (!form.bot_token || !form.app_token)) {
      setError('Both tokens are required for a new bot');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        agent_id: form.agent_id,
        ...(isMasked(form.bot_token) ? {} : { bot_token: form.bot_token.trim() }),
        ...(isMasked(form.app_token) ? {} : { app_token: form.app_token.trim() }),
      };
      if (existingBot) {
        await api.updateSlackBot(existingBot.id, payload);
      } else {
        // Must provide tokens for new bots
        await api.createSlackBot({
          ...payload,
          bot_token: form.bot_token.trim(),
          app_token: form.app_token.trim(),
        });
      }
      onSaved();
    } catch (err: any) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const stepContent = {
    0: (
      <div className="space-y-5">
        <div className="bg-blue-950/40 border border-blue-800/40 rounded-xl p-4 text-sm space-y-3">
          <p className="font-medium text-blue-300 flex items-center gap-2">
            <Info size={15} /> Step 1 — Create a Slack App
          </p>
          <ol className="space-y-2 text-gray-300 list-decimal ml-4">
            <li>
              Go to{' '}
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noreferrer"
                className="text-blue-400 underline"
              >
                api.slack.com/apps <ExternalLink size={11} className="inline" />
              </a>{' '}
              and click <strong>Create New App → From scratch</strong>.
            </li>
            <li>
              Give it a name and pick your workspace, then click <strong>Create App</strong>.
            </li>
            <li>
              Under <strong>OAuth &amp; Permissions → Scopes → Bot Token Scopes</strong>, add:
              <code className="ml-1 bg-gray-800 px-1.5 py-0.5 rounded text-xs">
                chat:write, channels:history, channels:read, files:read, reactions:write,
                im:history, im:write, mpim:history, groups:history
              </code>
            </li>
            <li>
              Under <strong>Socket Mode</strong>, enable it and create an{' '}
              <strong>App-Level Token</strong> with scope{' '}
              <code className="bg-gray-800 px-1 rounded text-xs">connections:write</code>. Copy this
              token — it starts with <code className="bg-gray-800 px-1 rounded text-xs">xapp-</code>
              .
            </li>
            <li>
              Under <strong>Event Subscriptions → Subscribe to bot events</strong>, add{' '}
              <code className="bg-gray-800 px-1 rounded text-xs">message.channels</code>,{' '}
              <code className="bg-gray-800 px-1 rounded text-xs">message.im</code>,{' '}
              <code className="bg-gray-800 px-1 rounded text-xs">message.groups</code>.
            </li>
            <li>
              Under <strong>OAuth &amp; Permissions</strong>, click{' '}
              <strong>Install to Workspace</strong>. Copy the <strong>Bot User OAuth Token</strong>{' '}
              (starts with <code className="bg-gray-800 px-1 rounded text-xs">xoxb-</code>).
            </li>
          </ol>
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => setStep(1)}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            I've created the app →
          </button>
        </div>
      </div>
    ),

    1: (
      <div className="space-y-4">
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 text-sm space-y-3">
          <p className="text-gray-300 font-medium">Enter your Slack tokens:</p>
          <div>
            <label className="text-xs text-gray-400 block mb-1">
              Bot User OAuth Token <span className="text-red-400">*</span>
            </label>
            <input
              type="password"
              value={form.bot_token}
              onChange={handleChange('bot_token')}
              placeholder="xoxb-..."
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Found at OAuth &amp; Permissions → Bot User OAuth Token
            </p>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">
              App-Level Token <span className="text-red-400">*</span>
            </label>
            <input
              type="password"
              value={form.app_token}
              onChange={handleChange('app_token')}
              placeholder="xapp-..."
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Found at Basic Information → App-Level Tokens (Socket Mode)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {form.bot_token && !isMasked(form.bot_token) && (
            <button
              onClick={handleTestTokens}
              disabled={testing}
              className="flex items-center gap-1.5 text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {testing ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
              {testing ? 'Testing…' : 'Test Bot Token'}
            </button>
          )}
          {testResult && (
            <span
              className={`text-xs flex items-center gap-1 ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}
            >
              {testResult.ok ? (
                <>
                  <CheckCircle2 size={13} /> Connected as @{testResult.user} in {testResult.team}
                </>
              ) : (
                <>
                  <AlertCircle size={13} /> {testResult.error}
                </>
              )}
            </span>
          )}
        </div>
        <div className="flex justify-between">
          <button
            onClick={() => setStep(0)}
            className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-lg border border-gray-700 transition-colors"
          >
            ← Back
          </button>
          <button
            onClick={() => setStep(2)}
            disabled={!form.bot_token || !form.app_token}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Next →
          </button>
        </div>
      </div>
    ),

    2: (
      <div className="space-y-4">
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            Bot name <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={form.name}
            onChange={handleChange('name')}
            placeholder="e.g. my-team-bot"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            Default agent <span className="text-red-400">*</span>
          </label>
          <select
            value={form.agent_id}
            onChange={handleChange('agent_id')}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          >
            {agents.map((a: any) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
          <p className="text-[11px] text-gray-500 mt-1">
            All Slack messages will route to this agent by default. You can add per-channel
            overrides after saving.
          </p>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-between">
          <button
            onClick={() => setStep(existingBot ? 2 : 1)}
            className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-lg border border-gray-700 transition-colors"
          >
            ← Back
          </button>
          <button
            onClick={() => setStep(3)}
            disabled={!form.name.trim() || !form.agent_id}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Next →
          </button>
        </div>
      </div>
    ),

    3: (
      <div className="space-y-4">
        <div className="bg-gray-800 rounded-xl p-4 space-y-2 text-sm">
          <p className="text-gray-400 text-xs font-medium uppercase tracking-wide mb-2">Summary</p>
          <div className="flex justify-between">
            <span className="text-gray-400">Bot name</span>
            <span className="font-medium">{form.name || '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Agent</span>
            <span className="font-medium font-mono text-xs">{form.agent_id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Bot token</span>
            <span className="text-gray-300 font-mono text-xs">
              {isMasked(form.bot_token) ? '(unchanged)' : form.bot_token.substring(0, 10) + '…'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">App token</span>
            <span className="text-gray-300 font-mono text-xs">
              {isMasked(form.app_token) ? '(unchanged)' : form.app_token.substring(0, 10) + '…'}
            </span>
          </div>
        </div>
        {!existingBot && !isMasked(form.bot_token) && (
          <div>
            <button
              onClick={handleTestTokens}
              disabled={testing}
              className="flex items-center gap-1.5 text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {testing ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            {testResult && (
              <p
                className={`text-xs mt-2 flex items-center gap-1 ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {testResult.ok ? (
                  <>
                    <CheckCircle2 size={13} /> @{testResult.user} in {testResult.team}
                  </>
                ) : (
                  <>
                    <AlertCircle size={13} /> {testResult.error}
                  </>
                )}
              </p>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-between">
          <button
            onClick={() => setStep(2)}
            className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-lg border border-gray-700 transition-colors"
          >
            ← Back
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {saving ? 'Saving…' : existingBot ? 'Save Changes' : 'Connect Bot'}
          </button>
        </div>
      </div>
    ),
  };

  return (
    <div className="bg-gray-850 border border-gray-700 rounded-2xl p-5">
      {/* Progress bar */}
      <div className="flex items-center gap-0 mb-6">
        {WIZARD_STEPS.map((s: any, i: any) => (
          <div key={s.id} className="flex items-center flex-1 last:flex-none">
            <button
              onClick={() => {
                if (i <= step || existingBot) setStep(i);
              }}
              className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold shrink-0 transition-colors ${
                i < step
                  ? 'bg-emerald-600 text-white'
                  : i === step
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-400'
              }`}
            >
              {i < step ? <CheckCircle2 size={14} /> : i + 1}
            </button>
            <span
              className={`ml-1.5 text-xs whitespace-nowrap mr-1 ${i === step ? 'text-gray-200' : 'text-gray-500'}`}
            >
              {s.label}
            </span>
            {i < WIZARD_STEPS.length - 1 && (
              <div className={`flex-1 h-px mx-1 ${i < step ? 'bg-emerald-600' : 'bg-gray-700'}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      {stepContent[step as keyof typeof stepContent]}
    </div>
  );
}

// ─── Per-bot channel map editor ───────────────────────────────────────────────

function ChannelMapEditor({ bot, agents, onSaved }: any) {
  const [channelMap, setChannelMap] = useState(
    typeof bot.channel_map === 'object' ? bot.channel_map : {},
  );
  const [newChannel, setNewChannel] = useState({ id: '', label: '', agentId: bot.agent_id });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<any>(null);

  const handleAdd = () => {
    if (!newChannel.id.trim()) return;
    setChannelMap((prev: any) => ({
      ...prev,
      [newChannel.id.trim()]: {
        label: newChannel.label.trim() || newChannel.id.trim(),
        agentId: newChannel.agentId || bot.agent_id,
      },
    }));
    setNewChannel({ id: '', label: '', agentId: bot.agent_id });
  };

  const handleRemove = (chId: any) => {
    setChannelMap((prev: any) => {
      const n = { ...prev };
      delete n[chId];
      return n;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateSlackBot(bot.id, { channel_map: channelMap });
      onSaved();
    } catch (err: any) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 border-t border-gray-700 pt-3 space-y-3">
      <p className="text-xs font-medium text-gray-400">Channel Routing</p>
      <p className="text-[11px] text-gray-500">
        By default all channels route to{' '}
        <code className="bg-gray-800 px-1 rounded">{bot.agent_id}</code>. Add per-channel overrides
        below to route specific channels to different agents.
      </p>

      {/* Existing mappings */}
      {Object.keys(channelMap).length > 0 && (
        <div className="space-y-1.5">
          {Object.entries(channelMap).map(([chId, cfg]: any) => (
            <div key={chId} className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
              <span className="font-mono text-xs text-blue-300 w-32 truncate">{chId}</span>
              <span className="text-xs text-gray-400 flex-1 truncate">{cfg.label || chId}</span>
              <span className="text-xs text-gray-500 font-mono">
                → {cfg.agentId || bot.agent_id}
              </span>
              <button
                onClick={() => handleRemove(chId)}
                className="text-gray-500 hover:text-red-400 ml-1"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new mapping */}
      <div className="flex gap-2 flex-wrap">
        <input
          type="text"
          value={newChannel.id}
          onChange={(e: any) => setNewChannel((p: any) => ({ ...p, id: e.target.value }))}
          placeholder="Channel ID (e.g. C0123456)"
          className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-blue-500 w-44"
        />
        <input
          type="text"
          value={newChannel.label}
          onChange={(e: any) => setNewChannel((p: any) => ({ ...p, label: e.target.value }))}
          placeholder="#channel-name"
          className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 w-36"
        />
        <select
          value={newChannel.agentId}
          onChange={(e: any) => setNewChannel((p: any) => ({ ...p, agentId: e.target.value }))}
          className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500"
        >
          {agents.map((a: any) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          onClick={handleAdd}
          disabled={!newChannel.id.trim()}
          className="flex items-center gap-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-2.5 py-1.5 rounded-lg transition-colors"
        >
          <Plus size={12} /> Add
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={handleSave}
        disabled={saving}
        className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : null}
        Save Channel Map
      </button>
    </div>
  );
}

// ─── Main SlackSection ─────────────────────────────────────────────────────────

function SlackSection() {
  const [bots, setBots] = useState<any[]>([]);
  const [liveStatus, setLiveStatus] = useState<any[]>([]); // live connection state from /status
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [editingBot, setEditingBot] = useState<any>(null);
  const [expandedBot, setExpandedBot] = useState<any>(null);
  const [expandedChannels, setExpandedChannels] = useState<any>(null);
  const [selectedMsgAgent, setSelectedMsgAgent] = useState<any>(null);
  const [testingId, setTestingId] = useState<any>(null);
  const [testResults, setTestResults] = useState<Record<string, any>>({});
  const [restarting, setRestarting] = useState(false);
  const [deletingId, setDeletingId] = useState<any>(null);
  const [agents, setAgents] = useState<any[]>([]);

  const loadAll = async () => {
    try {
      const [botsData, statusData, agentsData] = await Promise.all([
        api.listSlackBots(),
        api.getSlackStatus(),
        api.getAgents(),
      ]);
      setBots(botsData || []);
      setLiveStatus(statusData || []);
      setAgents(agentsData || []);
    } catch (err: any) {
      console.error('Failed to load Slack data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (agentId?: any) => {
    try {
      const data = await api.getSlackMessages(agentId, 20);
      setMessages(data);
    } catch (err: any) {
      console.error('Failed to load messages:', err);
    }
  };

  useEffect(() => {
    loadAll();
    loadMessages();
  }, []);

  // Merge live status into bot list for connection display
  const botsWithStatus = bots.map((bot: any) => {
    const live = liveStatus.find((s: any) => s.name === bot.name);
    return {
      ...bot,
      connected: live?.connected ?? false,
      lastMessage: live?.lastMessage ?? null,
      liveError: live?.error ?? null,
    };
  });

  // Also include file-backed bots that appear in status but not in DB
  const dbNames = new Set(bots.map((b: any) => b.name));
  const fileOnlyBots = liveStatus
    .filter((s: any) => !dbNames.has(s.name))
    .map((s: any) => ({
      ...s,
      id: null,
      bot_token: null,
      app_token: null,
      channel_map: {},
      enabled: 1,
      _fileOnly: true,
    }));

  const allBots = [...botsWithStatus, ...fileOnlyBots];

  const handleDelete = async (id: any) => {
    if (!id || !window.confirm('Delete this Slack bot? It will stop receiving messages.')) return;
    setDeletingId(id);
    try {
      await api.deleteSlackBot(id);
      await loadAll();
    } catch (err: any) {
      console.error('Delete failed:', err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggle = async (id: any) => {
    try {
      await api.toggleSlackBot(id);
      await loadAll();
    } catch (err: any) {
      console.error('Toggle failed:', err);
    }
  };

  const handleTestConnection = async (bot: any) => {
    if (!bot.id) return;
    setTestingId(bot.id);
    setTestResults((prev: any) => ({ ...prev, [bot.id]: null }));
    try {
      const result = await api.testSlackBotConnection(bot.id);
      setTestResults((prev: any) => ({ ...prev, [bot.id]: result }));
    } catch (err: any) {
      setTestResults((prev: any) => ({ ...prev, [bot.id]: { ok: false, error: err.message } }));
    } finally {
      setTestingId(null);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartSlack();
      await loadAll();
    } catch (err: any) {
      console.error('Restart failed:', err);
    } finally {
      setRestarting(false);
    }
  };

  if (loading) {
    return (
      <div className="text-gray-500 text-sm flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading Slack bots…
      </div>
    );
  }

  if (showWizard || editingBot) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => {
              setShowWizard(false);
              setEditingBot(null);
            }}
            className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1"
          >
            <ChevronRight size={13} className="rotate-180" /> Back
          </button>
          <h3 className="text-sm font-semibold">
            {editingBot ? `Edit: ${editingBot.name}` : 'Connect a Slack Bot'}
          </h3>
        </div>
        <SlackSetupWizard
          agents={agents}
          existingBot={editingBot}
          onSaved={() => {
            setShowWizard(false);
            setEditingBot(null);
            loadAll();
          }}
          onCancel={() => {
            setShowWizard(false);
            setEditingBot(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Slack Bots</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {restarting ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {restarting ? 'Restarting…' : 'Restart All'}
          </button>
          <button
            onClick={() => setShowWizard(true)}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <Plus size={13} /> Add Bot
          </button>
        </div>
      </div>

      {/* Bot list */}
      {allBots.length === 0 ? (
        <div className="bg-gray-800/50 border border-dashed border-gray-700 rounded-xl p-8 text-center">
          <MessageSquare size={28} className="mx-auto text-gray-600 mb-3" />
          <p className="text-sm text-gray-400 font-medium">No Slack bots configured</p>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            Connect a Slack app to let your agents respond to messages directly in Slack.
          </p>
          <button
            onClick={() => setShowWizard(true)}
            className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-2 mx-auto"
          >
            <Plus size={14} /> Connect First Bot
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {allBots.map((bot: any) => {
            const testResult = bot.id ? testResults[bot.id] : null;
            const isExpanded = expandedBot === (bot.id || bot.name);
            const isChannelsExpanded = expandedChannels === (bot.id || bot.name);
            const chanCount = bot.channel_map ? Object.keys(bot.channel_map).length : 0;

            return (
              <div key={bot.id || bot.name} className="bg-gray-800 rounded-xl overflow-hidden">
                {/* Bot header */}
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer"
                  onClick={() => setExpandedBot(isExpanded ? null : bot.id || bot.name)}
                >
                  {/* Status indicator */}
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      bot.connected
                        ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                        : bot.enabled === 0
                          ? 'bg-gray-500'
                          : 'bg-red-400'
                    }`}
                  />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-sm">{bot.name}</span>
                      {bot._fileOnly && (
                        <span className="text-[10px] bg-yellow-900/40 text-yellow-400 px-1.5 py-0.5 rounded border border-yellow-800/30">
                          file-only
                        </span>
                      )}
                      {bot.enabled === 0 && (
                        <span className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">
                          disabled
                        </span>
                      )}
                      <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded font-mono truncate">
                        → {bot.agent_id || bot.agentId}
                      </span>
                    </div>
                    {bot.liveError && (
                      <p className="text-[11px] text-red-400 mt-0.5">{bot.liveError}</p>
                    )}
                    {bot.lastMessage && (
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Last: {relativeTime(bot.lastMessage)}
                      </p>
                    )}
                  </div>

                  {/* Status badge */}
                  <span
                    className={`text-xs px-2 py-0.5 rounded-md flex-shrink-0 ${
                      bot.connected
                        ? 'bg-emerald-800/50 text-emerald-400'
                        : bot.enabled === 0
                          ? 'bg-gray-700 text-gray-400'
                          : 'bg-red-900/40 text-red-400'
                    }`}
                  >
                    {bot.connected ? 'Connected' : bot.enabled === 0 ? 'Disabled' : 'Disconnected'}
                  </span>

                  <ChevronDown
                    size={15}
                    className={`text-gray-500 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                  />
                </div>

                {/* Expanded actions */}
                {isExpanded && (
                  <div className="border-t border-gray-700 px-4 pb-4 pt-3 space-y-3">
                    {/* Action row */}
                    <div className="flex flex-wrap gap-2">
                      {bot.id && (
                        <>
                          <button
                            onClick={() => setEditingBot(bot)}
                            className="text-xs flex items-center gap-1 bg-gray-700 hover:bg-gray-600 px-2.5 py-1.5 rounded-lg transition-colors"
                          >
                            <Pencil size={12} /> Edit
                          </button>
                          <button
                            onClick={() => handleTestConnection(bot)}
                            disabled={testingId === bot.id}
                            className="text-xs flex items-center gap-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-2.5 py-1.5 rounded-lg transition-colors"
                          >
                            {testingId === bot.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Plug size={12} />
                            )}
                            Test Connection
                          </button>
                          <button
                            onClick={() => handleToggle(bot.id)}
                            className={`text-xs flex items-center gap-1 px-2.5 py-1.5 rounded-lg transition-colors ${
                              bot.enabled
                                ? 'bg-gray-700 hover:bg-yellow-900/40 text-gray-300 hover:text-yellow-400'
                                : 'bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-400'
                            }`}
                          >
                            {bot.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={() => handleDelete(bot.id)}
                            disabled={deletingId === bot.id}
                            className="text-xs flex items-center gap-1 bg-gray-700 hover:bg-red-900/40 text-gray-400 hover:text-red-400 disabled:opacity-50 px-2.5 py-1.5 rounded-lg transition-colors ml-auto"
                          >
                            {deletingId === bot.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Trash2 size={12} />
                            )}
                            Delete
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => {
                          setSelectedMsgAgent(
                            selectedMsgAgent === (bot.agent_id || bot.agentId)
                              ? null
                              : bot.agent_id || bot.agentId,
                          );
                          loadMessages(bot.agent_id || bot.agentId);
                        }}
                        className="text-xs flex items-center gap-1 bg-gray-700 hover:bg-gray-600 px-2.5 py-1.5 rounded-lg transition-colors"
                      >
                        <MessageSquare size={12} /> Messages
                      </button>
                    </div>

                    {/* Test result */}
                    {testResult && (
                      <p
                        className={`text-xs flex items-center gap-1.5 ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}
                      >
                        {testResult.ok ? (
                          <>
                            <CheckCircle2 size={13} /> @{testResult.user} in {testResult.team}
                          </>
                        ) : (
                          <>
                            <AlertCircle size={13} /> {testResult.error}
                          </>
                        )}
                      </p>
                    )}

                    {/* Channel map (DB bots only) */}
                    {bot.id && (
                      <div>
                        <button
                          onClick={() =>
                            setExpandedChannels(isChannelsExpanded ? null : bot.id || bot.name)
                          }
                          className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1"
                        >
                          <ChevronRight
                            size={12}
                            className={isChannelsExpanded ? 'rotate-90' : ''}
                          />
                          Channel Routing
                          {chanCount > 0 && (
                            <span className="ml-1 bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded text-[10px]">
                              {chanCount}
                            </span>
                          )}
                        </button>
                        {isChannelsExpanded && (
                          <ChannelMapEditor bot={bot} agents={agents} onSaved={loadAll} />
                        )}
                      </div>
                    )}

                    {/* Messages panel */}
                    {selectedMsgAgent === (bot.agent_id || bot.agentId) && (
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {messages.length === 0 ? (
                          <p className="text-xs text-gray-500">No messages yet</p>
                        ) : (
                          messages.map((msg: any) => (
                            <div key={msg.id} className="bg-gray-900 rounded-lg p-2.5 text-xs">
                              <div className="flex items-center gap-2 mb-1 text-gray-500">
                                <span className="font-mono">{msg.channel_id}</span>
                                <span>·</span>
                                <span>{relativeTime(msg.timestamp)}</span>
                              </div>
                              <p className="text-blue-300 mb-0.5">
                                <span className="text-gray-500">User: </span>
                                {msg.user_message?.substring(0, 180)}
                                {msg.user_message?.length > 180 ? '…' : ''}
                              </p>
                              <p className="text-gray-300">
                                <span className="text-gray-500">Bot: </span>
                                {msg.bot_response?.substring(0, 260)}
                                {msg.bot_response?.length > 260 ? '…' : ''}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* File-config note */}
      {fileOnlyBots.length > 0 && (
        <p className="text-[11px] text-gray-500 flex items-start gap-1.5 mt-2">
          <Info size={12} className="shrink-0 mt-0.5" />
          {fileOnlyBots.length} bot{fileOnlyBots.length > 1 ? 's are' : ' is'} managed via{' '}
          <code className="bg-gray-800 px-1 rounded">server/slack-config.json</code>. Use the UI to
          migrate them for full management support.
        </p>
      )}
    </div>
  );
}

/**
 * MCP Server management sub-section for an individual agent.
 * Renders inside the expanded agent config form.
 */
function McpServersSection({ agentId }: any) {
  const [servers, setServers] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingServer, setEditingServer] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<any>(null);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [newServer, setNewServer] = useState({
    name: '',
    type: 'stdio',
    command: '',
    args: '',
    url: '',
    env: '',
    cwd: '',
  });

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const loadServers = () => {
    api
      .getMcpServers(agentId)
      .then((data: any) => {
        setServers(data.mcpServers || {});
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadServers();
  }, [agentId]);

  const resetNewForm = () => {
    setNewServer({
      name: '',
      type: 'stdio',
      command: '',
      args: '',
      url: '',
      env: '',
      cwd: '',
    });
  };

  const parseArgs = (argsStr: any) => {
    if (!argsStr.trim()) return [];
    try {
      const parsed = JSON.parse(argsStr);
      return Array.isArray(parsed) ? parsed : [argsStr];
    } catch {
      return argsStr.split(/\s+/).filter(Boolean);
    }
  };

  const parseEnv = (envStr: any) => {
    if (!envStr.trim()) return {};
    try {
      return JSON.parse(envStr);
    } catch {
      // Parse KEY=VALUE format, one per line
      const env: Record<string, any> = {};
      for (const line of envStr.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        env[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
      }
      return env;
    }
  };

  const buildServerConfig = (form: any) => {
    const config: Record<string, any> = {};
    if (form.type === 'stdio') {
      config.command = form.command;
      const args = parseArgs(form.args);
      if (args.length) config.args = args;
    } else {
      config.url = form.url;
    }
    const env = parseEnv(form.env);
    if (Object.keys(env).length) config.env = env;
    if (form.cwd?.trim()) config.cwd = form.cwd.trim();
    return config;
  };

  const handleAddServer = async (e: any) => {
    e.preventDefault();
    if (!newServer.name.trim()) return;
    setSaving(true);
    try {
      const config = buildServerConfig(newServer);
      const result = await api.updateMcpServer(agentId, newServer.name.trim(), config);
      setServers(result.mcpServers || {});
      setShowAdd(false);
      resetNewForm();
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err: any) {
      console.error('Failed to add MCP server:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateServer = async (name: any, form: any) => {
    setSaving(true);
    try {
      const config = buildServerConfig(form);
      const result = await api.updateMcpServer(agentId, name, config);
      setServers(result.mcpServers || {});
      setEditingServer(null);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err: any) {
      console.error('Failed to update MCP server:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteServer = async (name: any) => {
    try {
      const result = await api.deleteMcpServer(agentId, name);
      setServers(result.mcpServers || {});
      setConfirmDelete(null);
      setEditingServer(null);
    } catch (err: any) {
      console.error('Failed to delete MCP server:', err);
    }
  };

  const serverEntries = Object.entries(servers);
  const serverCount = serverEntries.length;

  const ServerForm = ({ form, setForm, onSubmit, onCancel, submitLabel, serverName }: any) => (
    <form onSubmit={onSubmit} className="bg-gray-900/50 rounded-lg p-3 space-y-3">
      {!serverName && (
        <div>
          <label className={labelClass}>Server Name</label>
          <input
            value={form.name}
            onChange={(e: any) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. filesystem, github, slack"
            className={inputClass}
            required
          />
        </div>
      )}

      <div>
        <label className={labelClass}>Connection Type</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setForm({ ...form, type: 'stdio' })}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors ${
              form.type === 'stdio'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
            }`}
          >
            <Terminal size={12} />
            stdio (command)
          </button>
          <button
            type="button"
            onClick={() => setForm({ ...form, type: 'sse' })}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors ${
              form.type === 'sse'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
            }`}
          >
            <Globe size={12} />
            SSE (url)
          </button>
        </div>
      </div>

      {form.type === 'stdio' ? (
        <>
          <div>
            <label className={labelClass}>Command</label>
            <input
              value={form.command}
              onChange={(e: any) => setForm({ ...form, command: e.target.value })}
              placeholder="e.g. npx, uvx, node, python"
              className={inputClass + ' font-mono'}
              required
            />
          </div>
          <div>
            <label className={labelClass}>
              Arguments <span className="text-gray-500">(space-separated or JSON array)</span>
            </label>
            <input
              value={form.args}
              onChange={(e: any) => setForm({ ...form, args: e.target.value })}
              placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path"
              className={inputClass + ' font-mono'}
            />
          </div>
        </>
      ) : (
        <div>
          <label className={labelClass}>URL</label>
          <input
            value={form.url}
            onChange={(e: any) => setForm({ ...form, url: e.target.value })}
            placeholder="e.g. http://localhost:8080/sse"
            className={inputClass + ' font-mono'}
            required
          />
        </div>
      )}

      <div>
        <label className={labelClass}>
          Environment Variables <span className="text-gray-500">(KEY=VALUE per line or JSON)</span>
        </label>
        <textarea
          value={form.env}
          onChange={(e: any) => setForm({ ...form, env: e.target.value })}
          placeholder={'API_KEY=sk-xxx\nANOTHER_VAR=value'}
          rows={2}
          className={inputClass + ' resize-none font-mono'}
        />
      </div>

      <div>
        <label className={labelClass}>
          Working Directory <span className="text-gray-500">(optional)</span>
        </label>
        <input
          value={form.cwd}
          onChange={(e: any) => setForm({ ...form, cwd: e.target.value })}
          placeholder="/path/to/working/directory"
          className={inputClass + ' font-mono'}
        />
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : submitLabel || 'Add Server'}
        </button>
      </div>
    </form>
  );

  return (
    <div className="border-t border-gray-700 pt-3">
      <div
        className="flex items-center gap-3 mb-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <Server size={14} className="text-gray-400" />
        <label className="text-xs text-gray-400 font-medium cursor-pointer">MCP Servers</label>
        {serverCount > 0 && (
          <span className="bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded-full text-xs">
            {serverCount}
          </span>
        )}
        {saveStatus === 'saved' && <span className="text-xs text-emerald-400">Saved</span>}
        {saveStatus === 'error' && <span className="text-xs text-red-400">Error</span>}
        <span className="ml-auto text-gray-500">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </div>

      {expanded && (
        <div className="space-y-2">
          {loading && <p className="text-xs text-gray-500">Loading MCP servers...</p>}

          {!loading && serverCount === 0 && !showAdd && (
            <p className="text-xs text-gray-500">
              No MCP servers configured. Add servers to give this agent access to external tools.
            </p>
          )}

          {/* Server list */}
          {serverEntries.map(([name, config]: any) => {
            const isEditing = editingServer === name;
            const isStdio = !!config.command;

            if (isEditing) {
              const editForm = {
                name,
                type: isStdio ? 'stdio' : 'sse',
                command: config.command || '',
                args: config.args
                  ? config.args.some((a: any) => a.includes(' '))
                    ? JSON.stringify(config.args)
                    : config.args.join(' ')
                  : '',
                url: config.url || '',
                env: config.env
                  ? Object.entries(config.env)
                      .map(([k, v]: any) => `${k}=${v}`)
                      .join('\n')
                  : '',
                cwd: config.cwd || '',
              };

              return (
                <EditServerWrapper
                  key={name}
                  serverName={name}
                  initialForm={editForm}
                  saving={saving}
                  onSave={(form: any) => handleUpdateServer(name, form)}
                  onCancel={() => setEditingServer(null)}
                  onDelete={() => {
                    if (confirmDelete === name) {
                      handleDeleteServer(name);
                    } else {
                      setConfirmDelete(name);
                      setTimeout(() => setConfirmDelete(null), 3000);
                    }
                  }}
                  confirmDelete={confirmDelete === name}
                  ServerForm={ServerForm}
                />
              );
            }

            return (
              <div
                key={name}
                className="bg-gray-900/50 rounded-lg p-3 flex items-center gap-3 group"
              >
                <div className="flex-shrink-0">
                  {isStdio ? (
                    <Terminal size={14} className="text-gray-500" />
                  ) : (
                    <Globe size={14} className="text-gray-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200">{name}</span>
                    <span className="text-xs text-gray-500">{isStdio ? 'stdio' : 'sse'}</span>
                  </div>
                  <p className="text-xs text-gray-500 font-mono truncate mt-0.5">
                    {isStdio
                      ? `${config.command}${config.args?.length ? ' ' + config.args.join(' ') : ''}`
                      : config.url}
                  </p>
                  {config.env && Object.keys(config.env).length > 0 && (
                    <p className="text-xs text-gray-600 mt-0.5">
                      env: {Object.keys(config.env).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => setEditingServer(name)}
                    className="text-gray-500 hover:text-blue-400 p-1 rounded transition-colors"
                    title="Edit server"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirmDelete === name) {
                        handleDeleteServer(name);
                      } else {
                        setConfirmDelete(name);
                        setTimeout(() => setConfirmDelete(null), 3000);
                      }
                    }}
                    className={`p-1 rounded transition-colors ${
                      confirmDelete === name
                        ? 'text-red-400 bg-red-900/30'
                        : 'text-gray-500 hover:text-red-400'
                    }`}
                    title={confirmDelete === name ? 'Click again to confirm' : 'Delete server'}
                  >
                    {confirmDelete === name ? <X size={12} /> : <Trash2 size={12} />}
                  </button>
                </div>
              </div>
            );
          })}

          {/* Add new server */}
          {showAdd ? (
            <ServerForm
              form={newServer}
              setForm={setNewServer}
              onSubmit={handleAddServer}
              onCancel={() => {
                setShowAdd(false);
                resetNewForm();
              }}
              submitLabel="Add Server"
            />
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-400 px-2 py-1.5 rounded-lg transition-colors hover:bg-gray-700/50"
            >
              <Plus size={12} />
              Add MCP Server
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Wrapper for editing an existing MCP server — holds local form state.
 */
function EditServerWrapper({
  serverName,
  initialForm,
  saving,
  onSave,
  onCancel,
  onDelete,
  confirmDelete,
  ServerForm,
}: any) {
  const [form, setForm] = useState(initialForm);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400 font-medium">Editing: {serverName}</span>
        <button
          onClick={onDelete}
          className={`text-xs px-2 py-0.5 rounded transition-colors ${
            confirmDelete
              ? 'bg-red-600 text-white hover:bg-red-500'
              : 'text-gray-500 hover:text-red-400'
          }`}
        >
          {confirmDelete ? 'Confirm Delete' : 'Delete'}
        </button>
      </div>
      <ServerForm
        form={form}
        setForm={setForm}
        onSubmit={(e: any) => {
          e.preventDefault();
          onSave(form);
        }}
        onCancel={onCancel}
        submitLabel={saving ? 'Saving...' : 'Save Changes'}
        serverName={serverName}
      />
    </div>
  );
}

export function AgentConfigSection({
  agents: initialAgents,
  projects = [],
  onAgentsChange,
  showToast,
  projectId = null,
}: any) {
  const scopedProjects = useMemo(
    () => (projectId ? projects.filter((p: any) => p.id === projectId) : projects),
    [projects, projectId],
  );
  const [agents, setAgents] = useState(initialAgents);
  const [expanded, setExpanded] = useState<any>(null);
  // Full merged skill list (project + bundled) per agent, lazily fetched when
  // an agent row is expanded. Backs the "Allowed skills" multi-select. The
  // `/agents/:id/skills` endpoint returns every skill (unfiltered by the
  // allowlist) so removed skills can still be re-added. `agentSkills[id]` is set
  // ONLY on a successful load (an array — possibly empty); a fetch failure sets
  // `agentSkillsError[id]` instead and leaves the list undefined, so a transient
  // error is never mistaken for "no skills" (which could let a save write
  // `allowedSkills: []` and wipe the agent's skills).
  const [agentSkills, setAgentSkills] = useState<Record<string, any>>({});
  const [agentSkillsError, setAgentSkillsError] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState<Record<string, any>>({});
  const [saveStatus, setSaveStatus] = useState<Record<string, any>>({});
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [showNew, setShowNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [modelConfig, setModelConfig] = useState<any>(null);
  // Per-user, per-agent default-model picks (`{ [agentId]: modelId }`).
  // Backs the Model dropdown below: selecting a model only changes the model
  // *this* user's sessions spawn with — never the shared agent row.
  const [modelOverrides, setModelOverrides] = useState<Record<string, any>>({});
  const [modelOverrideSaving, setModelOverrideSaving] = useState<Record<string, any>>({});
  const [modelOverrideSaved, setModelOverrideSaved] = useState<Record<string, any>>({});
  // Per-user, per-agent engine override (`{ [agentId]: engineId }`). Lets a
  // user run their own sessions under a different CLI engine than the shared
  // `agent.engine` row. Same caller-scoped storage as the model picks.
  const [engineOverrides, setEngineOverrides] = useState<Record<string, any>>({});
  const [engineOverrideSaving, setEngineOverrideSaving] = useState<Record<string, any>>({});
  const [engineOverrideSaved, setEngineOverrideSaved] = useState<Record<string, any>>({});
  // Saves go through the per-AGENT merge endpoints, so a write never sends the
  // whole map and can't clobber another agent's pick or another tab's edit.
  // We still serialize writes per agentId (keyed promise chain) so rapid edits
  // to the SAME agent land in order. The server response returns the full,
  // freshly-merged map, which we use to reconcile display state.
  const saveChainsRef = useRef<Record<string, any>>({});
  const [bulkEngine, setBulkEngine] = useState('claude-code');
  const [bulkModel, setBulkModel] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [newForm, setNewForm] = useState({
    id: '',
    name: '',
    engine: 'claude-code',
    model: '',
    projectId: projectId || scopedProjects[0]?.id || '',
    color: '#6b7280',
    avatar: '',
    systemPrompt: '',
    isDev: false,
    heartbeat: { enabled: false, interval: '', prompt: '' },
  });

  useEffect(() => {
    setAgents(initialAgents);
  }, [initialAgents]);

  const configurableAgents = useMemo(() => {
    let list = agents.filter((agent: any) => agent.role !== 'reviewer');
    if (projectId) list = list.filter((agent: any) => agent.projectId === projectId);
    return list;
  }, [agents, projectId]);

  useEffect(() => {
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => {});
  }, []);

  // Lazily load the skill list for whichever agent is expanded so the
  // "Allowed skills" multi-select has options. Cached per agent id. Skips when
  // already loaded or in a known error state (cleared by the Retry button).
  useEffect(() => {
    if (!expanded) return;
    if (Array.isArray(agentSkills[expanded]) || agentSkillsError[expanded]) return;
    let cancelled = false;
    api
      .getSkills(expanded)
      .then((list: any) => {
        if (!cancelled) {
          setAgentSkills((prev: any) => ({
            ...prev,
            [expanded]: Array.isArray(list) ? list : [],
          }));
        }
      })
      .catch(() => {
        // Distinct error state — do NOT collapse a failure into an empty list,
        // which would enable the restriction toggle with an empty allowlist.
        if (!cancelled) setAgentSkillsError((prev: any) => ({ ...prev, [expanded]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, agentSkills, agentSkillsError]);

  // Clear the error so the effect above re-fetches the agent's skill list.
  const retryLoadSkills = (agentId: any) => {
    setAgentSkillsError((prev: any) => {
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  };

  const parseModelMap = (body: any) =>
    body?.agentModelOverrides && typeof body.agentModelOverrides === 'object'
      ? body.agentModelOverrides
      : null;

  // Flatten `{ [agentId]: { engine, model? } }` → `{ [agentId]: engineId }`.
  // This page manages only the engine; the legacy `model` subfield is left
  // untouched server-side (the per-agent PUT preserves it).
  const parseEngineMap = (body: any) => {
    const raw =
      body?.agentEngineOverrides && typeof body.agentEngineOverrides === 'object'
        ? body.agentEngineOverrides
        : null;
    if (!raw) return null;
    const flat: Record<string, any> = {};
    for (const [id, entry] of Object.entries(raw)) {
      if (entry && typeof (entry as any).engine === 'string') flat[id] = (entry as any).engine;
    }
    return flat;
  };

  useEffect(() => {
    api
      .getMyAgentModelOverrides()
      .then((body: any) => setModelOverrides(parseModelMap(body) ?? {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .getMyAgentEngineOverrides()
      .then((body: any) => setEngineOverrides(parseEngineMap(body) ?? {}))
      .catch(() => {});
  }, []);

  // Serialize writes per agentId so rapid edits to the SAME agent land in
  // order. Different agents don't contend — the per-agent endpoint merges
  // each one independently on the server.
  const runSerialized = (key: any, fn: any) => {
    const prev = saveChainsRef.current[key] || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    saveChainsRef.current[key] = next;
    return next;
  };

  // Persist a single agent's per-user pick via the per-agent merge endpoint.
  // Optimistic update of the display map; reconciled from the server's full
  // merged map on success; refetched (not rolled back to a stale snapshot) on
  // error. Because each write touches only this agent's key server-side, it
  // can't drop another agent's pick or another tab's concurrent edit.
  const persistOverride = ({
    agentId,
    value,
    setMap,
    setSaving,
    setSaved,
    save,
    parse,
    refetch,
    errorMsg,
  }: any) => {
    setMap((m: any) => {
      const n = { ...m };
      if (value) n[agentId] = value;
      else delete n[agentId];
      return n;
    });
    setSaving((p: any) => ({ ...p, [agentId]: true }));
    setSaved((p: any) => ({ ...p, [agentId]: false }));
    return runSerialized(`${errorMsg}:${agentId}`, async () => {
      try {
        const merged = parse(await save());
        if (merged) setMap(merged);
        setSaved((p: any) => ({ ...p, [agentId]: true }));
        setTimeout(() => setSaved((p: any) => ({ ...p, [agentId]: false })), 2000);
      } catch (e: any) {
        try {
          const fresh = parse(await refetch());
          if (fresh) setMap(fresh);
        } catch {
          /* leave optimistic state; toast already surfaces the failure */
        }
        showToast?.(e instanceof Error ? e.message : errorMsg, 'error');
      } finally {
        setSaving((p: any) => ({ ...p, [agentId]: false }));
      }
    });
  };

  const saveModelOverride = (agentId: any, model: any) =>
    persistOverride({
      agentId,
      value: model,
      setMap: setModelOverrides,
      setSaving: setModelOverrideSaving,
      setSaved: setModelOverrideSaved,
      save: () =>
        model
          ? api.putMyAgentModelOverride(agentId, { model })
          : api.deleteMyAgentModelOverride(agentId),
      parse: parseModelMap,
      refetch: () => api.getMyAgentModelOverrides(),
      errorMsg: 'Failed to save model',
    });

  const saveEngineOverride = (agentId: any, engine: any) =>
    persistOverride({
      agentId,
      value: engine,
      setMap: setEngineOverrides,
      setSaving: setEngineOverrideSaving,
      setSaved: setEngineOverrideSaved,
      // Engine-only PUT — the server preserves any existing per-agent model.
      save: () =>
        engine
          ? api.putMyAgentEngineOverride(agentId, { engine })
          : api.deleteMyAgentEngineOverride(agentId),
      parse: parseEngineMap,
      refetch: () => api.getMyAgentEngineOverrides(),
      errorMsg: 'Failed to save engine',
    });

  const getModelsForEngine = (engine: any) => {
    if (!modelConfig) return [];
    return modelConfig.engineValidModels[engine] || [];
  };

  const getDefaultModel = (engine: any) => {
    if (!modelConfig) return '';
    return modelConfig.engineDefaultModels[engine] || modelConfig.defaultModel || '';
  };

  /** Engines come only from `GET /api/config/models` so new server engines appear automatically. */
  const engineChoices = useMemo(() => {
    if (!modelConfig) return [];
    return Object.keys(modelConfig.engineValidModels).filter(
      (e: any) => (modelConfig.engineValidModels[e]?.length ?? 0) > 0,
    );
  }, [modelConfig]);

  useEffect(() => {
    if (engineChoices.length === 0) return;
    if (!engineChoices.includes(bulkEngine)) {
      setBulkEngine(engineChoices[0]);
      setBulkModel('');
    }
  }, [engineChoices, bulkEngine]);

  const handleBulkApplyAll = async () => {
    if (!modelConfig || configurableAgents.length === 0) return;
    const effectiveModel = bulkModel || getDefaultModel(bulkEngine);
    if (
      !window.confirm(
        `Set your personal default for all ${configurableAgents.length} agents to engine "${bulkEngine}" with model "${effectiveModel}"? This only affects your sessions — not other users.`,
      )
    ) {
      return;
    }
    setBulkSaving(true);
    try {
      await api.bulkSetAllAgentsEngine({ engine: bulkEngine, model: effectiveModel });
      const [modelBody, engineBody] = await Promise.all([
        api.getMyAgentModelOverrides(),
        api.getMyAgentEngineOverrides(),
      ]);
      setModelOverrides(parseModelMap(modelBody) ?? {});
      setEngineOverrides(parseEngineMap(engineBody) ?? {});
      showToast?.(
        `Updated your defaults for ${configurableAgents.length} agent(s) to ${bulkEngine}.`,
        'success',
      );
    } catch (e: any) {
      console.error('Bulk agent engine update failed:', e);
      const msg = e instanceof Error ? e.message : 'Bulk engine update failed.';
      showToast?.(msg, 'error');
    } finally {
      setBulkSaving(false);
    }
  };

  const getEdit = (agentId: any) => {
    if (edits[agentId]) return edits[agentId];
    const agent = agents.find((a: any) => a.id === agentId);
    return agent ? { ...agent } : {};
  };

  const setEdit = (agentId: any, field: any, value: any) => {
    setEdits((prev: any) => ({
      ...prev,
      [agentId]: {
        ...(prev[agentId] || agents.find((a: any) => a.id === agentId)),
        [field]: value,
      },
    }));
  };

  const setHeartbeatEdit = (agentId: any, field: any, value: any) => {
    const current = getEdit(agentId);
    const hb = {
      ...(current.heartbeat || { enabled: false, interval: '', prompt: '' }),
      [field]: value,
    };
    setEdit(agentId, 'heartbeat', hb);
  };

  const handleSave = async (agentId: any) => {
    setSaving((prev: any) => ({ ...prev, [agentId]: true }));
    try {
      const data = edits[agentId];
      if (!data) return;
      const {
        id: _id,
        lastActivity: _lastActivity,
        lastMessage: _lastMessage,
        model: _model,
        ...payload
      } = data;
      const updated = await api.updateAgent(agentId, payload);
      setAgents((prev: any) => prev.map((a: any) => (a.id === agentId ? { ...a, ...updated } : a)));
      // Reconcile a per-user model override the new shared engine made stale.
      // Only relevant when the user has no per-user engine override shadowing
      // the shared one (otherwise the effective engine — and thus the valid
      // models — is unchanged). Clears the override so persisted state matches
      // the "Default" the model picker now shows.
      if (payload.engine !== undefined) {
        const eff = effectiveEngine(engineOverrides[agentId], updated?.engine ?? payload.engine);
        if (modelOverrideIsStale(modelOverrides[agentId], modelConfig, eff)) {
          await saveModelOverride(agentId, '');
        }
      }
      setEdits((prev: any) => {
        const n = { ...prev };
        delete n[agentId];
        return n;
      });
      setSaveStatus((prev: any) => ({ ...prev, [agentId]: 'saved' }));
      if (onAgentsChange) onAgentsChange();
      setTimeout(() => setSaveStatus((prev: any) => ({ ...prev, [agentId]: null })), 2000);
    } catch (_e: any) {
      setSaveStatus((prev: any) => ({ ...prev, [agentId]: 'error' }));
      setTimeout(() => setSaveStatus((prev: any) => ({ ...prev, [agentId]: null })), 3000);
    } finally {
      setSaving((prev: any) => ({ ...prev, [agentId]: false }));
    }
  };

  const handleCreate = async (e: any) => {
    e.preventDefault();
    try {
      const created = await api.createAgent(newForm);
      setAgents((prev: any) => [...prev, created]);
      setShowNew(false);
      setNewForm({
        id: '',
        name: '',
        engine: 'claude-code',
        model: '',
        projectId: projectId || scopedProjects[0]?.id || '',
        color: '#6b7280',
        avatar: '',
        systemPrompt: '',
        isDev: false,
        heartbeat: { enabled: false, interval: '', prompt: '' },
      });
      if (onAgentsChange) onAgentsChange();
    } catch (e: any) {
      console.error('Failed to create agent:', e);
    }
  };

  const handleToggleActive = async (agentId: any, currentlyActive: any) => {
    try {
      const updated = await api.updateAgent(agentId, { active: !currentlyActive });
      setAgents((prev: any) =>
        prev.map((a: any) => (a.id === agentId ? { ...a, active: updated.active } : a)),
      );
      if (onAgentsChange) onAgentsChange();
    } catch (e: any) {
      console.error('Failed to toggle agent active state:', e);
    }
  };

  const handleDelete = async (agentId: any) => {
    try {
      await api.deleteAgent(agentId);
      setAgents((prev: any) => prev.filter((a: any) => a.id !== agentId));
      setConfirmDelete(null);
      if (onAgentsChange) onAgentsChange();
    } catch (e: any) {
      console.error('Failed to delete agent:', e);
    }
  };

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const [projectCommands, setProjectCommands] = useState<any>(() => {
    const map: Record<string, any> = {};
    scopedProjects.forEach((p: any) => {
      map[p.id] = {
        install: p.commands?.install || '',
        build: p.commands?.build || '',
        test: p.commands?.test || '',
        lint: p.commands?.lint || '',
      };
    });
    return map;
  });
  const [projectPreCommitInput, setProjectPreCommitInput] = useState<any>(() => {
    const map: Record<string, any> = {};
    projects.forEach((p: any) => {
      map[p.id] =
        Array.isArray(p.preCommitCommands) && p.preCommitCommands.length
          ? p.preCommitCommands.join('\n')
          : '';
    });
    return map;
  });

  const [projectCheckHealInput, setProjectCheckHealInput] = useState<any>(() => {
    const map: Record<string, any> = {};
    projects.forEach((p: any) => {
      map[p.id] =
        Array.isArray(p.checkHealCommands) && p.checkHealCommands.length
          ? p.checkHealCommands.join('\n')
          : '';
    });
    return map;
  });

  const [projectCheckHealMaxRounds, setProjectCheckHealMaxRounds] = useState<any>(() => {
    const map: Record<string, any> = {};
    projects.forEach((p: any) => {
      const n = p.checkHealMaxRounds;
      map[p.id] = typeof n === 'number' && n >= 1 && n <= 5 ? String(n) : '2';
    });
    return map;
  });

  const [projectOrchestrationFields, setProjectOrchestrationFields] = useState<any>(() => {
    const map: Record<string, any> = {};
    projects.forEach((p: any) => {
      map[p.id] = orchestrationFieldsFromProject(p.orchestrationBudgets);
    });
    return map;
  });

  const preCommitServerSnap = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(projects.map((p: any) => [p.id, p.preCommitCommands ?? []])),
      ),
    [projects],
  );

  const checkHealServerSnap = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(
          projects.map((p: any) => [
            p.id,
            { h: p.checkHealCommands ?? [], r: p.checkHealMaxRounds ?? null },
          ]),
        ),
      ),
    [projects],
  );

  const orchestrationServerSnap = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(projects.map((p: any) => [p.id, p.orchestrationBudgets ?? null])),
      ),
    [projects],
  );

  useEffect(() => {
    setProjectPreCommitInput(() =>
      Object.fromEntries(
        projects.map((p: any) => {
          const fromServer =
            Array.isArray(p.preCommitCommands) && p.preCommitCommands.length
              ? p.preCommitCommands.join('\n')
              : '';
          return [p.id, fromServer];
        }),
      ),
    );
  }, [preCommitServerSnap]);

  useEffect(() => {
    setProjectCheckHealInput(() =>
      Object.fromEntries(
        projects.map((p: any) => {
          const fromServer =
            Array.isArray(p.checkHealCommands) && p.checkHealCommands.length
              ? p.checkHealCommands.join('\n')
              : '';
          return [p.id, fromServer];
        }),
      ),
    );
    setProjectCheckHealMaxRounds(() =>
      Object.fromEntries(
        projects.map((p: any) => {
          const n = p.checkHealMaxRounds;
          return [p.id, typeof n === 'number' && n >= 1 && n <= 5 ? String(n) : '2'];
        }),
      ),
    );
  }, [checkHealServerSnap]);

  useEffect(() => {
    setProjectOrchestrationFields(() =>
      Object.fromEntries(
        projects.map((p: any) => [p.id, orchestrationFieldsFromProject(p.orchestrationBudgets)]),
      ),
    );
  }, [orchestrationServerSnap]);

  const browserDefaultsServerSnap = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(
          projects.map((p: any) => [
            p.id,
            {
              d: p.browserToolsDefaultEnabled ?? null,
              w: p.browserViewportWidth ?? null,
              h: p.browserViewportHeight ?? null,
              t: p.browserPageLoadTimeoutMs ?? null,
            },
          ]),
        ),
      ),
    [projects],
  );

  const [projectBrowserFields, setProjectBrowserFields] = useState<Record<string, any>>({});
  useEffect(() => {
    setProjectBrowserFields(() =>
      Object.fromEntries(
        projects.map((p: any) => [
          p.id,
          {
            defaultOn: p.browserToolsDefaultEnabled !== false,
            viewportW:
              typeof p.browserViewportWidth === 'number' ? String(p.browserViewportWidth) : '',
            viewportH:
              typeof p.browserViewportHeight === 'number' ? String(p.browserViewportHeight) : '',
            timeoutMs:
              typeof p.browserPageLoadTimeoutMs === 'number'
                ? String(p.browserPageLoadTimeoutMs)
                : '',
          },
        ]),
      ),
    );
  }, [browserDefaultsServerSnap]);

  const [projectCommandsSaved, setProjectCommandsSaved] = useState<Record<string, any>>({});
  const [expandedProject, setExpandedProject] = useState<any>(null);

  const saveProjectCommands = async (projectId: any) => {
    try {
      const cmds = projectCommands[projectId] || {};
      const preCommitLines = (projectPreCommitInput[projectId] || '')
        .split('\n')
        .map((l: any) => l.trim())
        .filter(Boolean);
      const checkHealLines = (projectCheckHealInput[projectId] || '')
        .split('\n')
        .map((l: any) => l.trim())
        .filter(Boolean);
      const roundsRaw = String(projectCheckHealMaxRounds[projectId] ?? '2').trim();
      const roundsParsed = parseInt(roundsRaw, 10);
      const checkHealMaxRounds =
        Number.isFinite(roundsParsed) && roundsParsed >= 1 && roundsParsed <= 5 ? roundsParsed : 2;
      const obFields = projectOrchestrationFields[projectId] || {};
      const hasObTyping = ORCHESTRATION_FIELD_META.some(
        ({ key }: any) => String(obFields[key] ?? '').trim() !== '',
      );
      const basePayload = {
        commands: {
          install: cmds.install || null,
          build: cmds.build || null,
          test: cmds.test || null,
          lint: cmds.lint || null,
        },
        preCommitCommands: preCommitLines,
        checkHealCommands: checkHealLines,
        checkHealMaxRounds: checkHealLines.length ? checkHealMaxRounds : null,
      };
      let payload: any = basePayload;
      if (!hasObTyping) {
        payload = { ...basePayload, orchestrationBudgets: null };
      } else {
        const obParsed = buildOrchestrationBudgetsPayload(obFields);
        if (obParsed === null) {
          showToast?.(
            'Orchestration budgets: values must be whole numbers (e.g. 4, 120000). Budgets were not saved — fix or clear the fields and try again.',
            'error',
          );
          return;
        }
        payload = { ...basePayload, orchestrationBudgets: obParsed };
      }
      const projRow = projects.find((x: any) => x.id === projectId);
      const bf = projectBrowserFields[projectId] || {
        defaultOn: true,
        viewportW: '',
        viewportH: '',
        timeoutMs: '',
      };
      const browserPayload: Record<string, any> = {};
      if (bf.defaultOn) {
        browserPayload.browserToolsDefaultEnabled =
          projRow?.browserToolsDefaultEnabled === false ? true : null;
      } else {
        browserPayload.browserToolsDefaultEnabled = false;
      }
      const mergeOptDim = (raw: any, prevVal: any, field: any, min: any, max: any, label: any) => {
        const t = String(raw ?? '').trim();
        if (t === '') {
          if (prevVal != null) browserPayload[field] = null;
          return true;
        }
        const n = parseInt(t, 10);
        if (!Number.isFinite(n) || n < min || n > max) {
          showToast?.(
            `${label}: use an integer between ${min} and ${max}, or leave empty.`,
            'error',
          );
          return false;
        }
        browserPayload[field] = n;
        return true;
      };
      if (
        !mergeOptDim(
          bf.viewportW,
          projRow?.browserViewportWidth,
          'browserViewportWidth',
          320,
          3840,
          'Viewport width',
        )
      ) {
        return;
      }
      if (
        !mergeOptDim(
          bf.viewportH,
          projRow?.browserViewportHeight,
          'browserViewportHeight',
          240,
          2160,
          'Viewport height',
        )
      ) {
        return;
      }
      const timeoutRaw = String(bf.timeoutMs ?? '').trim();
      if (timeoutRaw === '') {
        if (projRow?.browserPageLoadTimeoutMs != null) {
          browserPayload.browserPageLoadTimeoutMs = null;
        }
      } else {
        const n = parseInt(timeoutRaw, 10);
        if (!Number.isFinite(n) || n < 1000 || n > 120000) {
          showToast?.(
            'Browser timeout: enter 1000–120000 ms, or leave empty for default.',
            'error',
          );
          return;
        }
        browserPayload.browserPageLoadTimeoutMs = n;
      }

      payload = { ...payload, ...browserPayload };
      await api.updateProject(projectId, payload);
      setProjectCommandsSaved((prev: any) => ({ ...prev, [projectId]: true }));
      setTimeout(
        () => setProjectCommandsSaved((prev: any) => ({ ...prev, [projectId]: false })),
        2000,
      );
    } catch {}
  };

  return (
    <div>
      {/* Project-level settings */}
      {scopedProjects.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">Project Settings</h3>
          <div className="space-y-2">
            {scopedProjects.map((p: any) => (
              <div key={p.id} className="bg-gray-800 rounded-xl p-3 space-y-2">
                <div
                  className="flex items-center gap-3 cursor-pointer"
                  onClick={() => setExpandedProject(expandedProject === p.id ? null : p.id)}
                >
                  <span className="text-2xl flex items-center text-gray-400">
                    {expandedProject === p.id ? '▾' : '▸'}
                  </span>
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: p.color }} />
                  <span className="text-sm font-medium">{p.name}</span>
                </div>
                {expandedProject === p.id && (
                  <div className="pl-8 space-y-3">
                    {/* Project Commands */}
                    <div className="space-y-2">
                      <label className="text-xs text-gray-400 font-semibold">
                        Project Commands
                      </label>
                      {['install', 'build', 'test', 'lint'].map((cmd: any) => (
                        <div key={cmd} className="flex items-center gap-2">
                          <label className="text-xs text-gray-400 flex-shrink-0 w-28 capitalize">
                            {cmd}:
                          </label>
                          <input
                            value={projectCommands[p.id]?.[cmd] || ''}
                            onChange={(e: any) =>
                              setProjectCommands((prev: any) => ({
                                ...prev,
                                [p.id]: { ...prev[p.id], [cmd]: e.target.value },
                              }))
                            }
                            placeholder={
                              cmd === 'install'
                                ? 'npm ci'
                                : cmd === 'build'
                                  ? 'npm run build'
                                  : cmd === 'test'
                                    ? 'npm test'
                                    : 'npm run lint'
                            }
                            className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-gray-600 flex-1 font-mono"
                          />
                        </div>
                      ))}
                      <div className="pt-1">
                        <label className="text-xs text-gray-400 font-semibold">
                          Pre-commit (before git commit)
                        </label>
                        <p className="text-[11px] text-gray-500 mt-0.5 mb-1">
                          One shell command per line, run in the agent worktree after an initial{' '}
                          <code className="text-gray-400">git add</code>, then the tree is{' '}
                          <code className="text-gray-400">git add</code>’d again before{' '}
                          <code className="text-gray-400">git commit</code> so formatters/fixers
                          stay staged. Leave empty to skip. Native git hooks still run on commit.
                        </p>
                        <textarea
                          value={projectPreCommitInput[p.id] ?? ''}
                          onChange={(e: any) =>
                            setProjectPreCommitInput((prev: any) => ({
                              ...prev,
                              [p.id]: e.target.value,
                            }))
                          }
                          placeholder={'npm run lint\nnpm test'}
                          rows={4}
                          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
                        />
                      </div>
                      <div className="pt-1">
                        <label className="text-xs text-gray-400 font-semibold">
                          Check auto-heal (after failed pre-commit)
                        </label>
                        <p className="text-[11px] text-gray-500 mt-0.5 mb-1">
                          One shell command per line (e.g.{' '}
                          <code className="text-gray-400">npm run lint:fix</code>,{' '}
                          <code className="text-gray-400">npm run format</code>). When a configured
                          pre-commit command exits non-zero, the server runs these fixers,
                          optionally re-stages with{' '}
                          <code className="text-gray-400">git add -A</code>, waits briefly, then
                          re-runs <strong>all</strong> check commands. Timeouts and output-cap
                          failures are never auto-healed. Leave empty to keep the legacy fail-fast
                          behavior.
                        </p>
                        <textarea
                          value={projectCheckHealInput[p.id] ?? ''}
                          onChange={(e: any) =>
                            setProjectCheckHealInput((prev: any) => ({
                              ...prev,
                              [p.id]: e.target.value,
                            }))
                          }
                          placeholder={'npm run lint:fix\nnpm run format'}
                          rows={3}
                          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
                        />
                        <div className="flex items-center gap-2 mt-1.5">
                          <label className="text-[11px] text-gray-500 whitespace-nowrap">
                            Max check rounds (1–5, default 2)
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={5}
                            value={projectCheckHealMaxRounds[p.id] ?? '2'}
                            onChange={(e: any) =>
                              setProjectCheckHealMaxRounds((prev: any) => ({
                                ...prev,
                                [p.id]: e.target.value,
                              }))
                            }
                            className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
                          />
                        </div>
                      </div>
                      <div className="pt-2 border-t border-gray-700/50 space-y-2">
                        <label className="text-xs text-gray-400 font-semibold">
                          ReAct / orchestration budgets
                        </label>
                        <p className="text-[11px] text-gray-500">
                          Optional caps for auto-continuation, host ReAct actions, wiki hybrid RAG,
                          and web search. Leave all empty to clear project-level overrides (server
                          defaults apply).
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                          {ORCHESTRATION_FIELD_META.map(({ key, label, hint }: any) => (
                            <div key={key}>
                              <label
                                className="block text-[10px] text-gray-500 mb-0.5"
                                title={hint}
                              >
                                {label}
                              </label>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={(projectOrchestrationFields[p.id] || {})[key] ?? ''}
                                onChange={(e: any) =>
                                  setProjectOrchestrationFields((prev: any) => ({
                                    ...prev,
                                    [p.id]: { ...(prev[p.id] || {}), [key]: e.target.value },
                                  }))
                                }
                                placeholder="—"
                                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="pt-2 border-t border-gray-700/50 space-y-2">
                        <div className="flex items-center gap-2 text-xs text-gray-400 font-semibold">
                          <Globe size={14} className="text-sky-400 shrink-0" />
                          <Monitor size={14} className="text-sky-400 shrink-0" />
                          <span>Browser tools (project default)</span>
                        </div>
                        <p className="text-[11px] text-gray-500">
                          Agents without their own Browser Tools setting follow this default. When
                          OFF, host browser ReAct tools stay out of the enriched prompt unless an
                          agent explicitly enables them.
                        </p>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            data-testid={`project-${p.id}-browser-default-toggle`}
                            onClick={() =>
                              setProjectBrowserFields((prev: any) => {
                                const row = {
                                  defaultOn: true,
                                  viewportW: '',
                                  viewportH: '',
                                  timeoutMs: '',
                                  ...prev[p.id],
                                };
                                const cur = row.defaultOn !== false;
                                return {
                                  ...prev,
                                  [p.id]: { ...row, defaultOn: !cur },
                                };
                              })
                            }
                            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                              projectBrowserFields[p.id]?.defaultOn !== false
                                ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                                : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                            }`}
                          >
                            {projectBrowserFields[p.id]?.defaultOn !== false ? 'ON' : 'OFF'}
                          </button>
                          <span className="text-[11px] text-gray-500">Default browser tools</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pl-1">
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">
                              Viewport width (px)
                            </label>
                            <input
                              type="number"
                              min={320}
                              max={3840}
                              placeholder="1280 default"
                              value={projectBrowserFields[p.id]?.viewportW ?? ''}
                              onChange={(e: any) =>
                                setProjectBrowserFields((prev: any) => ({
                                  ...prev,
                                  [p.id]: {
                                    ...(prev[p.id] || { defaultOn: true }),
                                    viewportW: e.target.value,
                                  },
                                }))
                              }
                              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">
                              Viewport height (px)
                            </label>
                            <input
                              type="number"
                              min={240}
                              max={2160}
                              placeholder="720 default"
                              value={projectBrowserFields[p.id]?.viewportH ?? ''}
                              onChange={(e: any) =>
                                setProjectBrowserFields((prev: any) => ({
                                  ...prev,
                                  [p.id]: {
                                    ...(prev[p.id] || { defaultOn: true }),
                                    viewportH: e.target.value,
                                  },
                                }))
                              }
                              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">
                              Load timeout (ms)
                            </label>
                            <input
                              type="number"
                              min={1000}
                              max={120000}
                              step={500}
                              placeholder="30000 default"
                              value={projectBrowserFields[p.id]?.timeoutMs ?? ''}
                              onChange={(e: any) =>
                                setProjectBrowserFields((prev: any) => ({
                                  ...prev,
                                  [p.id]: {
                                    ...(prev[p.id] || { defaultOn: true }),
                                    timeoutMs: e.target.value,
                                  },
                                }))
                              }
                              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
                            />
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => saveProjectCommands(p.id)}
                        className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded-lg transition-colors"
                      >
                        {projectCommandsSaved[p.id] ? 'Saved' : 'Save Commands'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Agent Configurations</h3>
        <button
          onClick={() => setShowNew(!showNew)}
          className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors"
        >
          {showNew ? 'Cancel' : '+ New Agent'}
        </button>
      </div>

      {agents.length > 0 && modelConfig && (
        <div className="bg-gray-800/80 rounded-xl p-4 mb-4 space-y-3 border border-gray-700/50">
          <p className="text-xs text-gray-400">
            Switch every agent at once for your own sessions only (for example when moving off a
            provider or subscription). Does not change shared agent settings for other users.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label className={labelClass}>Engine (all agents, only for me)</label>
              <select
                value={bulkEngine}
                onChange={(e: any) => {
                  setBulkEngine(e.target.value);
                  setBulkModel('');
                }}
                className={inputClass}
              >
                {engineChoices.map((e: any) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Model (only for me)</label>
              <select
                value={bulkModel || getDefaultModel(bulkEngine)}
                onChange={(e: any) => setBulkModel(e.target.value)}
                className={inputClass}
              >
                {getModelsForEngine(bulkEngine).map((m: any) => (
                  <option key={m} value={m}>
                    {m}
                    {m === getDefaultModel(bulkEngine) ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={bulkSaving}
              onClick={handleBulkApplyAll}
              className="text-sm bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white px-3 py-2 rounded-lg transition-colors"
            >
              {bulkSaving ? 'Applying…' : 'Apply to all agents'}
            </button>
          </div>
        </div>
      )}

      {showNew && (
        <form onSubmit={handleCreate} className="bg-gray-800 rounded-xl p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>ID (required, alphanumeric + hyphens)</label>
              <input
                value={newForm.id}
                onChange={(e: any) => setNewForm({ ...newForm, id: e.target.value })}
                required
                pattern="[a-zA-Z0-9-]+"
                className={inputClass}
                placeholder="my-agent"
              />
            </div>
            <div>
              <label className={labelClass}>Name</label>
              <input
                value={newForm.name}
                onChange={(e: any) => setNewForm({ ...newForm, name: e.target.value })}
                className={inputClass}
                placeholder="My Agent"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelClass}>Engine</label>
              <select
                value={newForm.engine}
                onChange={(e: any) => setNewForm({ ...newForm, engine: e.target.value, model: '' })}
                className={inputClass}
              >
                {engineChoices.map((e: any) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Model</label>
              <select
                value={newForm.model || getDefaultModel(newForm.engine)}
                onChange={(e: any) => setNewForm({ ...newForm, model: e.target.value })}
                className={inputClass}
              >
                {getModelsForEngine(newForm.engine).map((m: any) => (
                  <option key={m} value={m}>
                    {m}
                    {m === getDefaultModel(newForm.engine) ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={newForm.color}
                  onChange={(e: any) => setNewForm({ ...newForm, color: e.target.value })}
                  className="w-10 h-10 rounded border border-gray-700 cursor-pointer bg-transparent"
                />
                <span className="text-xs text-gray-400 font-mono">{newForm.color}</span>
              </div>
            </div>
          </div>
          <div>
            <label className={labelClass}>Avatar</label>
            <div className="flex items-center gap-3">
              <AgentAvatar
                avatar={newForm.avatar}
                color={newForm.color}
                size={48}
                apiBase={getServerBase()}
              />
              <label className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors cursor-pointer">
                Upload
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e: any) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const formData = new FormData();
                    formData.append('image', file);
                    try {
                      const res = await fetch(`${getApiBase()}/upload`, {
                        method: 'POST',
                        headers: getAuthHeaders(),
                        body: formData,
                      });
                      const data = await res.json();
                      if (data.url) setNewForm({ ...newForm, avatar: data.url });
                    } catch (err: any) {
                      console.error('Avatar upload failed:', err);
                    }
                  }}
                />
              </label>
              {newForm.avatar && (
                <button
                  type="button"
                  onClick={() => setNewForm({ ...newForm, avatar: '' })}
                  className="text-xs text-gray-500 hover:text-red-400"
                >
                  Remove
                </button>
              )}
            </div>
            <IconPickerGrid
              selected={isIconAvatar(newForm.avatar) ? newForm.avatar : null}
              color={newForm.color}
              onSelect={(iconName: any) =>
                setNewForm({ ...newForm, avatar: buildIconAvatar(iconName) })
              }
            />
          </div>
          {!projectId && (
            <div>
              <label className={labelClass}>Project</label>
              <select
                value={newForm.projectId}
                onChange={(e: any) => setNewForm({ ...newForm, projectId: e.target.value })}
                className={inputClass}
                required
              >
                <option value="" disabled>
                  Select a project...
                </option>
                {scopedProjects.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.cwd}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={labelClass}>System Prompt</label>
            <textarea
              value={newForm.systemPrompt}
              onChange={(e: any) => setNewForm({ ...newForm, systemPrompt: e.target.value })}
              rows={3}
              className={inputClass + ' resize-none'}
            />
          </div>
          <div className="border-t border-gray-700 pt-3">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <label className="text-xs text-gray-400 font-medium">Dev</label>
              <button
                type="button"
                data-testid="agent-create-dev-toggle"
                onClick={() => setNewForm({ ...newForm, isDev: !newForm.isDev })}
                className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                  newForm.isDev
                    ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                {newForm.isDev ? 'ON' : 'OFF'}
              </button>
            </div>
            <p className="text-xs text-gray-500">
              When ON, this agent can be automatically assigned autonomous tickets from the kanban
              board. Defaults to OFF — flip it on to opt the agent into autonomous dispatch.
            </p>
          </div>
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Create Agent
          </button>
        </form>
      )}

      <div className="space-y-3">
        {(() => {
          // Group agents: leads first, then subs indented under their lead
          const leads = configurableAgents.filter((a: any) => a.role === 'lead');
          const subs = configurableAgents.filter((a: any) => a.role === 'sub');
          const standalone = configurableAgents.filter(
            (a: any) => a.role !== 'lead' && a.role !== 'sub',
          );
          const subsByParent: Record<string, any> = {};
          for (const s of subs) {
            const pid = s.parentAgentId;
            if (!subsByParent[pid]) subsByParent[pid] = [];
            subsByParent[pid].push(s);
          }
          // Build ordered list: lead, then its subs, then next lead, etc., then standalone
          const ordered: any[] = [];
          for (const lead of leads) {
            ordered.push({ agent: lead, indent: 0, isLead: true });
            for (const sub of subsByParent[lead.id] || []) {
              ordered.push({ agent: sub, indent: 1, isSub: true });
            }
          }
          for (const a of standalone) {
            ordered.push({ agent: a, indent: 0 });
          }
          // Any orphan subs
          for (const s of subs) {
            if (!leads.find((l: any) => l.id === s.parentAgentId)) {
              ordered.push({ agent: s, indent: 0, isSub: true });
            }
          }
          return ordered;
        })().map(({ agent, indent, isLead, isSub }: any) => {
          const isExpanded = expanded === agent.id;
          const edit = getEdit(agent.id);
          const isDirty = !!edits[agent.id];
          return (
            <div
              key={agent.id}
              className={`bg-gray-800 rounded-xl overflow-hidden${agent.active === false ? ' opacity-50' : ''}`}
              style={indent > 0 ? { marginLeft: `${indent * 24}px` } : {}}
            >
              <div
                className="flex items-center gap-3 p-4 cursor-pointer hover:bg-gray-750"
                onClick={() => setExpanded(isExpanded ? null : agent.id)}
              >
                {isSub && <span className="text-gray-600 text-xs -ml-1">└</span>}
                <span
                  className={`w-3 h-3 flex-shrink-0 ${isLead ? 'rounded-sm' : 'rounded-full'}`}
                  style={{ backgroundColor: agent.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{agent.name}</span>
                    {isLead && (
                      <span className="bg-amber-900/50 text-amber-300 px-1.5 py-0.5 rounded-full text-xs font-medium">
                        Lead
                      </span>
                    )}
                    {isSub && (
                      <span className="bg-indigo-900/50 text-indigo-300 px-1.5 py-0.5 rounded-full text-xs">
                        Sub
                      </span>
                    )}
                    <span className="text-xs text-gray-500 font-mono">{agent.id}</span>
                    <span className="text-xs text-gray-500">{agent.engine}</span>
                    {agent.active === false && (
                      <span className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">
                        inactive
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {agent.projectName && (
                      <span className="text-gray-400">{agent.projectName}</span>
                    )}
                    {agent.projectName && agent.cwd && <span className="mx-1">·</span>}
                    <span className="font-mono">{agent.cwd}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e: any) => {
                      e.stopPropagation();
                      handleToggleActive(agent.id, agent.active !== false);
                    }}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                      agent.active !== false
                        ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    {agent.active !== false ? 'Active' : 'Inactive'}
                  </button>
                  {saveStatus[agent.id] === 'saved' && (
                    <span className="text-xs text-emerald-400">✓ Saved</span>
                  )}
                  {saveStatus[agent.id] === 'error' && (
                    <span className="text-xs text-red-400">✕ Error</span>
                  )}
                  <span className="text-base text-gray-400">{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-gray-700 p-4 space-y-3">
                  <div>
                    <label className={labelClass}>ID</label>
                    <p className="text-sm text-gray-300 font-mono bg-gray-900 rounded-lg px-3 py-2">
                      {agent.id}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Name</label>
                      <input
                        value={edit.name || ''}
                        onChange={(e: any) => setEdit(agent.id, 'name', e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Engine (shared)</label>
                      <select
                        value={edit.engine || 'claude-code'}
                        onChange={(e: any) => setEdit(agent.id, 'engine', e.target.value)}
                        className={inputClass}
                        data-testid="agent-shared-engine"
                      >
                        {engineChoices.map((e: any) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Per-user picks — these change only the current user's own
                      sessions for this agent, never the shared row above. */}
                  <div className="rounded-lg border border-indigo-900/40 bg-indigo-950/20 p-3">
                    <h5 className="mb-2 text-xs font-medium text-indigo-200">Only for me</h5>
                    <div className="grid grid-cols-2 gap-3">
                      <PerUserEngineSelect
                        agentEngine={edit.engine || agent.engine || 'claude-code'}
                        modelConfig={modelConfig}
                        value={engineOverrides[agent.id] || ''}
                        onSelect={(eng: any) => saveEngineOverride(agent.id, eng)}
                        saving={!!engineOverrideSaving[agent.id]}
                        saved={!!engineOverrideSaved[agent.id]}
                        selectClassName={inputClass}
                      />
                      <PerUserModelSelect
                        engine={
                          engineOverrides[agent.id] || edit.engine || agent.engine || 'claude-code'
                        }
                        modelConfig={modelConfig}
                        value={modelOverrides[agent.id] || ''}
                        onSelect={(m: any) => saveModelOverride(agent.id, m)}
                        saving={!!modelOverrideSaving[agent.id]}
                        saved={!!modelOverrideSaved[agent.id]}
                        selectClassName={inputClass}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Color</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={edit.color || '#6b7280'}
                          onChange={(e: any) => setEdit(agent.id, 'color', e.target.value)}
                          className="w-10 h-10 rounded border border-gray-700 cursor-pointer bg-transparent"
                        />
                        <span className="text-xs text-gray-400 font-mono">
                          {edit.color || agent.color}
                        </span>
                      </div>
                    </div>
                    <div>
                      <label className={labelClass}>Avatar</label>
                      <div className="flex items-center gap-3">
                        <AgentAvatar
                          avatar={edit.avatar ?? agent.avatar}
                          color={edit.color || agent.color}
                          size={48}
                          apiBase={getServerBase()}
                        />
                        <label className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors cursor-pointer">
                          Upload
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={async (e: any) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const formData = new FormData();
                              formData.append('image', file);
                              try {
                                const res = await fetch(`${getApiBase()}/upload`, {
                                  method: 'POST',
                                  headers: getAuthHeaders(),
                                  body: formData,
                                });
                                const data = await res.json();
                                if (data.url) setEdit(agent.id, 'avatar', data.url);
                              } catch (err: any) {
                                console.error('Avatar upload failed:', err);
                              }
                            }}
                          />
                        </label>
                        {(edit.avatar || agent.avatar) && (
                          <button
                            type="button"
                            onClick={() => setEdit(agent.id, 'avatar', '')}
                            className="text-xs text-gray-500 hover:text-red-400"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <IconPickerGrid
                        selected={
                          isIconAvatar(edit.avatar ?? agent.avatar)
                            ? (edit.avatar ?? agent.avatar)
                            : null
                        }
                        color={edit.color || agent.color}
                        onSelect={(iconName: any) =>
                          setEdit(agent.id, 'avatar', buildIconAvatar(iconName))
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <label className={labelClass}>Project</label>
                    <p className="text-sm text-gray-300 font-mono bg-gray-900 rounded-lg px-3 py-2">
                      {agent.projectName || 'Unknown'}{' '}
                      <span className="text-gray-500">— {agent.cwd || 'no cwd'}</span>
                    </p>
                  </div>

                  <div>
                    <label className={labelClass}>System Prompt</label>
                    <textarea
                      value={edit.systemPrompt || ''}
                      onChange={(e: any) => setEdit(agent.id, 'systemPrompt', e.target.value)}
                      rows={4}
                      className={inputClass + ' resize-none'}
                    />
                  </div>

                  <div className="border-t border-gray-700 pt-3">
                    {(() => {
                      const lockedOn = isAutonomyLockedOn(agent);
                      const locked = isAutonomyLocked(agent);
                      // Editable value follows the explicit edit, else the
                      // agent's effective eligibility (so a pre-flag agent
                      // shows its real routing state, not a misleading OFF).
                      const devOn = locked
                        ? lockedOn
                        : edit.isDev !== undefined
                          ? edit.isDev
                          : agentAcceptsAutonomousTickets(agent);
                      return (
                        <>
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <label className="text-xs text-gray-400 font-medium">Dev</label>
                            <button
                              type="button"
                              data-testid="agent-dev-toggle"
                              disabled={locked}
                              onClick={() => {
                                if (locked) return;
                                setEdit(agent.id, 'isDev', !devOn);
                              }}
                              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                                locked ? 'cursor-not-allowed opacity-70 ' : ''
                              }${
                                devOn
                                  ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                              }`}
                            >
                              {devOn ? 'ON' : 'OFF'}
                            </button>
                          </div>
                          <p className="text-xs text-gray-500">
                            When ON, this agent can be automatically assigned autonomous tickets
                            from the kanban board.
                            {lockedOn
                              ? ' Default Dev agent — always on and cannot be changed.'
                              : locked
                                ? ' Out-of-band role — never receives autonomous tickets.'
                                : ' Turn OFF to stop autonomous tickets from routing here.'}
                          </p>
                        </>
                      );
                    })()}
                  </div>

                  <div className="border-t border-gray-700 pt-3">
                    {(() => {
                      const projRow = projects.find((pr: any) => pr.id === agent.projectId);
                      const inheritedOff = projRow?.browserToolsDefaultEnabled === false;
                      const toggleOn =
                        edit.browserToolsEnabled !== undefined
                          ? edit.browserToolsEnabled
                          : agent.browserToolsEnabled !== undefined
                            ? agent.browserToolsEnabled
                            : !inheritedOff;
                      const browserToolsOnForAgent = toggleOn !== false;
                      const vw =
                        edit.browserViewportWidth !== undefined
                          ? edit.browserViewportWidth
                          : agent.browserViewportWidth;
                      const vh =
                        edit.browserViewportHeight !== undefined
                          ? edit.browserViewportHeight
                          : agent.browserViewportHeight;
                      const bto =
                        edit.browserPageLoadTimeoutMs !== undefined
                          ? edit.browserPageLoadTimeoutMs
                          : agent.browserPageLoadTimeoutMs;
                      return (
                        <>
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <Globe size={14} className="text-sky-400 shrink-0" />
                            <Monitor size={14} className="text-sky-400 shrink-0" />
                            <label className="text-xs text-gray-400 font-medium">
                              Browser Tools
                            </label>
                            <button
                              type="button"
                              data-testid="agent-browser-tools-toggle"
                              onClick={() => {
                                setEdit(agent.id, 'browserToolsEnabled', !browserToolsOnForAgent);
                              }}
                              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                                browserToolsOnForAgent
                                  ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                              }`}
                            >
                              {browserToolsOnForAgent ? 'ON' : 'OFF'}
                            </button>
                          </div>
                          <p className="text-xs text-gray-500 mb-2">
                            When ON, the enriched prompt documents{' '}
                            <code className="font-mono">{'{"tool":"browser",...}'}</code> in{' '}
                            <code className="font-mono">&lt;agenthub:react&gt;</code> and the host
                            runs Stagehand/Playwright steps. When OFF, browser actions are stripped.
                            Uses the project default when this agent has no explicit setting
                            {projRow?.browserToolsDefaultEnabled === false
                              ? ' (this project defaults to OFF).'
                              : '.'}
                          </p>
                          {browserToolsOnForAgent && (
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                              <div>
                                <label className={labelClass}>Viewport width (optional)</label>
                                <input
                                  type="number"
                                  min={320}
                                  max={3840}
                                  placeholder={
                                    projRow?.browserViewportWidth != null
                                      ? `Project: ${projRow.browserViewportWidth}`
                                      : '1280 default'
                                  }
                                  value={vw != null ? String(vw) : ''}
                                  onChange={(e: any) => {
                                    const t = e.target.value.trim();
                                    if (t === '') setEdit(agent.id, 'browserViewportWidth', null);
                                    else {
                                      const n = parseInt(t, 10);
                                      if (Number.isFinite(n))
                                        setEdit(agent.id, 'browserViewportWidth', n);
                                    }
                                  }}
                                  className={inputClass}
                                />
                              </div>
                              <div>
                                <label className={labelClass}>Viewport height (optional)</label>
                                <input
                                  type="number"
                                  min={240}
                                  max={2160}
                                  placeholder={
                                    projRow?.browserViewportHeight != null
                                      ? `Project: ${projRow.browserViewportHeight}`
                                      : '720 default'
                                  }
                                  value={vh != null ? String(vh) : ''}
                                  onChange={(e: any) => {
                                    const t = e.target.value.trim();
                                    if (t === '') setEdit(agent.id, 'browserViewportHeight', null);
                                    else {
                                      const n = parseInt(t, 10);
                                      if (Number.isFinite(n))
                                        setEdit(agent.id, 'browserViewportHeight', n);
                                    }
                                  }}
                                  className={inputClass}
                                />
                              </div>
                              <div>
                                <label className={labelClass}>Max page load timeout (ms)</label>
                                <input
                                  type="number"
                                  min={1000}
                                  max={120000}
                                  step={500}
                                  placeholder={
                                    projRow?.browserPageLoadTimeoutMs != null
                                      ? `Project: ${projRow.browserPageLoadTimeoutMs}`
                                      : '30000 default'
                                  }
                                  value={bto != null ? String(bto) : ''}
                                  onChange={(e: any) => {
                                    const t = e.target.value.trim();
                                    if (t === '')
                                      setEdit(agent.id, 'browserPageLoadTimeoutMs', null);
                                    else {
                                      const n = parseInt(t, 10);
                                      if (Number.isFinite(n))
                                        setEdit(agent.id, 'browserPageLoadTimeoutMs', n);
                                    }
                                  }}
                                  className={inputClass}
                                />
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  <div className="border-t border-gray-700 pt-3">
                    {(() => {
                      const skillList = agentSkills[agent.id];
                      const skillsLoaded = Array.isArray(skillList);
                      const skillsLoadError = !!agentSkillsError[agent.id];
                      const allowed =
                        edit.allowedSkills !== undefined ? edit.allowedSkills : agent.allowedSkills;
                      const restricted = Array.isArray(allowed);
                      const allowedSet = new Set(restricted ? allowed : []);
                      const allIds = skillsLoaded ? skillList.map((s: any) => s.id) : [];
                      return (
                        <>
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <label className="text-xs text-gray-400 font-medium">
                              Allowed skills
                            </label>
                            <button
                              type="button"
                              data-testid="agent-allowed-skills-toggle"
                              // Disabled until the skill list successfully loads.
                              // This both avoids seeding an empty-lockout on the
                              // initial-load race AND prevents a fetch FAILURE
                              // (distinct error state) from enabling restriction
                              // with an empty allowlist that a save would persist
                              // as `allowedSkills: []`, wiping every skill.
                              disabled={!skillsLoaded}
                              onClick={() => {
                                // OFF -> null clears the restriction (all skills).
                                // ON  -> seed with every known skill id so enabling
                                // the restriction is not an instant lockout; the
                                // operator then unchecks what to remove.
                                setEdit(agent.id, 'allowedSkills', restricted ? null : allIds);
                              }}
                              className={`text-xs px-2.5 py-1 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                restricted
                                  ? 'bg-amber-800/50 text-amber-300 hover:bg-amber-800'
                                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                              }`}
                            >
                              {restricted ? 'RESTRICTED' : 'ALL'}
                            </button>
                          </div>
                          <p className="text-xs text-gray-500 mb-2">
                            When set to <span className="font-medium">ALL</span>, this agent sees
                            and can trigger every project + bundled skill. When{' '}
                            <span className="font-medium">RESTRICTED</span>, only the checked skills
                            are listed in its prompt and loadable via{' '}
                            <code className="font-mono">&lt;agenthub:skill&gt;</code> — every other
                            skill fails to load. Useful for trimming prompt noise and for keeping
                            sensitive skills (e.g. <code className="font-mono">1password</code>,{' '}
                            <code className="font-mono">aws-cli</code>) off agents that should never
                            touch them.
                          </p>
                          {skillsLoadError && (
                            <div
                              className="flex items-center gap-2 mb-1"
                              data-testid="agent-allowed-skills-error"
                            >
                              <p className="text-xs text-red-400">
                                Couldn’t load this agent’s skill list — restriction editing is
                                disabled to avoid accidentally removing skills.
                              </p>
                              <button
                                type="button"
                                data-testid="agent-allowed-skills-retry"
                                onClick={() => retryLoadSkills(agent.id)}
                                className="text-xs px-2 py-0.5 rounded-md bg-gray-700 text-gray-200 hover:bg-gray-600"
                              >
                                Retry
                              </button>
                            </div>
                          )}
                          {restricted &&
                            !skillsLoadError &&
                            (!skillsLoaded ? (
                              <p className="text-xs text-gray-500">Loading skills…</p>
                            ) : allIds.length === 0 ? (
                              <p className="text-xs text-gray-500">
                                No skills available for this agent.
                              </p>
                            ) : (
                              <div
                                className="space-y-1 max-h-56 overflow-y-auto pr-1"
                                data-testid="agent-allowed-skills-list"
                              >
                                {skillList.map((s: any) => (
                                  <label
                                    key={s.id}
                                    className="flex items-start gap-2 py-1 px-2 rounded hover:bg-gray-800 cursor-pointer"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={allowedSet.has(s.id)}
                                      onChange={() => {
                                        const next = new Set(allowedSet);
                                        if (next.has(s.id)) next.delete(s.id);
                                        else next.add(s.id);
                                        // Preserve the on-disk skill order.
                                        setEdit(
                                          agent.id,
                                          'allowedSkills',
                                          allIds.filter((id: any) => next.has(id)),
                                        );
                                      }}
                                      className="mt-0.5 rounded border-gray-600 bg-gray-900 text-indigo-500"
                                    />
                                    <span className="min-w-0">
                                      <span className="text-sm text-gray-200 font-mono">
                                        {s.id}
                                      </span>
                                      {s.description ? (
                                        <span className="block text-xs text-gray-500 truncate">
                                          {s.description}
                                        </span>
                                      ) : null}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ))}
                        </>
                      );
                    })()}
                  </div>

                  <div>
                    <label className={labelClass}>
                      PR Reviewer (GitHub username — overrides project default)
                    </label>
                    <input
                      value={edit.reviewer || ''}
                      onChange={(e: any) => setEdit(agent.id, 'reviewer', e.target.value)}
                      placeholder="github-username"
                      className={inputClass}
                    />
                  </div>

                  {/*
                    Delegation gate (per-agent operator switch).

                    Surfaced only for lead agents (those with one or more
                    sub-agents). Default is ON (treat undefined/true as
                    enabled); the only state that disables dispatch is the
                    explicit literal `false`. See
                    `server/delegation-gate.ts` for the matching server-side
                    semantics. Toggling here flips `delegationEnabled` in
                    the agent edit buffer; saving sends it through the
                    standard `PATCH /api/agents/:id` flow.
                  */}
                  {Array.isArray(agent.subAgents) && agent.subAgents.length > 0 && (
                    <div className="border-t border-gray-700 pt-3">
                      <div className="flex items-center gap-3 mb-2">
                        <label className="text-xs text-gray-400 font-medium">
                          Delegation to sub-agents
                        </label>
                        <button
                          data-testid="agent-delegation-toggle"
                          onClick={() => {
                            const current =
                              edit.delegationEnabled !== undefined
                                ? edit.delegationEnabled
                                : agent.delegationEnabled !== false;
                            setEdit(agent.id, 'delegationEnabled', !current);
                          }}
                          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                            (
                              edit.delegationEnabled !== undefined
                                ? edit.delegationEnabled
                                : agent.delegationEnabled !== false
                            )
                              ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                              : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                          }`}
                        >
                          {(
                            edit.delegationEnabled !== undefined
                              ? edit.delegationEnabled
                              : agent.delegationEnabled !== false
                          )
                            ? 'ON'
                            : 'OFF'}
                        </button>
                      </div>
                      <p className="text-xs text-gray-500">
                        When OFF, this lead&apos;s{' '}
                        <code className="font-mono">&lt;delegate&gt;</code> blocks are ignored and
                        an in-chat nudge is shown instead. Use this when sub-agent fan-out is more
                        harmful than helpful — the lead will complete the work inline.
                      </p>
                    </div>
                  )}

                  {/* Heartbeat settings */}
                  <div className="border-t border-gray-700 pt-3">
                    <div className="flex items-center gap-3 mb-3">
                      <label className="text-xs text-gray-400 font-medium">Heartbeat</label>
                      <button
                        onClick={() =>
                          setHeartbeatEdit(agent.id, 'enabled', !edit.heartbeat?.enabled)
                        }
                        className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                          edit.heartbeat?.enabled
                            ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                            : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                        }`}
                      >
                        {edit.heartbeat?.enabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className={labelClass}>
                          Interval (cron expression, e.g. */30 * * * * = every 30 min)
                        </label>
                        <input
                          value={edit.heartbeat?.interval || ''}
                          onChange={(e: any) =>
                            setHeartbeatEdit(agent.id, 'interval', e.target.value)
                          }
                          placeholder="*/30 * * * *"
                          className={inputClass}
                        />
                        {edit.heartbeat?.interval &&
                          humanCron(edit.heartbeat.interval) !== edit.heartbeat.interval && (
                            <p className="text-xs text-blue-400 mt-1">
                              ↳ {humanCron(edit.heartbeat.interval)}
                            </p>
                          )}
                      </div>
                      <div>
                        <label className={labelClass}>Heartbeat Prompt</label>
                        <textarea
                          value={edit.heartbeat?.prompt || ''}
                          onChange={(e: any) =>
                            setHeartbeatEdit(agent.id, 'prompt', e.target.value)
                          }
                          rows={3}
                          className={inputClass + ' resize-none'}
                        />
                      </div>
                      {(modelConfig?.engineValidModels?.['claude-code'] || []).length > 0 && (
                        <div>
                          <label className={labelClass}>Heartbeat Model</label>
                          <select
                            value={edit.heartbeat?.model || ''}
                            onChange={(e: any) =>
                              setHeartbeatEdit(agent.id, 'model', e.target.value)
                            }
                            className={inputClass}
                          >
                            <option value="">CLI default</option>
                            {(modelConfig.engineValidModels['claude-code'] || []).map((m: any) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <p className="text-xs text-gray-500 mt-1">
                            Heartbeats always run via the Claude CLI, so only{' '}
                            <code className="font-mono">claude-code</code> models apply.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* MCP Servers */}
                  <McpServersSection agentId={agent.id} />

                  <div className="flex items-center justify-between pt-2">
                    <button
                      onClick={() => {
                        if (confirmDelete === agent.id) {
                          handleDelete(agent.id);
                        } else {
                          setConfirmDelete(agent.id);
                          setTimeout(() => setConfirmDelete(null), 3000);
                        }
                      }}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                        confirmDelete === agent.id
                          ? 'bg-red-600 text-white hover:bg-red-500'
                          : 'text-gray-500 hover:text-red-400 hover:bg-gray-700'
                      }`}
                    >
                      {confirmDelete === agent.id ? 'Confirm Delete' : 'Delete Agent'}
                    </button>
                    <button
                      onClick={() => handleSave(agent.id)}
                      disabled={!isDirty || saving[agent.id]}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
                    >
                      {saving[agent.id] ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {agents.length === 0 && <p className="text-sm text-gray-500">No agents configured</p>}
      </div>
    </div>
  );
}

function UsageSection() {
  const [usage, setUsage] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getUsage()
      .then(setUsage)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading usage data...</p>;
  }

  if (!usage || !usage.totals) {
    return (
      <p className="text-sm text-gray-500">
        No usage data available yet. Usage is tracked from Claude Code stream-json output.
      </p>
    );
  }

  const { totals, byAgent, byDay, recentSessions } = usage;
  const fmtCost = (c: any) => `$${Number(c || 0).toFixed(2)}`;
  const fmtDuration = (ms: any) => {
    const s = (ms || 0) / 1000;
    if (s < 60) return `${s.toFixed(0)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };

  // Find max daily cost for bar chart scaling
  const maxDayCost = Math.max(...(byDay || []).map((d: any) => d.cost), 0.01);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div>
        <h3 className="text-lg font-semibold mb-3">Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total Cost</p>
            <p className="text-2xl font-bold text-emerald-400 mt-1">{fmtCost(totals.total_cost)}</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total Time</p>
            <p className="text-2xl font-bold text-blue-400 mt-1">
              {fmtDuration(totals.total_duration_ms)}
            </p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Turns</p>
            <p className="text-2xl font-bold text-gray-200 mt-1">{totals.total_turns}</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Messages</p>
            <p className="text-2xl font-bold text-gray-200 mt-1">{totals.count}</p>
          </div>
        </div>
      </div>

      {/* Per-agent breakdown */}
      {byAgent?.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">By Agent</h3>
          <div className="bg-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-left text-xs text-gray-500 uppercase">
                  <th className="px-4 py-3">Agent</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                  <th className="px-4 py-3 text-right">Time</th>
                  <th className="px-4 py-3 text-right">Turns</th>
                  <th className="px-4 py-3 text-right">Messages</th>
                </tr>
              </thead>
              <tbody>
                {byAgent.map((row: any) => (
                  <tr key={row.agent_id} className="border-b border-gray-700/50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: row.agent_color }}
                        />
                        <span className="font-medium">{row.agent_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-emerald-400 font-mono">
                      {fmtCost(row.total_cost)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400 font-mono">
                      {fmtDuration(row.total_duration_ms)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400">{row.total_turns}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Daily usage chart */}
      {byDay?.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Daily Cost (last 30 days)</h3>
          <div className="bg-gray-800 rounded-xl p-4">
            <div className="space-y-1.5">
              {byDay.map((day: any) => {
                const pct = (day.cost / maxDayCost) * 100;
                return (
                  <div key={day.day} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 font-mono w-20 flex-shrink-0">
                      {day.day.slice(5)}
                    </span>
                    <div className="flex-1 h-5 bg-gray-900 rounded overflow-hidden">
                      <div
                        className="h-full bg-emerald-600/60 rounded"
                        style={{ width: `${Math.max(pct, 1)}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 font-mono w-16 text-right">
                      {fmtCost(day.cost)}
                    </span>
                    <span className="text-xs text-gray-600 w-8 text-right">{day.count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Recent sessions */}
      {recentSessions?.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Recent Sessions</h3>
          <div className="bg-gray-800 rounded-xl overflow-hidden">
            <div className="divide-y divide-gray-700/50">
              {recentSessions.map((s: any) => (
                <div key={s.id} className="px-4 py-3 flex items-center gap-3">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: s.agent_color }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{s.session_name}</p>
                    <p className="text-xs text-gray-500">
                      {s.agent_name} · {s.message_count} message{s.message_count !== 1 ? 's' : ''}
                      {' · '}
                      {fmtDuration(s.duration_ms)}
                    </p>
                  </div>
                  <span className="text-sm text-emerald-400 font-mono flex-shrink-0">
                    {fmtCost(s.cost)}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            Note: Only Claude Code sessions report cost data.
          </p>
        </div>
      )}
    </div>
  );
}

function formatBytes(n: any) {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * InstanceBackupSection — pick-and-zip migration export.
 *
 * Loads the manifest from /api/instance-backup/manifest, lets the user
 * select a subset, and POSTs to /api/instance-backup/bundle to download
 * a streamed zip. db.full and db.slim are mutually exclusive in the UI.
 */
export function InstanceBackupSection({ showToast }: any) {
  const [manifest, setManifest] = useState<any>(null);
  const [loadError, setLoadError] = useState<any>(null);
  const [selected, setSelected] = useState<Set<any>>(() => new Set(['db.slim', 'config']));
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getInstanceBackupManifest()
      .then((data: any) => {
        if (cancelled) return;
        setManifest(data);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setLoadError(err.message || String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id: any) => {
    setSelected((prev: any) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // db.full and db.slim are mutually exclusive.
        if (id === 'db.full') next.delete('db.slim');
        if (id === 'db.slim') next.delete('db.full');
      }
      return next;
    });
  };

  const selectAll = () => {
    if (!manifest) return;
    const next = new Set(manifest.items.map((i: any) => i.id));
    // Default to slim when bulk-selecting.
    next.delete('db.full');
    setSelected(next);
  };

  const clearAll = () => setSelected(new Set());

  const totalBytes = useMemo(() => {
    if (!manifest) return 0;
    return manifest.items
      .filter((i: any) => selected.has(i.id))
      .reduce((acc: any, i: any) => acc + (i.estimatedBytes || 0), 0);
  }, [manifest, selected]);

  const handleDownload = async () => {
    if (selected.size === 0) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const items = Array.from(selected);
      const { blob, filename } = await api.downloadInstanceBackup(items);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (showToast) showToast('Backup downloaded', 'success');
    } catch (err: any) {
      setDownloadError(err.message || String(err));
      if (showToast) showToast('Backup failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mb-8">
      <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
        <Package size={18} className="text-gray-400" />
        Download Instance Backup
      </h3>
      <p className="text-sm text-gray-400 mb-4">
        Pick the data you want to ship to another Agent Hub instance. The download is a single zip
        containing live SQLite backups, config files, agent workspaces, and JSON dumps for the items
        you select. Owner role required.
      </p>

      {loadError && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 mb-4 flex items-start gap-2">
          <AlertCircle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-red-300">
            <p className="font-medium mb-0.5">Couldn&apos;t load backup manifest</p>
            <p className="text-xs text-red-400/80">{loadError}</p>
          </div>
        </div>
      )}

      {!manifest && !loadError && (
        <div className="bg-gray-800/50 rounded-lg p-4 flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading manifest...
        </div>
      )}

      {manifest && (
        <div className="bg-gray-800/50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 rounded"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 rounded"
              >
                Clear
              </button>
            </div>
            <div className="text-xs text-gray-500">
              {selected.size} item{selected.size === 1 ? '' : 's'} • ~{formatBytes(totalBytes)}
            </div>
          </div>

          <ul className="divide-y divide-gray-700/50 mb-4">
            {manifest.items.map((item: any) => {
              const isSelected = selected.has(item.id);
              // Disable the alternate DB option if the other is already selected.
              const disabled =
                (item.id === 'db.full' && selected.has('db.slim')) ||
                (item.id === 'db.slim' && selected.has('db.full'));
              return (
                <li key={item.id} className="py-2">
                  <label
                    className={`flex items-start gap-3 cursor-pointer ${
                      disabled ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={disabled}
                      onChange={() => !disabled && toggle(item.id)}
                      className="mt-1 accent-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium text-gray-100">{item.label}</span>
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {formatBytes(item.estimatedBytes)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{item.description}</p>
                      {disabled && (
                        <p className="text-xs text-amber-400/80 mt-0.5">
                          Choose either slim or full DB, not both.
                        </p>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>

          {downloadError && (
            <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 mb-3 flex items-start gap-2">
              <AlertCircle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-300">{downloadError}</p>
            </div>
          )}

          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading || selected.size === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:text-gray-400 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            {downloading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Preparing backup…
              </>
            ) : (
              <>
                <Download size={14} />
                Download backup
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function ConfigBackupSection({ projects = [], onAgentsChange }: any) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [importError, setImportError] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [importTargetId, setImportTargetId] = useState('');
  // Default the import flow to "create a new project" — that's the natural
  // first-run case and removes the hidden requirement that a target project
  // must already exist before you can drop in an export file.
  const [importMode, setImportMode] = useState('new'); // 'new' | 'existing'

  const handleExport = async () => {
    if (!selectedProjectId) return;
    setExporting(true);
    try {
      const data = await api.exportProject(selectedProjectId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const proj = projects.find((p: any) => p.id === selectedProjectId);
      const safeName = (proj?.name || selectedProjectId)
        .replace(/[^a-zA-Z0-9-_]/g, '-')
        .toLowerCase();
      const now = new Date();
      const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      a.download = `${safeName}-export-${localDate}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const handleFileSelect = (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    setImportError(null);

    const reader = new FileReader();
    reader.onload = (ev: any) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.version === 3 && data.type === 'project') {
          setPreview(data);
        } else if (data.version === 1 || data.version === 2) {
          setImportError(
            'This is a legacy full-instance export. Per-project import requires a v3 project export file.',
          );
          setPreview(null);
        } else {
          setImportError('Invalid export file');
          setPreview(null);
        }
      } catch {
        setImportError('Invalid JSON file');
        setPreview(null);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!preview) return;
    if (importMode === 'existing' && !importTargetId) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const result =
        importMode === 'new'
          ? await api.importProjectAsNew(preview)
          : await api.importProject(importTargetId, preview);
      setImportResult(result);
      setPreview(null);
      if (onAgentsChange) onAgentsChange();
    } catch (err: any) {
      setImportError(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleCancel = () => {
    setPreview(null);
    setImportResult(null);
    setImportError(null);
    setImportTargetId('');
    setImportMode('new');
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Export / Import Project</h3>
      <p className="text-sm text-gray-400 mb-6">
        Export a project with its agents, kanban board, wiki, crons, and rooms. Import creates the
        project on a new instance — or merge into an existing project to layer the export's data on
        top.
      </p>

      {/* Export */}
      <div className="bg-gray-800/50 rounded-lg p-4 mb-4">
        <h4 className="font-medium mb-3">Export Project</h4>
        <div className="flex items-center gap-3">
          <select
            value={selectedProjectId}
            onChange={(e: any) => setSelectedProjectId(e.target.value)}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          >
            <option value="">Select a project...</option>
            {projects.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleExport}
            disabled={exporting || !selectedProjectId}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:text-gray-400 text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
          >
            {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>

      {/* Import */}
      <div className="bg-gray-800/50 rounded-lg p-4">
        <h4 className="font-medium mb-3">Import Project</h4>
        <p className="text-sm text-gray-400 mb-3">
          Upload a project export file. By default the export creates a brand-new project with all
          its data. Switch to “Merge into existing” to layer the export onto a project that already
          exists — agents and settings are overwritten; crons, rooms, and wiki are merged.
        </p>

        {!preview && (
          <label className="inline-flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer">
            Choose File
            <input
              type="file"
              accept=".json,application/json"
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>
        )}

        {preview && (
          <div className="mt-3">
            <div className="bg-gray-900 rounded-lg p-3 mb-3 text-sm">
              <p className="text-gray-300 mb-2 font-medium">
                Project: <span className="text-white">{preview.project?.name}</span>
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-400">
                <span>Agents:</span>
                <span className="text-white">{preview.project?.agents?.length || 0}</span>
                <span>Kanban cards:</span>
                <span className="text-white">{preview.kanban?.cards?.length || 0}</span>
                <span>Wiki pages:</span>
                <span className="text-white">{preview.wiki?.length || 0}</span>
                <span>Crons:</span>
                <span className="text-white">{preview.crons?.length || 0}</span>
                <span>Rooms:</span>
                <span className="text-white">{preview.rooms?.length || 0}</span>
                {preview.exportedAt && (
                  <>
                    <span>Exported:</span>
                    <span className="text-white">{formatDateTime(preview.exportedAt)}</span>
                  </>
                )}
              </div>
            </div>

            <div className="mb-3">
              <label className="block text-sm text-gray-400 mb-1">Import target:</label>
              <div className="flex flex-col gap-2 mb-2">
                <label className="flex items-start gap-2 text-sm text-gray-200 cursor-pointer">
                  <input
                    type="radio"
                    name="import-mode"
                    value="new"
                    checked={importMode === 'new'}
                    onChange={() => setImportMode('new')}
                    className="mt-1"
                  />
                  <span>
                    <span className="block">Create a new project from this export</span>
                    <span className="block text-xs text-gray-500">
                      Uses the exported id when free; allocates a unique id on collision.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-gray-200 cursor-pointer">
                  <input
                    type="radio"
                    name="import-mode"
                    value="existing"
                    checked={importMode === 'existing'}
                    onChange={() => setImportMode('existing')}
                    className="mt-1"
                  />
                  <span>
                    <span className="block">Merge into an existing project</span>
                    <span className="block text-xs text-gray-500">
                      Overwrites agents/settings; merges crons, rooms, and wiki.
                    </span>
                  </span>
                </label>
              </div>

              {importMode === 'existing' && (
                <select
                  value={importTargetId}
                  onChange={(e: any) => setImportTargetId(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                >
                  <option value="">Select target project...</option>
                  {projects.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleImport}
                disabled={importing || (importMode === 'existing' && !importTargetId)}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:text-gray-400 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
              <button
                onClick={handleCancel}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {importResult && (
          <div className="mt-3 bg-emerald-900/30 border border-emerald-700/50 rounded-lg p-3">
            <p className="text-emerald-400 font-medium text-sm mb-1">{importResult.message}</p>
            <div className="text-xs text-gray-400 space-y-0.5">
              {Object.entries(importResult.results || {}).map(([key, val]: any) => (
                <p key={key}>
                  <span className="text-gray-300 capitalize">{key}:</span>{' '}
                  {val === true ? 'Updated' : val === false ? 'Skipped' : String(val)}
                </p>
              ))}
            </div>
          </div>
        )}

        {importError && (
          <div className="mt-3 bg-red-900/30 border border-red-700/50 rounded-lg p-3">
            <p className="text-red-400 text-sm">{importError}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ServerLogsSection({ wsRef }: any) {
  const [logs, setLogs] = useState<any[]>([]);
  const [autoFollow, setAutoFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('all'); // 'all' | 'log' | 'warn' | 'error'
  const containerRef = useRef<any>(null);
  const wasAtBottomRef = useRef(true);

  // Fetch initial logs
  useEffect(() => {
    api
      .getServerLogs()
      .then((data: any) => setLogs(data))
      .catch(() => {});
  }, []);

  // Subscribe to WS server-log events
  useEffect(() => {
    function handler(e: any) {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'server-log' && data.entry) {
          setLogs((prev: any) => {
            const next = [...prev, data.entry];
            return next.length > 2000 ? next.slice(-2000) : next;
          });
        }
      } catch {}
    }
    const ws = wsRef?.current;
    if (ws) {
      ws.addEventListener('message', handler);
      return () => ws.removeEventListener('message', handler);
    }
  }, [wsRef]);

  // Auto-scroll
  useEffect(() => {
    if (autoFollow && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoFollow]);

  // Detect manual scroll
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    wasAtBottomRef.current = atBottom;
    if (atBottom && !autoFollow) setAutoFollow(true);
    if (!atBottom && autoFollow) setAutoFollow(false);
  };

  const filteredLogs = logs.filter((entry: any) => {
    if (levelFilter !== 'all' && entry.level !== levelFilter) return false;
    if (filter && !entry.message.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  const levelColor = (level: any) => {
    if (level === 'error') return 'text-red-400';
    if (level === 'warn') return 'text-yellow-400';
    return 'text-gray-400';
  };

  const tsColor = 'text-gray-600';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Filter logs..."
          value={filter}
          onChange={(e: any) => setFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 flex-1 min-w-[200px]"
        />
        <div className="flex gap-1">
          {['all', 'log', 'warn', 'error'].map((lvl: any) => (
            <button
              key={lvl}
              onClick={() => setLevelFilter(lvl)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                levelFilter === lvl ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {lvl === 'all' ? 'All' : lvl.charAt(0).toUpperCase() + lvl.slice(1)}
            </button>
          ))}
        </div>
        <button
          onClick={() => setAutoFollow(!autoFollow)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            autoFollow ? 'bg-blue-600/30 text-blue-400' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Auto-follow {autoFollow ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => setLogs([])}
          className="px-2.5 py-1 rounded text-xs font-medium text-gray-500 hover:text-gray-300 transition-colors"
        >
          Clear
        </button>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="bg-gray-950 border border-gray-800 rounded-xl font-mono text-xs leading-5 overflow-auto"
        style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600">
            {logs.length === 0 ? 'No logs yet — waiting for server output...' : 'No matching logs'}
          </div>
        ) : (
          <div className="p-3">
            {filteredLogs.map((entry: any, i: any) => (
              <div key={i} className="hover:bg-gray-900/50 px-1 -mx-1 rounded">
                <span className={tsColor}>
                  {formatTime(entry.ts, {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>{' '}
                <span className={levelColor(entry.level)}>
                  {entry.level === 'log' ? ' ' : entry.level === 'warn' ? '⚠' : '✖'}
                </span>{' '}
                <span className="text-gray-300">{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-gray-600">
        {filteredLogs.length} of {logs.length} entries
        {logs.length >= 2000 && ' (oldest entries trimmed)'}
      </p>
    </div>
  );
}

/**
 * Minimal counts-by-error-type view for TOOL_ERROR self-reports. Stub for the
 * future Session Health dashboard — just enough UI to see whether the new
 * agent-hub skill actually reduces tool-error rates.
 */
export function ToolErrorsSection({ projects }: any) {
  const defaultProjectId = projects?.[0]?.id || '';
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [sinceDays, setSinceDays] = useState(30);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const since = sinceDays
      ? new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10)
      : undefined;
    api
      .getToolErrors(projectId, { since, limit: 200 })
      .then((res: any) => {
        if (!cancelled) setData(res);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || 'Failed to load tool errors');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sinceDays]);

  if (!projects?.length) {
    return (
      <p className="text-sm text-gray-500">No projects yet — create one to see tool errors.</p>
    );
  }

  const entries = (obj: any) => Object.entries(obj || {}).sort((a: any, b: any) => b[1] - a[1]);

  const byType = data ? entries(data.countsByErrorType) : [];
  const byTool = data ? entries(data.countsByTool) : [];
  const maxTypeCount = Math.max(...byType.map(([, n]: any) => n), 1);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <AlertTriangle size={18} className="text-amber-400" />
          Tool Errors
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          TOOL_ERROR self-reports parsed from daily notes. This is a stub for the future Session
          Health dashboard — counts only, no resolution tracking.
        </p>

        <div className="flex flex-wrap gap-3 mb-4">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-gray-400">Project:</span>
            <select
              value={projectId}
              onChange={(e: any) => setProjectId(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm"
            >
              {projects.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-gray-400">Window:</span>
            <select
              value={sinceDays}
              onChange={(e: any) => setSinceDays(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={0}>All time</option>
            </select>
          </label>
        </div>
      </div>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Total</p>
              <p className="text-2xl font-bold text-amber-400 mt-1">{data.total}</p>
            </div>
            <div className="bg-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Distinct Types</p>
              <p className="text-2xl font-bold text-gray-200 mt-1">{byType.length}</p>
            </div>
            <div className="bg-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Distinct Tools</p>
              <p className="text-2xl font-bold text-gray-200 mt-1">{byTool.length}</p>
            </div>
            <div className="bg-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Since</p>
              <p className="text-sm font-mono text-gray-200 mt-2">{data.since || 'all time'}</p>
            </div>
          </div>

          {data.total === 0 ? (
            <p className="text-sm text-gray-500">
              No TOOL_ERROR entries found in this window. Either nothing is failing, or agents
              aren&apos;t self-reporting yet.
            </p>
          ) : (
            <>
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">By error type</h4>
                <div className="bg-gray-800 rounded-xl p-4 space-y-1.5">
                  {byType.map(([type, count]: any) => {
                    const pct = (count / maxTypeCount) * 100;
                    return (
                      <div key={type} className="flex items-center gap-3">
                        <span
                          className="text-xs font-mono text-gray-400 w-40 truncate"
                          title={type}
                        >
                          {type}
                        </span>
                        <div className="flex-1 h-4 bg-gray-900 rounded overflow-hidden">
                          <div
                            className="h-full bg-amber-600/60 rounded"
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-400 font-mono w-10 text-right">
                          {count}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">By tool</h4>
                <div className="bg-gray-800 rounded-xl p-3 flex flex-wrap gap-2">
                  {byTool.map(([tool, count]: any) => (
                    <span
                      key={tool}
                      className="text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1"
                    >
                      <span className="text-gray-300 font-mono">{tool}</span>
                      <span className="text-gray-500 ml-2">{count}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">
                  Recent entries
                  {data.truncated && (
                    <span className="text-xs text-gray-500 font-normal ml-2">
                      (showing first {data.returned} of {data.total})
                    </span>
                  )}
                </h4>
                <div className="bg-gray-800 rounded-xl overflow-hidden">
                  <div className="divide-y divide-gray-700/50 max-h-96 overflow-y-auto">
                    {data.errors.slice(0, 50).map((e: any, i: any) => (
                      <div key={i} className="px-3 py-2 text-xs">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-gray-500">{e.timestamp}</span>
                          <span className="font-mono text-indigo-300">{e.tool}</span>
                          <span className="font-mono text-amber-300">{e.errorType}</span>
                        </div>
                        <p className="text-gray-300 truncate" title={e.summary}>
                          {e.summary}
                        </p>
                        {e.action && (
                          <p className="text-gray-500 font-mono truncate" title={e.action}>
                            {e.action}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Settings tabs for the left sidebar (flat list — no section groupings).
 */
const SETTINGS_TABS = [
  { id: 'general', iconName: 'Settings', text: 'General' },
  { id: 'account', iconName: 'UserCircle', text: 'Account' },
  { id: 'orgs', iconName: 'Building2', text: 'Organizations' },
  // Host-wide Gemini API key (used for wiki embeddings; managed in
  // ~/.agent-hub/data/config.json). Per-user Claude/Cursor/Codex creds live
  // on Settings → Account, so this tab is gated to Admin/Owner via
  // `visibleSettingsTabs` below. Sole-source-of-truth for the tab id is
  // `claude-auth` (historical — predates the renaming).
  { id: 'claude-auth', iconName: 'Key', text: 'Global API Keys' },
  { id: 'global-skills', iconName: 'Globe', text: 'Global Skills' },
  { id: 'github', iconName: 'GitBranch', text: 'GitHub' },
  { id: 'slack', iconName: 'MessageSquare', text: 'Slack' },
  { id: 'usage', iconName: 'BarChart3', text: 'Usage' },
  { id: 'tool-errors', iconName: 'AlertTriangle', text: 'Tool Errors' },
  { id: 'backup', iconName: 'HardDrive', text: 'Backup' },
  { id: 'logs', iconName: 'FileText', text: 'Logs' },
];

const SETTINGS_ICONS = {
  Settings: SettingsIcon,
  UserCircle,
  Building2,
  Bot,
  Key,
  Globe,
  GitBranch,
  HeartPulse,
  Clock,
  MessageSquare,
  BarChart3,
  Activity,
  AlertTriangle,
  HardDrive,
  FileText,
  FolderGit2,
  Plug,
  Monitor,
  ClipboardCheck,
} as Record<string, any>;

function SettingsNavItem({ tab, active, onSelect }: any) {
  const Icon = SETTINGS_ICONS[tab.iconName] || SettingsIcon;
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.id)}
      aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors min-h-[40px] text-left ${
        active ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
      }`}
    >
      <Icon size={16} className={active ? '' : 'text-gray-500'} />
      <span className="truncate">{tab.text}</span>
    </button>
  );
}

export default function SettingsPage({
  projects = [],
  agents,
  onAgentsChange,
  initialTab,
  /** When opening Settings → GitHub from Workflows, expand this project's card. */
  initialGithubExpandedProjectId = null,
  onNavigate,
  onOpenSession,
  showToast,
  wsRef,
}: any) {
  const [tab, setTab] = useState(
    initialTab === 'integrations' ? 'general' : initialTab || 'general',
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Legacy `?tab=integrations` deep-link (the old MCP location). MCP is now
  // configured per-agent in each agent's config form below, so the link just
  // falls back to the General tab (handled by the `tab` initializer above).

  // When navigating directly to a specific tab (e.g. from OrgSwitcher)
  useEffect(() => {
    if (initialTab && initialTab !== 'integrations') setTab(initialTab);
  }, [initialTab]);

  // Browser deep-links can still target `?tab=orgs` even though we no
  // longer render the tab there. Redirect to the first visible tab so
  // the user doesn't land on a blank settings pane.
  useEffect(() => {
    if (tab === 'orgs' && !isElectron()) setTab('general');
  }, [tab]);

  // The "Organizations" tab manages remote Hub-server bookmarks and the
  // multi-org switcher. That UX only makes sense in Electron (which can
  // hop between Hub servers via its file-backed remote-orgs store +
  // cross-origin API-key injector). The web app is locked to a single
  // Hub server, so hide the tab there.
  //
  // Role-gated tab visibility. The host-wide "Gemini API Key" panel writes
  // to `~/.agent-hub/data/config.json` and only Admin/Owner users have a
  // reason to touch it — regular users manage their own per-user creds on
  // Settings → Account. The server still enforces the underlying permissions;
  // this is a UX hint only.
  const electronShell = isElectron();
  // In local-bundled mode (Electron / single-user self-host) the server
  // short-circuits auth so no JWT is written and hasRole() returns false.
  // Treat local-mode sessions as Admin-equivalent so the host-wide Gemini
  // API key tab stays visible on every fresh install.
  const isAdminPlus = hasRole('Admin') || isLocalMode();
  const visibleSettingsTabs = useMemo(() => {
    return SETTINGS_TABS.filter((t: any) => {
      if (t.id === 'orgs' && !electronShell) return false;
      if (t.id === 'claude-auth' && !isAdminPlus) return false;
      return true;
    });
  }, [electronShell, isAdminPlus]);

  // If a non-Admin user lands on the hidden `claude-auth` tab via a deep
  // link, send them to Account (which hosts their per-user CLI creds).
  useEffect(() => {
    if (tab === 'claude-auth' && !isAdminPlus) {
      setTab('account');
    }
  }, [tab, isAdminPlus]);

  // Preview & Finalize moved to the per-project sidebar (Preview / Runners).
  // Agents, Project settings, Cron Jobs, and heartbeats moved to the
  // per-project sidebar menu — fall back when old deep links land here.
  useEffect(() => {
    if (
      tab === 'preview' ||
      tab === 'finalize' ||
      tab === 'agents' ||
      tab === 'projects' ||
      tab === 'heartbeats' ||
      tab === 'crons'
    ) {
      setTab('general');
    }
  }, [tab]);

  // Find the currently active tab metadata (for mobile header).
  const activeTab = useMemo(() => {
    return (
      visibleSettingsTabs.find((t: any) => t.id === tab) ??
      visibleSettingsTabs[0] ??
      SETTINGS_TABS[0]
    );
  }, [tab, visibleSettingsTabs]);

  // The previous tab-change guard existed solely for the Preview section's
  // unsaved-edit prompt. Preview moved to the per-project sidebar, so no
  // settings tab registers a guard anymore and the machinery was dropped.
  const handleSelectTab = (id: any) => {
    if (id === tab) {
      setMobileNavOpen(false);
      return;
    }
    setTab(id);
    setMobileNavOpen(false);
  };

  const sidebar = (
    <nav aria-label="Settings sections" className="space-y-0.5">
      {visibleSettingsTabs.map((t: any) => (
        <SettingsNavItem key={t.id} tab={t} active={tab === t.id} onSelect={handleSelectTab} />
      ))}
    </nav>
  );

  return (
    <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
      {/* Mobile header — surfaces the current section + a button to reveal the nav drawer. */}
      <div className="md:hidden flex items-center justify-between border-b border-gray-800 px-4 py-3 bg-gray-950">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-lg font-bold truncate">Settings</h2>
          <span className="text-gray-600">/</span>
          <span className="text-sm text-gray-300 truncate">{activeTab.text}</span>
        </div>
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          className="p-2 rounded-lg hover:bg-gray-800 text-gray-300"
          aria-label="Open settings navigation"
        >
          <Menu size={18} />
        </button>
      </div>

      {/* Desktop sidebar — persistent left rail */}
      <aside className="hidden md:flex md:flex-col w-60 lg:w-64 shrink-0 border-r border-gray-800 bg-gray-950/40 overflow-y-auto">
        <div className="px-4 pt-6 pb-3">
          <h2 className="text-lg font-bold">Settings</h2>
        </div>
        <div className="px-2 pb-6">{sidebar}</div>
      </aside>

      {/* Mobile drawer — sliding overlay, dismissible by tapping outside or selecting a tab */}
      {mobileNavOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <div className="relative w-72 max-w-[85vw] bg-gray-900 border-r border-gray-800 flex flex-col overflow-y-auto">
            <div className="flex items-center justify-between px-4 pt-6 pb-3">
              <h2 className="text-lg font-bold">Settings</h2>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-300"
                aria-label="Close settings navigation"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-2 pb-6">{sidebar}</div>
          </div>
        </div>
      )}

      {/* Main content panel */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-4 md:p-6">
          <div className="max-w-4xl mx-auto">
            <AuthUpgradeBanner />

            <SettingsErrorBoundary key={tab}>
              {tab === 'general' && <GeneralSection />}
              {tab === 'account' && <AccountSection />}
              {tab === 'claude-auth' && isAdminPlus && <GeminiAuthSection />}
              {tab === 'global-skills' && (
                <GlobalSkillsSection agents={agents} projects={projects} />
              )}
              {tab === 'github' && <GitHubSection />}
              {tab === 'orgs' && electronShell && <OrganizationsSection />}

              {tab === 'slack' && <SlackSection />}
              {tab === 'usage' && <UsageSection />}
              {tab === 'tool-errors' && <ToolErrorsSection projects={projects} />}
              {tab === 'backup' && (
                <>
                  <InstanceBackupSection showToast={showToast} />
                  <ConfigBackupSection projects={projects} onAgentsChange={onAgentsChange} />
                </>
              )}
              {tab === 'logs' && <ServerLogsSection wsRef={wsRef} />}
            </SettingsErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}
