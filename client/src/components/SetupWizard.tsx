import { useState, useEffect } from 'react';
import { Bot, Rocket, Loader2, UserPlus, Lock } from 'lucide-react';
import { getApiBase, getAuthHeaders, getConnectionConfig } from '../utils/connection';
import { setup as setupHubAuth, login as loginHubAuth } from '../utils/auth';
import { createOrg, switchOrg, getActiveOrg, updateOrg } from '../utils/orgs';
import GithubConnectionSection from './GithubConnectionSection';
import MyClaudeAuthSection from './MyClaudeAuthSection';
import MyCursorAuthSection from './MyCursorAuthSection';
import MyCodexAuthSection from './MyCodexAuthSection';
import MyGrokAuthSection from './MyGrokAuthSection';

const DEFAULT_ORG_NAME = 'Personal';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Step keys and labels when Hub owner auth is not configured yet. */
export function getSetupWizardStepPlan(setupStatus: any) {
  const needsHubAccount = setupStatus?.authConfigured === false;
  const stepKeys = needsHubAccount
    ? ['account', 'welcome', 'credentials', 'github', 'project']
    : ['welcome', 'credentials', 'github', 'project'];
  const stepLabels = needsHubAccount
    ? ['Hub account', 'Welcome', 'AI engines', 'GitHub (optional)', 'First Project']
    : ['Welcome', 'AI engines', 'GitHub (optional)', 'First Project'];
  return { stepKeys, stepLabels, needsHubAccount };
}

/** 1-based step index for a logical step key (used by App.jsx initialStep). */
export function stepIndexForKey(setupStatus: any, key: any) {
  const { stepKeys } = getSetupWizardStepPlan(setupStatus);
  const idx = stepKeys.indexOf(key);
  return idx >= 0 ? idx + 1 : 1;
}

