import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Shield,
  Terminal,
} from 'lucide-react';
import { api } from '../utils/api';
import { StatusChip } from './MyClaudeAuthSection';

/**
 * Per-user Codex auth panel — combines the ChatGPT device-code flow
 * (mirrors the host-wide `CodexAuthSection`) with the paste-the-API-key
 * fallback in a single card. Replaces the previous pair of
 * `MyBrowserAuthSection` + `MySingleKeyAuthSection` mounts for Codex
 * inside `AccountSection.jsx`.
 *
 * Endpoints (see `server/routes/per-user-engine-auth.ts` + the per-user
 * paste-key surface in `server/routes/per-user-creds.ts`):
 *   - GET    /api/auth/me/codex-auth          → paste-key state ({apiKey, hostConfigFallback})
 *   - PUT    /api/auth/me/codex-auth          → save / clear paste key
 *   - GET    /api/auth/me/codex-auth/browser  → CLI cache state ({uiStatus, oauth.loggedIn})
 *   - POST   /api/auth/me/codex-auth/browser/device-login   → kick `codex login --device-auth`
 *   - POST   /api/auth/me/codex-auth/browser/cancel-login   → kill the in-flight login
 *   - DELETE /api/auth/me/codex-auth/browser                → `codex logout`
 *
 * Device flow returns `{deviceAuthUrl, userCode}` — the user-code is
 * displayed in a copy-friendly card so the user can paste it into the
 * verification page they opened.
 */
