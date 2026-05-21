import { useState, useEffect, useRef, useMemo, useCallback, Component } from 'react';
import { api } from '../utils/api.js';
import {
  buildOrchestrationBudgetsPayload,
  orchestrationFieldsFromProject,
  ORCHESTRATION_FIELD_META,
} from '../utils/orchestrationBudgets.js';
import { relativeTime, relativeFuture } from '../utils/time.js';
import {
  parseAllowlist,
  serializeAllowlist,
  parseAllowlistFromBackend,
} from '../utils/authorAllowlist.js';
import { hasRole, isLocalMode } from '../utils/auth.js';
import humanCron from '../../../shared/utils/humanCron.js';
import CronSchedulePicker from './CronSchedulePicker.jsx';
import AgentAvatar from './AgentAvatar.jsx';
import AccountSection from './AccountSection.jsx';
import GithubConnectionSection from './GithubConnectionSection.jsx';
import PersonalOAuthConfigSection from './PersonalOAuthConfigSection.jsx';
import AuthUpgradeBanner from './AuthUpgradeBanner.jsx';
import CursorAuthSection from './CursorAuthSection.jsx';
import MyAgentEngineOverrideInline from './MyAgentEngineOverrideInline.jsx';
import WorkflowRunsSection from './WorkflowRunsSection.jsx';
import PreviewSection from './PreviewSection.jsx';
import ProjectSecretsEditor from './ProjectSecretsEditor.jsx';
import ProjectAwsProfilesEditor from './ProjectAwsProfilesEditor.jsx';
import { AVATAR_ICON_NAMES, buildIconAvatar, isIconAvatar } from '../utils/avatar.js';
import { isWorkflowProject } from '../utils/projectMode.js';
import { isElectron } from '../utils/isElectron.js';
import * as LucideIcons from 'lucide-react';

/** Error boundary to catch render crashes in individual settings tabs */
class SettingsErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
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
} from '../utils/connection.js';
import {
  getOrgs,
  getActiveOrg,
  createOrg,
  updateOrg,
  deleteOrg,
  switchOrg,
} from '../utils/orgs.js';
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
  LogIn,
  LogOut,
  Shield,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Copy,
  Eye,
  EyeOff,
  ScrollText,
  Link,
  FileText,
  UserCircle,
  AlertTriangle,
  Info,
  Menu,
  FolderGit2,
  Download,
  Package,
} from 'lucide-react';