function StepIndicator({ currentStep, minStep = 1, stepLabels }: any) {
  return (
    <div className="flex items-center justify-center gap-3 mb-8">
      {stepLabels.map((label: any, i: any) => {
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

function ToggleSwitch({ enabled, onChange, label }: any) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
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

export default function SetupWizard({ onComplete, setupStatus, initialStep = 1 }: any) {
  // `initialStep` lets the host (App.jsx) jump the wizard to AI engines
  // when an org already exists but the user has no usable AI engine enabled
  // (e.g. fresh sandbox reset). The minimum back-target stays pinned to
  // `initialStep` so users can't navigate to earlier steps that were
  // intentionally skipped.
  const { stepKeys, stepLabels } = getSetupWizardStepPlan(setupStatus);
  const stepIndex = (key: any) => {
    const idx = stepKeys.indexOf(key);
    return idx >= 0 ? idx + 1 : 1;
  };

  const [step, setStep] = useState(initialStep);
  const currentKey = stepKeys[step - 1] ?? stepKeys[0];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<any>(null);

  // Hub owner account (first step when authConfigured is false)
  const [hubUsername, setHubUsername] = useState('');
  const [hubPassword, setHubPassword] = useState('');

  const claudeEngine = setupStatus?.engines?.['claude-code'] || {};
  const cursorEngine = setupStatus?.engines?.['cursor-agent'] || {};
  const codexEngine = setupStatus?.engines?.['codex-cli'] || {};
  const grokEngine = setupStatus?.engines?.['grok-cli'] || {};

  const [claudePath, setClaudePath] = useState(claudeEngine.path || '');
  const [claudeEnabled, setClaudeEnabled] = useState(claudeEngine.available || false);
  const [cursorPath, setCursorPath] = useState(cursorEngine.path || '');
  const [cursorEnabled, setCursorEnabled] = useState(cursorEngine.available || false);
  const [codexPath, setCodexPath] = useState(codexEngine.path || '');
  const [codexEnabled, setCodexEnabled] = useState(codexEngine.available || false);
  const [grokPath, setGrokPath] = useState(grokEngine.path || '');
  const [grokEnabled, setGrokEnabled] = useState(grokEngine.available || false);

  useEffect(() => {
    const c = setupStatus?.engines?.['claude-code'];
    const u = setupStatus?.engines?.['cursor-agent'];
    const x = setupStatus?.engines?.['codex-cli'];
    const g = setupStatus?.engines?.['grok-cli'];
    if (c?.path != null && c.path !== '') setClaudePath(c.path);
    if (typeof c?.available === 'boolean') setClaudeEnabled(c.available);
    if (u?.path != null && u.path !== '') setCursorPath(u.path);
    if (typeof u?.available === 'boolean') setCursorEnabled(u.available);
    if (x?.path != null && x.path !== '') setCodexPath(x.path);
    if (typeof x?.available === 'boolean') setCodexEnabled(x.available);
    if (g?.path != null && g.path !== '') setGrokPath(g.path);
    if (typeof g?.available === 'boolean') setGrokEnabled(g.available);
  }, [setupStatus]);

  const anyEngineEnabled = claudeEnabled || cursorEnabled || codexEnabled || grokEnabled;

  /** Ensure a default local org exists (no naming step in first-run wizard). */
  const ensureDefaultOrg = async () => {
    const existing = getActiveOrg();
    if (existing) {
      // The server seeds a `default` org on first boot — that's enough to
      // continue onboarding. Avoid a PUT here: after Owner creation the
      // client must send a JWT, and an interrupted first-run (or a setup
      // that failed to seed the users row) used to 401 on this call and
      // abort the Welcome step.
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

  const handleHubAccountContinue = async (e: any) => {
    e.preventDefault();
    // Read from the form DOM (FormData), not React state. Password managers
    // (Bitwarden generate / autofill) write the <input> value without always
    // firing React onChange — controlled-state submits then send a stale /
    // empty password, create a half-baked Owner, and kick the user out of
    // the wizard. FormData sees what the user actually sees in the fields.
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const username = String(fd.get('hub-email') || hubUsername).trim();
    const password = String(fd.get('hub-password') || hubPassword);
    // Keep React state in sync so validation UI stays honest after autofill.
    if (username !== hubUsername) setHubUsername(username);
    if (password !== hubPassword) setHubPassword(password);
    if (!isValidEmail(username) || password.length < 12) {
      setError('Email and a password of at least 12 characters are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // When the server still has a legacy global `X-API-Key` configured
      // (the pre-JWT install), `/api/auth/setup` requires it as
      // break-glass proof so the migration to Owner-tracked auth can
      // run. Plain fresh installs (no key stored) pass `''` and the
      // header is omitted — `client/src/utils/auth.js#setup` only
      // attaches it when truthy.
      const { apiKey = '' } = getConnectionConfig();
      const sanitizedApiKey = apiKey.replace(/\s+/g, '').replace(/^["']+|["']+$/g, '');
      try {
        await setupHubAuth({
          baseUrl: getApiBase(),
          username,
          password,
          apiKey: sanitizedApiKey,
        });
      } catch (setupErr: any) {
        // Interrupted / double-submit after Owner already exists (password
        // manager autofill often fires submit twice). Fall through to login
        // with the same credentials so the wizard can continue.
        const msg = String(setupErr?.message || '');
        if (!/already configured/i.test(msg)) throw setupErr;
        await loginHubAuth({ baseUrl: getApiBase(), username, password });
      }
      setHubPassword('');
      setStep(stepIndex('welcome'));
    } catch (err: any) {
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
    } catch (err: any) {
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
          grokBin: grokEnabled ? grokPath.trim() : '',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Configuration failed: ${res.status}`);
      }

      setStep(stepIndex('github'));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const pathsOk =
    (!claudeEnabled || claudePath.trim()) &&
    (!cursorEnabled || cursorPath.trim()) &&
    (!codexEnabled || codexPath.trim()) &&
    (!grokEnabled || grokPath.trim());

  const credentialsCanContinue = anyEngineEnabled && pathsOk && !saving;

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
                This email and password protect Agent Hub on this machine — API access, settings,
                and org data. Pick something strong; you can add more users later in Settings.
              </p>
            </div>
            <form
              onSubmit={handleHubAccountContinue}
              className="space-y-3"
              autoComplete="off"
              data-bwignore="true"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
            >
              <div>
                <label htmlFor="hub-account-username" className="block text-xs text-gray-400 mb-1">
                  Email
                </label>
                <input
                  id="hub-account-username"
                  name="hub-email"
                  data-testid="hub-account-username"
                  type="email"
                  value={hubUsername}
                  onChange={(e: any) => setHubUsername(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  data-bwignore="true"
                  data-lpignore="true"
                  data-1p-ignore="true"
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
                  name="hub-password"
                  data-testid="hub-account-password"
                  type="password"
                  value={hubPassword}
                  onChange={(e: any) => setHubPassword(e.target.value)}
                  autoComplete="new-password"
                  data-bwignore="true"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  required
                  minLength={12}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
                <p className="text-[10px] text-gray-500 mt-1">
                  12–256 characters. This credential protects everything served from this
                  environment. Prefer typing or pasting — password-manager autofill can interrupt
                  first-run setup.
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
                disabled={saving || !isValidEmail(hubUsername) || hubPassword.length < 12}
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
                Your self-hosted home for teams of AI agents — and their git. Host projects right
                here: clone, push, open and review pull requests, and run CI, all on the Hub. Agents
                take work from idea to reviewed, tested, merged code without leaving it. First
                we&apos;ll enable your AI engines (Claude, Cursor, Codex, or Grok); you&apos;ll sign
                in to your own account later in Settings → Account. Want a GitHub presence too? You
                can mirror any Hub repo to GitHub — it&apos;s optional, not required.
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

        {/* AI engines */}
        {currentKey === 'credentials' && (
          <div className="space-y-5">
            <div className="text-center mb-2">
              <h1 className="text-xl font-bold text-white mb-1">Choose Your AI Engines</h1>
              <p className="text-gray-400 text-sm">
                Enable at least one engine, then sign in to it right here. Each login is personal to
                your account — no shared host credentials are configured. You can revisit these
                anytime in Settings → Account.
              </p>
            </div>

            {/* Claude Code Card */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-purple-500 inline-block" />
                  <span className="font-medium text-white text-sm">Claude Code</span>
                </div>
                <ToggleSwitch
                  enabled={claudeEnabled}
                  onChange={setClaudeEnabled}
                  label="Enable Claude Code"
                />
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
              {claudeEnabled && !claudeEngine.available && (
                <input
                  type="text"
                  value={claudePath}
                  onChange={(e: any) => setClaudePath(e.target.value)}
                  placeholder="/path/to/claude"
                  aria-label="Claude Code binary path"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              )}
            </div>

            {/* Sign in to Claude inline once the engine is enabled. */}
            {claudeEnabled && <MyClaudeAuthSection />}

            {/* Cursor Agent card */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-sky-500 inline-block" />
                  <span className="font-medium text-white text-sm">Cursor Agent</span>
                </div>
                <ToggleSwitch
                  enabled={cursorEnabled}
                  onChange={setCursorEnabled}
                  label="Enable Cursor Agent"
                />
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
              {cursorEnabled && !cursorEngine.available && (
                <input
                  type="text"
                  value={cursorPath}
                  onChange={(e: any) => setCursorPath(e.target.value)}
                  placeholder="/path/to/cursor-agent"
                  aria-label="Cursor Agent binary path"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              )}
            </div>

            {/* Sign in to Cursor inline once the engine is enabled. */}
            {cursorEnabled && <MyCursorAuthSection />}

            {/* Codex CLI card */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-amber-500 inline-block" />
                  <span className="font-medium text-white text-sm">Codex CLI</span>
                </div>
                <ToggleSwitch
                  enabled={codexEnabled}
                  onChange={setCodexEnabled}
                  label="Enable Codex CLI"
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
              {codexEnabled && !codexEngine.available && (
                <input
                  type="text"
                  value={codexPath}
                  onChange={(e: any) => setCodexPath(e.target.value)}
                  placeholder="/path/to/codex"
                  aria-label="Codex CLI binary path"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              )}
            </div>

            {/* Sign in to Codex inline once the engine is enabled. */}
            {codexEnabled && <MyCodexAuthSection />}

            {/* Grok CLI card */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-gray-300 inline-block" />
                  <span className="font-medium text-white text-sm">Grok CLI</span>
                </div>
                <ToggleSwitch
                  enabled={grokEnabled}
                  onChange={setGrokEnabled}
                  label="Enable Grok CLI"
                />
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                {grokEngine.available ? (
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
                    <span className="text-emerald-400">Detected at {grokEngine.path}</span>
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
              {grokEnabled && !grokEngine.available && (
                <input
                  type="text"
                  value={grokPath}
                  onChange={(e: any) => setGrokPath(e.target.value)}
                  placeholder="/path/to/grok"
                  aria-label="Grok CLI binary path"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              )}
            </div>

            {/* Sign in to Grok inline once the engine is enabled. */}
            {grokEnabled && <MyGrokAuthSection />}

            {!anyEngineEnabled && (
              <p className="text-yellow-400 text-xs text-center">
                Turn on at least one engine (Claude Code, Cursor Agent, Codex CLI, or Grok CLI) to
                continue.
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
              <h1 className="text-xl font-bold text-white mb-1">GitHub (optional)</h1>
              <p className="text-gray-400 text-sm">
                Agent Hub hosts your repo natively — clone, push, PRs, reviews, and CI all work
                without GitHub. If you also want a GitHub presence (for downstream Actions or
                deploys), paste a personal access token to connect your account and mirror Hub repos
                one-way to GitHub. Each user connects their own account. You can skip this and
                finish it later in Settings.
              </p>
            </div>

            {/* Setup uses the simple PAT paste flow. OAuth App registration
                lives in Settings for operators who want "Sign in with GitHub". */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <GithubConnectionSection embedded patOnly />
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
                Host a new repo on the Hub, import an existing one, or clone from a URL — the
                project wizard walks you through it next.
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
