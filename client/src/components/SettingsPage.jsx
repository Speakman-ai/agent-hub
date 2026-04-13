import { useState, useEffect } from 'react';
import { api } from '../utils/api.js';
import { relativeTime, relativeFuture } from '../utils/time.js';
import humanCron from '../../../shared/utils/humanCron.js';
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
  HardDrive,
  Monitor,
  Cloud,
  Loader2,
  Plug,
  Play,
  Pencil,
  RefreshCw,
  User,
  Plus,
  Trash2,
  ArrowRightLeft,
  GitBranch,
} from 'lucide-react';

function OrganizationsSection() {
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

                  <div>
                    <label className={labelClass}>Connection Mode</label>
                    {renderModeToggle(editForm.mode, (mode) => {
                      setEditForm((prev) => ({ ...prev, mode }));
                      setTestResult(null);
                    })}
                  </div>

                  {editForm.mode === 'remote' && renderRemoteFields(editForm, setEditForm)}

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

          <div>
            <label className={labelClass}>Connection Mode</label>
            {renderModeToggle(newForm.mode, (mode) => {
              setNewForm((prev) => ({ ...prev, mode }));
              setTestResult(null);
            })}
          </div>

          {newForm.mode === 'remote' && renderRemoteFields(newForm, setNewForm)}

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

function GitHubAppSection({ config, setConfig }) {
  const [appStatus, setAppStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showBotFallback, setShowBotFallback] = useState(false);

  useEffect(() => {
    api
      .get('/api/github-app/status')
      .then(setAppStatus)
      .catch(() => {});
  }, []);

  // Handle return from GitHub App auto-setup flow
  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/[?&]githubApp=([^&]*)/);
    if (!match) return;
    const status = match[1];

    // Clean up URL by removing githubApp (and optional message) params
    const cleanHash = hash.replace(/[?&]githubApp=[^&]*(&message=[^&]*)?/, '').replace(/\?$/, '');
    window.history.replaceState(null, '', window.location.pathname + cleanHash);

    if (status === 'ready' || status === 'no-install' || status === 'created') {
      // Refresh status from server to reflect the new app/installation
      api
        .get('/api/github-app/status')
        .then(setAppStatus)
        .catch(() => {});
    }
    if (status === 'error') {
      const msgMatch = hash.match(/message=([^&]*)/);
      if (msgMatch) alert(decodeURIComponent(msgMatch[1]));
    }
  }, []);

  const handleCreateApp = async () => {
    try {
      const data = await api.get('/api/github-app/manifest');
      // Create a form and submit it to GitHub (manifest flow requires a POST)
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = `${data.githubUrl}`;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = JSON.stringify(data.manifest);
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      alert(err.message || 'Failed to start GitHub App creation');
    }
  };

  const handleRefreshInstallation = async () => {
    setRefreshing(true);
    try {
      const result = await api.post('/api/github-app/refresh-installation');
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
      setRefreshing(false);
    }
  };

  const handleRemoveApp = async () => {
    if (!confirm('Remove the GitHub App configuration? You can re-create it anytime.')) return;
    try {
      await api.del('/api/github-app');
      setAppStatus(null);
      setConfig((prev) => ({ ...prev, githubApp: null }));
    } catch {
      /* ignore */
    }
  };

  const handleInstallApp = async () => {
    try {
      const data = await api.get('/api/github-app/install-url');
      window.open(data.installUrl, '_blank');
    } catch (err) {
      alert(err.message || 'Failed to get install URL');
    }
  };

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-4">
      <h4 className="text-sm font-medium text-gray-300">PR Review Authentication</h4>
      <p className="text-xs text-gray-500">
        GitHub prevents the same account from reviewing its own PRs. Set up a GitHub App
        (recommended) or a bot PAT to enable formal PR reviews and auto-merging.
      </p>

      {/* GitHub App — Primary option */}
      <div className="border border-gray-700 rounded-lg p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-200">GitHub App</span>
            <span className="text-[10px] px-1.5 py-0.5 bg-blue-600/20 text-blue-400 rounded">
              Recommended
            </span>
          </div>
          {appStatus?.configured && (
            <button onClick={handleRemoveApp} className="text-xs text-red-400 hover:text-red-300">
              Remove
            </button>
          )}
        </div>

        {!appStatus?.configured ? (
          <div>
            <p className="text-xs text-gray-500 mb-2">
              One-click setup — creates and installs a GitHub App on your account with the right
              permissions. No separate account needed.
            </p>
            {!config?.publicUrl ? (
              <p className="text-xs text-amber-400">
                Set a Public URL above first — GitHub needs a callback URL.
              </p>
            ) : (
              <button
                onClick={handleCreateApp}
                className="bg-gray-700 hover:bg-gray-600 text-white text-sm px-3 py-1.5 rounded-lg transition-colors"
              >
                Set Up GitHub App
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2 h-2 rounded-full ${appStatus.hasInstallation ? 'bg-emerald-400' : 'bg-amber-400'}`}
              />
              <span
                className={`text-xs ${appStatus.hasInstallation ? 'text-emerald-400' : 'text-amber-400'}`}
              >
                {appStatus.hasInstallation
                  ? `Connected: ${appStatus.appSlug || appStatus.appName || `App #${appStatus.appId}`}`
                  : `App created — needs installation`}
              </span>
            </div>
            {!appStatus.hasInstallation && (
              <div className="flex gap-2">
                <button
                  onClick={handleInstallApp}
                  className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
                >
                  Install on GitHub
                </button>
                <button
                  onClick={handleRefreshInstallation}
                  disabled={refreshing}
                  className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {refreshing ? 'Checking...' : 'Refresh'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bot PAT — Fallback option */}
      <div className="border border-gray-700 rounded-lg p-3 space-y-3">
        <button
          onClick={() => setShowBotFallback(!showBotFallback)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-400">Bot PAT</span>
            <span className="text-[10px] px-1.5 py-0.5 bg-gray-600/50 text-gray-400 rounded">
              Fallback
            </span>
          </div>
          <span className="text-xs text-gray-500">{showBotFallback ? '▼' : '▶'}</span>
        </button>

        {showBotFallback && (
          <div>
            <label className={labelClass}>Bot Personal Access Token</label>
            <input
              type="password"
              value={config._botTokenEdit || ''}
              onChange={(e) => setConfig((prev) => ({ ...prev, _botTokenEdit: e.target.value }))}
              className={inputClass}
              placeholder={config.botGithubTokenSet ? '••••••••  (set)' : 'ghp_xxxx...'}
            />
            <button
              onClick={async () => {
                const token = config._botTokenEdit?.trim();
                if (!token) return;
                try {
                  const result = await api.updateConfig({ botGithubToken: token });
                  setConfig((prev) => ({
                    ...prev,
                    botGithubTokenSet: true,
                    botGithubUser: result.botGithubUser || null,
                    _botTokenEdit: '',
                  }));
                } catch (err) {
                  alert(err.message || 'Failed to save bot token');
                }
              }}
              disabled={!config._botTokenEdit?.trim()}
              className="mt-2 px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded disabled:opacity-50"
            >
              Save
            </button>
            <p className="text-xs text-gray-600 mt-1">
              Alternative: use a PAT from a separate GitHub account. Requires creating a new account
              and adding it as a collaborator.
            </p>
            {config.botGithubTokenSet && (
              <div className="mt-2 flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
                <span className="text-xs text-emerald-400">
                  Bot configured{config.botGithubUser ? `: @${config.botGithubUser}` : ''}
                </span>
                <button
                  onClick={async () => {
                    try {
                      await api.updateConfig({ botGithubToken: '' });
                      setConfig((prev) => ({
                        ...prev,
                        botGithubTokenSet: false,
                        botGithubUser: null,
                        botGithubToken: '',
                      }));
                    } catch {
                      /* ignore */
                    }
                  }}
                  className="text-xs text-red-400 hover:text-red-300 ml-auto"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function GeneralSection() {
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
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const isDirty = config && edits.claudeBin !== config.claudeBin;

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { claudeBin: edits.claudeBin };
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

function GitHubSection({ projects = [], onProjectsChange }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [publicUrl, setPublicUrl] = useState('');
  const [saving, setSaving] = useState({});
  const [saveStatus, setSaveStatus] = useState({});

  // Per-project workflow state
  const [projectWorkflow, setProjectWorkflow] = useState({});
  const [projectReviewers, setProjectReviewers] = useState({});
  const [workflowSaved, setWorkflowSaved] = useState({});
  const [reviewerSaved, setReviewerSaved] = useState({});
  const [expandedProject, setExpandedProject] = useState(null);

  useEffect(() => {
    api
      .getConfig()
      .then((data) => {
        setConfig(data);
        setPublicUrl(data.publicUrl || '');
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Init per-project state when projects arrive
  useEffect(() => {
    const wf = {};
    const rev = {};
    projects.forEach((p) => {
      wf[p.id] = {
        autoMerge: p.githubWorkflow?.autoMerge || false,
        autoReview: p.githubWorkflow?.autoReview !== false,
        waitForCI: p.githubWorkflow?.waitForCI || false,
        waitForResolvedComments: p.githubWorkflow?.waitForResolvedComments || false,
      };
      rev[p.id] = p.defaultReviewer || '';
    });
    setProjectWorkflow(wf);
    setProjectReviewers(rev);
  }, [projects]);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const savePublicUrl = async () => {
    setSaving((s) => ({ ...s, publicUrl: true }));
    try {
      await api.updateConfig({ publicUrl });
      setConfig((prev) => ({ ...prev, publicUrl }));
      setSaveStatus((s) => ({ ...s, publicUrl: 'saved' }));
      setTimeout(() => setSaveStatus((s) => ({ ...s, publicUrl: null })), 2000);
    } catch {
      setSaveStatus((s) => ({ ...s, publicUrl: 'error' }));
      setTimeout(() => setSaveStatus((s) => ({ ...s, publicUrl: null })), 3000);
    } finally {
      setSaving((s) => ({ ...s, publicUrl: false }));
    }
  };

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

  const saveReviewer = async (projectId) => {
    try {
      await api.updateProject(projectId, { defaultReviewer: projectReviewers[projectId] });
      setReviewerSaved((prev) => ({ ...prev, [projectId]: true }));
      setTimeout(() => setReviewerSaved((prev) => ({ ...prev, [projectId]: false })), 2000);
      if (onProjectsChange) onProjectsChange();
    } catch {
      /* ignore */
    }
  };

  if (loading) return <p className="text-sm text-gray-500">Loading config...</p>;
  if (!config) return <p className="text-sm text-red-400">Failed to load config</p>;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">GitHub Settings</h3>
        <p className="text-xs text-gray-500 mb-4">
          Configure GitHub integration — bot authentication, webhook URLs, and per-project PR
          workflow settings.
        </p>
      </div>

      <GitHubAppSection config={config} setConfig={setConfig} />

      {/* Public URL */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-300">Webhook Endpoint</h4>
        <div>
          <label className={labelClass}>Public URL</label>
          <div className="flex gap-2">
            <input
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
              className={inputClass}
              placeholder="https://my-server.example.com"
            />
            <button
              onClick={savePublicUrl}
              disabled={publicUrl === (config.publicUrl || '') || saving.publicUrl}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors whitespace-nowrap"
            >
              {saving.publicUrl ? 'Saving...' : 'Save'}
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-1">
            The externally-reachable URL for this server. Used as the callback URL when
            auto-registering GitHub webhooks. Leave empty if running locally only.
          </p>
          {saveStatus.publicUrl === 'saved' && (
            <span className="text-xs text-emerald-400 mt-1 block">Saved</span>
          )}
        </div>
      </div>

      {/* Per-Project Workflow Settings */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-300">PR Workflow per Project</h4>
        <p className="text-xs text-gray-500">
          Control how the lead agent handles PR reviews and merges for each project.
        </p>

        {projects.length === 0 && (
          <p className="text-xs text-gray-600 italic">No projects configured yet.</p>
        )}

        <div className="space-y-2">
          {projects.map((p) => (
            <div key={p.id} className="bg-gray-900/50 rounded-lg p-3">
              <div
                className="flex items-center gap-3 cursor-pointer"
                onClick={() => setExpandedProject(expandedProject === p.id ? null : p.id)}
              >
                <span className="text-lg text-gray-500">
                  {expandedProject === p.id ? '▾' : '▸'}
                </span>
                <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: p.color }} />
                <span className="text-sm font-medium">{p.name}</span>
                {workflowSaved[p.id] && (
                  <span className="text-xs text-emerald-400 ml-auto">Saved</span>
                )}
              </div>

              {expandedProject === p.id && (
                <div className="pl-8 pt-3 space-y-3">
                  {/* PR Reviewer */}
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400 flex-shrink-0 w-28">PR Reviewer:</label>
                    <input
                      value={projectReviewers[p.id] || ''}
                      onChange={(e) =>
                        setProjectReviewers((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      placeholder="github-username"
                      className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-gray-600 flex-1"
                    />
                    <button
                      onClick={() => saveReviewer(p.id)}
                      className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded-lg transition-colors"
                    >
                      {reviewerSaved[p.id] ? 'Saved' : 'Save'}
                    </button>
                  </div>

                  {/* Workflow Toggles */}
                  {[
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
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Webhooks */}
      <WebhookSection />
    </div>
  );
}

function HeartbeatSection() {
  const [heartbeats, setHeartbeats] = useState([]);
  const [expandedAgent, setExpandedAgent] = useState(null);
  const [logs, setLogs] = useState({});
  const [running, setRunning] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ interval: '', prompt: '' });
  // Tick every 30s so the "next run in Xm" badges decrement live without
  // hitting the network. Server is re-polled every 60s for fresh state.
  const [, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => api.getHeartbeats().then(setHeartbeats).catch(console.error);
    refresh();
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

  const startEdit = (hb) => {
    setEditingId(hb.agentId);
    setEditForm({ interval: hb.heartbeat.interval || '', prompt: hb.heartbeat.prompt || '' });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    await api.updateHeartbeat(editingId, { interval: editForm.interval, prompt: editForm.prompt });
    setHeartbeats((prev) =>
      prev.map((h) =>
        h.agentId === editingId
          ? {
              ...h,
              heartbeat: { ...h.heartbeat, interval: editForm.interval, prompt: editForm.prompt },
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
                <textarea
                  value={editForm.prompt}
                  onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
                  placeholder="Heartbeat prompt"
                  required
                  rows={4}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
                />
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

function CronSection() {
  const [crons, setCrons] = useState([]);
  const [running, setRunning] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [, setTick] = useState(0);
  const [cronLogs, setCronLogs] = useState({}); // { [cronId]: log[] }
  const [expandedLog, setExpandedLog] = useState(null); // "cronId:logId"
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [form, setForm] = useState({
    name: '',
    schedule: '',
    prompt: '',
    cwd: '/home/ryan',
    enabled: true,
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

    // When a babysit cron is cleaned up server-side, remove it from local state
    const onBabysitCleaned = (e) => {
      const { cronId } = e.detail;
      if (cronId) setCrons((prev) => prev.filter((c) => c.id !== cronId));
    };
    window.addEventListener('babysit-cleaned', onBabysitCleaned);

    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
      window.removeEventListener('babysit-cleaned', onBabysitCleaned);
    };
  }, []);

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

  const createCron = async (e) => {
    e.preventDefault();
    const created = await api.createCron(form);
    setCrons((prev) => [...prev, created]);
    setShowForm(false);
    setForm({ name: '', schedule: '', prompt: '', cwd: '/home/ryan', enabled: true });
  };

  const startEditing = (cronJob) => {
    setEditingId(cronJob.id);
    setEditForm({
      name: cronJob.name,
      schedule: cronJob.schedule,
      prompt: cronJob.prompt,
      cwd: cronJob.cwd || '',
    });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    const updated = await api.updateCron(editingId, editForm);
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
          <input
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            placeholder="Cron schedule (e.g. */30 * * * *)"
            required
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder="Prompt"
            required
            rows={3}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
          />
          <input
            value={form.cwd}
            onChange={(e) => setForm({ ...form, cwd: e.target.value })}
            placeholder="Working directory"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />
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
                <input
                  value={editForm.schedule}
                  onChange={(e) => setEditForm({ ...editForm, schedule: e.target.value })}
                  placeholder="Cron schedule (e.g. */30 * * * *)"
                  required
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                />
                <textarea
                  value={editForm.prompt}
                  onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
                  placeholder="Prompt"
                  required
                  rows={3}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
                />
                <input
                  value={editForm.cwd}
                  onChange={(e) => setEditForm({ ...editForm, cwd: e.target.value })}
                  placeholder="Working directory"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                />
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

function WebhookSection() {
  const [webhooks, setWebhooks] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [webhookLogs, setWebhookLogs] = useState({});
  const [expandedWebhook, setExpandedWebhook] = useState(null);
  const [copiedField, setCopiedField] = useState(null);
  const [registering, setRegistering] = useState({});
  const [regStatus, setRegStatus] = useState({}); // { [whId]: { registered, hooks, webhookUrl } }
  const [projects, setProjects] = useState([]);
  const [serverConfig, setServerConfig] = useState(null); // { publicUrl, ... }
  const [form, setForm] = useState({
    projectId: '',
    repoUrl: '',
    autoRegister: false,
    events: {
      'pull_request.opened': { enabled: true, label: 'PR opened' },
      'pull_request.closed': { enabled: true, label: 'PR closed / merged' },
      'pull_request.synchronize': { enabled: true, label: 'New commits pushed to PR' },
      'pull_request_review.submitted': {
        enabled: true,
        label: 'Review submitted (approve / request changes)',
      },
      'pull_request_review_comment.created': {
        enabled: true,
        label: 'Inline review comment posted',
      },
      'check_suite.completed': { enabled: true, label: 'CI checks completed' },
      'issues.opened': { enabled: false, label: 'Issue opened' },
      push: { enabled: false, label: 'Push to any branch' },
    },
  });

  const refreshLogs = async (list) => {
    const entries = await Promise.all(
      (list || webhooks).map(async (w) => {
        try {
          const logs = await api.getWebhookLogs(w.id, 5);
          return [w.id, logs];
        } catch {
          return [w.id, []];
        }
      }),
    );
    setWebhookLogs(Object.fromEntries(entries));
  };

  useEffect(() => {
    const load = async () => {
      try {
        const [wh, proj, cfg] = await Promise.all([
          api.getWebhooks().catch(() => []),
          api.getProjects(),
          api.getConfig().catch(() => null),
        ]);
        setWebhooks(wh);
        setProjects(proj);
        if (cfg) setServerConfig(cfg);
        if (wh.length) await refreshLogs(wh);
      } catch (e) {
        console.error(e);
      }
    };
    load();
    const pollId = setInterval(load, 60000);
    return () => clearInterval(pollId);
  }, []);

  const copyToClipboard = (text, field) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const createWebhook = async (e) => {
    e.preventDefault();
    const enabledEvents = {};
    Object.entries(form.events).forEach(([key, val]) => {
      if (val.enabled) enabledEvents[key] = { enabled: true };
    });
    const created = await api.createWebhook({
      projectId: form.projectId,
      repoUrl: form.repoUrl,
      events: enabledEvents,
      autoRegister: form.autoRegister,
    });
    // If auto-register returned inline registration info, extract the webhook record
    const { registration, ...webhookRecord } = created;
    setWebhooks((prev) => [...prev, webhookRecord]);
    if (registration) {
      if (registration.ok) {
        setRegStatus((prev) => ({
          ...prev,
          [webhookRecord.id]: {
            registered: true,
            hooks: [{ id: registration.hookId }],
            webhookUrl: registration.url,
          },
        }));
      }
    }
    setShowForm(false);
  };

  const toggleWebhook = async (wh) => {
    const updated = await api.updateWebhook(wh.id, { enabled: !wh.enabled });
    setWebhooks((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
  };

  const deleteWebhook = async (id) => {
    await api.deleteWebhook(id);
    setWebhooks((prev) => prev.filter((w) => w.id !== id));
  };

  const registerOnGitHub = async (wh) => {
    setRegistering((prev) => ({ ...prev, [wh.id]: true }));
    try {
      const result = await api.registerWebhook(wh.id);
      setRegStatus((prev) => ({
        ...prev,
        [wh.id]: { registered: true, hooks: [{ id: result.hookId }], webhookUrl: result.url },
      }));
    } catch (err) {
      setRegStatus((prev) => ({ ...prev, [wh.id]: { registered: false, error: err.message } }));
    }
    setRegistering((prev) => ({ ...prev, [wh.id]: false }));
  };

  const unregisterFromGitHub = async (wh) => {
    setRegistering((prev) => ({ ...prev, [wh.id]: true }));
    try {
      await api.unregisterWebhook(wh.id);
      setRegStatus((prev) => ({ ...prev, [wh.id]: { registered: false } }));
    } catch (err) {
      setRegStatus((prev) => ({ ...prev, [wh.id]: { registered: false, error: err.message } }));
    }
    setRegistering((prev) => ({ ...prev, [wh.id]: false }));
  };

  const checkRegistration = async (wh) => {
    try {
      const status = await api.getWebhookRegistration(wh.id);
      setRegStatus((prev) => ({ ...prev, [wh.id]: status }));
    } catch (err) {
      console.warn('checkRegistration failed:', err);
    }
  };

  /** Resolve the public webhook URL: prefer server-side publicUrl, fall back to client base */
  const getWebhookUrl = () => {
    if (serverConfig?.publicUrl)
      return `${serverConfig.publicUrl.replace(/\/+$/, '')}/api/webhooks/github`;
    const base = getServerBase() || window.location.origin;
    return `${base}/api/webhooks/github`;
  };

  const statusColor = (s) =>
    s === 'success'
      ? 'bg-emerald-500'
      : s === 'error'
        ? 'bg-red-500'
        : s === 'running'
          ? 'bg-blue-500'
          : 'bg-gray-600';

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">GitHub Webhooks</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors"
        >
          {showForm ? 'Cancel' : '+ New Webhook'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={createWebhook} className="bg-gray-800 rounded-xl p-4 mb-4 space-y-3">
          <select
            value={form.projectId}
            onChange={(e) => setForm({ ...form, projectId: e.target.value })}
            required
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          >
            <option value="">Select Project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            value={form.repoUrl}
            onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
            placeholder="Repository URL (e.g. https://github.com/owner/repo)"
            required
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />

          <div className="space-y-2">
            <p className="text-xs text-gray-400 font-medium">Events to handle:</p>
            {Object.entries(form.events).map(([eventKey, eventConfig]) => (
              <label
                key={eventKey}
                className="flex items-center gap-3 cursor-pointer bg-gray-900 rounded-lg px-3 py-2.5"
              >
                <input
                  type="checkbox"
                  checked={eventConfig.enabled}
                  onChange={() =>
                    setForm({
                      ...form,
                      events: {
                        ...form.events,
                        [eventKey]: { ...eventConfig, enabled: !eventConfig.enabled },
                      },
                    })
                  }
                  className="rounded border-gray-600"
                />
                <div>
                  <span className="text-sm font-mono text-gray-300">{eventKey}</span>
                  <span className="text-xs text-gray-500 ml-2">{eventConfig.label}</span>
                </div>
              </label>
            ))}
          </div>

          <label className="flex items-center gap-3 cursor-pointer bg-gray-900 rounded-lg px-3 py-2.5">
            <input
              type="checkbox"
              checked={form.autoRegister}
              onChange={() => setForm({ ...form, autoRegister: !form.autoRegister })}
              className="rounded border-gray-600"
            />
            <div>
              <span className="text-sm text-gray-300">Auto-register on GitHub</span>
              <p className="text-xs text-gray-500 mt-0.5">
                {serverConfig?.publicUrl ? (
                  <>
                    Webhook URL:{' '}
                    <code className="text-gray-400">
                      {serverConfig.publicUrl.replace(/\/+$/, '')}/api/webhooks/github
                    </code>
                  </>
                ) : (
                  <span className="text-amber-400">
                    Set a Public URL above for reliable webhook delivery
                  </span>
                )}
              </p>
            </div>
          </label>

          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {form.autoRegister ? 'Create & Register' : 'Create Webhook'}
          </button>
        </form>
      )}

      <div className="space-y-3">
        {webhooks.map((wh) => {
          const events = JSON.parse(wh.events || '{}');
          const enabledEvents = Object.entries(events).filter(([, v]) => v.enabled);
          const project = projects.find((p) => p.id === wh.project_id);
          const logs = webhookLogs[wh.id] || [];
          const isExpanded = expandedWebhook === wh.id;

          return (
            <div key={wh.id} className="bg-gray-800 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">
                      {wh.repo_url.replace(/https?:\/\/github\.com\//, '')}
                    </span>
                    {project && (
                      <span className="text-xs bg-gray-700 px-1.5 py-0.5 rounded text-gray-400">
                        {project.name}
                      </span>
                    )}
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${wh.enabled ? 'bg-emerald-900/40 text-emerald-400' : 'bg-gray-700 text-gray-500'}`}
                    >
                      {wh.enabled ? 'active' : 'disabled'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {enabledEvents.length} event{enabledEvents.length !== 1 ? 's' : ''}:{' '}
                    {enabledEvents.map(([k]) => k).join(', ')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {logs.slice(0, 5).map((log) => (
                    <div
                      key={log.id}
                      title={`${log.event_type} — ${log.status}${log.duration_ms ? ` (${(log.duration_ms / 1000).toFixed(1)}s)` : ''}`}
                      className={`w-2 h-2 rounded-full ${statusColor(log.status)}`}
                    />
                  ))}
                  <button
                    onClick={() => toggleWebhook(wh)}
                    className={`ml-2 text-xs px-2 py-1 rounded transition-colors ${wh.enabled ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : 'bg-emerald-800 hover:bg-emerald-700 text-emerald-300'}`}
                  >
                    {wh.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => setExpandedWebhook(isExpanded ? null : wh.id)}
                    className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded transition-colors text-gray-300"
                  >
                    {isExpanded ? 'Hide' : 'Setup'}
                  </button>
                  <button
                    onClick={() => deleteWebhook(wh.id)}
                    className="text-xs bg-red-900/40 hover:bg-red-800/60 px-2 py-1 rounded transition-colors text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="mt-3 space-y-3 border-t border-gray-700 pt-3">
                  <div className="space-y-2">
                    <p className="text-xs text-gray-400 font-medium">Webhook Setup</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs bg-gray-900 px-2 py-1.5 rounded font-mono text-gray-300 truncate">
                        {getWebhookUrl()}
                      </code>
                      <button
                        onClick={() => copyToClipboard(getWebhookUrl(), `url-${wh.id}`)}
                        className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-gray-300"
                      >
                        {copiedField === `url-${wh.id}` ? 'Copied' : 'Copy URL'}
                      </button>
                    </div>
                    {!serverConfig?.publicUrl && (
                      <p className="text-xs text-amber-400">
                        No Public URL configured — webhook URL may not be reachable from GitHub. Set
                        it in the Webhook Endpoint section above.
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs bg-gray-900 px-2 py-1.5 rounded font-mono text-gray-300 truncate">
                        {wh.secret}
                      </code>
                      <button
                        onClick={() => copyToClipboard(wh.secret, `secret-${wh.id}`)}
                        className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-gray-300"
                      >
                        {copiedField === `secret-${wh.id}` ? 'Copied' : 'Copy Secret'}
                      </button>
                    </div>

                    {/* Registration status */}
                    {regStatus[wh.id]?.registered && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                        <span className="text-emerald-400">Registered on GitHub</span>
                        {regStatus[wh.id]?.hooks?.[0]?.id && (
                          <span className="text-gray-500 font-mono">
                            Hook #{regStatus[wh.id].hooks[0].id}
                          </span>
                        )}
                      </div>
                    )}
                    {regStatus[wh.id]?.error && (
                      <p className="text-xs text-red-400">
                        Registration error: {regStatus[wh.id].error}
                      </p>
                    )}

                    <div className="flex items-center gap-2">
                      {regStatus[wh.id]?.registered ? (
                        <>
                          <button
                            onClick={() => unregisterFromGitHub(wh)}
                            disabled={registering[wh.id]}
                            className="text-xs bg-red-900/40 hover:bg-red-800/60 disabled:opacity-50 px-3 py-1.5 rounded text-red-400 transition-colors"
                          >
                            {registering[wh.id] ? 'Removing...' : 'Remove from GitHub'}
                          </button>
                          <button
                            onClick={() => checkRegistration(wh)}
                            className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1.5 rounded text-gray-300 transition-colors"
                          >
                            Refresh Status
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => registerOnGitHub(wh)}
                            disabled={registering[wh.id]}
                            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-3 py-1.5 rounded text-white transition-colors"
                          >
                            {registering[wh.id] ? 'Registering...' : 'Register on GitHub'}
                          </button>
                          <button
                            onClick={() => checkRegistration(wh)}
                            className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1.5 rounded text-gray-300 transition-colors"
                          >
                            Check Status
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <p className="text-xs text-gray-400 font-medium">Event Handlers</p>
                    {enabledEvents.map(([eventKey]) => (
                      <span
                        key={eventKey}
                        className="inline-block bg-gray-900 rounded px-2 py-1 text-xs font-mono text-emerald-400 mr-1 mb-1"
                      >
                        {eventKey}
                      </span>
                    ))}
                  </div>

                  {logs.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-gray-400 font-medium">Recent Activity</p>
                      {logs.map((log) => (
                        <div key={log.id} className="flex items-center gap-2 text-xs">
                          <div
                            className={`w-2 h-2 rounded-full shrink-0 ${statusColor(log.status)}`}
                          />
                          <span className="font-mono text-gray-400">{log.event_type}</span>
                          <span className="text-gray-600">
                            {log.duration_ms ? `${(log.duration_ms / 1000).toFixed(1)}s` : '...'}
                          </span>
                          <span className="text-gray-600 ml-auto">
                            {new Date(log.created_at).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {webhooks.length === 0 && !showForm && (
          <p className="text-sm text-gray-500 text-center py-4">
            No webhooks configured. Create one to receive GitHub events.
          </p>
        )}
      </div>
    </div>
  );
}

function SlackSection() {
  const [status, setStatus] = useState([]);
  const [messages, setMessages] = useState([]);
  const [restarting, setRestarting] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = async () => {
    try {
      const data = await api.getSlackStatus();
      setStatus(data);
    } catch (err) {
      console.error('Failed to load Slack status:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (agentId) => {
    try {
      const data = await api.getSlackMessages(agentId, 20);
      setMessages(data);
    } catch (err) {
      console.error('Failed to load Slack messages:', err);
    }
  };

  useEffect(() => {
    loadStatus();
    loadMessages();
  }, []);

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartSlack();
      await loadStatus();
    } catch (err) {
      console.error('Restart failed:', err);
    } finally {
      setRestarting(false);
    }
  };

  const handleSelectAgent = (agentId) => {
    if (selectedAgent === agentId) {
      setSelectedAgent(null);
      loadMessages();
    } else {
      setSelectedAgent(agentId);
      loadMessages(agentId);
    }
  };

  if (loading) {
    return <div className="text-gray-500 text-sm">Loading Slack status...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Slack Bots</h3>
        <button
          onClick={handleRestart}
          disabled={restarting}
          className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          <span className="flex items-center gap-1.5">
            {restarting ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Restarting...
              </>
            ) : (
              <>
                <RefreshCw size={14} /> Restart All
              </>
            )}
          </span>
        </button>
      </div>

      {status.length === 0 ? (
        <p className="text-sm text-gray-500">No Slack accounts configured</p>
      ) : (
        <div className="space-y-3">
          {status.map((bot) => (
            <div
              key={bot.name}
              className="bg-gray-800 rounded-xl p-4 cursor-pointer hover:bg-gray-750"
              onClick={() => handleSelectAgent(bot.agentId)}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`w-3 h-3 rounded-full flex-shrink-0 ${
                    bot.connected
                      ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
                      : 'bg-red-400'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                    <span className="font-medium text-sm">{bot.name}</span>
                    <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded font-mono truncate max-w-[120px] sm:max-w-none">
                      → {bot.agentId}
                    </span>
                  </div>
                  {bot.channels && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      Channels: {bot.channels.join(', ')}
                    </p>
                  )}
                  {bot.error && <p className="text-xs text-red-400 mt-0.5">{bot.error}</p>}
                  {bot.lastMessage && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      Last message: {relativeTime(bot.lastMessage)}
                    </p>
                  )}
                </div>
                <span
                  className={`text-xs px-2.5 py-1 rounded-md ${
                    bot.connected
                      ? 'bg-emerald-800/50 text-emerald-400'
                      : 'bg-red-900/50 text-red-400'
                  }`}
                >
                  {bot.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent messages */}
      <div className="mt-6">
        <h4 className="text-sm font-semibold text-gray-400 mb-3">
          Recent Messages{selectedAgent ? ` (${selectedAgent})` : ''}
        </h4>
        {messages.length === 0 ? (
          <p className="text-xs text-gray-500">No messages yet</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {messages.map((msg) => (
              <div key={msg.id} className="bg-gray-800 rounded-lg p-3 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-500 font-mono">{msg.agent_id}</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-500">{relativeTime(msg.timestamp)}</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-600 font-mono">{msg.channel_id}</span>
                </div>
                <p className="text-blue-300 mb-1">
                  <span className="text-gray-500">User:</span> {msg.user_message?.substring(0, 200)}
                  {msg.user_message?.length > 200 ? '...' : ''}
                </p>
                <p className="text-gray-300">
                  <span className="text-gray-500">Bot:</span> {msg.bot_response?.substring(0, 300)}
                  {msg.bot_response?.length > 300 ? '...' : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentConfigSection({ agents: initialAgents, projects = [], onAgentsChange }) {
  const [agents, setAgents] = useState(initialAgents);
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState({});
  const [saveStatus, setSaveStatus] = useState({});
  const [edits, setEdits] = useState({});
  const [showNew, setShowNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [modelConfig, setModelConfig] = useState(null);
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
  const [projectCommandsSaved, setProjectCommandsSaved] = useState({});
  const [expandedProject, setExpandedProject] = useState(null);

  const saveProjectCommands = async (projectId) => {
    try {
      const cmds = projectCommands[projectId] || {};
      await api.updateProject(projectId, {
        commands: {
          install: cmds.install || null,
          build: cmds.build || null,
          test: cmds.test || null,
          lint: cmds.lint || null,
        },
      });
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
                <option value="claude-code">claude-code</option>
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
              {newForm.avatar ? (
                <img
                  src={`${getApiBase()}${newForm.avatar}`}
                  alt="Avatar"
                  className="w-12 h-12 rounded-full object-cover border border-gray-700"
                />
              ) : (
                <div className="w-12 h-12 rounded-full border border-gray-700 bg-gray-900 flex items-center justify-center">
                  <User size={20} className="text-gray-600" />
                </div>
              )}
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
                      const res = await fetch(`${getApiBase()}/api/upload`, {
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
                  onClick={() => setNewForm({ ...newForm, avatar: '' })}
                  className="text-xs text-gray-500 hover:text-red-400"
                >
                  Remove
                </button>
              )}
            </div>
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
                        <option value="claude-code">claude-code</option>
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
                        {edit.avatar || agent.avatar ? (
                          <img
                            src={`${getApiBase()}${edit.avatar || agent.avatar}`}
                            alt="Avatar"
                            className="w-12 h-12 rounded-full object-cover border border-gray-700"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-full border border-gray-700 bg-gray-900 flex items-center justify-center">
                            <User size={20} className="text-gray-600" />
                          </div>
                        )}
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
                                const res = await fetch(`${getApiBase()}/api/upload`, {
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
                            onClick={() => setEdit(agent.id, 'avatar', '')}
                            className="text-xs text-gray-500 hover:text-red-400"
                          >
                            Remove
                          </button>
                        )}
                      </div>
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
                    </div>
                  </div>

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

function ConfigBackupSection({ projects = [], onAgentsChange }) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [importTargetId, setImportTargetId] = useState('');

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
      a.download = `${safeName}-export-${new Date().toISOString().split('T')[0]}.json`;
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
    if (!preview || !importTargetId) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const result = await api.importProject(importTargetId, preview);
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
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Export / Import Project</h3>
      <p className="text-sm text-gray-400 mb-6">
        Export a project with its agents, kanban board, wiki, crons, rooms, and webhooks. Import
        into an existing project on another instance to replicate your setup.
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
          Upload a project export file. Agents and settings are overwritten; crons, rooms, wiki, and
          webhooks are merged. Kanban boards are only created if no board exists yet.
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
              <label className="block text-sm text-gray-400 mb-1">Import into project:</label>
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
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleImport}
                disabled={importing || !importTargetId}
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

export default function SettingsPage({ projects = [], agents, onAgentsChange, initialTab }) {
  const [tab, setTab] = useState(initialTab || 'general');

  // When navigating directly to a specific tab (e.g. from OrgSwitcher)
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const tabs = [
    { id: 'general', icon: <SettingsIcon size={16} />, text: 'General' },
    { id: 'github', icon: <GitBranch size={16} />, text: 'GitHub' },
    { id: 'orgs', icon: <Building2 size={16} />, text: 'Organizations' },
    { id: 'agents', icon: <Bot size={16} />, text: 'Agents' },
    { id: 'heartbeats', icon: <HeartPulse size={16} />, text: 'Heartbeats' },
    { id: 'crons', icon: <Clock size={16} />, text: 'Cron Jobs' },

    { id: 'slack', icon: <MessageSquare size={16} />, text: 'Slack' },
    { id: 'usage', icon: <BarChart3 size={16} />, text: 'Usage' },
    { id: 'backup', icon: <HardDrive size={16} />, text: 'Backup' },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold mb-6">Settings</h2>

        <div className="flex gap-1.5 sm:gap-2 mb-6 overflow-x-auto pb-1 -mx-1 px-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 sm:px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors min-h-[44px] ${
                tab === t.id
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
              }`}
            >
              <span className="flex items-center gap-1.5">
                {t.icon}
                <span>{t.text}</span>
              </span>
            </button>
          ))}
        </div>

        {tab === 'general' && <GeneralSection />}
        {tab === 'github' && (
          <GitHubSection projects={projects} onProjectsChange={onAgentsChange} />
        )}
        {tab === 'orgs' && <OrganizationsSection />}
        {tab === 'heartbeats' && <HeartbeatSection />}
        {tab === 'crons' && <CronSection />}

        {tab === 'slack' && <SlackSection />}
        {tab === 'agents' && (
          <AgentConfigSection agents={agents} projects={projects} onAgentsChange={onAgentsChange} />
        )}
        {tab === 'usage' && <UsageSection />}
        {tab === 'backup' && (
          <ConfigBackupSection projects={projects} onAgentsChange={onAgentsChange} />
        )}
      </div>
    </div>
  );
}
