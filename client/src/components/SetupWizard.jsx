import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Bot,
  Rocket,
  Loader2,
  Key,
  Terminal,
  CheckCircle2,
  AlertCircle,
  Globe,
  LogIn,
  ExternalLink,
  Copy,
  UserPlus,
  Lock,
} from 'lucide-react';
import { getApiBase, getAuthHeaders } from '../utils/connection.js';
import { setup as setupHubAuth } from '../utils/auth.js';
import { createOrg, switchOrg, getActiveOrg, updateOrg } from '../utils/orgs.js';
import { api } from '../utils/api.js';
import GithubConnectionSection from './GithubConnectionSection.jsx';
import PersonalOAuthConfigSection from './PersonalOAuthConfigSection.jsx';
import CursorAuthSection from './CursorAuthSection.jsx';

const DEFAULT_ORG_NAME = 'Personal';

/** Step keys and labels when Hub owner auth is not configured yet. */
export function getSetupWizardStepPlan(setupStatus) {
  const needsHubAccount = setupStatus?.authConfigured === false;
  const stepKeys = needsHubAccount
    ? ['account', 'welcome', 'credentials', 'github', 'project']
    : ['welcome', 'credentials', 'github', 'project'];
  const stepLabels = needsHubAccount
    ? ['Hub account', 'Welcome', 'AI credentials', 'Connect GitHub', 'First Project']
    : ['Welcome', 'AI credentials', 'Connect GitHub', 'First Project'];
  return { stepKeys, stepLabels, needsHubAccount };
}

/** 1-based step index for a logical step key (used by App.jsx initialStep). */
export function stepIndexForKey(setupStatus, key) {
  const { stepKeys } = getSetupWizardStepPlan(setupStatus);
  const idx = stepKeys.indexOf(key);
  return idx >= 0 ? idx + 1 : 1;
}

