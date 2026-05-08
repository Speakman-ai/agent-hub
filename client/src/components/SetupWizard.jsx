import { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  Rocket,
  Monitor,
  Cloud,
  Loader2,
  Plug,
  Key,
  Terminal,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { getApiBase, getAuthHeaders, saveConnectionConfig } from '../utils/connection.js';
import { createOrg, switchOrg, getActiveOrg, updateOrg } from '../utils/orgs.js';
import { testConnection } from '../utils/connection.js';
import GithubConnectionSection from './GithubConnectionSection.jsx';
import PersonalOAuthConfigSection from './PersonalOAuthConfigSection.jsx';

const STEP_LABELS = [
  'Welcome',
  'Organization',
  'AI credentials',
  'Connect GitHub',
  'First Project',
];

function StepIndicator({ currentStep, minStep = 1 }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-8">
      {STEP_LABELS.map((label, i) => {
        const stepNum = i + 1;
        // Steps before `minStep` were intentionally skipped (e.g. wizard
        // launched from "no AI credentials" path with org already in place).
        // Render them as already-completed so the indicator reflects the
        // true entry point rather than implying the user can return to them.
        const isSkipped = stepNum < minStep;
        const isActive = stepNum === currentStep;
        const isCompleted = stepNum < currentStep || isSkipped;
        return (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && (
              <div
                className={`w-8 h-px ${isCompleted || isActive ? 'bg-emerald-500' : 'bg-gray-600'}`}
              />
            )}
            <div className="flex items-center gap-1.5">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-colors ${
                  isCompleted
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : isActive
                      ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10'
                      : 'border-gray-600 text-gray-500 bg-transparent'
                }`}
              >
                {isCompleted ? (
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  stepNum
                )}
              </div>
              <span
                className={`text-xs font-medium ${
                  isActive ? 'text-emerald-400' : isCompleted ? 'text-emerald-500' : 'text-gray-500'
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToggleSwitch({ enabled, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
        enabled ? 'bg-emerald-500' : 'bg-gray-600'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export default function SetupWizard({ onComplete, setupStatus, initialStep = 1 }) {
  // `initialStep` lets the host (App.jsx) jump the wizard to AI credentials
  // when an org already exists but the user has no usable AI credentials
  // (e.g. fresh sandbox reset). The minimum back-target stays pinned to
  // `initialStep` so users can't navigate to earlier steps that were
  // intentionally skipped.
  const [step, setStep] = useState(initialStep);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // The Local/Remote toggle is only meaningful when the client is decoupled
  // from the server it talks to. The web build is *served by* its server, so
  // the page's origin is the server URL — there's no other server it could
  // sensibly point at, and a "remote" mode here would just dump the user
  // into a connection-test UI that, on success, would navigate the page
  // away to a server which serves its own copy of this same wizard. The
  // shell desktop app (Electron) is the only place this choice means
  // anything — it ships a renderer that can either spawn a bundled local
  // server or HTTP/WS to a remote one. React Native uses its own flow.
  const isElectron = typeof window !== 'undefined' && window.electronAPI?.isElectron === true;

  // Org step state
  const [orgName, setOrgName] = useState('Personal');
  // Web defaults to (and is locked to) `local`. Electron lets the user pick.
  const [orgMode, setOrgMode] = useState('local');
  const [orgRemoteUrl, setOrgRemoteUrl] = useState('');
  const [orgApiKey, setOrgApiKey] = useState('');
  const [orgTesting, setOrgTesting] = useState(false);
  const [orgTestResult, setOrgTestResult] = useState(null);

  const claudeEngine = setupStatus?.engines?.['claude-code'] || {};
  const cursorEngine = setupStatus?.engines?.['cursor-agent'] || {};
  const codexEngine = setupStatus?.engines?.['codex-cli'] || {};

  const [claudePath, setClaudePath] = useState(claudeEngine.path || '');
  const [claudeEnabled, setClaudeEnabled] = useState(claudeEngine.available || false);
  const [cursorPath, setCursorPath] = useState(cursorEngine.path || '');
  const [cursorEnabled, setCursorEnabled] = useState(cursorEngine.available || false);
  const [codexPath, setCodexPath] = useState(codexEngine.path || '');
  const [codexEnabled, setCodexEnabled] = useState(codexEngine.available || false);

  const [cursorAuthState, setCursorAuthState] = useState(null);
  const [cursorAuthError, setCursorAuthError] = useState(null);
  const [codexAuthState, setCodexAuthState] = useState(null);
  const [codexAuthError, setCodexAuthError] = useState(null);
  const [codexApiKeyInput, setCodexApiKeyInput] = useState('');
  const [codexApiKeySaving, setCodexApiKeySaving] = useState(false);
  const [codexApiKeyStatus, setCodexApiKeyStatus] = useState(null);

  useEffect(() => {
    const c = setupStatus?.engines?.['claude-code'];
    const u = setupStatus?.engines?.['cursor-agent'];
    const x = setupStatus?.engines?.['codex-cli'];
    if (c?.path != null && c.path !== '') setClaudePath(c.path);
    if (typeof c?.available === 'boolean') setClaudeEnabled(c.available);
    if (u?.path != null && u.path !== '') setCursorPath(u.path);
    if (typeof u?.available === 'boolean') setCursorEnabled(u.available);
    if (x?.path != null && x.path !== '') setCodexPath(x.path);
    if (typeof x?.available === 'boolean') setCodexEnabled(x.available);
  }, [setupStatus]);

  // Step 3 — Claude credential gate. The CLI binary path alone isn't enough
  // for first-run users: every spawned `claude` invocation needs an API key
  // or a setup-token (or an existing CLI OAuth login) or it 401s on the
  // very first agent message. We fetch /api/config/claude-auth on Step 3
  // mount and block "Save & Continue" until at least one credential source
  // is configured. Remote-mode wizards never reach Step 3 (they navigate
  // away during Step 2), but we still skip the gate defensively.
  const [authState, setAuthState] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [credTab, setCredTab] = useState('apiKey');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState(null);
  const [oauthTokenInput, setOauthTokenInput] = useState('');
  const [oauthTokenSaving, setOauthTokenSaving] = useState(false);
  const [oauthTokenStatus, setOauthTokenStatus] = useState(null);

  const fetchCursorAuth = useCallback(async () => {
    setCursorAuthError(null);
    try {
      const binForProbe = cursorEnabled && cursorPath.trim().length > 0 ? cursorPath.trim() : null;
      const qs =
        binForProbe != null ? `?${new URLSearchParams({ cursorBin: binForProbe }).toString()}` : '';
      const res = await fetch(`${getApiBase()}/config/cursor-auth${qs}`, {
        headers: { ...getAuthHeaders() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCursorAuthState(await res.json());
    } catch (err) {
      setCursorAuthError(err.message || 'Failed to load Cursor auth status');
      setCursorAuthState(null);
    }
  }, [cursorEnabled, cursorPath]);

  const fetchCodexAuth = async () => {
    setCodexAuthError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/codex-auth`, {
        headers: { ...getAuthHeaders() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCodexAuthState(await res.json());
    } catch (err) {
      setCodexAuthError(err.message || 'Failed to load Codex auth status');
      setCodexAuthState(null);
    }
  };

  const fetchClaudeAuth = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/claude-auth`, {
        headers: { ...getAuthHeaders() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAuthState(data);
    } catch (err) {
      setAuthError(err.message || 'Failed to load Claude auth status');
      setAuthState(null);
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    if (step === 3 && orgMode !== 'remote') {
      fetchClaudeAuth();
      fetchCodexAuth();
    }
  }, [step, orgMode]);

  // Cursor status must follow the path typed in the wizard (not only the
  // server's persisted config) so correcting a bad auto-detect unblocks the
  // gate before Save & Continue runs /setup/configure.
  useEffect(() => {
    if (step !== 3 || orgMode === 'remote') return;
    void fetchCursorAuth();
    const id = window.setTimeout(() => {
      void fetchCursorAuth();
    }, 400);
    return () => window.clearTimeout(id);
  }, [step, orgMode, cursorEnabled, cursorPath, fetchCursorAuth]);

  const credsConfigured = !!(
    authState?.apiKey?.configured ||
    authState?.oauthToken?.configured ||
    authState?.oauth?.loggedIn
  );

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      const res = await fetch(`${getApiBase()}/config/claude-auth/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Save failed: ${res.status}`);
      }
      const result = await res.json().catch(() => ({}));
      setApiKeyStatus({
        type: 'success',
        msg: result.masked ? `Saved: ${result.masked}` : 'Saved',
      });
      setApiKeyInput('');
      await fetchClaudeAuth();
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message });
    } finally {
      setApiKeySaving(false);
    }
  };

  const handleSaveOauthToken = async () => {
    // Terminal-wrapped `claude setup-token` output may contain newlines
    // inside the token; collapse all whitespace before validating + sending.
    const collapsed = oauthTokenInput.trim().replace(/\s+/g, '');
    if (!collapsed) return;
    setOauthTokenSaving(true);
    setOauthTokenStatus(null);
    try {
      const res = await fetch(`${getApiBase()}/config/claude-auth/oauth-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ oauthToken: collapsed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Save failed: ${res.status}`);
      }
      const result = await res.json().catch(() => ({}));
      setOauthTokenStatus({
        type: 'success',
        msg: result.masked ? `Saved: ${result.masked}` : 'Saved',
      });
      setOauthTokenInput('');
      await fetchClaudeAuth();
    } catch (err) {
      setOauthTokenStatus({ type: 'error', msg: err.message });
    } finally {
      setOauthTokenSaving(false);
    }
  };

  const codexCredsConfigured =
    codexAuthState?.activeMethod && codexAuthState.activeMethod !== 'none';
  const cursorCredsConfigured = cursorAuthState?.activeMethod === 'oauth';

  const anyEngineEnabled = claudeEnabled || cursorEnabled || codexEnabled;

  const handleSaveCodexApiKey = async () => {
    const trimmedKey = codexApiKeyInput.trim();
    const binPath = codexPath.trim();
    if (!trimmedKey || !binPath) return;
    setCodexApiKeySaving(true);
    setCodexApiKeyStatus(null);
    try {
      const patchRes = await fetch(`${getApiBase()}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ codexBin: binPath }),
      });
      if (!patchRes.ok) {
        const err = await patchRes.json().catch(() => ({ error: `HTTP ${patchRes.status}` }));
        throw new Error(err.error || 'Failed to save Codex binary path');
      }
      const res = await fetch(`${getApiBase()}/config/codex-auth/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ apiKey: trimmedKey }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Save failed: ${res.status}`);
      }
      const result = await res.json().catch(() => ({}));
      setCodexApiKeyStatus({
        type: 'success',
        msg: result.masked ? `Saved: ${result.masked}` : 'Saved',
      });
      setCodexApiKeyInput('');
      await fetchCodexAuth();
    } catch (err) {
      setCodexApiKeyStatus({ type: 'error', msg: err.message });
    } finally {
      setCodexApiKeySaving(false);
    }
  };

  const handleOrgContinue = async () => {
    if (!orgName.trim()) return;

    // Remote mode: don't create/update a local org. The user's account and
    // data live on the remote server — our only job here is to persist the
    // connection config and reload the window against the remote URL. That
    // server then serves its own React bundle, AuthGate, and LoginScreen.
    //
    // Without this branch we'd write org rows to the local SQLite (which
    // the remote server will never see), then drop the user into step 3's
    // local CLI configuration — neither of which belong on a machine that's
    // only meant to be a thin client for a remote hub.
    if (orgMode === 'remote') {
      if (!orgRemoteUrl.trim()) {
        setError('Enter a server URL and test the connection.');
        return;
      }
      // Force a fresh connection test before committing. This prevents a
      // typo'd URL from stranding the Electron window on an unreachable
      // origin with no graceful back-out.
      setOrgTesting(true);
      const result = await testConnection(orgRemoteUrl, orgApiKey);
      setOrgTestResult(result);
      setOrgTesting(false);
      if (!result.ok) {
        setError('Connection test failed — fix the URL or API key before continuing.');
        return;
      }
      setError(null);
      saveConnectionConfig({
        mode: 'remote',
        remoteUrl: orgRemoteUrl.trim().replace(/\/+$/, ''),
        apiKey: orgApiKey.trim(),
      });
      if (window.electronAPI?.navigateToOrg) {
        window.electronAPI.navigateToOrg();
      } else {
        window.location.reload();
      }
      return;
    }

    // Local mode: if an org already exists (e.g. the legacy-migrated
    // "Default"), update it in place so first-run setup doesn't leave a
    // stale duplicate behind.
    const existing = getActiveOrg();
    if (existing) {
      await updateOrg(existing.id, {
        name: orgName.trim(),
        mode: orgMode,
        remoteUrl: orgRemoteUrl,
        apiKey: orgApiKey,
      });
    } else {
      const org = await createOrg({
        name: orgName.trim(),
        mode: orgMode,
        remoteUrl: orgRemoteUrl,
        apiKey: orgApiKey,
        color: '#6366f1',
      });
      await switchOrg(org.id);
    }
    setStep(3);
  };

  const handleOrgTest = async () => {
    if (!orgRemoteUrl) {
      setOrgTestResult({ ok: false, message: 'Enter a server URL first.' });
      return;
    }
    setOrgTesting(true);
    setOrgTestResult(null);
    const result = await testConnection(orgRemoteUrl, orgApiKey);
    setOrgTestResult(result);
    setOrgTesting(false);
  };

  const handleSaveAndContinue = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/setup/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          claudeBin: claudeEnabled ? claudePath.trim() : '',
          cursorBin: cursorEnabled ? cursorPath.trim() : '',
          codexBin: codexEnabled ? codexPath.trim() : '',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Configuration failed: ${res.status}`);
      }

      if (cursorEnabled || codexEnabled) {
        const modelsRes = await fetch(`${getApiBase()}/config/models`, {
          headers: { ...getAuthHeaders() },
        });
        if (!modelsRes.ok) {
          throw new Error(`Could not verify engine credentials (HTTP ${modelsRes.status}).`);
        }
        const modelsBody = await modelsRes.json();
        const engineAuth = modelsBody.engineAuth || {};
        if (cursorEnabled && !engineAuth['cursor-agent']) {
          throw new Error(
            'Cursor Agent is enabled but not signed in. On the machine running this Hub, run `cursor-agent login` in a terminal, then click Save & Continue again — or disable Cursor Agent above.',
          );
        }
        if (codexEnabled && !engineAuth['codex-cli']) {
          throw new Error(
            'Codex CLI is enabled but is not authenticated. Paste an OpenAI-compatible API key above, complete `codex login` on the server, or disable Codex above.',
          );
        }
      }

      setStep(4);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const claudeGateOk = !claudeEnabled || credsConfigured;
  const cursorGateOk = !cursorEnabled || cursorCredsConfigured;
  const codexGateOk = !codexEnabled || codexCredsConfigured;
  const pathsOk =
    (!claudeEnabled || claudePath.trim()) &&
    (!cursorEnabled || cursorPath.trim()) &&
    (!codexEnabled || codexPath.trim());

  const step3CanContinue =
    orgMode !== 'remote' &&
    anyEngineEnabled &&
    pathsOk &&
    claudeGateOk &&
    cursorGateOk &&
    codexGateOk &&
    !saving;

  return (
    <div className="fixed inset-0 z-[70] bg-gray-950 flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-8">
        <StepIndicator currentStep={step} minStep={initialStep} />

        {/* Step 1: Welcome */}
        {step === 1 && (
          <div className="text-center space-y-6">
            <div className="text-gray-300">
              <Bot size={64} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white mb-3">Welcome to Agent Hub</h1>
              <p className="text-gray-400 text-sm leading-relaxed max-w-md mx-auto">
                We&apos;ll create your organization, then set up AI credentials (Claude, Cursor, or
                Codex). If your first project is a code repo, we&apos;ll connect GitHub next so
                clones and PRs work.
              </p>
            </div>
            <button
              onClick={() => setStep(2)}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors"
            >
              Continue
            </button>
          </div>
        )}

        {/* Step 2: Organization */}
        {step === 2 && (
          <div className="space-y-5">
            <div className="text-center mb-2">
              <h1 className="text-xl font-bold text-white mb-1">Create Your Organization</h1>
              <p className="text-gray-400 text-sm">
                An organization is a connection profile. You can add more later.
              </p>
            </div>

            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Organization Name
                </label>
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Personal"
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                />
              </div>

              {isElectron && (
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-2">
                    Connection Mode
                  </label>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setOrgMode('local');
                        setOrgTestResult(null);
                      }}
                      className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all text-sm font-medium ${
                        orgMode === 'local'
                          ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                          : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      <div className="text-base mb-1 flex items-center gap-1.5">
                        <Monitor size={18} /> Local
                      </div>
                      <div className="text-xs text-gray-500">Server on this machine</div>
                    </button>
                    <button
                      onClick={() => {
                        setOrgMode('remote');
                        setOrgTestResult(null);
                      }}
                      className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all text-sm font-medium ${
                        orgMode === 'remote'
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
                </div>
              )}

              {isElectron && orgMode === 'remote' && (
                <div className="space-y-3 pt-1">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      Server URL
                    </label>
                    <input
                      type="text"
                      value={orgRemoteUrl}
                      onChange={(e) => setOrgRemoteUrl(e.target.value)}
                      placeholder="https://my-server.example.com:3051"
                      className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      API Key (optional)
                    </label>
                    <input
                      type="password"
                      value={orgApiKey}
                      onChange={(e) => setOrgApiKey(e.target.value)}
                      placeholder="Enter API key if required"
                      className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleOrgTest}
                      disabled={orgTesting}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
                    >
                      <span className="flex items-center gap-1.5">
                        {orgTesting ? (
                          <>
                            <Loader2 size={14} className="animate-spin" /> Testing...
                          </>
                        ) : (
                          <>
                            <Plug size={14} /> Test Connection
                          </>
                        )}
                      </span>
                    </button>
                    {orgTestResult && (
                      <span
                        className={`text-sm ${orgTestResult.ok ? 'text-emerald-400' : 'text-red-400'}`}
                      >
                        {orgTestResult.ok ? '✓' : '✕'} {orgTestResult.message}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Remote-mode validation errors surface inline so the user can
                correct the URL / key without jumping to another step. */}
            {error && (
              <div
                role="alert"
                className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300"
              >
                {error}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setStep(1)}
                className="bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleOrgContinue}
                disabled={!orgName.trim()}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors disabled:cursor-not-allowed"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 3: CLI Setup */}
        {step === 3 && (
          <div className="space-y-5">
            <div className="text-center mb-2">
              <h1 className="text-xl font-bold text-white mb-1">Configure Your Tools</h1>
              <p className="text-gray-400 text-sm">
                Enable at least one engine and add credentials. Agents cannot run chats without a
                signed-in CLI or API key.
              </p>
            </div>

            {/* Claude Code Card */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-purple-500 inline-block" />
                  <span className="font-medium text-white text-sm">Claude Code</span>
                </div>
                <ToggleSwitch enabled={claudeEnabled} onChange={setClaudeEnabled} />
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                {claudeEngine.available ? (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-emerald-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-emerald-400">Detected at {claudeEngine.path}</span>
                  </>
                ) : (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-red-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    <span className="text-red-400">Not found</span>
                  </>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Binary Path</label>
                <input
                  type="text"
                  value={claudePath}
                  onChange={(e) => setClaudePath(e.target.value)}
                  placeholder="/usr/local/bin/claude"
                  disabled={!claudeEnabled}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                />
              </div>
            </div>

            {/* Cursor Agent card */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-sky-500 inline-block" />
                  <span className="font-medium text-white text-sm">Cursor Agent</span>
                </div>
                <ToggleSwitch enabled={cursorEnabled} onChange={setCursorEnabled} />
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                {cursorEngine.available ? (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-emerald-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-emerald-400">Detected at {cursorEngine.path}</span>
                  </>
                ) : (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-red-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    <span className="text-red-400">Not found</span>
                  </>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Binary Path (cursor-agent)
                </label>
                <input
                  type="text"
                  value={cursorPath}
                  onChange={(e) => setCursorPath(e.target.value)}
                  placeholder="/usr/local/bin/cursor-agent"
                  disabled={!cursorEnabled}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                />
              </div>
              {cursorEnabled && (
                <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-200">Sign in to Cursor</span>
                    {cursorCredsConfigured ? (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 size={12} /> Connected
                      </span>
                    ) : (
                      <span className="text-yellow-400">Required on server</span>
                    )}
                  </div>
                  <p className="text-gray-500 leading-relaxed">
                    On this Hub&apos;s host, run{' '}
                    <code className="text-gray-300">cursor-agent login</code> in a terminal, then
                    press Save &amp; Continue. Device login links also work from Settings → Cursor
                    after onboarding.
                  </p>
                  {cursorAuthError && (
                    <p className="text-red-400 flex items-center gap-1">
                      <AlertCircle size={12} /> {cursorAuthError}
                    </p>
                  )}
                  <button
                    type="button"
                    className="text-xs text-emerald-400 hover:text-emerald-300 underline"
                    onClick={() => fetchCursorAuth()}
                  >
                    Refresh status
                  </button>
                </div>
              )}
            </div>

            {/* Codex CLI card */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-amber-500 inline-block" />
                  <span className="font-medium text-white text-sm">Codex CLI</span>
                </div>
                <ToggleSwitch enabled={codexEnabled} onChange={setCodexEnabled} />
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                {codexEngine.available ? (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-emerald-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-emerald-400">Detected at {codexEngine.path}</span>
                  </>
                ) : (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-red-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    <span className="text-red-400">Not found</span>
                  </>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Binary Path (codex)
                </label>
                <input
                  type="text"
                  value={codexPath}
                  onChange={(e) => setCodexPath(e.target.value)}
                  placeholder="/usr/local/bin/codex"
                  disabled={!codexEnabled}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                />
              </div>
              {codexEnabled && (
                <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-200">Codex credentials</span>
                    {codexCredsConfigured ? (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 size={12} /> Authenticated ({codexAuthState?.activeMethod})
                      </span>
                    ) : (
                      <span className="text-yellow-400">API key or login required</span>
                    )}
                  </div>
                  <p className="text-gray-500 leading-relaxed">
                    Paste an API key used by Codex/OpenAI-compatible endpoints, or use{' '}
                    <code className="text-gray-300">codex login</code> on the server. Keys are saved
                    to this org&apos;s config.
                  </p>
                  <div className="space-y-2">
                    <label className="block text-xs font-medium text-gray-400">API key</label>
                    <input
                      type="password"
                      value={codexApiKeyInput}
                      onChange={(e) => {
                        setCodexApiKeyInput(e.target.value);
                        setCodexApiKeyStatus(null);
                      }}
                      placeholder="sk-proj-... or CODEX_API_KEY"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleSaveCodexApiKey}
                      disabled={!codexApiKeyInput.trim() || !codexPath.trim() || codexApiKeySaving}
                      className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-lg transition-colors"
                    >
                      {codexApiKeySaving ? <Loader2 size={12} className="animate-spin" /> : null}
                      {codexApiKeySaving ? 'Saving…' : 'Save API key'}
                    </button>
                    {codexApiKeyStatus && (
                      <div
                        className={`flex items-center gap-1.5 ${codexApiKeyStatus.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
                      >
                        {codexApiKeyStatus.type === 'success' ? (
                          <CheckCircle2 size={12} />
                        ) : (
                          <AlertCircle size={12} />
                        )}
                        <span>{codexApiKeyStatus.msg}</span>
                      </div>
                    )}
                  </div>
                  {codexAuthError && (
                    <p className="text-red-400 flex items-center gap-1">
                      <AlertCircle size={12} /> {codexAuthError}
                    </p>
                  )}
                  <button
                    type="button"
                    className="text-xs text-emerald-400 hover:text-emerald-300 underline"
                    onClick={() => fetchCodexAuth()}
                  >
                    Refresh status
                  </button>
                </div>
              )}
            </div>

            {!anyEngineEnabled && (
              <p className="text-yellow-400 text-xs text-center">
                Turn on at least one engine (Claude Code, Cursor Agent, or Codex CLI) to continue.
              </p>
            )}

            {/* Claude credentials gate — API key OR setup-token OR a prior
                CLI OAuth login. First-run users hit this; if any of the
                three is already configured (e.g. ANTHROPIC_API_KEY env var),
                the success pill is shown and Continue is unblocked without
                further input. */}
            {claudeEnabled && (
              <div
                className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3"
                data-testid="claude-credentials"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-white text-sm">Sign in to Claude</span>
                  {authLoading ? (
                    <span className="flex items-center gap-1.5 text-xs text-gray-400">
                      <Loader2 size={12} className="animate-spin" /> Loading
                    </span>
                  ) : credsConfigured ? (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <CheckCircle2 size={12} />{' '}
                      {authState?.activeMethod === 'oauth'
                        ? 'OAuth active'
                        : authState?.apiKey?.configured
                          ? 'API key configured'
                          : 'Setup token configured'}
                      {authState?.oauthToken?.masked ? ` (${authState.oauthToken.masked})` : ''}
                    </span>
                  ) : (
                    <span className="text-xs text-yellow-400">Required</span>
                  )}
                </div>

                {!credsConfigured && (
                  <>
                    <p className="text-xs text-gray-500">
                      Agent Hub spawns the Claude CLI for every chat — without a key or setup-token,
                      the first message will 401. Pick one:
                    </p>
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setCredTab('apiKey')}
                        className={`flex-1 py-1.5 px-2 rounded-md border transition-colors flex items-center justify-center gap-1.5 ${
                          credTab === 'apiKey'
                            ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                            : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'
                        }`}
                      >
                        <Key size={12} /> API Key
                      </button>
                      <button
                        type="button"
                        onClick={() => setCredTab('oauthToken')}
                        className={`flex-1 py-1.5 px-2 rounded-md border transition-colors flex items-center justify-center gap-1.5 ${
                          credTab === 'oauthToken'
                            ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                            : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'
                        }`}
                      >
                        <Terminal size={12} /> Setup token
                      </button>
                    </div>

                    {credTab === 'apiKey' && (
                      <div className="space-y-2">
                        <label className="block text-xs font-medium text-gray-400">
                          Anthropic API key
                        </label>
                        <input
                          type="password"
                          value={apiKeyInput}
                          onChange={(e) => {
                            setApiKeyInput(e.target.value);
                            setApiKeyStatus(null);
                          }}
                          placeholder="sk-ant-api03-..."
                          autoComplete="off"
                          data-1p-ignore
                          data-lpignore="true"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                        />
                        <button
                          type="button"
                          onClick={handleSaveApiKey}
                          disabled={!apiKeyInput.trim() || apiKeySaving}
                          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
                        >
                          {apiKeySaving ? <Loader2 size={12} className="animate-spin" /> : null}
                          {apiKeySaving ? 'Saving…' : 'Save API key'}
                        </button>
                        {apiKeyStatus && (
                          <div
                            className={`flex items-center gap-1.5 text-xs ${
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
                    )}

                    {credTab === 'oauthToken' && (
                      <div className="space-y-2">
                        <label className="block text-xs font-medium text-gray-400">
                          Setup token from <code className="text-gray-300">claude setup-token</code>
                        </label>
                        <input
                          type="password"
                          value={oauthTokenInput}
                          onChange={(e) => {
                            setOauthTokenInput(e.target.value);
                            setOauthTokenStatus(null);
                          }}
                          placeholder="sk-ant-oat01-..."
                          autoComplete="off"
                          data-1p-ignore
                          data-lpignore="true"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                        />
                        <button
                          type="button"
                          onClick={handleSaveOauthToken}
                          disabled={!oauthTokenInput.trim().replace(/\s+/g, '') || oauthTokenSaving}
                          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
                        >
                          {oauthTokenSaving ? <Loader2 size={12} className="animate-spin" /> : null}
                          {oauthTokenSaving ? 'Saving…' : 'Save setup token'}
                        </button>
                        {oauthTokenStatus && (
                          <div
                            className={`flex items-center gap-1.5 text-xs ${
                              oauthTokenStatus.type === 'success'
                                ? 'text-emerald-400'
                                : 'text-red-400'
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
                    )}
                  </>
                )}

                {authError && (
                  <div className="text-xs text-red-400 flex items-center gap-1.5">
                    <AlertCircle size={12} /> {authError}
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              {initialStep < 3 && (
                <button
                  onClick={() => setStep(2)}
                  className="bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors"
                >
                  Back
                </button>
              )}
              <button
                onClick={handleSaveAndContinue}
                disabled={!step3CanContinue}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving && (
                  <svg
                    className="animate-spin h-4 w-4 text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                )}
                {saving ? 'Saving...' : 'Save & Continue'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Connect GitHub (optional) */}
        {step === 4 && (
          <div className="space-y-5">
            <div className="text-center mb-2">
              <h1 className="text-xl font-bold text-white mb-1">Connect GitHub</h1>
              <p className="text-gray-400 text-sm">
                This is the right moment if your first project will be a{' '}
                <strong className="text-gray-300">GitHub codebase</strong>— clones, PRs, and
                reviewer bots need your GitHub login (and often the hub&apos;s GitHub App). Each
                user connects their own account. Skip if you&apos;re starting non-repo work; you can
                finish this later in Settings.
              </p>
            </div>

            {/* Optional: register an OAuth App so "Sign in with GitHub" works
                without falling back to a PAT. Skipped by users who don't run
                the server (the section already shows a Configured state if
                someone else set it up). */}
            <PersonalOAuthConfigSection />

            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <GithubConnectionSection embedded />
            </div>

            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setStep(3)}
                className="bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => setStep(5)}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Create First Project */}
        {step === 5 && (
          <div className="text-center space-y-6">
            <div className="text-gray-300">
              <Rocket size={48} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white mb-2">Open Your First Project</h1>
              <p className="text-gray-400 text-sm leading-relaxed max-w-sm mx-auto">
                If you use GitHub or the clone-from-URL path, you should have finished the previous
                step. We&apos;ll launch the project wizard next.
              </p>
            </div>
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={onComplete}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors flex items-center gap-2"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                  />
                </svg>
                Open Project
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