/** Grid of Lucide icon chips used as quick-pick agent avatars. */
function IconPickerGrid({ selected, color = '#6b7280', onSelect }) {
  return (
    <div className="mt-3">
      <p className="text-[11px] text-gray-500 mb-1.5">Or pick an icon:</p>
      <div className="grid grid-cols-10 gap-1.5">
        {AVATAR_ICON_NAMES.map((name) => {
          const IconComponent = LucideIcons[name];
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
  const [expandedOrgId, setExpandedOrgId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
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

  const handleExpand = (orgId) => {
    if (expandedOrgId === orgId) {
      setExpandedOrgId(null);
      return;
    }
    const org = orgs.find((o) => o.id === orgId);
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

  const handleSaveEdit = async (orgId) => {
    await updateOrg(orgId, editForm);
    refreshOrgs();
    setExpandedOrgId(null);
    if (activeOrg?.id === orgId) {
      reloadForOrgSwitch();
    }
  };

  const handleDelete = async (orgId) => {
    if (await deleteOrg(orgId)) {
      refreshOrgs();
      setExpandedOrgId(null);
      if (activeOrg?.id === orgId) {
        reloadForOrgSwitch();
      }
    }
  };

  const handleSwitch = async (orgId) => {
    await switchOrg(orgId);
    reloadForOrgSwitch();
  };

  const handleTest = async (url, apiKey) => {
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

  const renderModeToggle = (mode, onChange) => (
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

  const renderRemoteFields = (form, setForm, showTest = true) => (
    <div className="space-y-3 mt-3">
      <div>
        <label className={labelClass}>Server URL</label>
        <input
          value={form.remoteUrl}
          onChange={(e) => setForm((prev) => ({ ...prev, remoteUrl: e.target.value }))}
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
          onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
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
        {orgs.map((org) => {
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
                    onClick={(e) => {
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
                      onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Color</label>
                    <div className="flex gap-2">
                      {COLOR_OPTIONS.map((c) => (
                        <button
                          key={c}
                          onClick={() => setEditForm((prev) => ({ ...prev, color: c }))}
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
                      {renderModeToggle(editForm.mode, (mode) => {
                        setEditForm((prev) => ({ ...prev, mode }));
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
              onChange={(e) => setNewForm((prev) => ({ ...prev, name: e.target.value }))}
              className={inputClass}
              placeholder="e.g. Work, Production, Home Lab"
            />
          </div>

          <div>
            <label className={labelClass}>Color</label>
            <div className="flex gap-2">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewForm((prev) => ({ ...prev, color: c }))}
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
              {renderModeToggle(newForm.mode, (mode) => {
                setNewForm((prev) => ({ ...prev, mode }));
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

function ClaudeAuthSection() {
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyValidating, setApiKeyValidating] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState(null); // { type: 'success'|'error', msg }
  const [oauthTokenInput, setOauthTokenInput] = useState('');
  const [oauthTokenSaving, setOauthTokenSaving] = useState(false);
  const [oauthTokenStatus, setOauthTokenStatus] = useState(null);
  const [showClaudeOauthToken, setShowClaudeOauthToken] = useState(false);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';

  const fetchAuth = async () => {
    setError(null);
    try {
      const data = await api.getClaudeAuth();
      setAuth(data);
    } catch (err) {
      setAuth(null);
      setError(err.message || 'Failed to load auth status');
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
      const result = await api.setClaudeApiKey(apiKeyInput);
      if (result.ok) {
        setApiKeyStatus({
          type: 'success',
          msg: result.masked ? `Saved: ${result.masked}` : 'API key cleared',
        });
        setApiKeyInput('');
        await fetchAuth();
      }
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeySaving(false);
  };

  const handleClearApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      await api.setClaudeApiKey('');
      setApiKeyStatus({ type: 'success', msg: 'API key cleared' });
      await fetchAuth();
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeySaving(false);
  };

  const handleValidateApiKey = async () => {
    if (!apiKeyInput) return;
    setApiKeyValidating(true);
    setApiKeyStatus(null);
    try {
      const result = await api.validateClaudeApiKey(apiKeyInput);
      setApiKeyStatus({
        type: result.valid ? 'success' : 'error',
        msg: result.output,
      });
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeyValidating(false);
  };

  const handleSaveOauthToken = async () => {
    setOauthTokenSaving(true);
    setOauthTokenStatus(null);
    try {
      // Terminal-wrapped `claude setup-token` output may contain newlines inside the token.
      const collapsed = oauthTokenInput.trim().replace(/\s+/g, '');
      const result = await api.setClaudeOAuthToken(collapsed);
      if (result.ok) {
        setOauthTokenStatus({
          type: 'success',
          msg: result.masked ? `Saved: ${result.masked}` : 'Cleared',
        });
        setOauthTokenInput('');
        await fetchAuth();
      }
    } catch (err) {
      setOauthTokenStatus({ type: 'error', msg: err.message });
    }
    setOauthTokenSaving(false);
  };

  const handleClearOauthToken = async () => {
    setOauthTokenSaving(true);
    setOauthTokenStatus(null);
    try {
      await api.setClaudeOAuthToken('');
      setOauthTokenStatus({ type: 'success', msg: 'Cleared' });
      await fetchAuth();
    } catch (err) {
      setOauthTokenStatus({ type: 'error', msg: err.message });
    }
    setOauthTokenSaving(false);
  };

  if (loading)
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-8">
        <Loader2 size={16} className="animate-spin" />
        <span>Loading auth status...</span>
      </div>
    );

  if (error && !auth)
    return (
      <div className="space-y-4">
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
            <AlertCircle size={16} />
            <span className="font-medium">Failed to load authentication status</span>
          </div>
          <p className="text-xs text-gray-400 mb-3">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              fetchAuth();
            }}
            className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      </div>
    );

  const isOAuthLoggedIn = auth?.oauth?.loggedIn;
  const email = auth?.oauth?.email;
  const orgName = auth?.oauth?.orgName;
  const subscriptionType = auth?.oauth?.subscriptionType || auth?.token?.subscriptionType;
  const rateLimitTier = auth?.token?.rateLimitTier;
  const tokenExpired = auth?.token?.expired;
  const apiKeyConfigured = auth?.apiKey?.configured;
  const apiKeySource = auth?.apiKey?.source;
  const oauthTokenConfigured = auth?.oauthToken?.configured;
  const oauthTokenSource = auth?.oauthToken?.source;
  const subscriptionAuthOk = !!(isOAuthLoggedIn || oauthTokenConfigured);
  const activeMethod = auth?.activeMethod;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">Claude Code Authentication</h3>
        <p className="text-xs text-gray-500 mb-4">
          API key or paste a token from <code className="text-gray-400">claude setup-token</code>.
          Subscription CLI login stays in your terminal.
        </p>
      </div>

      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <Shield size={16} /> Status
          </h4>
          <span
            className={`text-xs px-2.5 py-1 rounded-full font-medium ${
              activeMethod === 'oauth'
                ? 'bg-emerald-500/15 text-emerald-400'
                : activeMethod === 'api-key'
                  ? 'bg-blue-500/15 text-blue-400'
                  : 'bg-red-500/15 text-red-400'
            }`}
          >
            {activeMethod === 'oauth'
              ? 'CLI OAuth'
              : activeMethod === 'api-key'
                ? 'API Key Active'
                : 'Not Authenticated'}
          </span>
        </div>

        {(subscriptionAuthOk || apiKeyConfigured) && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            {email && (
              <>
                <span className="text-gray-500">Email</span>
                <span className="text-gray-300 font-mono">{email}</span>
              </>
            )}
            {orgName && orgName !== email && (
              <>
                <span className="text-gray-500">Organization</span>
                <span className="text-gray-300 font-mono">{orgName}</span>
              </>
            )}
            {subscriptionType && (
              <>
                <span className="text-gray-500">Plan</span>
                <span className="text-gray-300 font-mono capitalize">{subscriptionType}</span>
              </>
            )}
            {rateLimitTier && (
              <>
                <span className="text-gray-500">Rate Limit Tier</span>
                <span className="text-gray-300 font-mono">{rateLimitTier}</span>
              </>
            )}
            {apiKeyConfigured && (
              <>
                <span className="text-gray-500">API Key Source</span>
                <span className="text-gray-300 font-mono capitalize">{apiKeySource}</span>
              </>
            )}
            {auth?.token?.expiresAt && !apiKeyConfigured && !oauthTokenConfigured && (
              <>
                <span className="text-gray-500">Token Expires</span>
                <span className={`font-mono ${tokenExpired ? 'text-red-400' : 'text-gray-300'}`}>
                  {tokenExpired ? 'Expired' : relativeFuture(auth.token.expiresAt).label}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Terminal size={16} /> Setup token
        </h4>
        <p className="text-xs text-gray-500">
          Run <code className="text-gray-400">claude setup-token</code>, then paste here.{' '}
          <a
            href="https://docs.anthropic.com/en/docs/claude-code/authentication#generate-a-long-lived-token"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300"
          >
            Docs
          </a>
        </p>
        <p className="text-xs text-gray-500 mt-1">
          If chats show <code className="text-gray-400">401 Invalid bearer</code>, run{' '}
          <code className="text-gray-400">claude setup-token</code> again and paste the new token —
          setup tokens can expire, and Hub runs Claude in non-interactive mode where refresh is less
          reliable than in an interactive terminal. Multi-line terminal output is joined
          automatically.
        </p>
        {oauthTokenConfigured && (
          <div className="flex items-center justify-between bg-gray-900 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span className="text-gray-300">
                Saved
                <span className="text-gray-500 ml-1">
                  ({oauthTokenSource}) {auth?.oauthToken?.masked || ''}
                </span>
              </span>
            </div>
            {oauthTokenSource === 'config' && (
              <button
                type="button"
                onClick={handleClearOauthToken}
                disabled={oauthTokenSaving}
                className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              >
                {oauthTokenSaving ? '…' : 'Clear'}
              </button>
            )}
          </div>
        )}
        <div className="space-y-2">
          <div className="relative">
            <input
              type={showClaudeOauthToken ? 'text' : 'password'}
              value={oauthTokenInput}
              onChange={(e) => {
                setOauthTokenInput(e.target.value);
                setOauthTokenStatus(null);
              }}
              className={`${inputClass} pr-10 text-xs`}
              placeholder="sk-ant-oat01-..."
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
            <button
              type="button"
              onClick={() => setShowClaudeOauthToken(!showClaudeOauthToken)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1"
            >
              {showClaudeOauthToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            type="button"
            onClick={handleSaveOauthToken}
            disabled={!oauthTokenInput.trim().replace(/\s+/g, '') || oauthTokenSaving}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
          >
            {oauthTokenSaving ? <Loader2 size={12} className="animate-spin" /> : null}
            {oauthTokenSaving ? 'Saving…' : 'Save'}
          </button>
          {oauthTokenStatus && (
            <div
              className={`flex items-center gap-2 text-xs ${
                oauthTokenStatus.type === 'success' ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {oauthTokenStatus.type === 'success' ? (
                <CheckCircle2 size={12} />
              ) : (
                <AlertCircle size={12} />
              )}
              <span>{oauthTokenStatus.msg}</span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Key size={16} /> API Key
        </h4>
        <p className="text-xs text-gray-500">
          Passed to spawned Claude Code processes (recommended for Agent Hub).
        </p>

        {apiKeyConfigured && (
          <div className="flex items-center justify-between bg-gray-900 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span className="text-gray-300">
                API key configured
                <span className="text-gray-500 ml-1">({apiKeySource})</span>
              </span>
            </div>
            {apiKeySource === 'config' && (
              <button
                onClick={handleClearApiKey}
                disabled={apiKeySaving}
                className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
              >
                {apiKeySaving ? 'Clearing...' : 'Clear'}
              </button>
            )}
          </div>
        )}

        <div className="space-y-2">
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(e) => {
                setApiKeyInput(e.target.value);
                setApiKeyStatus(null);
              }}
              className={`${inputClass} pr-10 text-xs`}
              placeholder="sk-ant-api03-..."
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1"
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleValidateApiKey}
              disabled={!apiKeyInput || apiKeyValidating}
              className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
            >
              {apiKeyValidating ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Shield size={12} />
              )}
              {apiKeyValidating ? 'Validating...' : 'Validate'}
            </button>
            <button
              onClick={handleSaveApiKey}
              disabled={!apiKeyInput || apiKeySaving}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
            >
              {apiKeySaving ? <Loader2 size={12} className="animate-spin" /> : null}
              {apiKeySaving ? 'Saving...' : 'Save Key'}
            </button>
          </div>

          {apiKeyStatus && (
            <div
              className={`flex items-center gap-2 text-xs mt-1 ${
                apiKeyStatus.type === 'success' ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {apiKeyStatus.type === 'success' ? (
                <CheckCircle2 size={12} />
              ) : (
                <AlertCircle size={12} />
              )}
              <span>{apiKeyStatus.msg}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => {
            setLoading(true);
            fetchAuth();
          }}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          <RefreshCw size={12} />
          Refresh status
        </button>
      </div>
    </div>
  );
}

/**
 * Gemini CLI auth panel — sibling of ClaudeAuthSection but scoped to Gemini.
 * Currently exposes API-key management only (GEMINI_API_KEY).  OAuth via
 * `gemini /auth` is still a terminal-only flow; the status endpoint returns
 * `oauth.loggedIn: null` which we surface as "Not managed here" so users know
 * where to look.
 */
function GeminiAuthSection() {
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyValidating, setApiKeyValidating] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState(null);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';

  const fetchAuth = async () => {
    setError(null);
    try {
      const data = await api.getGeminiAuth();
      setAuth(data);
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
        <p className="text-xs text-gray-500 mb-4">
          Configure the <code>GEMINI_API_KEY</code> used when Agent Hub spawns the{' '}
          <code>gemini</code> CLI. Google-account OAuth via <code>gemini /auth</code> is still
          managed from the terminal and not driven by this panel.
        </p>
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
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="AIza..."
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => setShowApiKey((v) => !v)}
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
function CodexAuthSection() {
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyValidating, setApiKeyValidating] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState(null);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [deviceAuthUrl, setDeviceAuthUrl] = useState(null);
  const [deviceUserCode, setDeviceUserCode] = useState(null);
  const [deviceMsg, setDeviceMsg] = useState(null);
  const [deviceCopied, setDeviceCopied] = useState(null);
  const [fullLogoutBusy, setFullLogoutBusy] = useState(false);
  const codexDeviceTimersRef = useRef({ intervalId: null, timeoutId: null });

  const clearCodexDeviceTimers = () => {
    const { intervalId, timeoutId } = codexDeviceTimersRef.current;
    if (intervalId !== null) clearInterval(intervalId);
    if (timeoutId !== null) clearTimeout(timeoutId);
    codexDeviceTimersRef.current = { intervalId: null, timeoutId: null };
  };

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';

  const fetchAuth = async () => {
    setError(null);
    try {
      const data = await api.getCodexAuth();
      setAuth(data);
    } catch (err) {
      setAuth(null);
      setError(err.message || 'Failed to load Codex auth status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuth();
  }, []);

  useEffect(
    () => () => {
      clearCodexDeviceTimers();
    },
    [],
  );

  const handleSaveApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      const result = await api.setCodexApiKey(apiKeyInput);
      if (result.ok) {
        setApiKeyStatus({
          type: 'success',
          msg: result.masked ? `Saved: ${result.masked}` : 'API key cleared',
        });
        setApiKeyInput('');
        await fetchAuth();
      }
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeySaving(false);
  };

  const handleClearApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      await api.setCodexApiKey('');
      setApiKeyStatus({ type: 'success', msg: 'API key cleared' });
      await fetchAuth();
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeySaving(false);
  };

  const handleValidateApiKey = async () => {
    if (!apiKeyInput) return;
    setApiKeyValidating(true);
    setApiKeyStatus(null);
    try {
      const result = await api.validateCodexApiKey(apiKeyInput);
      setApiKeyStatus({
        type: result.valid ? 'success' : 'error',
        msg: result.output,
      });
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    }
    setApiKeyValidating(false);
  };

  const handleDeviceLogin = async () => {
    clearCodexDeviceTimers();
    setDeviceLoading(true);
    setDeviceAuthUrl(null);
    setDeviceUserCode(null);
    setDeviceMsg(null);
    try {
      const data = await api.startCodexDeviceLogin();
      if (data.deviceAuthUrl && data.userCode) {
        setDeviceAuthUrl(data.deviceAuthUrl);
        setDeviceUserCode(data.userCode);
        window.open(data.deviceAuthUrl, '_blank');
        const timeoutId = setTimeout(() => {
          clearCodexDeviceTimers();
          setDeviceLoading(false);
        }, 900_000);
        const intervalId = setInterval(async () => {
          try {
            const st = await api.getCodexAuth();
            if (st.uiStatus === 'authenticated' && !st.loginInProgress) {
              clearCodexDeviceTimers();
              setAuth(st);
              setDeviceAuthUrl(null);
              setDeviceUserCode(null);
              setDeviceLoading(false);
              setDeviceMsg({ type: 'success', msg: 'Codex is authenticated on this host.' });
            } else if (!st.loginInProgress && st.uiStatus !== 'authenticated') {
              clearCodexDeviceTimers();
              setAuth(st);
              setDeviceAuthUrl(null);
              setDeviceUserCode(null);
              setDeviceLoading(false);
              setDeviceMsg({
                type: 'error',
                msg: st.statusError || 'Device login did not complete.',
              });
            }
          } catch {
            /* keep polling */
          }
        }, 3000);
        codexDeviceTimersRef.current = { intervalId, timeoutId };
      } else {
        setDeviceLoading(false);
        setDeviceMsg({ type: 'error', msg: data.output || 'Could not start device login.' });
      }
    } catch (err) {
      setDeviceLoading(false);
      setDeviceMsg({ type: 'error', msg: err.message || 'Device login failed' });
    }
  };

  const handleCancelDevice = async () => {
    clearCodexDeviceTimers();
    try {
      await api.cancelCodexDeviceLogin();
    } catch {
      /* ignore */
    }
    setDeviceLoading(false);
    setDeviceAuthUrl(null);
    setDeviceUserCode(null);
    setDeviceMsg(null);
  };

  const handleFullLogoutCodex = async () => {
    setDeviceMsg(null);
    setFullLogoutBusy(true);
    try {
      const r = await api.logoutCodex();
      setDeviceMsg({ type: 'success', msg: r.output || 'Codex credentials cleared.' });
      await fetchAuth();
    } catch (err) {
      setDeviceMsg({ type: 'error', msg: err.message || 'Logout failed' });
    }
    setFullLogoutBusy(false);
  };

  const copyDeviceCode = () => {
    if (!deviceUserCode) return;
    navigator.clipboard.writeText(deviceUserCode);
    setDeviceCopied('code');
    setTimeout(() => setDeviceCopied(null), 2000);
  };

  if (loading)
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
        <Loader2 size={16} className="animate-spin" />
        <span>Loading Codex auth status...</span>
      </div>
    );

  if (error && !auth)
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
        <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
          <AlertCircle size={16} />
          <span className="font-medium">Failed to load Codex auth status</span>
        </div>
        <p className="text-xs text-gray-400">{error}</p>
      </div>
    );

  const apiKeyConfigured = auth?.apiKey?.configured;
  const apiKeySource = auth?.apiKey?.source;
  const masked = auth?.apiKey?.masked;
  const activeMethod = auth?.activeMethod;
  const uiStatus = auth?.uiStatus || 'missing';
  const loginInProgress = !!auth?.loginInProgress;
  const uiBadge =
    uiStatus === 'authenticated'
      ? 'bg-emerald-500/15 text-emerald-400'
      : uiStatus === 'pending'
        ? 'bg-amber-500/15 text-amber-400'
        : 'bg-red-500/15 text-red-400';

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">Codex CLI Authentication</h3>
        <p className="text-xs text-gray-500 mb-4">
          Use an OpenAI API key (recommended for automation per Codex docs) or sign in with a
          ChatGPT-linked Codex account using device authorization — no SSH required.
        </p>
      </div>

      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <Shield size={16} /> Authentication Status
          </h4>
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${uiBadge}`}>
            {uiStatus === 'authenticated'
              ? 'Authenticated'
              : uiStatus === 'pending'
                ? 'Pending login'
                : 'Missing'}
          </span>
        </div>

        {auth?.statusError && uiStatus !== 'authenticated' && (
          <p className="text-xs text-amber-400/90 mb-2">{auth.statusError}</p>
        )}

        <div className="grid grid-cols-2 gap-2 text-xs">
          <span className="text-gray-500">Hub method</span>
          <span className="text-gray-300">
            {activeMethod === 'api-key'
              ? 'API key'
              : activeMethod === 'oauth'
                ? 'ChatGPT (CLI cache)'
                : 'None'}
          </span>
          <span className="text-gray-500">Device login</span>
          <span className="text-gray-300">{loginInProgress ? 'In progress' : 'Idle'}</span>
          <span className="text-gray-500">OAuth cache</span>
          <span className="text-gray-300 font-mono">
            {auth?.oauth?.mode ? String(auth.oauth.mode) : '—'}
          </span>
          <span className="text-gray-500">API Key</span>
          <span className="text-gray-300 font-mono">
            {apiKeyConfigured ? masked || '••••••••' : '—'}
          </span>
          <span className="text-gray-500">Source</span>
          <span className="text-gray-300">
            {apiKeySource === 'environment'
              ? 'Environment (CODEX_API_KEY / OPENAI_API_KEY)'
              : apiKeySource === 'config'
                ? 'Config file'
                : 'Not set'}
          </span>
        </div>
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Globe size={16} /> ChatGPT sign-in (device code)
        </h4>
        <p className="text-xs text-gray-500">
          Starts <code>codex login --device-auth</code> on the Hub. Open the verification URL, paste
          the one-time code, then wait for this page to show Authenticated (see{' '}
          <a
            href="https://developers.openai.com/codex/noninteractive"
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline"
          >
            Codex non-interactive docs
          </a>
          ).
        </p>
        {deviceAuthUrl && (
          <div className="rounded-lg border border-gray-700 bg-gray-900/80 p-3 space-y-2 text-xs">
            <p className="text-gray-400">Verification page</p>
            <a
              href={deviceAuthUrl}
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:underline break-all flex items-center gap-1"
            >
              {deviceAuthUrl} <ExternalLink size={12} />
            </a>
            <p className="text-gray-400 pt-1">One-time code</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-lg tracking-widest text-white">{deviceUserCode}</code>
              <button
                type="button"
                onClick={copyDeviceCode}
                className="text-gray-400 hover:text-white flex items-center gap-1 text-xs"
              >
                <Copy size={12} /> {deviceCopied === 'code' ? 'Copied' : 'Copy code'}
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDeviceLogin}
            disabled={deviceLoading || !auth?.binary?.present}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
          >
            {deviceLoading && <Loader2 size={14} className="animate-spin" />}
            <LogIn size={14} />
            {deviceLoading ? 'Waiting for OpenAI…' : 'Start ChatGPT device login'}
          </button>
          {deviceLoading && (
            <button
              type="button"
              onClick={handleCancelDevice}
              className="text-sm text-gray-400 hover:text-white px-3 py-2"
            >
              Cancel
            </button>
          )}
        </div>
        {deviceMsg && (
          <p
            className={`text-xs ${deviceMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
          >
            {deviceMsg.msg}
          </p>
        )}
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Key size={16} /> Set or update API key
        </h4>
        <p className="text-xs text-gray-500">
          Paste an OpenAI API key from{' '}
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline"
          >
            platform.openai.com
          </a>
          . Agent Hub will export it as <code>CODEX_API_KEY</code> and <code>OPENAI_API_KEY</code>{' '}
          when spawning the Codex CLI.
        </p>

        <div className="flex items-center gap-2">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="sk-..."
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => setShowApiKey((v) => !v)}
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

      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <LogOut size={16} /> Clear Hub key + CLI session
        </h4>
        <p className="text-xs text-gray-500">
          Removes the saved API key from Agent Hub configuration and runs <code>codex logout</code>{' '}
          so ChatGPT tokens are cleared on this host.
        </p>
        <button
          type="button"
          onClick={handleFullLogoutCodex}
          disabled={fullLogoutBusy}
          className="flex items-center gap-2 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 text-red-300 text-sm px-4 py-2 rounded-lg disabled:opacity-50"
        >
          {fullLogoutBusy && <Loader2 size={14} className="animate-spin" />}
          <LogOut size={14} />
          Full sign out (Hub + CLI)
        </button>
      </div>
    </div>
  );
}

export function GeneralSection() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  useEffect(() => {
    api
      .getConfig()
      .then((data) => {
        setConfig(data);
        setEdits({
          claudeBin: data.claudeBin,
          cursorBin: data.cursorBin,
          geminiBin: data.geminiBin,
          codexBin: data.codexBin,
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
      (edits.codexBin ?? '') !== (config.codexBin ?? ''));

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        claudeBin: edits.claudeBin,
        cursorBin: edits.cursorBin,
        geminiBin: edits.geminiBin,
        codexBin: edits.codexBin,
      };
      await api.updateConfig(payload);
      setConfig((prev) => ({ ...prev, ...payload }));
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

      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-300">CLI Binary Paths</h4>

        <div>
          <label className={labelClass}>Claude Code CLI</label>
          <input
            value={edits.claudeBin || ''}
            onChange={(e) => setEdits((prev) => ({ ...prev, claudeBin: e.target.value }))}
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
            onChange={(e) => setEdits((prev) => ({ ...prev, cursorBin: e.target.value }))}
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
            onChange={(e) => setEdits((prev) => ({ ...prev, geminiBin: e.target.value }))}
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
            onChange={(e) => setEdits((prev) => ({ ...prev, codexBin: e.target.value }))}
            className={inputClass}
            placeholder="/usr/local/bin/codex"
          />
          <p className="text-xs text-gray-600 mt-1">
            Path to the <code>codex</code> binary (install via{' '}
            <code>npm install -g @openai/codex</code>). Used for all codex-cli engine sessions.
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

export function GitHubSection({ onProjectsChange }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  // GitHub App state
  const [appStatus, setAppStatus] = useState(null);
  const [refreshingApp, setRefreshingApp] = useState(false);
  const [syncingSecret, setSyncingSecret] = useState(false);
  const [syncSecretMessage, setSyncSecretMessage] = useState(null);
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [connectForm, setConnectForm] = useState({ appId: '', privateKey: '', installationId: '' });
  const [connectError, setConnectError] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [publicUrlInput, setPublicUrlInput] = useState('');
  const [showPublicUrlPrompt, setShowPublicUrlPrompt] = useState(false);
  const pollIntervalRef = useRef(null);
  const pollTimeoutRef = useRef(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    api
      .getConfig()
      .then((data) => {
        setConfig(data);
        setPublicUrlInput(data.publicUrl || '');
        setLoading(false);
      })
      .catch(() => setLoading(false));
    // Fetch app status
    api
      .get('/github-app/status')
      .then(setAppStatus)
      .catch(() => {});
  }, []);

  // Handle return from GitHub App auto-setup flow
  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/[?&]githubApp=([^&]*)/);
    if (!match) return;
    const status = match[1];
    const cleanHash = hash.replace(/[?&]githubApp=[^&]*(&message=[^&]*)?/, '').replace(/\?$/, '');
    window.history.replaceState(null, '', window.location.pathname + cleanHash);
    if (status === 'ready' || status === 'no-install' || status === 'created') {
      api
        .get('/github-app/status')
        .then(setAppStatus)
        .catch(() => {});
      // The server may have just seeded a Reviewer agent via
      // `ensureReviewerAgents()` during setup-complete. A `projects_updated`
      // WS broadcast is emitted, but the WebSocket may have been disconnected
      // mid-redirect and missed the event. Refresh projects/agents locally
      // too so the sidebar reflects the new Reviewer without a page reload.
      if (onProjectsChange) onProjectsChange();
    }
    if (status === 'error') {
      const msgMatch = hash.match(/message=([^&]*)/);
      if (msgMatch) alert(decodeURIComponent(msgMatch[1]));
    }
  }, [onProjectsChange]);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  // --- GitHub App handlers ---

  const handleCreateApp = async () => {
    // Ensure publicUrl is persisted via config API before navigating
    if (publicUrlInput && publicUrlInput.trim()) {
      await api.updateConfig({ publicUrl: publicUrlInput.trim() });
      setConfig((prev) => ({ ...prev, publicUrl: publicUrlInput.trim() }));
    }
    const base = getServerBase();
    window.open(`${base}/api/github-app/register`, '_blank');

    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const status = await api.get('/github-app/status');
        if (status.configured) {
          setAppStatus(status);
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      } catch {
        /* ignore — keep polling */
      }
    }, 3000);
    pollTimeoutRef.current = setTimeout(
      () => {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      },
      5 * 60 * 1000,
    );
  };

  const handleConnectExisting = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      await api.post('/github-app/connect', {
        appId: Number(connectForm.appId),
        privateKey: connectForm.privateKey,
        installationId: Number(connectForm.installationId),
      });
      const status = await api.get('/github-app/status');
      setAppStatus(status);
      setShowConnectForm(false);
      setConnectForm({ appId: '', privateKey: '', installationId: '' });
    } catch (err) {
      setConnectError(err.message || 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  const handleRefreshInstallation = async () => {
    setRefreshingApp(true);
    try {
      const result = await api.post('/github-app/refresh-installation');
      if (result.installed) {
        setAppStatus((prev) => ({
          ...prev,
          hasInstallation: true,
          installationId: result.installationId,
        }));
      } else {
        alert(result.message || 'No installation found');
      }
    } catch (err) {
      alert(err.message || 'Failed to refresh');
    } finally {
      setRefreshingApp(false);
    }
  };

  const handleInstallApp = async () => {
    try {
      const data = await api.get('/github-app/install-url');
      window.open(data.installUrl, '_blank');
    } catch (err) {
      alert(err.message || 'Failed to get install URL');
    }
  };

  const handleSyncWebhookSecret = async (rotate = false) => {
    // Push our local App webhook secret to GitHub via
    // POST /api/github-app/sync-webhook-secret. This is the manual
    // recovery for "the App's webhook secret on GitHub drifted out of
    // sync with our copy in config.json" — symptom is
    // `[Webhook] HMAC verification failed ... tried=repo + github-app`
    // in the server log. Most drift now self-heals on the next failed
    // delivery (see routes/webhooks.ts), but this button is the
    // explicit operator escape hatch.
    if (
      rotate &&
      !confirm(
        'Generate a fresh webhook secret and push it to GitHub? Any other agents using ' +
          "the App's current secret will need to be reconfigured.",
      )
    ) {
      return;
    }
    setSyncingSecret(true);
    setSyncSecretMessage(null);
    try {
      const result = await api.post('/github-app/sync-webhook-secret', rotate ? { rotate } : {});
      setSyncSecretMessage({
        kind: 'ok',
        text: `Synced — pushed secret to GitHub (${result.generated ? 'newly generated, ' : ''}prefix ${result.secretPrefix}…, ${result.secretLength} chars).`,
      });
    } catch (err) {
      setSyncSecretMessage({
        kind: 'error',
        text: err.message || 'Failed to sync webhook secret to GitHub',
      });
    } finally {
      setSyncingSecret(false);
    }
  };

  const handleRemoveApp = async () => {
    if (!confirm('Remove the GitHub App configuration? You can re-create it anytime.')) return;
    try {
      await api.del('/github-app');
      setAppStatus(null);
      setConfig((prev) => ({ ...prev, githubApp: null }));
    } catch {
      /* ignore */
    }
  };

  if (loading) return <p className="text-sm text-gray-500">Loading config...</p>;
  if (!config) return <p className="text-sm text-red-400">Failed to load config</p>;

  const handleToggleLanMode = async (next) => {
    // Optimistic update — flip in-memory first so the toggle responds
    // immediately. On failure we roll back AND re-fetch the config so a
    // half-applied state can't linger.
    setConfig((prev) => ({ ...prev, lanMode: next }));
    try {
      await api.updateConfig({ lanMode: next });
    } catch (err) {
      setConfig((prev) => ({ ...prev, lanMode: !next }));
      try {
        const fresh = await api.getConfig();
        setConfig(fresh);
      } catch {
        /* leave the rollback in place */
      }
      alert((err && err.message) || 'Failed to update LAN mode');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">GitHub Settings</h3>
        <p className="text-xs text-gray-500 mb-4">
          Three independent pieces: <span className="text-gray-300">your GitHub account</span>{' '}
          (sign-in for PR actions), <span className="text-gray-300">an OAuth App</span>{' '}
          (server-wide; powers &ldquo;Sign in with GitHub&rdquo; without PATs), and{' '}
          <span className="text-gray-300">a GitHub App</span> (the reviewer bot for formal PR
          reviews). Per-project repo links live on the{' '}
          <span className="text-gray-300">Projects</span> tab.
        </p>
      </div>

      {/* LAN / air-gapped mode toggle. Lives at the top of the GitHub
          section because every other block on this page assumes inbound
          webhooks are reachable — LAN mode flips that assumption to
          polling-only. The same field is also exposed on the first-run
          SetupWizard so users opt in before any webhook setup is
          attempted. Disabled state is the cloud-default. */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h4 className="text-sm font-medium text-gray-300">LAN / air-gapped mode</h4>
            <p className="text-xs text-gray-500 mt-1">
              Turn this on if Agent Hub is running on a private network where GitHub cannot reach
              it. Webhook auto-registration is disabled; PR state, reviews, and CI failures are
              detected by polling GitHub every 3 minutes using your personal access token. Turning
              it off restores the normal webhook-driven path — no other settings change.
            </p>
          </div>
          <label
            className="relative inline-flex items-center cursor-pointer shrink-0 mt-1"
            aria-label="Toggle LAN mode"
          >
            <input
              type="checkbox"
              className="sr-only peer"
              checked={!!config.lanMode}
              onChange={(e) => handleToggleLanMode(e.target.checked)}
              data-testid="lan-mode-toggle"
            />
            <span className="w-10 h-6 bg-gray-700 peer-checked:bg-blue-600 rounded-full transition-colors relative">
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                  config.lanMode ? 'translate-x-4' : ''
                }`}
              />
            </span>
          </label>
        </div>
        {config.lanMode && (
          <div className="bg-blue-900/20 border border-blue-700/40 rounded-lg p-2.5 text-xs text-blue-200">
            <strong>LAN mode is on.</strong> New webhook registrations are skipped — the
            reconciliation poller is the source of truth for PR state.
          </div>
        )}
      </div>

      {/* Personal GitHub OAuth — moved here so the connected account is visible
          alongside the App + per-project tabs that depend on it. */}
      <GithubConnectionSection />

      {/* Server-level OAuth App credentials (separate from the GitHub App). */}
      <PersonalOAuthConfigSection />

      {/* GitHub App */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-300">GitHub App (Reviewer Bot)</h4>
        <p className="text-xs text-gray-500">
          One-time setup for the reviewer-bot identity. Posts formal PR reviews, manages webhooks,
          and (optionally) auto-merges. <strong>Not required</strong> for personal sign-in or
          per-user PR actions — those use the OAuth App above (or a personal access token).
        </p>

        {!appStatus?.configured ? (
          /* State A — Not configured */
          <div className="space-y-3">
            {/* Identity warning */}
            <div className="bg-amber-900/30 border border-amber-700/50 rounded-lg p-3 flex items-start gap-2">
              <span className="text-amber-400 text-sm mt-0.5">⚠</span>
              <div className="text-xs text-amber-300/90">
                <strong>No bot identity configured.</strong> PR reviews will appear as your personal
                GitHub profile. Create a GitHub App or set a{' '}
                <code className="bg-gray-900/50 px-1 rounded">botGithubToken</code> in config to fix
                this.
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  if (!config?.publicUrl && !publicUrlInput) {
                    setShowPublicUrlPrompt(true);
                    setShowConnectForm(false);
                  } else {
                    handleCreateApp();
                  }
                }}
                className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <Plus size={14} />
                Create New App
              </button>
              <button
                onClick={() => {
                  setShowConnectForm(!showConnectForm);
                  setShowPublicUrlPrompt(false);
                }}
                className="bg-gray-700 hover:bg-gray-600 text-white text-sm px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <Link size={14} />
                Connect Existing App
              </button>
            </div>

            {/* Inline public URL prompt */}
            {showPublicUrlPrompt && (
              <div className="bg-gray-900/50 rounded-lg p-3 space-y-2">
                <label className={labelClass}>Public URL (required for GitHub callback)</label>
                <div className="flex gap-2">
                  <input
                    value={publicUrlInput}
                    onChange={(e) => setPublicUrlInput(e.target.value)}
                    className={inputClass}
                    placeholder="https://my-server.example.com"
                  />
                  <button
                    onClick={async () => {
                      if (!publicUrlInput.trim()) return;
                      await api.updateConfig({ publicUrl: publicUrlInput.trim() });
                      setConfig((prev) => ({ ...prev, publicUrl: publicUrlInput.trim() }));
                      setShowPublicUrlPrompt(false);
                      handleCreateApp();
                    }}
                    disabled={!publicUrlInput.trim()}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Connect existing app form */}
            {showConnectForm && (
              <div className="bg-gray-900/50 rounded-lg p-3 space-y-3">
                <div>
                  <label className={labelClass}>App ID</label>
                  <input
                    type="number"
                    value={connectForm.appId}
                    onChange={(e) => setConnectForm((f) => ({ ...f, appId: e.target.value }))}
                    className={inputClass}
                    placeholder="123456"
                  />
                </div>
                <div>
                  <label className={labelClass}>Private Key</label>
                  <textarea
                    value={connectForm.privateKey}
                    onChange={(e) => setConnectForm((f) => ({ ...f, privateKey: e.target.value }))}
                    className={`${inputClass} h-24 resize-none`}
                    placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..."
                  />
                </div>
                <div>
                  <label className={labelClass}>Installation ID</label>
                  <input
                    type="number"
                    value={connectForm.installationId}
                    onChange={(e) =>
                      setConnectForm((f) => ({ ...f, installationId: e.target.value }))
                    }
                    className={inputClass}
                    placeholder="12345678"
                  />
                </div>
                {connectError && <p className="text-xs text-red-400">{connectError}</p>}
                <button
                  onClick={handleConnectExisting}
                  disabled={
                    connecting ||
                    !connectForm.appId ||
                    !connectForm.privateKey ||
                    !connectForm.installationId
                  }
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {connecting && <Loader2 size={12} className="animate-spin" />}
                  {connecting ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            )}
          </div>
        ) : !appStatus?.hasInstallation ? (
          /* State B — Created but not installed */
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-xs text-amber-400">App created — needs installation</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleInstallApp}
                className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <ExternalLink size={12} />
                Install on GitHub
              </button>
              <button
                onClick={handleRefreshInstallation}
                disabled={refreshingApp}
                className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                <RefreshCw size={12} className={refreshingApp ? 'animate-spin' : ''} />
                {refreshingApp ? 'Checking...' : 'Refresh'}
              </button>
            </div>
          </div>
        ) : (
          /* State C — Fully configured */
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-sm text-emerald-400">
                Connected: {appStatus.appName || appStatus.appSlug || `App #${appStatus.appId}`}
              </span>
              <button
                onClick={handleRemoveApp}
                className="text-xs text-red-400 hover:text-red-300 ml-auto"
              >
                Remove
              </button>
            </div>
            <div className="border-t border-gray-800 pt-3 space-y-2">
              <p className="text-xs text-gray-500">
                <span className="text-gray-400">Webhook secret —</span> if the server log shows{' '}
                <code className="text-[10px] text-gray-400">
                  [Webhook] HMAC verification failed
                </code>{' '}
                for GitHub-App deliveries, push our local secret to GitHub to put both sides back in
                sync. (GitHub never returns the secret on read, so we can only push.)
              </p>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => handleSyncWebhookSecret(false)}
                  disabled={syncingSecret}
                  className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  title="Push the stored webhook secret to GitHub"
                >
                  <RefreshCw size={12} className={syncingSecret ? 'animate-spin' : ''} />
                  {syncingSecret ? 'Syncing…' : 'Sync webhook secret to GitHub'}
                </button>
                <button
                  onClick={() => handleSyncWebhookSecret(true)}
                  disabled={syncingSecret}
                  className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50"
                  title="Generate a fresh secret and push it to GitHub (destructive)"
                >
                  Rotate
                </button>
              </div>
              {syncSecretMessage && (
                <p
                  className={`text-xs ${syncSecretMessage.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}
                >
                  {syncSecretMessage.text}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
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
}) {
  const [projectWorkflow, setProjectWorkflow] = useState({});
  const [modelConfig, setModelConfig] = useState(null);
  const [reviewerModelSaving, setReviewerModelSaving] = useState({});
  const [projectRepos, setProjectRepos] = useState({});
  const [projectRepoUrls, setProjectRepoUrls] = useState({});
  const [workflowSaved, setWorkflowSaved] = useState({});
  const [repoSaving, setRepoSaving] = useState({});
  const [repoSaveStatus, setRepoSaveStatus] = useState({});
  const [repoUrlSaving, setRepoUrlSaving] = useState({});
  const [repoUrlSaveStatus, setRepoUrlSaveStatus] = useState({});
  const [expandedProject, setExpandedProject] = useState(null);
  const [detecting, setDetecting] = useState({});
  /** One-shot deep-link expand — do not re-expand on `projects` identity churn after manual collapse. */
  const lastDeepLinkExpandIdRef = useRef(null);

  // Per-project repo test
  const [repoTesting, setRepoTesting] = useState({});
  const [repoTestResult, setRepoTestResult] = useState({});

  // Per-project author allowlist (comma-separated input, per-project webhook)
  const [allowlistInput, setAllowlistInput] = useState({});
  const [allowlistSaving, setAllowlistSaving] = useState({});
  const [allowlistStatus, setAllowlistStatus] = useState({});
  const [webhookIds, setWebhookIds] = useState({}); // projectId → first webhook id

  // Project delete confirmation (inline toggle pattern)
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(null);

  useEffect(() => {
    if (!initialExpandedProjectId) {
      lastDeepLinkExpandIdRef.current = null;
      return;
    }
    if (!projects.some((p) => p.id === initialExpandedProjectId)) return;
    if (lastDeepLinkExpandIdRef.current === initialExpandedProjectId) return;
    setExpandedProject(initialExpandedProjectId);
    lastDeepLinkExpandIdRef.current = initialExpandedProjectId;
  }, [initialExpandedProjectId, projects]);

  // Load each project's first webhook config to pick up its author_allowlist.
  // There's typically one webhook per project (auto-managed when the repo is
  // linked), so we grab [0] and use its id for subsequent PUTs.
  const loadAllowlistFor = async (projectId) => {
    try {
      const hooks = await api.getProjectWebhooks(projectId);
      const first = Array.isArray(hooks) && hooks.length > 0 ? hooks[0] : null;
      if (!first) return;
      setWebhookIds((prev) => ({ ...prev, [projectId]: first.id }));
      const list = parseAllowlistFromBackend(first.author_allowlist);
      setAllowlistInput((prev) => ({ ...prev, [projectId]: serializeAllowlist(list) }));
    } catch {
      /* ignore — project may not have a webhook yet */
    }
  };

  const saveAllowlist = async (projectId) => {
    const webhookId = webhookIds[projectId];
    if (!webhookId) {
      setAllowlistStatus((prev) => ({ ...prev, [projectId]: 'no-webhook' }));
      setTimeout(() => setAllowlistStatus((prev) => ({ ...prev, [projectId]: null })), 3000);
      return;
    }
    setAllowlistSaving((prev) => ({ ...prev, [projectId]: true }));
    setAllowlistStatus((prev) => ({ ...prev, [projectId]: null }));
    try {
      const normalized = parseAllowlist(allowlistInput[projectId] || '');
      await api.updateWebhook(webhookId, { authorAllowlist: normalized });
      setAllowlistInput((prev) => ({ ...prev, [projectId]: serializeAllowlist(normalized) }));
      setAllowlistStatus((prev) => ({ ...prev, [projectId]: 'saved' }));
      setTimeout(() => setAllowlistStatus((prev) => ({ ...prev, [projectId]: null })), 2000);
    } catch {
      setAllowlistStatus((prev) => ({ ...prev, [projectId]: 'error' }));
      setTimeout(() => setAllowlistStatus((prev) => ({ ...prev, [projectId]: null })), 3000);
    } finally {
      setAllowlistSaving((prev) => ({ ...prev, [projectId]: false }));
    }
  };

  useEffect(() => {
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => {});
  }, []);

  // Init per-project state when projects arrive
  useEffect(() => {
    const wf = {};
    const repos = {};
    const repoUrls = {};
    projects.forEach((p) => {
      wf[p.id] = {
        autoMerge: p.githubWorkflow?.autoMerge || false,
        autoReview: p.githubWorkflow?.autoReview !== false,
        waitForCI: p.githubWorkflow?.waitForCI || false,
        waitForResolvedComments: p.githubWorkflow?.waitForResolvedComments || false,
        reviewerModel:
          typeof p.githubWorkflow?.reviewerModel === 'string' ? p.githubWorkflow.reviewerModel : '',
      };
      repos[p.id] = p.githubRepo || '';
      repoUrls[p.id] = p.repoUrl || '';
      // Fire-and-forget: hydrate allowlist from the webhook API.
      loadAllowlistFor(p.id);
    });
    setProjectWorkflow(wf);
    setProjectRepos(repos);
    setProjectRepoUrls(repoUrls);
  }, [projects]);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  // --- Per-project handlers ---

  const toggleWorkflowSetting = async (projectId, key) => {
    const current = projectWorkflow[projectId] || {};
    const newValue = !current[key];
    setProjectWorkflow((prev) => ({
      ...prev,
      [projectId]: { ...prev[projectId], [key]: newValue },
    }));
    try {
      await api.updateProject(projectId, { githubWorkflow: { [key]: newValue } });
      setWorkflowSaved((prev) => ({ ...prev, [projectId]: true }));
      setTimeout(() => setWorkflowSaved((prev) => ({ ...prev, [projectId]: false })), 2000);
      if (onProjectsChange) onProjectsChange();
    } catch {
      setProjectWorkflow((prev) => ({
        ...prev,
        [projectId]: { ...prev[projectId], [key]: !newValue },
      }));
    }
  };

  const saveWorkflowReviewerModel = async (projectId, value) => {
    const prevVal =
      typeof projectWorkflow[projectId]?.reviewerModel === 'string'
        ? projectWorkflow[projectId].reviewerModel
        : '';
    setProjectWorkflow((prev) => ({
      ...prev,
      [projectId]: { ...prev[projectId], reviewerModel: value },
    }));
    setReviewerModelSaving((s) => ({ ...s, [projectId]: true }));
    try {
      await api.updateProject(projectId, {
        githubWorkflow: { reviewerModel: value.trim() ? value.trim() : '' },
      });
      setWorkflowSaved((prev) => ({ ...prev, [projectId]: true }));
      setTimeout(() => setWorkflowSaved((prev) => ({ ...prev, [projectId]: false })), 2000);
      if (onProjectsChange) onProjectsChange();
    } catch {
      setProjectWorkflow((prev) => ({
        ...prev,
        [projectId]: { ...prev[projectId], reviewerModel: prevVal },
      }));
    } finally {
      setReviewerModelSaving((s) => ({ ...s, [projectId]: false }));
    }
  };

  const saveProjectRepo = async (projectId) => {
    setRepoSaving((prev) => ({ ...prev, [projectId]: true }));
    setRepoSaveStatus((prev) => ({ ...prev, [projectId]: null }));
    try {
      await api.updateProject(projectId, { githubRepo: projectRepos[projectId] });
      setRepoSaveStatus((prev) => ({ ...prev, [projectId]: 'saved' }));
      setTimeout(() => setRepoSaveStatus((prev) => ({ ...prev, [projectId]: null })), 2000);
      if (onProjectsChange) onProjectsChange();
    } catch {
      setRepoSaveStatus((prev) => ({ ...prev, [projectId]: 'error' }));
      setTimeout(() => setRepoSaveStatus((prev) => ({ ...prev, [projectId]: null })), 3000);
    } finally {
      setRepoSaving((prev) => ({ ...prev, [projectId]: false }));
    }
  };

  const saveProjectRepoUrl = async (projectId) => {
    setRepoUrlSaving((prev) => ({ ...prev, [projectId]: true }));
    setRepoUrlSaveStatus((prev) => ({ ...prev, [projectId]: null }));
    try {
      const raw = projectRepoUrls[projectId] || '';
      const trimmed = raw.trim();
      // Empty string clears the field on the server.
      await api.updateProject(projectId, { repoUrl: trimmed || null });
      setRepoUrlSaveStatus((prev) => ({ ...prev, [projectId]: 'saved' }));
      setTimeout(() => setRepoUrlSaveStatus((prev) => ({ ...prev, [projectId]: null })), 2000);
      if (onProjectsChange) onProjectsChange();
    } catch (err) {
      const msg = String(err?.message || err || 'Failed to save');
      setRepoUrlSaveStatus((prev) => ({ ...prev, [projectId]: { error: msg } }));
      setTimeout(() => setRepoUrlSaveStatus((prev) => ({ ...prev, [projectId]: null })), 4000);
    } finally {
      setRepoUrlSaving((prev) => ({ ...prev, [projectId]: false }));
    }
  };

  const detectRepo = async (project) => {
    setDetecting((prev) => ({ ...prev, [project.id]: true }));
    try {
      const res = await fetch(`${getApiBase()}/github/detect-repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ cwd: project.cwd }),
      });
      const data = await res.json();
      if (data.owner && data.repo) {
        setProjectRepos((prev) => ({ ...prev, [project.id]: `${data.owner}/${data.repo}` }));
      }
    } catch {
      /* ignore */
    } finally {
      setDetecting((prev) => ({ ...prev, [project.id]: false }));
    }
  };

  const testProjectConnection = async (project) => {
    setRepoTesting((prev) => ({ ...prev, [project.id]: true }));
    setRepoTestResult((prev) => ({ ...prev, [project.id]: null }));
    try {
      const repo = projectRepos[project.id];
      if (!repo) {
        setRepoTestResult((prev) => ({
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
      setRepoTestResult((prev) => ({
        ...prev,
        [project.id]: result.ok
          ? { ok: true, detail: `${repo} (${result.repoInfo.private ? 'private' : 'public'})` }
          : { ok: false, error: result.error },
      }));
    } catch {
      setRepoTestResult((prev) => ({
        ...prev,
        [project.id]: { ok: false, error: 'Request failed' },
      }));
    } finally {
      setRepoTesting((prev) => ({ ...prev, [project.id]: false }));
    }
  };

  const handleDeleteProject = async (projectId) => {
    if (confirmDeleteProject === projectId) {
      try {
        await api.deleteProject(projectId);
        if (onProjectsChange) onProjectsChange();
      } catch (err) {
        console.error('Failed to delete project:', err);
      }
      setConfirmDeleteProject(null);
    } else {
      setConfirmDeleteProject(projectId);
      setTimeout(() => setConfirmDeleteProject(null), 3000);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">Projects</h3>
        <p className="text-xs text-gray-500 mb-4">
          Link GitHub repositories, configure PR workflow, and manage each project&apos;s lifecycle.
        </p>
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-300">Projects & Repos</h4>
        <p className="text-xs text-gray-500">
          Link GitHub repositories and configure PR workflow for each project.
        </p>

        {projects.length === 0 && (
          <p className="text-xs text-gray-600 italic">No projects configured yet.</p>
        )}

        <div className="space-y-2">
          {projects.map((p) => {
            const isExpanded = expandedProject === p.id;
            const repo = projectRepos[p.id] || '';
            const reviewerAgent = p.agents?.find((a) => a.role === 'reviewer');
            const reviewerEngine = reviewerAgent?.engine || 'claude-code';
            let reviewerModelOpts =
              modelConfig?.engineValidModels?.[reviewerEngine]
                ?.slice()
                .sort((a, b) => a.localeCompare(b)) || [];
            const savedReviewerModel = projectWorkflow[p.id]?.reviewerModel || '';
            if (savedReviewerModel && !reviewerModelOpts.includes(savedReviewerModel)) {
              reviewerModelOpts = [savedReviewerModel, ...reviewerModelOpts];
            }

            return (
              <div key={p.id} className="bg-gray-900/50 rounded-lg p-3">
                {/* Header row */}
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

                {/* Expanded content */}
                {isExpanded && (
                  <div className="pl-8 pt-3 space-y-4">
                    {/* Repo linking */}
                    <div className="space-y-2">
                      <label className={labelClass}>GitHub Repository</label>
                      <div className="flex gap-2">
                        <input
                          value={repo}
                          onChange={(e) =>
                            setProjectRepos((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          className={inputClass}
                          placeholder="owner/repo"
                        />
                        <button
                          onClick={() => detectRepo(p)}
                          disabled={detecting[p.id]}
                          className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {detecting[p.id] ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Globe size={12} />
                          )}
                          Auto-detect
                        </button>
                        <button
                          onClick={() => saveProjectRepo(p.id)}
                          disabled={repoSaving[p.id]}
                          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                        >
                          {repoSaving[p.id] ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                      {repoSaveStatus[p.id] === 'saved' && (
                        <span className="text-xs text-emerald-400">
                          Saved — webhook auto-configured
                        </span>
                      )}
                      {repoSaveStatus[p.id] === 'error' && (
                        <span className="text-xs text-red-400">Failed to save</span>
                      )}
                    </div>

                    {/* Clone URL — used to auto-clone the project workspace
                        on session spawn when `cwd` is missing or non-git.
                        Server validates: HTTPS GitHub URLs only. */}
                    <div className="space-y-2">
                      <label className={labelClass}>Clone URL (auto-clone source)</label>
                      <p className="text-xs text-gray-500">
                        Optional HTTPS GitHub URL (e.g.{' '}
                        <code className="font-mono">https://github.com/owner/repo.git</code>). When
                        set, Agent Hub auto-clones the repo into the project{' '}
                        <code className="font-mono">cwd</code> on session spawn if it's missing or
                        not a git repo. Authenticates via the registered GitHub App. SSH URLs are
                        not supported.
                      </p>
                      <div className="flex gap-2">
                        <input
                          value={projectRepoUrls[p.id] || ''}
                          onChange={(e) =>
                            setProjectRepoUrls((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          className={inputClass}
                          placeholder="https://github.com/owner/repo.git"
                        />
                        <button
                          onClick={() => saveProjectRepoUrl(p.id)}
                          disabled={repoUrlSaving[p.id]}
                          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                        >
                          {repoUrlSaving[p.id] ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                      {repoUrlSaveStatus[p.id] === 'saved' && (
                        <span className="text-xs text-emerald-400">Saved</span>
                      )}
                      {repoUrlSaveStatus[p.id] &&
                        typeof repoUrlSaveStatus[p.id] === 'object' &&
                        repoUrlSaveStatus[p.id].error && (
                          <span className="text-xs text-red-400">
                            {repoUrlSaveStatus[p.id].error}
                          </span>
                        )}
                    </div>

                    <ProjectSecretsEditor projectId={p.id} />

                    <ProjectAwsProfilesEditor projectId={p.id} />

                    <div className="space-y-2" data-testid={`project-visibility-${p.id}`}>
                      <label className={labelClass}>Visibility</label>
                      <p className="text-xs text-gray-500">
                        <strong>Shared</strong> (default): every member of your org can see and
                        enter this project. <strong>Private</strong>: visible only to you; org
                        Owners retain a delete-only kill switch from the admin list. Flipping a
                        shared project private is restricted to org Owners (it hides the project
                        from collaborators); the current owner or any org Owner can publish a
                        private project back to shared.
                      </p>
                      <select
                        value={p.visibility === 'private' ? 'private' : 'shared'}
                        data-testid={`project-visibility-select-${p.id}`}
                        onChange={async (e) => {
                          const visibility = e.target.value;
                          try {
                            await api.updateProject(p.id, { visibility });
                            if (onProjectsChange) onProjectsChange();
                          } catch (err) {
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
                        <strong>Dev</strong> (default): kanban lifecycle, per-session worktrees, and
                        GitHub PR review automation. <strong>Workflow</strong>: work in the project
                        checkout; automated reviewer dispatch and session PR flows stay off. For a{' '}
                        <strong>tasks-only project</strong> (just wiki, board, sessions, crons,
                        heartbeats — no git or GitHub), pick <em>Workflow</em> and leave the GitHub
                        repo field empty.
                      </p>
                      <select
                        value={isWorkflowProject(p) ? 'workflow' : 'dev'}
                        onChange={async (e) => {
                          const mode = e.target.value;
                          try {
                            await api.updateProject(p.id, { mode });
                            if (onProjectsChange) onProjectsChange();
                          } catch (err) {
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

                    <SettingsErrorBoundary>
                      <WorkflowRunsSection projectId={p.id} />
                    </SettingsErrorBoundary>

                    {/* Workflow Toggles */}
                    {!isWorkflowProject(p) &&
                      [
                        {
                          key: 'autoReview',
                          label: 'Auto Review',
                          desc: 'Lead agent automatically reviews every PR',
                        },
                        {
                          key: 'autoMerge',
                          label: 'Auto Merge',
                          desc: 'Lead agent merges approved PRs automatically',
                        },
                        {
                          key: 'waitForCI',
                          label: 'Wait for CI',
                          desc: 'Wait for all GitHub checks to pass before approving',
                        },
                        {
                          key: 'waitForResolvedComments',
                          label: 'Wait for Resolved Comments',
                          desc: 'Wait for all review comments to be resolved',
                        },
                      ].map(({ key, label, desc }) => (
                        <div key={key} className="flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-gray-200">{label}</span>
                            <p className="text-xs text-gray-500 truncate">{desc}</p>
                          </div>
                          <button
                            onClick={() => toggleWorkflowSetting(p.id, key)}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
                              projectWorkflow[p.id]?.[key] ? 'bg-emerald-600' : 'bg-gray-600'
                            }`}
                          >
                            <span
                              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                                projectWorkflow[p.id]?.[key] ? 'translate-x-4' : 'translate-x-0.5'
                              }`}
                            />
                          </button>
                        </div>
                      ))}
                    {!isWorkflowProject(p) && (
                      <>
                        <div className="pt-1 space-y-1">
                          <label className={labelClass}>PR review model (GitHub webhook)</label>
                          <p className="text-xs text-gray-500 mb-1">
                            Model for the reviewer agent ({reviewerEngine}) when Auto Review runs
                            after a PR webhook. Default follows the reviewer&apos;s Agents settings.
                          </p>
                          <div className="flex items-center gap-2">
                            <select
                              value={projectWorkflow[p.id]?.reviewerModel || ''}
                              disabled={reviewerModelSaving[p.id] || reviewerModelOpts.length === 0}
                              onChange={(e) => saveWorkflowReviewerModel(p.id, e.target.value)}
                              className={`${inputClass} max-w-xl flex-1`}
                            >
                              <option value="">Same as reviewer agent</option>
                              {reviewerModelOpts.map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                            {reviewerModelSaving[p.id] && (
                              <Loader2
                                size={14}
                                className="animate-spin text-gray-400 flex-shrink-0"
                              />
                            )}
                          </div>
                          {!modelConfig && (
                            <p className="text-[11px] text-gray-600">Loading models…</p>
                          )}
                          {modelConfig && reviewerModelOpts.length === 0 && (
                            <p className="text-[11px] text-amber-400/90">
                              No models listed for this engine in server config — check
                              engineValidModels.
                            </p>
                          )}
                        </div>
                        {workflowSaved[p.id] && (
                          <span className="text-xs text-emerald-400">Saved</span>
                        )}
                      </>
                    )}

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

                    {/* Author Allowlist */}
                    <div className="pt-2 border-t border-gray-800 space-y-2">
                      <label className={labelClass}>Author Allowlist</label>
                      <p className="text-xs text-gray-500">
                        Only review PRs authored by these GitHub usernames. Comma-separated. Leave
                        blank to review all PRs. Use this to prevent two Agent Hub instances on the
                        same repo from cross-reviewing each other&apos;s PRs.
                      </p>
                      <div className="flex gap-2">
                        <input
                          value={allowlistInput[p.id] ?? ''}
                          onChange={(e) =>
                            setAllowlistInput((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          placeholder="e.g. mcsteen, alice"
                          disabled={!webhookIds[p.id]}
                          className={inputClass}
                        />
                        <button
                          onClick={() => saveAllowlist(p.id)}
                          disabled={allowlistSaving[p.id] || !webhookIds[p.id]}
                          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                        >
                          {allowlistSaving[p.id] ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                      {allowlistStatus[p.id] === 'saved' && (
                        <span className="text-xs text-emerald-400">Saved</span>
                      )}
                      {allowlistStatus[p.id] === 'error' && (
                        <span className="text-xs text-red-400">Failed to save</span>
                      )}
                      {allowlistStatus[p.id] === 'no-webhook' && (
                        <span className="text-xs text-amber-400">
                          Save a repo first to configure the webhook
                        </span>
                      )}
                      {!webhookIds[p.id] && !allowlistStatus[p.id] && (
                        <span className="text-xs text-gray-600">
                          No webhook yet — save a repo above to enable this field
                        </span>
                      )}
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
                        {confirmDeleteProject === p.id
                          ? 'Confirm Delete Project'
                          : 'Delete Project'}
                      </button>
                      {confirmDeleteProject === p.id && (
                        <p className="text-xs text-red-400 mt-1">
                          This will permanently delete all agents, sessions, board, wiki, and other
                          data.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HeartbeatSection({ onNavigate, showToast }) {
  const [heartbeats, setHeartbeats] = useState([]);
  const [expandedAgent, setExpandedAgent] = useState(null);
  const [logs, setLogs] = useState({});
  const [running, setRunning] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ interval: '', prompt: '', model: '' });
  // Heartbeats always spawn the Claude CLI, so the picker is locked to the
  // claude-code engine catalog from /api/config/models. We fetch it lazily
  // on mount; an empty list means Claude is unauthenticated and the picker
  // hides itself.
  const [claudeModels, setClaudeModels] = useState([]);
  // Tick every 30s so the "next run in Xm" badges decrement live without
  // hitting the network. Server is re-polled every 60s for fresh state.
  const [, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => api.getHeartbeats().then(setHeartbeats).catch(console.error);
    refresh();
    api
      .getModelConfig()
      .then((cfg) => setClaudeModels(cfg?.engineValidModels?.['claude-code'] || []))
      .catch((err) => console.warn('[HeartbeatSection] getModelConfig failed:', err?.message));
    const pollId = setInterval(refresh, 60_000);
    const tickId = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  const loadLogs = async (agentId) => {
    if (expandedAgent === agentId) {
      setExpandedAgent(null);
      return;
    }
    setExpandedAgent(agentId);
    const data = await api.getHeartbeatLogs(agentId, 20);
    setLogs((prev) => ({ ...prev, [agentId]: data }));
  };

  const toggleHeartbeat = async (agentId, current) => {
    await api.updateHeartbeat(agentId, { enabled: !current });
    setHeartbeats((prev) =>
      prev.map((h) =>
        h.agentId === agentId ? { ...h, heartbeat: { ...h.heartbeat, enabled: !current } } : h,
      ),
    );
  };

  const triggerRun = async (agentId) => {
    setRunning((prev) => ({ ...prev, [agentId]: true }));
    try {
      await api.runHeartbeat(agentId);
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => setRunning((prev) => ({ ...prev, [agentId]: false })), 3000);
  };

  const viewThread = async (hb) => {
    if (!onNavigate) return;
    try {
      const { thread } = await api.getHeartbeatThread(hb.agentId);
      if (thread) {
        onNavigate('threads', { projectId: thread.project_id, threadId: thread.id, thread });
      } else {
        showToast?.('No thread yet — run this heartbeat at least once to create a thread.', 'info');
      }
    } catch (e) {
      console.error('Failed to fetch heartbeat thread:', e);
      showToast?.('Failed to load heartbeat thread.', 'error');
    }
  };

  const startEdit = (hb) => {
    setEditingId(hb.agentId);
    setEditForm({
      interval: hb.heartbeat.interval || '',
      prompt: hb.heartbeat.prompt || '',
      model: hb.heartbeat.model || '',
    });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    // Send empty string explicitly so the server can clear an existing
    // model override (PUT route maps "" → undefined).
    await api.updateHeartbeat(editingId, {
      interval: editForm.interval,
      prompt: editForm.prompt,
      model: editForm.model || '',
    });
    setHeartbeats((prev) =>
      prev.map((h) =>
        h.agentId === editingId
          ? {
              ...h,
              heartbeat: {
                ...h.heartbeat,
                interval: editForm.interval,
                prompt: editForm.prompt,
                model: editForm.model || undefined,
              },
            }
          : h,
      ),
    );
    setEditingId(null);
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Agent Heartbeats</h3>
      <div className="space-y-3">
        {heartbeats.map((hb) => (
          <div key={hb.agentId} className="bg-gray-800 rounded-xl overflow-hidden">
            {editingId === hb.agentId ? (
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
                  onChange={(e) => setEditForm({ ...editForm, interval: e.target.value })}
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
                  onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
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
                      onChange={(e) => setEditForm({ ...editForm, model: e.target.value })}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                    >
                      <option value="">CLI default</option>
                      {claudeModels.map((m) => (
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
                    <span className="text-xs text-gray-500 font-mono" title={hb.heartbeat.interval}>
                      {hb.heartbeat.interval ? humanCron(hb.heartbeat.interval) : 'not set'}
                    </span>
                    {hb.heartbeat.enabled &&
                      hb.state?.next_run_at &&
                      (() => {
                        const { label, overdue } = relativeFuture(hb.state.next_run_at);
                        return (
                          <span
                            title={`Next run: ${new Date(hb.state.next_run_at).toLocaleString()}`}
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
                    className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-2 sm:py-1 rounded-md transition-colors min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => triggerRun(hb.agentId)}
                    disabled={running[hb.agentId]}
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
                    className={`text-xs px-2.5 py-2 sm:py-1 rounded-md transition-colors min-h-[36px] sm:min-h-0 flex items-center ${
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
                    {(logs[hb.agentId] || []).map((log) => (
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

function CronSection({ projects = [], onNavigate, showToast }) {
  const defaultCwd = projects[0]?.cwd || '';
  const [crons, setCrons] = useState([]);
  const [running, setRunning] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [, setTick] = useState(0);
  const [cronLogs, setCronLogs] = useState({}); // { [cronId]: log[] }
  const [expandedLog, setExpandedLog] = useState(null); // "cronId:logId"
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  // Model allowlist for the cron's claude-code engine. Fetched once from
  // /api/config/models so the dropdown stays in sync with the server's
  // engineValidModels (config.ts) without us hardcoding the list here. The
  // dropdown stays hidden until the fetch resolves so we never present an
  // empty <select>.
  const [modelConfig, setModelConfig] = useState(null);
  const [form, setForm] = useState({
    name: '',
    schedule: '*/30 * * * *',
    prompt: '',
    cwd: defaultCwd,
    project_id: projects[0]?.id || '',
    enabled: true,
    // Timeout expressed in minutes in the form; '' means "use server default".
    timeoutMinutes: '',
    // Per-cron opt-in for "ran successfully" push notifications. Off by
    // default — historically every cron pinged every device on every tick,
    // which mobile users complained about. Users explicitly enable on the
    // crons they actually want notifications for.
    notify_on_run: false,
    // Empty string = "use engine default" (resolved server-side via
    // defaultModelForEngine('claude-code')). The blank option is the first
    // entry in the model dropdown so existing crons don't auto-pin to a
    // specific id when an operator opens the form.
    model: '',
  });

  /** Fetch last-3 logs for every cron */
  const refreshLogs = async (cronList) => {
    const entries = await Promise.all(
      (cronList || crons).map(async (c) => {
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
      } catch (e) {
        console.error(e);
      }
    };
    refresh();
    const pollId = setInterval(refresh, 60_000);
    const tickId = setInterval(() => setTick((t) => t + 1), 30_000);

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
   * The list of models we render in the dropdown. Driven by the server's
   * `engineValidModels['claude-code']` so a config update propagates without
   * a client redeploy. Returns [] when the config hasn't loaded yet (or
   * comes back empty), in which case the caller hides the dropdown.
   */
  const modelOptions = modelConfig?.engineValidModels?.['claude-code'] || [];
  const defaultModel = modelConfig?.engineDefaultModels?.['claude-code'];

  const viewThread = async (cronJob) => {
    if (!onNavigate) return;
    try {
      const { thread } = await api.getCronThread(cronJob.id);
      if (thread) {
        onNavigate('threads', { projectId: thread.project_id, threadId: thread.id, thread });
      } else {
        showToast?.('No thread yet — run this cron job at least once to create a thread.', 'info');
      }
    } catch (e) {
      console.error('Failed to fetch cron thread:', e);
      showToast?.('Failed to load cron thread.', 'error');
    }
  };

  const toggleCron = async (cronJob) => {
    const updated = await api.updateCron(cronJob.id, {
      enabled: !cronJob.enabled,
    });
    setCrons((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const triggerRun = async (id) => {
    setRunning((prev) => ({ ...prev, [id]: true }));
    try {
      await api.runCron(id);
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => setRunning((prev) => ({ ...prev, [id]: false })), 3000);
  };

  const deleteCron = async (id) => {
    await api.deleteCron(id);
    setCrons((prev) => prev.filter((c) => c.id !== id));
  };

  /**
   * Convert the form's minutes field into the API's `timeout_ms` contract:
   *   - blank → null (use server default)
   *   - positive integer → minutes * 60_000
   * Returns `undefined` when the field is invalid so the caller can surface an
   * error instead of silently wiping the existing override.
   */
  const minutesToTimeoutMs = (minutes) => {
    if (minutes === '' || minutes === null || minutes === undefined) return null;
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.round(n * 60_000);
  };

  const createCron = async (e) => {
    e.preventDefault();
    const timeout_ms = minutesToTimeoutMs(form.timeoutMinutes);
    if (timeout_ms === undefined) {
      showToast?.('Timeout must be a positive number of minutes.', 'error');
      return;
    }
    const payload = { ...form, timeout_ms };
    delete payload.timeoutMinutes;
    // The API's normalizeModel treats '' as null (= "use engine default").
    // Passing the empty string explicitly keeps the round-trip stable: the
    // row stores NULL, the dropdown stays on "Default" when the cron is
    // re-opened for editing.
    const created = await api.createCron(payload);
    setCrons((prev) => [...prev, created]);
    setShowForm(false);
    setForm({
      name: '',
      schedule: '*/30 * * * *',
      prompt: '',
      cwd: defaultCwd,
      project_id: projects[0]?.id || '',
      enabled: true,
      timeoutMinutes: '',
      notify_on_run: false,
      model: '',
    });
  };

  const startEditing = (cronJob) => {
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
    });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    const timeout_ms = minutesToTimeoutMs(editForm.timeoutMinutes);
    if (timeout_ms === undefined) {
      showToast?.('Timeout must be a positive number of minutes.', 'error');
      return;
    }
    const payload = { ...editForm, timeout_ms };
    delete payload.timeoutMinutes;
    const updated = await api.updateCron(editingId, payload);
    setCrons((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
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
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Name"
            required
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />
          <CronSchedulePicker
            value={form.schedule}
            onChange={(schedule) => setForm({ ...form, schedule })}
          />
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder="Prompt"
            required
            rows={3}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
          />
          {projects.length > 0 && (
            <select
              value={form.project_id}
              onChange={(e) => {
                const proj = projects.find((p) => p.id === e.target.value);
                setForm({ ...form, project_id: e.target.value, cwd: proj?.cwd || form.cwd });
              }}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <input
            value={form.cwd}
            onChange={(e) => setForm({ ...form, cwd: e.target.value })}
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
              onChange={(e) => setForm({ ...form, timeoutMinutes: e.target.value })}
              placeholder="e.g. 30"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
            />
          </div>
          {modelOptions.length > 0 && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Model{' '}
                <span className="text-gray-600">
                  — blank uses the engine default
                  {defaultModel ? ` (${defaultModel})` : ''}
                </span>
              </label>
              <select
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
              >
                <option value="">Default{defaultModel ? ` (${defaultModel})` : ''}</option>
                {modelOptions.map((m) => (
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
              onChange={(e) => setForm({ ...form, notify_on_run: e.target.checked })}
              className="mt-0.5 accent-blue-500"
            />
            <span className="text-xs text-gray-300">
              Send a push notification on every run
              <span className="block text-gray-500">
                Off by default — thread/heartbeat logs are written either way.
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
        {crons.map((cronJob) => (
          <div key={cronJob.id} className="bg-gray-800 rounded-xl p-4">
            {editingId === cronJob.id ? (
              <form onSubmit={saveEdit} className="space-y-3">
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  placeholder="Name"
                  required
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                />
                <CronSchedulePicker
                  value={editForm.schedule}
                  onChange={(schedule) => setEditForm({ ...editForm, schedule })}
                />
                <textarea
                  value={editForm.prompt}
                  onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
                  placeholder="Prompt"
                  required
                  rows={3}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
                />
                {projects.length > 0 && (
                  <select
                    value={editForm.project_id}
                    onChange={(e) => {
                      const proj = projects.find((p) => p.id === e.target.value);
                      setEditForm({
                        ...editForm,
                        project_id: e.target.value,
                        cwd: proj?.cwd || editForm.cwd,
                      });
                    }}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  value={editForm.cwd}
                  onChange={(e) => setEditForm({ ...editForm, cwd: e.target.value })}
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
                    onChange={(e) => setEditForm({ ...editForm, timeoutMinutes: e.target.value })}
                    placeholder="e.g. 30"
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                  />
                </div>
                {modelOptions.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Model{' '}
                      <span className="text-gray-600">
                        — blank uses the engine default
                        {defaultModel ? ` (${defaultModel})` : ''}
                      </span>
                    </label>
                    <select
                      value={editForm.model ?? ''}
                      onChange={(e) => setEditForm({ ...editForm, model: e.target.value })}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                    >
                      <option value="">Default{defaultModel ? ` (${defaultModel})` : ''}</option>
                      {modelOptions.map((m) => (
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
                    onChange={(e) => setEditForm({ ...editForm, notify_on_run: e.target.checked })}
                    className="mt-0.5 accent-blue-500"
                  />
                  <span className="text-xs text-gray-300">
                    Send a push notification on every run
                    <span className="block text-gray-500">
                      Off by default — thread/heartbeat logs are written either way.
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
                    {cronJob.enabled &&
                      cronJob.next_run_at &&
                      (() => {
                        const { label, overdue } = relativeFuture(cronJob.next_run_at);
                        return (
                          <span
                            title={`Next run: ${new Date(cronJob.next_run_at).toLocaleString()}`}
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
                    {cronJob.model ? <> · Model: {cronJob.model}</> : null}
                    {cronJob.notify_on_run ? <> · 🔔 Notifies on run</> : null}
                    {cronJob.last_run && <> · Last: {relativeTime(cronJob.last_run)}</>}
                  </p>
                  {/* Recent runs — clickable status dots */}
                  {cronLogs[cronJob.id]?.length > 0 && (
                    <div className="mt-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-500 mr-0.5">Runs:</span>
                        {cronLogs[cronJob.id].map((log) => {
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
                              title={`${log.status} — ${new Date(log.timestamp).toLocaleString()}${durationLabel ? ` (${durationLabel})` : ''}`}
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
                      {cronLogs[cronJob.id].map((log) => {
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
                                  {new Date(log.timestamp).toLocaleString()}
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
                    disabled={running[cronJob.id]}
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
                    className="text-xs text-gray-500 hover:text-blue-400 px-2 py-2 sm:px-1 sm:py-1 transition-colors min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => deleteCron(cronJob.id)}
                    className="text-xs text-gray-500 hover:text-red-400 px-2 py-2 sm:px-1 sm:py-1 transition-colors min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
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

/* WebhookSection removed — webhooks are now auto-managed when saving project repos */

// ─── Slack Setup Wizard ───────────────────────────────────────────────────────

const WIZARD_STEPS = [
  { id: 'intro', label: 'Create App' },
  { id: 'tokens', label: 'Get Tokens' },
  { id: 'configure', label: 'Configure' },
  { id: 'test', label: 'Test & Save' },
];

function SlackSetupWizard({ agents, onSaved, onCancel, existingBot }) {
  const [step, setStep] = useState(existingBot ? 2 : 0);
  const [form, setForm] = useState({
    name: existingBot?.name || '',
    bot_token: existingBot ? '****masked****' : '',
    app_token: existingBot ? '****masked****' : '',
    agent_id: existingBot?.agent_id || agents[0]?.id || '',
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // null | { ok, team, user, error }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Masked-token sentinel: the API returns either the literal '****masked****'
  // (legacy callers) or a partially-masked form like 'xoxb-****…-ab12cd' that
  // begins with the prefix + leading '****'. The leading '****' check is
  // intentional — real Slack tokens never start with '****', so it's a safe
  // sentinel for "user did not edit this token field; preserve the stored
  // value." Don't soften this to .includes('****') — that would also match
  // legitimate tokens that happen to contain the substring.
  const isMasked = (v) => v === '****masked****' || v?.startsWith('****');

  const handleChange = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    if (field === 'bot_token' || field === 'app_token') setTestResult(null);
  };

  const handleTestTokens = async () => {
    if (!form.bot_token || isMasked(form.bot_token)) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testSlackTokens({ bot_token: form.bot_token });
      setTestResult(result);
    } catch (err) {
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
    } catch (err) {
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
            {agents.map((a) => (
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
        {WIZARD_STEPS.map((s, i) => (
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
      {stepContent[step]}
    </div>
  );
}

// ─── Per-bot channel map editor ───────────────────────────────────────────────

function ChannelMapEditor({ bot, agents, onSaved }) {
  const [channelMap, setChannelMap] = useState(
    typeof bot.channel_map === 'object' ? bot.channel_map : {},
  );
  const [newChannel, setNewChannel] = useState({ id: '', label: '', agentId: bot.agent_id });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleAdd = () => {
    if (!newChannel.id.trim()) return;
    setChannelMap((prev) => ({
      ...prev,
      [newChannel.id.trim()]: {
        label: newChannel.label.trim() || newChannel.id.trim(),
        agentId: newChannel.agentId || bot.agent_id,
      },
    }));
    setNewChannel({ id: '', label: '', agentId: bot.agent_id });
  };

  const handleRemove = (chId) => {
    setChannelMap((prev) => {
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
    } catch (err) {
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
          {Object.entries(channelMap).map(([chId, cfg]) => (
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
          onChange={(e) => setNewChannel((p) => ({ ...p, id: e.target.value }))}
          placeholder="Channel ID (e.g. C0123456)"
          className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-blue-500 w-44"
        />
        <input
          type="text"
          value={newChannel.label}
          onChange={(e) => setNewChannel((p) => ({ ...p, label: e.target.value }))}
          placeholder="#channel-name"
          className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 w-36"
        />
        <select
          value={newChannel.agentId}
          onChange={(e) => setNewChannel((p) => ({ ...p, agentId: e.target.value }))}
          className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500"
        >
          {agents.map((a) => (
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
  const [bots, setBots] = useState([]);
  const [liveStatus, setLiveStatus] = useState([]); // live connection state from /status
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [editingBot, setEditingBot] = useState(null);
  const [expandedBot, setExpandedBot] = useState(null);
  const [expandedChannels, setExpandedChannels] = useState(null);
  const [selectedMsgAgent, setSelectedMsgAgent] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [restarting, setRestarting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [agents, setAgents] = useState([]);

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
    } catch (err) {
      console.error('Failed to load Slack data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (agentId) => {
    try {
      const data = await api.getSlackMessages(agentId, 20);
      setMessages(data);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  };

  useEffect(() => {
    loadAll();
    loadMessages();
  }, []);

  // Merge live status into bot list for connection display
  const botsWithStatus = bots.map((bot) => {
    const live = liveStatus.find((s) => s.name === bot.name);
    return {
      ...bot,
      connected: live?.connected ?? false,
      lastMessage: live?.lastMessage ?? null,
      liveError: live?.error ?? null,
    };
  });

  // Also include file-backed bots that appear in status but not in DB
  const dbNames = new Set(bots.map((b) => b.name));
  const fileOnlyBots = liveStatus
    .filter((s) => !dbNames.has(s.name))
    .map((s) => ({
      ...s,
      id: null,
      bot_token: null,
      app_token: null,
      channel_map: {},
      enabled: 1,
      _fileOnly: true,
    }));

  const allBots = [...botsWithStatus, ...fileOnlyBots];

  const handleDelete = async (id) => {
    if (!id || !window.confirm('Delete this Slack bot? It will stop receiving messages.')) return;
    setDeletingId(id);
    try {
      await api.deleteSlackBot(id);
      await loadAll();
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggle = async (id) => {
    try {
      await api.toggleSlackBot(id);
      await loadAll();
    } catch (err) {
      console.error('Toggle failed:', err);
    }
  };

  const handleTestConnection = async (bot) => {
    if (!bot.id) return;
    setTestingId(bot.id);
    setTestResults((prev) => ({ ...prev, [bot.id]: null }));
    try {
      const result = await api.testSlackBotConnection(bot.id);
      setTestResults((prev) => ({ ...prev, [bot.id]: result }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [bot.id]: { ok: false, error: err.message } }));
    } finally {
      setTestingId(null);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartSlack();
      await loadAll();
    } catch (err) {
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
          {allBots.map((bot) => {
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
                          messages.map((msg) => (
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
function McpServersSection({ agentId }) {
  const [servers, setServers] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingServer, setEditingServer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
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
      .then((data) => {
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

  const parseArgs = (argsStr) => {
    if (!argsStr.trim()) return [];
    try {
      const parsed = JSON.parse(argsStr);
      return Array.isArray(parsed) ? parsed : [argsStr];
    } catch {
      return argsStr.split(/\s+/).filter(Boolean);
    }
  };

  const parseEnv = (envStr) => {
    if (!envStr.trim()) return {};
    try {
      return JSON.parse(envStr);
    } catch {
      // Parse KEY=VALUE format, one per line
      const env = {};
      for (const line of envStr.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        env[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
      }
      return env;
    }
  };

  const buildServerConfig = (form) => {
    const config = {};
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

  const handleAddServer = async (e) => {
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
    } catch (err) {
      console.error('Failed to add MCP server:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateServer = async (name, form) => {
    setSaving(true);
    try {
      const config = buildServerConfig(form);
      const result = await api.updateMcpServer(agentId, name, config);
      setServers(result.mcpServers || {});
      setEditingServer(null);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.error('Failed to update MCP server:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteServer = async (name) => {
    try {
      const result = await api.deleteMcpServer(agentId, name);
      setServers(result.mcpServers || {});
      setConfirmDelete(null);
      setEditingServer(null);
    } catch (err) {
      console.error('Failed to delete MCP server:', err);
    }
  };

  const serverEntries = Object.entries(servers);
  const serverCount = serverEntries.length;

  const ServerForm = ({ form, setForm, onSubmit, onCancel, submitLabel, serverName }) => (
    <form onSubmit={onSubmit} className="bg-gray-900/50 rounded-lg p-3 space-y-3">
      {!serverName && (
        <div>
          <label className={labelClass}>Server Name</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
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
              onChange={(e) => setForm({ ...form, command: e.target.value })}
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
              onChange={(e) => setForm({ ...form, args: e.target.value })}
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
            onChange={(e) => setForm({ ...form, url: e.target.value })}
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
          onChange={(e) => setForm({ ...form, env: e.target.value })}
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
          onChange={(e) => setForm({ ...form, cwd: e.target.value })}
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
          {serverEntries.map(([name, config]) => {
            const isEditing = editingServer === name;
            const isStdio = !!config.command;

            if (isEditing) {
              const editForm = {
                name,
                type: isStdio ? 'stdio' : 'sse',
                command: config.command || '',
                args: config.args
                  ? config.args.some((a) => a.includes(' '))
                    ? JSON.stringify(config.args)
                    : config.args.join(' ')
                  : '',
                url: config.url || '',
                env: config.env
                  ? Object.entries(config.env)
                      .map(([k, v]) => `${k}=${v}`)
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
                  onSave={(form) => handleUpdateServer(name, form)}
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
}) {
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
        onSubmit={(e) => {
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

function AgentConfigSection({ agents: initialAgents, projects = [], onAgentsChange, showToast }) {
  const [agents, setAgents] = useState(initialAgents);
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState({});
  const [saveStatus, setSaveStatus] = useState({});
  const [edits, setEdits] = useState({});
  const [showNew, setShowNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [modelConfig, setModelConfig] = useState(null);
  const [bulkEngine, setBulkEngine] = useState('claude-code');
  const [bulkModel, setBulkModel] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [newForm, setNewForm] = useState({
    id: '',
    name: '',
    engine: 'claude-code',
    model: '',
    projectId: projects[0]?.id || '',
    color: '#6b7280',
    avatar: '',
    systemPrompt: '',
    heartbeat: { enabled: false, interval: '', prompt: '' },
  });

  useEffect(() => {
    setAgents(initialAgents);
  }, [initialAgents]);

  useEffect(() => {
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => {});
  }, []);

  const getModelsForEngine = (engine) => {
    if (!modelConfig) return [];
    return modelConfig.engineValidModels[engine] || [];
  };

  const getDefaultModel = (engine) => {
    if (!modelConfig) return '';
    return modelConfig.engineDefaultModels[engine] || modelConfig.defaultModel || '';
  };

  /** Engines come only from `GET /api/config/models` so new server engines appear automatically. */
  const engineChoices = useMemo(() => {
    if (!modelConfig) return [];
    return Object.keys(modelConfig.engineValidModels).filter(
      (e) => (modelConfig.engineValidModels[e]?.length ?? 0) > 0,
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
    if (!modelConfig || agents.length === 0) return;
    const effectiveModel = bulkModel || getDefaultModel(bulkEngine);
    if (
      !window.confirm(
        `Set all ${agents.length} agents to engine "${bulkEngine}" with model "${effectiveModel}"?`,
      )
    ) {
      return;
    }
    setBulkSaving(true);
    try {
      await api.bulkSetAllAgentsEngine({ engine: bulkEngine, model: effectiveModel });
      const list = await api.getAgents();
      setAgents(list);
      setEdits({});
      if (onAgentsChange) onAgentsChange();
      showToast?.(`Updated ${agents.length} agent(s) to ${bulkEngine}.`, 'success');
    } catch (e) {
      console.error('Bulk agent engine update failed:', e);
      const msg = e instanceof Error ? e.message : 'Bulk engine update failed.';
      showToast?.(msg, 'error');
    } finally {
      setBulkSaving(false);
    }
  };

  const getEdit = (agentId) => {
    if (edits[agentId]) return edits[agentId];
    const agent = agents.find((a) => a.id === agentId);
    return agent ? { ...agent } : {};
  };

  const setEdit = (agentId, field, value) => {
    setEdits((prev) => ({
      ...prev,
      [agentId]: { ...(prev[agentId] || agents.find((a) => a.id === agentId)), [field]: value },
    }));
  };

  const setHeartbeatEdit = (agentId, field, value) => {
    const current = getEdit(agentId);
    const hb = {
      ...(current.heartbeat || { enabled: false, interval: '', prompt: '' }),
      [field]: value,
    };
    setEdit(agentId, 'heartbeat', hb);
  };

  const handleSave = async (agentId) => {
    setSaving((prev) => ({ ...prev, [agentId]: true }));
    try {
      const data = edits[agentId];
      if (!data) return;
      const { id: _id, lastActivity: _lastActivity, lastMessage: _lastMessage, ...payload } = data;
      const updated = await api.updateAgent(agentId, payload);
      setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, ...updated } : a)));
      setEdits((prev) => {
        const n = { ...prev };
        delete n[agentId];
        return n;
      });
      setSaveStatus((prev) => ({ ...prev, [agentId]: 'saved' }));
      if (onAgentsChange) onAgentsChange();
      setTimeout(() => setSaveStatus((prev) => ({ ...prev, [agentId]: null })), 2000);
    } catch (_e) {
      setSaveStatus((prev) => ({ ...prev, [agentId]: 'error' }));
      setTimeout(() => setSaveStatus((prev) => ({ ...prev, [agentId]: null })), 3000);
    } finally {
      setSaving((prev) => ({ ...prev, [agentId]: false }));
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      const created = await api.createAgent(newForm);
      setAgents((prev) => [...prev, created]);
      setShowNew(false);
      setNewForm({
        id: '',
        name: '',
        engine: 'claude-code',
        model: '',
        projectId: projects[0]?.id || '',
        color: '#6b7280',
        avatar: '',
        systemPrompt: '',
        heartbeat: { enabled: false, interval: '', prompt: '' },
      });
      if (onAgentsChange) onAgentsChange();
    } catch (e) {
      console.error('Failed to create agent:', e);
    }
  };

  const handleToggleActive = async (agentId, currentlyActive) => {
    try {
      const updated = await api.updateAgent(agentId, { active: !currentlyActive });
      setAgents((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, active: updated.active } : a)),
      );
      if (onAgentsChange) onAgentsChange();
    } catch (e) {
      console.error('Failed to toggle agent active state:', e);
    }
  };

  const handleDelete = async (agentId) => {
    try {
      await api.deleteAgent(agentId);
      setAgents((prev) => prev.filter((a) => a.id !== agentId));
      setConfirmDelete(null);
      if (onAgentsChange) onAgentsChange();
    } catch (e) {
      console.error('Failed to delete agent:', e);
    }
  };

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const [projectCommands, setProjectCommands] = useState(() => {
    const map = {};
    projects.forEach((p) => {
      map[p.id] = {
        install: p.commands?.install || '',
        build: p.commands?.build || '',
        test: p.commands?.test || '',
        lint: p.commands?.lint || '',
      };
    });
    return map;
  });
  const [projectPreCommitInput, setProjectPreCommitInput] = useState(() => {
    const map = {};
    projects.forEach((p) => {
      map[p.id] =
        Array.isArray(p.preCommitCommands) && p.preCommitCommands.length
          ? p.preCommitCommands.join('\n')
          : '';
    });
    return map;
  });

  const [projectCheckHealInput, setProjectCheckHealInput] = useState(() => {
    const map = {};
    projects.forEach((p) => {
      map[p.id] =
        Array.isArray(p.checkHealCommands) && p.checkHealCommands.length
          ? p.checkHealCommands.join('\n')
          : '';
    });
    return map;
  });

  const [projectCheckHealMaxRounds, setProjectCheckHealMaxRounds] = useState(() => {
    const map = {};
    projects.forEach((p) => {
      const n = p.checkHealMaxRounds;
      map[p.id] = typeof n === 'number' && n >= 1 && n <= 5 ? String(n) : '2';
    });
    return map;
  });

  const [projectOrchestrationFields, setProjectOrchestrationFields] = useState(() => {
    const map = {};
    projects.forEach((p) => {
      map[p.id] = orchestrationFieldsFromProject(p.orchestrationBudgets);
    });
    return map;
  });

  const preCommitServerSnap = useMemo(
    () =>
      JSON.stringify(Object.fromEntries(projects.map((p) => [p.id, p.preCommitCommands ?? []]))),
    [projects],
  );

  const checkHealServerSnap = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(
          projects.map((p) => [
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
        Object.fromEntries(projects.map((p) => [p.id, p.orchestrationBudgets ?? null])),
      ),
    [projects],
  );

  useEffect(() => {
    setProjectPreCommitInput(() =>
      Object.fromEntries(
        projects.map((p) => {
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
        projects.map((p) => {
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
        projects.map((p) => {
          const n = p.checkHealMaxRounds;
          return [p.id, typeof n === 'number' && n >= 1 && n <= 5 ? String(n) : '2'];
        }),
      ),
    );
  }, [checkHealServerSnap]);

  useEffect(() => {
    setProjectOrchestrationFields(() =>
      Object.fromEntries(
        projects.map((p) => [p.id, orchestrationFieldsFromProject(p.orchestrationBudgets)]),
      ),
    );
  }, [orchestrationServerSnap]);

  const browserDefaultsServerSnap = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(
          projects.map((p) => [
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

  const [projectBrowserFields, setProjectBrowserFields] = useState({});
  useEffect(() => {
    setProjectBrowserFields(() =>
      Object.fromEntries(
        projects.map((p) => [
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

  const [projectCommandsSaved, setProjectCommandsSaved] = useState({});
  const [expandedProject, setExpandedProject] = useState(null);

  const saveProjectCommands = async (projectId) => {
    try {
      const cmds = projectCommands[projectId] || {};
      const preCommitLines = (projectPreCommitInput[projectId] || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const checkHealLines = (projectCheckHealInput[projectId] || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const roundsRaw = String(projectCheckHealMaxRounds[projectId] ?? '2').trim();
      const roundsParsed = parseInt(roundsRaw, 10);
      const checkHealMaxRounds =
        Number.isFinite(roundsParsed) && roundsParsed >= 1 && roundsParsed <= 5 ? roundsParsed : 2;
      const obFields = projectOrchestrationFields[projectId] || {};
      const hasObTyping = ORCHESTRATION_FIELD_META.some(
        ({ key }) => String(obFields[key] ?? '').trim() !== '',
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
      let payload = basePayload;
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
      const projRow = projects.find((x) => x.id === projectId);
      const bf = projectBrowserFields[projectId] || {
        defaultOn: true,
        viewportW: '',
        viewportH: '',
        timeoutMs: '',
      };
      const browserPayload = {};
      if (bf.defaultOn) {
        browserPayload.browserToolsDefaultEnabled =
          projRow?.browserToolsDefaultEnabled === false ? true : null;
      } else {
        browserPayload.browserToolsDefaultEnabled = false;
      }
      const mergeOptDim = (raw, prevVal, field, min, max, label) => {
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
      setProjectCommandsSaved((prev) => ({ ...prev, [projectId]: true }));
      setTimeout(() => setProjectCommandsSaved((prev) => ({ ...prev, [projectId]: false })), 2000);
    } catch {}
  };

  return (
    <div>
      {/* Project-level settings */}
      {projects.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">Project Settings</h3>
          <div className="space-y-2">
            {projects.map((p) => (
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
                      {['install', 'build', 'test', 'lint'].map((cmd) => (
                        <div key={cmd} className="flex items-center gap-2">
                          <label className="text-xs text-gray-400 flex-shrink-0 w-28 capitalize">
                            {cmd}:
                          </label>
                          <input
                            value={projectCommands[p.id]?.[cmd] || ''}
                            onChange={(e) =>
                              setProjectCommands((prev) => ({
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
                          onChange={(e) =>
                            setProjectPreCommitInput((prev) => ({
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
                          onChange={(e) =>
                            setProjectCheckHealInput((prev) => ({
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
                            onChange={(e) =>
                              setProjectCheckHealMaxRounds((prev) => ({
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
                          {ORCHESTRATION_FIELD_META.map(({ key, label, hint }) => (
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
                                onChange={(e) =>
                                  setProjectOrchestrationFields((prev) => ({
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
                              setProjectBrowserFields((prev) => {
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
                              onChange={(e) =>
                                setProjectBrowserFields((prev) => ({
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
                              onChange={(e) =>
                                setProjectBrowserFields((prev) => ({
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
                              onChange={(e) =>
                                setProjectBrowserFields((prev) => ({
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
            Switch every agent at once (for example when moving off a provider or subscription). The
            server validates the model against the selected engine.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label className={labelClass}>Engine (all agents)</label>
              <select
                value={bulkEngine}
                onChange={(e) => {
                  setBulkEngine(e.target.value);
                  setBulkModel('');
                }}
                className={inputClass}
              >
                {engineChoices.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Model</label>
              <select
                value={bulkModel || getDefaultModel(bulkEngine)}
                onChange={(e) => setBulkModel(e.target.value)}
                className={inputClass}
              >
                {getModelsForEngine(bulkEngine).map((m) => (
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
                onChange={(e) => setNewForm({ ...newForm, id: e.target.value })}
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
                onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
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
                onChange={(e) => setNewForm({ ...newForm, engine: e.target.value, model: '' })}
                className={inputClass}
              >
                {engineChoices.map((e) => (
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
                onChange={(e) => setNewForm({ ...newForm, model: e.target.value })}
                className={inputClass}
              >
                {getModelsForEngine(newForm.engine).map((m) => (
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
                  onChange={(e) => setNewForm({ ...newForm, color: e.target.value })}
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
                  onChange={async (e) => {
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
                    } catch (err) {
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
              onSelect={(iconName) => setNewForm({ ...newForm, avatar: buildIconAvatar(iconName) })}
            />
          </div>
          <div>
            <label className={labelClass}>Project</label>
            <select
              value={newForm.projectId}
              onChange={(e) => setNewForm({ ...newForm, projectId: e.target.value })}
              className={inputClass}
              required
            >
              <option value="" disabled>
                Select a project...
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.cwd}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>System Prompt</label>
            <textarea
              value={newForm.systemPrompt}
              onChange={(e) => setNewForm({ ...newForm, systemPrompt: e.target.value })}
              rows={3}
              className={inputClass + ' resize-none'}
            />
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
          const leads = agents.filter((a) => a.role === 'lead');
          const subs = agents.filter((a) => a.role === 'sub');
          const standalone = agents.filter((a) => a.role !== 'lead' && a.role !== 'sub');
          const subsByParent = {};
          for (const s of subs) {
            const pid = s.parentAgentId;
            if (!subsByParent[pid]) subsByParent[pid] = [];
            subsByParent[pid].push(s);
          }
          // Build ordered list: lead, then its subs, then next lead, etc., then standalone
          const ordered = [];
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
            if (!leads.find((l) => l.id === s.parentAgentId)) {
              ordered.push({ agent: s, indent: 0, isSub: true });
            }
          }
          return ordered;
        })().map(({ agent, indent, isLead, isSub }) => {
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
                    onClick={(e) => {
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

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className={labelClass}>Name</label>
                      <input
                        value={edit.name || ''}
                        onChange={(e) => setEdit(agent.id, 'name', e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Engine</label>
                      <select
                        value={edit.engine || 'claude-code'}
                        onChange={(e) => {
                          setEdit(agent.id, 'engine', e.target.value);
                          setEdit(agent.id, 'model', getDefaultModel(e.target.value));
                        }}
                        className={inputClass}
                      >
                        {engineChoices.map((e) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>Model</label>
                      <select
                        value={
                          edit.model ||
                          agent.model ||
                          getDefaultModel(edit.engine || agent.engine || 'claude-code')
                        }
                        onChange={(e) => setEdit(agent.id, 'model', e.target.value)}
                        className={inputClass}
                      >
                        {getModelsForEngine(edit.engine || agent.engine || 'claude-code').map(
                          (m) => (
                            <option key={m} value={m}>
                              {m}
                              {m === getDefaultModel(edit.engine || agent.engine || 'claude-code')
                                ? ' (default)'
                                : ''}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                  </div>

                  <MyAgentEngineOverrideInline
                    agentId={agent.id}
                    agentEngine={agent.engine || 'claude-code'}
                    modelConfig={modelConfig}
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Color</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={edit.color || '#6b7280'}
                          onChange={(e) => setEdit(agent.id, 'color', e.target.value)}
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
                            onChange={async (e) => {
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
                              } catch (err) {
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
                        onSelect={(iconName) =>
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
                      onChange={(e) => setEdit(agent.id, 'systemPrompt', e.target.value)}
                      rows={4}
                      className={inputClass + ' resize-none'}
                    />
                  </div>

                  <div className="border-t border-gray-700 pt-3">
                    {(() => {
                      const projRow = projects.find((pr) => pr.id === agent.projectId);
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
                                  onChange={(e) => {
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
                                  onChange={(e) => {
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
                                  onChange={(e) => {
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

                  <div>
                    <label className={labelClass}>
                      PR Reviewer (GitHub username — overrides project default)
                    </label>
                    <input
                      value={edit.reviewer || ''}
                      onChange={(e) => setEdit(agent.id, 'reviewer', e.target.value)}
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
                          onChange={(e) => setHeartbeatEdit(agent.id, 'interval', e.target.value)}
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
                          onChange={(e) => setHeartbeatEdit(agent.id, 'prompt', e.target.value)}
                          rows={3}
                          className={inputClass + ' resize-none'}
                        />
                      </div>
                      {(modelConfig?.engineValidModels?.['claude-code'] || []).length > 0 && (
                        <div>
                          <label className={labelClass}>Heartbeat Model</label>
                          <select
                            value={edit.heartbeat?.model || ''}
                            onChange={(e) => setHeartbeatEdit(agent.id, 'model', e.target.value)}
                            className={inputClass}
                          >
                            <option value="">CLI default</option>
                            {(modelConfig.engineValidModels['claude-code'] || []).map((m) => (
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
  const [usage, setUsage] = useState(null);
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
  const fmtCost = (c) => `$${Number(c || 0).toFixed(2)}`;
  const fmtDuration = (ms) => {
    const s = (ms || 0) / 1000;
    if (s < 60) return `${s.toFixed(0)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };

  // Find max daily cost for bar chart scaling
  const maxDayCost = Math.max(...(byDay || []).map((d) => d.cost), 0.01);

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
                {byAgent.map((row) => (
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
              {byDay.map((day) => {
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
              {recentSessions.map((s) => (
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

function formatBytes(n) {
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
export function InstanceBackupSection({ showToast }) {
  const [manifest, setManifest] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(() => new Set(['db.slim', 'config']));
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getInstanceBackupManifest()
      .then((data) => {
        if (cancelled) return;
        setManifest(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err.message || String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id) => {
    setSelected((prev) => {
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
    const next = new Set(manifest.items.map((i) => i.id));
    // Default to slim when bulk-selecting.
    next.delete('db.full');
    setSelected(next);
  };

  const clearAll = () => setSelected(new Set());

  const totalBytes = useMemo(() => {
    if (!manifest) return 0;
    return manifest.items
      .filter((i) => selected.has(i.id))
      .reduce((acc, i) => acc + (i.estimatedBytes || 0), 0);
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
    } catch (err) {
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
            {manifest.items.map((item) => {
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

function ConfigBackupSection({ projects = [], onAgentsChange }) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);
  const [preview, setPreview] = useState(null);
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
      const proj = projects.find((p) => p.id === selectedProjectId);
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
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    setImportError(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
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
    } catch (err) {
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
        Export a project with its agents, kanban board, wiki, crons, rooms, and webhooks. Import
        creates the project on a new instance — or merge into an existing project to layer the
        export's data on top.
      </p>

      {/* Export */}
      <div className="bg-gray-800/50 rounded-lg p-4 mb-4">
        <h4 className="font-medium mb-3">Export Project</h4>
        <div className="flex items-center gap-3">
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          >
            <option value="">Select a project...</option>
            {projects.map((p) => (
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
          exists — agents and settings are overwritten; crons, rooms, wiki, and webhooks are merged.
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
                <span>Webhooks:</span>
                <span className="text-white">{preview.webhooks?.length || 0}</span>
                {preview.exportedAt && (
                  <>
                    <span>Exported:</span>
                    <span className="text-white">
                      {new Date(preview.exportedAt).toLocaleString()}
                    </span>
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
                      Overwrites agents/settings; merges crons, rooms, wiki, webhooks.
                    </span>
                  </span>
                </label>
              </div>

              {importMode === 'existing' && (
                <select
                  value={importTargetId}
                  onChange={(e) => setImportTargetId(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                >
                  <option value="">Select target project...</option>
                  {projects.map((p) => (
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
              {Object.entries(importResult.results || {}).map(([key, val]) => (
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

function ServerLogsSection({ wsRef }) {
  const [logs, setLogs] = useState([]);
  const [autoFollow, setAutoFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('all'); // 'all' | 'log' | 'warn' | 'error'
  const containerRef = useRef(null);
  const wasAtBottomRef = useRef(true);

  // Fetch initial logs
  useEffect(() => {
    api
      .getServerLogs()
      .then((data) => setLogs(data))
      .catch(() => {});
  }, []);

  // Subscribe to WS server-log events
  useEffect(() => {
    function handler(e) {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'server-log' && data.entry) {
          setLogs((prev) => {
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

  const filteredLogs = logs.filter((entry) => {
    if (levelFilter !== 'all' && entry.level !== levelFilter) return false;
    if (filter && !entry.message.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  const levelColor = (level) => {
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
          onChange={(e) => setFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 flex-1 min-w-[200px]"
        />
        <div className="flex gap-1">
          {['all', 'log', 'warn', 'error'].map((lvl) => (
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
            {filteredLogs.map((entry, i) => (
              <div key={i} className="hover:bg-gray-900/50 px-1 -mx-1 rounded">
                <span className={tsColor}>
                  {new Date(entry.ts).toLocaleTimeString('en-US', {
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
export function ToolErrorsSection({ projects }) {
  const defaultProjectId = projects?.[0]?.id || '';
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [sinceDays, setSinceDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
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

  const entries = (obj) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);

  const byType = data ? entries(data.countsByErrorType) : [];
  const byTool = data ? entries(data.countsByTool) : [];
  const maxTypeCount = Math.max(...byType.map(([, n]) => n), 1);

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
              onChange={(e) => setProjectId(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm"
            >
              {projects.map((p) => (
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
              onChange={(e) => setSinceDays(Number(e.target.value))}
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
                  {byType.map(([type, count]) => {
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
                  {byTool.map(([tool, count]) => (
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
                    {data.errors.slice(0, 50).map((e, i) => (
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
 * Settings tabs grouped into logical sections for the left sidebar.
 *
 * Grouping mirrors mental model rather than alphabetical order:
 *   - Workspace: org/account/general level config the user touches first
 *   - Agents & Auth: per-agent and per-engine credential surfaces
 *   - Automation: heartbeats, crons, Slack
 *   - Operations: observability & infra-adjacent panels
 */
const SETTINGS_GROUPS = [
  {
    id: 'workspace',
    label: 'Workspace',
    tabs: [
      { id: 'general', iconName: 'Settings', text: 'General' },
      { id: 'account', iconName: 'UserCircle', text: 'Account' },
      { id: 'orgs', iconName: 'Building2', text: 'Organizations' },
      { id: 'projects', iconName: 'FolderGit2', text: 'Projects' },
      { id: 'preview', iconName: 'Monitor', text: 'Preview' },
    ],
  },
  {
    id: 'agents-auth',
    label: 'Agents & Auth',
    tabs: [
      { id: 'agents', iconName: 'Bot', text: 'Agents' },
      // Host-wide CLI credentials (managed in ~/.agent-hub/data/config.json).
      // Per-user CLI creds live on Settings → Account, so this tab is gated
      // to Admin/Owner via `visibleSettingsGroups` below. Sole-source-of-truth
      // for the tab id is `claude-auth` (historical — predates the renaming).
      { id: 'claude-auth', iconName: 'Key', text: 'Global AI Authentication' },
      { id: 'github', iconName: 'GitBranch', text: 'GitHub' },
    ],
  },
  {
    id: 'automation',
    label: 'Automation',
    tabs: [
      { id: 'heartbeats', iconName: 'HeartPulse', text: 'Heartbeats' },
      { id: 'crons', iconName: 'Clock', text: 'Cron Jobs' },
      { id: 'slack', iconName: 'MessageSquare', text: 'Slack' },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    tabs: [
      { id: 'usage', iconName: 'BarChart3', text: 'Usage' },
      { id: 'tool-errors', iconName: 'AlertTriangle', text: 'Tool Errors' },
      { id: 'backup', iconName: 'HardDrive', text: 'Backup' },
      { id: 'logs', iconName: 'FileText', text: 'Logs' },
    ],
  },
];

const SETTINGS_ICONS = {
  Settings: SettingsIcon,
  UserCircle,
  Building2,
  Bot,
  Key,
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
};

function SettingsNavItem({ tab, active, onSelect }) {
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
}) {
  const [tab, setTab] = useState(
    initialTab === 'integrations' ? 'general' : initialTab || 'general',
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Legacy MCP location was Settings → Integrations; MCP now lives under Skills & Context → MCP.
  useEffect(() => {
    if (initialTab === 'integrations' && typeof onNavigate === 'function') {
      onNavigate('skills:mcp');
    }
  }, [initialTab, onNavigate]);

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
  // Role-gated tab visibility. The host-wide "Global AI Authentication"
  // panel writes to `~/.agent-hub/data/config.json` and only Admin/Owner
  // users have a reason to touch it — regular users manage their own
  // per-user creds on Settings → Account. Empty groups are dropped to
  // keep the sidebar layout tidy when every tab in a group is hidden.
  // The server still enforces the underlying permissions; this is a
  // UX hint only.
  const electronShell = isElectron();
  // In local-bundled mode (Electron / single-user self-host) the server
  // short-circuits auth so no JWT is written and hasRole() returns false.
  // Treat local-mode sessions as Admin-equivalent so the host-wide CLI
  // auth tab stays visible on every fresh install.
  const isAdminPlus = hasRole('Admin') || isLocalMode();
  const visibleSettingsGroups = useMemo(() => {
    return SETTINGS_GROUPS.map((group) => ({
      ...group,
      tabs: group.tabs.filter((t) => {
        if (t.id === 'orgs' && !electronShell) return false;
        if (t.id === 'claude-auth' && !isAdminPlus) return false;
        return true;
      }),
    })).filter((group) => group.tabs.length > 0);
  }, [electronShell, isAdminPlus]);

  // If a non-Admin user lands on the hidden `claude-auth` tab via a deep
  // link, send them to Account (which hosts their per-user CLI creds).
  useEffect(() => {
    if (tab === 'claude-auth' && !isAdminPlus) {
      setTab('account');
    }
  }, [tab, isAdminPlus]);

  // Find the currently active tab metadata across all groups (for mobile header).
  const activeTab = useMemo(() => {
    for (const group of visibleSettingsGroups) {
      const found = group.tabs.find((t) => t.id === tab);
      if (found) return found;
    }
    return visibleSettingsGroups[0]?.tabs[0] ?? SETTINGS_GROUPS[0].tabs[0];
  }, [tab, visibleSettingsGroups]);

  // Guard registered by the active section to block tab change when it
  // has unsaved edits. Sections call `registerGuard(fn)` where `fn()`
  // returns true (allow change) or false (block). Only the active tab
  // owns the guard; switching tabs clears it.
  const tabChangeGuardRef = useRef(null);
  const registerTabChangeGuard = useCallback((fn) => {
    tabChangeGuardRef.current = typeof fn === 'function' ? fn : null;
  }, []);

  const handleSelectTab = (id) => {
    if (id === tab) {
      setMobileNavOpen(false);
      return;
    }
    const guard = tabChangeGuardRef.current;
    if (typeof guard === 'function' && !guard()) return;
    tabChangeGuardRef.current = null;
    setTab(id);
    setMobileNavOpen(false);
  };

  const sidebar = (
    <nav aria-label="Settings sections" className="space-y-5">
      {visibleSettingsGroups.map((group) => (
        <div key={group.id}>
          <p className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold px-3 mb-1.5">
            {group.label}
          </p>
          <div className="space-y-0.5">
            {group.tabs.map((t) => (
              <SettingsNavItem
                key={t.id}
                tab={t}
                active={tab === t.id}
                onSelect={handleSelectTab}
              />
            ))}
          </div>
        </div>
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
              {tab === 'claude-auth' && isAdminPlus && (
                <div className="space-y-10">
                  <ClaudeAuthSection />
                  <div className="h-px bg-gray-800" />
                  <GeminiAuthSection />
                  <div className="h-px bg-gray-800" />
                  <CursorAuthSection />
                  <div className="h-px bg-gray-800" />
                  <CodexAuthSection />
                </div>
              )}
              {tab === 'github' && <GitHubSection onProjectsChange={onAgentsChange} />}
              {tab === 'projects' && (
                <ProjectsSection
                  projects={projects}
                  onProjectsChange={onAgentsChange}
                  showToast={showToast}
                  initialExpandedProjectId={initialGithubExpandedProjectId || null}
                />
              )}
              {tab === 'orgs' && electronShell && <OrganizationsSection />}
              {tab === 'preview' && (
                <PreviewSection
                  projects={projects}
                  onProjectsChange={onAgentsChange}
                  registerGuard={registerTabChangeGuard}
                  onOpenSession={({ sessionId, agentId }) =>
                    onOpenSession?.({ sessionId, agentId })
                  }
                />
              )}
              {tab === 'heartbeats' && (
                <HeartbeatSection onNavigate={onNavigate} showToast={showToast} />
              )}
              {tab === 'crons' && (
                <CronSection projects={projects} onNavigate={onNavigate} showToast={showToast} />
              )}

              {tab === 'slack' && <SlackSection />}
              {tab === 'agents' && (
                <AgentConfigSection
                  agents={agents}
                  projects={projects}
                  onAgentsChange={onAgentsChange}
                  showToast={showToast}
                />
              )}
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