export default function MyCodexAuthSection() {
  // Device-login state ----------------------------------------------------
  const [browserAuth, setBrowserAuth] = useState<any>(null);
  const [browserLoading, setBrowserLoading] = useState(true);
  const [browserError, setBrowserError] = useState<any>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [deviceAuthUrl, setDeviceAuthUrl] = useState<any>(null);
  const [deviceUserCode, setDeviceUserCode] = useState<any>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [actionMsg, setActionMsg] = useState<any>(null);
  const loginTimersRef = useRef<any>({ intervalId: null, timeoutId: null });

  // Paste-key state -------------------------------------------------------
  const [pasteData, setPasteData] = useState<any>(null);
  const [pasteLoading, setPasteLoading] = useState(true);
  const [pasteError, setPasteError] = useState<any>(null);
  const [pasteUnauthenticated, setPasteUnauthenticated] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<any>(null);

  const clearLoginTimers = () => {
    const { intervalId, timeoutId } = loginTimersRef.current;
    if (intervalId !== null) clearInterval(intervalId);
    if (timeoutId !== null) clearTimeout(timeoutId);
    loginTimersRef.current = { intervalId: null, timeoutId: null };
  };

  const fetchBrowserAuth = useCallback(async () => {
    setBrowserError(null);
    try {
      const data = await api.getMyCodexBrowserAuth();
      setBrowserAuth(data);
    } catch (err: any) {
      setBrowserAuth(null);
      setBrowserError(err.message || 'Failed to load Codex sign-in status');
    } finally {
      setBrowserLoading(false);
    }
  }, []);

  const fetchPasteAuth = useCallback(async () => {
    setPasteError(null);
    try {
      const data = await api.getMyCodexAuth();
      setPasteData(data);
      setPasteUnauthenticated(false);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (/^401[:\s]/.test(msg) || /authentication required/i.test(msg)) {
        setPasteUnauthenticated(true);
        setPasteData(null);
      } else {
        setPasteError(msg);
        setPasteData(null);
      }
    } finally {
      setPasteLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBrowserAuth();
    fetchPasteAuth();
    return () => clearLoginTimers();
  }, [fetchBrowserAuth, fetchPasteAuth]);

  const handleDeviceLogin = async () => {
    clearLoginTimers();
    setLoginLoading(true);
    setDeviceAuthUrl(null);
    setDeviceUserCode(null);
    setActionMsg(null);
    try {
      const data = await api.startMyCodexDeviceLogin();
      if (data.deviceAuthUrl && data.userCode) {
        setDeviceAuthUrl(data.deviceAuthUrl);
        setDeviceUserCode(data.userCode);
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(data.deviceAuthUrl, '_blank');
        }
        const timeoutId = setTimeout(() => {
          clearLoginTimers();
          setLoginLoading(false);
        }, 900_000);
        const intervalId = setInterval(async () => {
          try {
            const st = await api.getMyCodexBrowserAuth();
            if (st.uiStatus === 'authenticated' || st.oauth?.loggedIn === true) {
              clearLoginTimers();
              setBrowserAuth(st);
              setDeviceAuthUrl(null);
              setDeviceUserCode(null);
              setLoginLoading(false);
              setActionMsg({ type: 'success', msg: 'Codex authenticated on this host.' });
            } else if (!st.loginInProgress) {
              clearLoginTimers();
              setBrowserAuth(st);
              setDeviceAuthUrl(null);
              setDeviceUserCode(null);
              setLoginLoading(false);
              setActionMsg({
                type: 'error',
                msg: st.statusError || 'Device login did not finish — try again.',
              });
            }
          } catch {
            /* keep polling */
          }
        }, 3000);
        loginTimersRef.current = { intervalId, timeoutId };
      } else {
        setLoginLoading(false);
        setActionMsg({
          type: 'error',
          msg: data.output || 'Could not start Codex device login.',
        });
      }
    } catch (err: any) {
      setLoginLoading(false);
      setActionMsg({ type: 'error', msg: err.message || 'Device login failed' });
    }
  };

  const handleCancel = async () => {
    clearLoginTimers();
    try {
      await api.cancelMyCodexDeviceLogin();
    } catch {
      /* ignore */
    }
    setLoginLoading(false);
    setDeviceAuthUrl(null);
    setDeviceUserCode(null);
    setActionMsg({ type: 'info', msg: 'Login cancelled.' });
    await fetchBrowserAuth();
  };

  const handleLogout = async () => {
    setLogoutLoading(true);
    setActionMsg(null);
    try {
      const result = await api.logoutMyCodex();
      setActionMsg({
        type: 'success',
        msg: result?.output || 'Signed out of Codex on this host.',
      });
      await fetchBrowserAuth();
    } catch (err: any) {
      setActionMsg({ type: 'error', msg: err.message || 'Logout failed' });
    } finally {
      setLogoutLoading(false);
    }
  };

  const handleCopyCode = async () => {
    if (!deviceUserCode) return;
    try {
      await navigator.clipboard.writeText(deviceUserCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const handleCopyUrl = async () => {
    if (!deviceAuthUrl) return;
    try {
      await navigator.clipboard.writeText(deviceAuthUrl);
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const handleSaveApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      const body = await api.putMyCodexAuth({ apiKey: apiKeyInput.trim() });
      setPasteData(body);
      setApiKeyStatus({ type: 'success', msg: body.apiKey ? 'Saved' : 'Cleared' });
      setApiKeyInput('');
    } catch (err: any) {
      setApiKeyStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setApiKeySaving(false);
    }
  };

  const handleClearApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      const body = await api.putMyCodexAuth({ apiKey: '' });
      setPasteData(body);
      setApiKeyStatus({ type: 'success', msg: 'Cleared' });
      setApiKeyInput('');
    } catch (err: any) {
      setApiKeyStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setApiKeySaving(false);
    }
  };

  if (browserLoading && pasteLoading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        Loading your Codex credentials…
      </div>
    );
  }

  if (pasteUnauthenticated) {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-2">
          <Terminal size={14} /> Personal Codex credentials
        </h4>
        <p className="text-xs text-gray-500">
          Sign in as a user (instead of the legacy global API key) to attach your own Codex
          credentials. Spawned sessions you own will use them instead of the host-wide
          configuration.
        </p>
      </div>
    );
  }

  const binaryMissing = browserAuth?.binary && browserAuth.binary.present === false;
  const signedInBrowser = browserAuth?.oauth?.loggedIn === true;
  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';

  const apiKeyMasked = pasteData?.apiKey || null;
  const apiKeyHostFallback = !!pasteData?.hostConfigFallback?.apiKey;

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-5" data-testid="my-codex-auth">
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Terminal size={14} /> Personal Codex credentials
        </h4>
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          Sign in with a ChatGPT-linked Codex account using device authorization, or paste an OpenAI
          API key for headless setups. Both override the host-wide{' '}
          <span className="text-gray-400">Settings → Codex Auth</span> for sessions you own.
        </p>
      </div>

      {/* ── ChatGPT device-code sign-in ────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="text-xs font-medium text-gray-300 flex items-center gap-2">
            <Shield size={12} /> ChatGPT sign-in (device code)
          </h5>
          {signedInBrowser && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
              Signed in
            </span>
          )}
        </div>

        {browserError && (
          <div
            role="alert"
            className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
          >
            {browserError}
          </div>
        )}

        {binaryMissing && (
          <div
            role="alert"
            className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 flex items-start gap-2"
          >
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>
              Codex CLI binary not found at <code>{browserAuth?.binary?.path}</code>. Configure the
              path in <span className="text-gray-400">Settings → General</span> before signing in.
            </span>
          </div>
        )}

        {deviceAuthUrl && deviceUserCode && (
          <div className="border border-indigo-500/30 bg-indigo-500/10 rounded p-3 space-y-2">
            <div>
              <div className="text-[11px] text-gray-400 mb-1">
                Enter this code on the verification page:
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  className="font-mono text-base text-white tracking-wider bg-gray-900 border border-gray-700 rounded px-3 py-2 inline-block select-all"
                  data-testid="codex-device-code"
                >
                  {deviceUserCode}
                </code>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  aria-label="Copy Codex device code"
                  className="text-[11px] text-gray-400 hover:text-white flex items-center gap-1 px-2 py-1 rounded border border-gray-700 hover:bg-gray-700"
                >
                  <Copy size={12} /> {codeCopied ? 'Copied' : 'Copy code'}
                </button>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-gray-400 mb-1">Verification page:</div>
              <a
                href={deviceAuthUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-indigo-300 hover:text-indigo-200 underline break-all flex items-center gap-1"
              >
                {deviceAuthUrl} <ExternalLink size={12} />
              </a>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="text-[11px] text-gray-400 hover:text-white flex items-center gap-1 mt-1"
              >
                <Copy size={12} /> {urlCopied ? 'Copied' : 'Copy link'}
              </button>
            </div>
            <div className="text-[11px] text-gray-400">
              Polling for completion… you can close this tab once you&apos;ve finished signing in.
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {signedInBrowser ? (
            <button
              type="button"
              onClick={handleLogout}
              disabled={logoutLoading}
              className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
            >
              {logoutLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <LogOut size={12} />
              )}
              Sign out
            </button>
          ) : loginLoading ? (
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-700"
            >
              <Loader2 size={12} className="animate-spin" /> Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDeviceLogin}
              disabled={binaryMissing}
              className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
            >
              <LogIn size={12} /> Sign in with browser
            </button>
          )}
        </div>

        {actionMsg && (
          <div
            role={actionMsg.type === 'success' ? 'status' : 'alert'}
            className={`text-[11px] rounded px-2 py-1 border ${
              actionMsg.type === 'success'
                ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                : actionMsg.type === 'error'
                  ? 'text-red-300 bg-red-500/10 border-red-500/30'
                  : 'text-gray-300 bg-gray-700/30 border-gray-600/40'
            }`}
          >
            {actionMsg.msg}
          </div>
        )}
      </div>

      <div className="h-px bg-gray-700/50" />

      {/* ── Paste API key fallback ──────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="text-xs font-medium text-gray-300 flex items-center gap-2">
            <Key size={12} /> Paste API key
          </h5>
          <StatusChip kind="api" mine={apiKeyMasked} hostFallback={apiKeyHostFallback} />
        </div>

        {pasteError && (
          <div
            role="alert"
            className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2"
          >
            <div className="flex items-center gap-2">
              <span className="flex-1">{pasteError}</span>
              <button
                type="button"
                onClick={() => {
                  setPasteLoading(true);
                  fetchPasteAuth();
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-300 hover:bg-gray-700"
              >
                <RefreshCw size={10} /> Retry
              </button>
            </div>
          </div>
        )}

        {apiKeyMasked && (
          <div className="flex items-center justify-between bg-gray-900 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span className="text-gray-300 font-mono">{apiKeyMasked}</span>
            </div>
            <button
              type="button"
              onClick={handleClearApiKey}
              disabled={apiKeySaving}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              aria-label="Clear my Codex API key"
            >
              {apiKeySaving ? '…' : 'Clear my API key'}
            </button>
          </div>
        )}

        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKeyInput}
            onChange={(e: any) => {
              setApiKeyInput(e.target.value);
              setApiKeyStatus(null);
            }}
            className={`${inputClass} pr-10 text-xs`}
            placeholder="sk-..."
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            aria-label="Codex API key"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1"
            aria-label={showApiKey ? 'Hide Codex API key' : 'Show Codex API key'}
          >
            {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSaveApiKey}
            disabled={!apiKeyInput.trim() || apiKeySaving}
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
          >
            {apiKeySaving ? <Loader2 size={12} className="animate-spin" /> : null}
            {apiKeySaving ? 'Saving…' : 'Save API key'}
          </button>
        </div>

        {apiKeyStatus && (
          <div
            role={apiKeyStatus.type === 'success' ? 'status' : 'alert'}
            className={`flex items-center gap-2 text-xs ${
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
  );
}