function StepIndicator({ currentStep, minStep = 1, stepLabels }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-8">
      {stepLabels.map((label, i) => {
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
  const { stepKeys, stepLabels } = getSetupWizardStepPlan(setupStatus);
  const stepIndex = (key) => {
    const idx = stepKeys.indexOf(key);
    return idx >= 0 ? idx + 1 : 1;
  };

  const [step, setStep] = useState(initialStep);
  const currentKey = stepKeys[step - 1] ?? stepKeys[0];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Hub owner account (first step when authConfigured is false)
  const [hubUsername, setHubUsername] = useState('');
  const [hubPassword, setHubPassword] = useState('');

  // Step 3 (Connect GitHub) — LAN mode toggle. Mirrors `config.lanMode` on the
  // server (see SettingsPage GitHub section for the same control post-setup).
  // First-run users on a private network can flip this on before any
  // webhook setup is attempted, sparing the "configure public URL"
  // round-trip. Loaded from the server on that step's mount so subsequent
  // re-entries see the current value; the toggle handler PATCHes
  // /api/config so the change is persisted before the user advances.
  const [lanMode, setLanMode] = useState(false);
  const [lanModeLoaded, setLanModeLoaded] = useState(false);
  const [lanModeSaving, setLanModeSaving] = useState(false);

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

  // Codex `codex login --device-auth` flow — mirrors the SettingsPage panel so
  // first-run users can complete a ChatGPT sign-in without leaving the wizard.
  const [codexDeviceLoading, setCodexDeviceLoading] = useState(false);
  const [codexDeviceAuthUrl, setCodexDeviceAuthUrl] = useState(null);
  const [codexDeviceUserCode, setCodexDeviceUserCode] = useState(null);
  const [codexDeviceMsg, setCodexDeviceMsg] = useState(null);
  const [codexDeviceCopied, setCodexDeviceCopied] = useState(false);
  const codexDeviceTimersRef = useRef({ intervalId: null, timeoutId: null });

  const clearCodexDeviceTimers = () => {
    const { intervalId, timeoutId } = codexDeviceTimersRef.current;
    if (intervalId !== null) clearInterval(intervalId);
    if (timeoutId !== null) clearTimeout(timeoutId);
    codexDeviceTimersRef.current = { intervalId: null, timeoutId: null };
  };

  // Always release the polling timers when the wizard unmounts — otherwise
  // a 15-minute device-login window would keep firing GETs against a
  // detached component.
  useEffect(() => () => clearCodexDeviceTimers(), []);

  // Load the current `lanMode` value when the user lands on Step 4 so the
  // toggle reflects whatever was previously persisted (env override,
  // config.json, or an earlier wizard run that already flipped it). Idle
  // on other steps so we don't fetch eagerly on every wizard mount.
  useEffect(() => {
    if (currentKey !== 'github' || lanModeLoaded) return;
    let cancelled = false;
    api
      .getConfig()
      .then((data) => {
        if (cancelled) return;
        setLanMode(!!data.lanMode);
        setLanModeLoaded(true);
      })
      .catch(() => {
        // GET /api/config can fail on a half-bootstrapped server (auth
        // setup mid-flight). Mark loaded anyway so the toggle is usable
        // — it just starts at the React default (off), and the server
        // stays untouched until the user explicitly flips it.
        if (!cancelled) setLanModeLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [currentKey, lanModeLoaded]);

  const handleToggleLanMode = async (next) => {
    const prev = lanMode;
    setLanMode(next);
    setLanModeSaving(true);
    try {
      await api.updateConfig({ lanMode: next });
    } catch (err) {
      // Roll back on failure so the toggle never claims a state the
      // server didn't accept.
      setLanMode(prev);
      setError((err && err.message) || 'Failed to update LAN mode');
    } finally {
      setLanModeSaving(false);
    }
  };

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

  // Step 2 — Claude credential gate. The CLI binary path alone isn't enough
  // for first-run users: every spawned `claude` invocation needs an API key
  // or a setup-token (or an existing CLI OAuth login) or it 401s on the
  // very first agent message. We fetch /api/config/claude-auth on Step 2
  // mount and block "Save & Continue" until at least one credential source
  // is configured.
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
    if (currentKey === 'credentials') {
      fetchClaudeAuth();
      fetchCodexAuth();
    }
  }, [currentKey]);

  // Cursor status must follow the path typed in the wizard (not only the
  // server's persisted config) so correcting a bad auto-detect unblocks the
  // gate before Save & Continue runs /setup/configure.
  useEffect(() => {
    if (currentKey !== 'credentials') return;
    void fetchCursorAuth();
    const id = window.setTimeout(() => {
      void fetchCursorAuth();
    }, 400);
    return () => window.clearTimeout(id);
  }, [currentKey, cursorEnabled, cursorPath, fetchCursorAuth]);

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

  const handleCodexDeviceLogin = async () => {
    clearCodexDeviceTimers();
    setCodexDeviceLoading(true);
    setCodexDeviceAuthUrl(null);
    setCodexDeviceUserCode(null);
    setCodexDeviceMsg(null);
    try {
      const data = await api.startCodexDeviceLogin();
      if (data.deviceAuthUrl && data.userCode) {
        setCodexDeviceAuthUrl(data.deviceAuthUrl);
        setCodexDeviceUserCode(data.userCode);
        // Rely on the visible link below — auto-open is blocked by Safari
        // and strict-mode Chrome after the async gap in handleCodexDeviceLogin.
        // 15-minute hard cap matches the OpenAI device code lifetime.
        const timeoutId = setTimeout(() => {
          clearCodexDeviceTimers();
          setCodexDeviceLoading(false);
        }, 900_000);
        const intervalId = setInterval(async () => {
          try {
            const st = await api.getCodexAuth();
            if (st.uiStatus === 'authenticated' && !st.loginInProgress) {
              clearCodexDeviceTimers();
              setCodexAuthState(st);
              setCodexDeviceAuthUrl(null);
              setCodexDeviceUserCode(null);
              setCodexDeviceLoading(false);
              setCodexDeviceMsg({
                type: 'success',
                msg: 'Codex is authenticated on this host.',
              });
            } else if (!st.loginInProgress && st.uiStatus !== 'authenticated') {
              clearCodexDeviceTimers();
              setCodexAuthState(st);
              setCodexDeviceAuthUrl(null);
              setCodexDeviceUserCode(null);
              setCodexDeviceLoading(false);
              setCodexDeviceMsg({
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
        setCodexDeviceLoading(false);
        setCodexDeviceMsg({
          type: 'error',
          msg: data.output || 'Could not start device login.',
        });
      }
    } catch (err) {
      setCodexDeviceLoading(false);
      setCodexDeviceMsg({ type: 'error', msg: err.message || 'Device login failed' });
    }
  };

  const handleCodexDeviceCancel = async () => {
    clearCodexDeviceTimers();
    try {
      await api.cancelCodexDeviceLogin();
    } catch {
      /* ignore */
    }
    setCodexDeviceLoading(false);
    setCodexDeviceAuthUrl(null);
    setCodexDeviceUserCode(null);
    setCodexDeviceMsg(null);
  };

  const handleCopyCodexDeviceCode = () => {
    if (!codexDeviceUserCode) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(codexDeviceUserCode);
    }
    setCodexDeviceCopied(true);
    setTimeout(() => setCodexDeviceCopied(false), 2000);
  };

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

  /** Ensure a default local org exists (no naming step in first-run wizard). */
  const ensureDefaultOrg = async () => {
    const existing = getActiveOrg();
    if (existing) {
      await updateOrg(existing.id, {
        name: existing.name?.trim() || DEFAULT_ORG_NAME,
        mode: 'local',
        remoteUrl: '',
        apiKey: '',
      });
      return;
    }
    const org = await createOrg({
      name: DEFAULT_ORG_NAME,
      mode: 'local',
      remoteUrl: '',
      apiKey: '',
      color: '#6366f1',
    });
    await switchOrg(org.id);
  };

  const handleHubAccountContinue = async (e) => {
    e.preventDefault();
    const username = hubUsername.trim();
    const password = hubPassword;
    if (!username || password.length < 12) {
      setError('Username and a password of at least 12 characters are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setupHubAuth({ baseUrl: getApiBase(), username, password });
      setHubPassword('');
      setStep(stepIndex('welcome'));
    } catch (err) {
      setError(err.message || 'Failed to create account');
    } finally {
      setSaving(false);
    }
  };

  const handleWelcomeContinue = async () => {
    setSaving(true);
    setError(null);
    try {
      await ensureDefaultOrg();
      setStep(stepIndex('credentials'));
    } catch (err) {
      setError((err && err.message) || 'Failed to initialize workspace');
    } finally {
      setSaving(false);
    }
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

      setStep(stepIndex('github'));
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

  const credentialsCanContinue =
    anyEngineEnabled && pathsOk && claudeGateOk && cursorGateOk && codexGateOk && !saving;

  return (
    <div className="fixed inset-0 z-[70] bg-gray-950 overflow-y-auto">
      <div className="min-h-full w-full max-w-2xl mx-auto p-8">
        <StepIndicator currentStep={step} minStep={initialStep} stepLabels={stepLabels} />

        {/* Hub owner account — only when auth.json has no users yet */}
        {currentKey === 'account' && (
          <div className="space-y-5 max-w-md mx-auto">
            <div className="text-center mb-2">
              <div className="flex justify-center mb-3">
                <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                  <UserPlus className="w-7 h-7 text-emerald-400" />
                </div>
              </div>
              <h1 className="text-xl font-bold text-white mb-1">Create your Hub account</h1>
              <p className="text-gray-400 text-sm">
                This username and password protect Agent Hub on this machine — API access, settings,
                and org data. Pick something strong; you can add more users later in Settings.
              </p>
            </div>
            <form onSubmit={handleHubAccountContinue} className="space-y-3">
              <div>
                <label htmlFor="hub-account-username" className="block text-xs text-gray-400 mb-1">
                  Username
                </label>
                <input
                  id="hub-account-username"
                  data-testid="hub-account-username"
                  type="text"
                  value={hubUsername}
                  onChange={(e) => setHubUsername(e.target.value)}
                  autoFocus
                  autoComplete="username"
                  required
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="hub-account-password" className="block text-xs text-gray-400 mb-1">
                  Password
                </label>
                <input
                  id="hub-account-password"
                  data-testid="hub-account-password"
                  type="password"
                  value={hubPassword}
                  onChange={(e) => setHubPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={12}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
                <p className="text-[10px] text-gray-500 mt-1">
                  12–256 characters. This credential protects everything served from this
                  environment.
                </p>
              </div>
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 p-2 bg-red-900/30 border border-red-700 rounded-lg text-xs text-red-300"
                >
                  <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={saving || hubUsername.trim().length === 0 || hubPassword.length < 12}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                {saving ? 'Creating account…' : 'Continue'}
              </button>
            </form>
          </div>
        )}

        {/* Welcome */}
        {currentKey === 'welcome' && (
          <div className="text-center space-y-6">
            <div className="text-gray-300">
              <Bot size={64} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white mb-3">Welcome to Agent Hub</h1>
              <p className="text-gray-400 text-sm leading-relaxed max-w-md mx-auto">
                We&apos;ll set up AI credentials (Claude, Cursor, or Codex). If your first project
                is a code repo, we&apos;ll connect GitHub next so clones and PRs work.
              </p>
            </div>
            {error && (
              <div
                role="alert"
                className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300 max-w-md mx-auto"
              >
                {error}
              </div>
            )}
            <button
              onClick={handleWelcomeContinue}
              disabled={saving}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2 mx-auto"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {saving ? 'Setting up…' : 'Continue'}
            </button>
          </div>
        )}

        {/* AI credentials */}
        {currentKey === 'credentials' && (
          <div className="space-y-5">
            <div className="text-center mb-2">
              <h1 className="text-xl font-bold text-white mb-1">Configure Your Tools</h1>
              <p className="text-gray-400 text-sm">
                Enable at least one engine and add credentials. Agents cannot run chats without a
                signed-in CLI or API key.
              </p>
            </div>

            {/* Claude credentials gate — API key OR setup-token OR a prior
                CLI OAuth login. First-run users hit this; if any of the
                three is already configured (e.g. ANTHROPIC_API_KEY env var),
                the success pill is shown and Continue is unblocked without
                further input. Rendered first so credentials sit above the
                CLI engine cards. */}
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
              {cursorEnabled && (
                <div
                  className="rounded-lg border border-gray-700 bg-gray-900/50 p-3 text-xs space-y-2"
                  data-testid="cursor-credentials"
                >
                  {/* Live "Sign in with browser" panel — same component used on
                      Settings. The wizard's own /config/cursor-auth probe (for
                      the gate, lines above) keeps its cursorBin query so a path
                      typed in this form is honored before it's persisted; this
                      embedded section reads/writes the persisted-config status
                      and bubbles auth changes back via onAuthChange so the gate
                      flips the moment the browser sign-in lands. */}
                  <CursorAuthSection onAuthChange={() => void fetchCursorAuth()} />
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
                <ToggleSwitch
                  enabled={codexEnabled}
                  onChange={(val) => {
                    if (!val) clearCodexDeviceTimers();
                    setCodexEnabled(val);
                  }}
                />
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
                    Paste an API key used by Codex/OpenAI-compatible endpoints, or sign in with a
                    ChatGPT-linked Codex account using device authorization — no SSH required.
                  </p>

                  {/* ChatGPT device-code login (codex login --device-auth) */}
                  <div
                    className="rounded-lg border border-gray-700 bg-gray-900/50 p-3 space-y-2"
                    data-testid="codex-device-login"
                  >
                    <div className="flex items-center gap-1.5 font-medium text-gray-200">
                      <Globe size={12} /> ChatGPT sign-in (device code)
                    </div>
                    <p className="text-gray-500 leading-relaxed">
                      Starts <code className="text-gray-300">codex login --device-auth</code> on the
                      Hub. Open the verification URL, paste the one-time code, then wait for this
                      panel to show Authenticated.
                    </p>
                    {codexDeviceAuthUrl && (
                      <div className="rounded border border-gray-700 bg-gray-900/80 p-2 space-y-1.5">
                        <p className="text-gray-400">Verification page</p>
                        <a
                          href={codexDeviceAuthUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-400 hover:underline break-all flex items-center gap-1"
                        >
                          {codexDeviceAuthUrl} <ExternalLink size={10} />
                        </a>
                        <p className="text-gray-400 pt-0.5">One-time code</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="text-base tracking-widest text-white">
                            {codexDeviceUserCode}
                          </code>
                          <button
                            type="button"
                            onClick={handleCopyCodexDeviceCode}
                            className="text-gray-400 hover:text-white flex items-center gap-1"
                          >
                            <Copy size={10} /> {codexDeviceCopied ? 'Copied' : 'Copy code'}
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleCodexDeviceLogin}
                        disabled={codexDeviceLoading || !codexEngine.available}
                        className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-lg transition-colors"
                      >
                        {codexDeviceLoading ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <LogIn size={12} />
                        )}
                        {codexDeviceLoading ? 'Waiting for OpenAI…' : 'Start ChatGPT device login'}
                      </button>
                      {codexDeviceLoading && (
                        <button
                          type="button"
                          onClick={handleCodexDeviceCancel}
                          className="text-gray-400 hover:text-white px-2 py-1.5"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    {codexDeviceMsg && (
                      <p
                        className={`flex items-center gap-1 ${codexDeviceMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
                      >
                        {codexDeviceMsg.type === 'success' ? (
                          <CheckCircle2 size={12} />
                        ) : (
                          <AlertCircle size={12} />
                        )}
                        <span>{codexDeviceMsg.msg}</span>
                      </p>
                    )}
                  </div>

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

            {/* Error */}
            {error && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              {step > initialStep && (
                <button
                  onClick={() => setStep(step - 1)}
                  className="bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors"
                >
                  Back
                </button>
              )}
              <button
                onClick={handleSaveAndContinue}
                disabled={!credentialsCanContinue}
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

        {/* Connect GitHub (optional) */}
        {currentKey === 'github' && (
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

            {/* LAN / air-gapped mode. Lives at the top of Step 4 so users on
                private networks see the opt-out before the OAuth App and
                webhook setup blocks below. The same toggle is also on the
                Settings → GitHub page for post-setup changes. */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <h2 className="text-sm font-semibold text-white">LAN / air-gapped mode</h2>
                  <p className="text-xs text-gray-400 mt-1">
                    Turn this on if Agent Hub is on a private network where GitHub cannot reach it.
                    Webhook auto-registration is skipped; PR state is detected by polling GitHub
                    every 3 minutes using your personal access token. You can flip it back off any
                    time in Settings — nothing else changes.
                  </p>
                </div>
                <div className="shrink-0 pt-1" data-testid="lan-mode-toggle-wrapper">
                  <ToggleSwitch
                    enabled={lanMode}
                    onChange={(next) => {
                      if (lanModeSaving) return;
                      handleToggleLanMode(next);
                    }}
                  />
                </div>
              </div>
              {lanMode && (
                <div className="mt-3 bg-blue-900/20 border border-blue-700/40 rounded-lg p-2.5 text-xs text-blue-200">
                  <strong>LAN mode is on.</strong> Webhook setup below is optional — Agent Hub will
                  poll GitHub instead.
                </div>
              )}
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
                onClick={() => setStep(stepIndex('credentials'))}
                className="bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => setStep(stepIndex('project'))}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Create First Project */}
        {currentKey === 'project' && (
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
