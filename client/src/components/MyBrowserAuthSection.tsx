import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2, LogIn, LogOut, Shield, Terminal } from 'lucide-react';

/**
 * Per-user "Sign in with browser" panel — wraps `/api/auth/me/<engine>-auth/browser/*`
 * so each Hub user can sign in to Cursor / Codex under their own account.
 *
 * The host-wide equivalents (`/api/config/cursor-auth`, `/api/config/codex-auth`)
 * remain available to Admins on the Models page; they share the operator's
 * HOME and therefore the operator's CLI cache. The per-user routes spawn the
 * CLI with `HOME=<dataDir>/per-user-creds/<userId>/home` so the OAuth handshake
 * lands in the caller's own subtree and every downstream agent spawn owned by
 * the same user picks up the same credentials.
 *
 * Props:
 *   engine — 'cursor' | 'codex'
 *   getStatus, startLogin, cancelLogin, logout — per-engine API methods
 *   loginMode — 'oauth' (cursor) | 'device' (codex). Controls whether the
 *               server returns a `loginUrl` or a `deviceAuthUrl`+`userCode`.
 */
export default function MyBrowserAuthSection({
  engine,
  engineLabel,
  hostSettingHint,
  getStatus,
  startLogin,
  cancelLogin,
  logout,
  loginMode,
}: any) {
  const [auth, setAuth] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [loginUrl, setLoginUrl] = useState<any>(null);
  const [deviceCode, setDeviceCode] = useState<any>(null);
  const [actionMsg, setActionMsg] = useState<any>(null);
  const loginTimersRef = useRef<any>({ intervalId: null, timeoutId: null });

  const clearLoginTimers = () => {
    const { intervalId, timeoutId } = loginTimersRef.current;
    if (intervalId !== null) clearInterval(intervalId);
    if (timeoutId !== null) clearTimeout(timeoutId);
    loginTimersRef.current = { intervalId: null, timeoutId: null };
  };

  const fetchAuth = async () => {
    setError(null);
    try {
      const data = await getStatus();
      setAuth(data);
    } catch (err: any) {
      setAuth(null);
      setError(err.message || `Failed to load ${engineLabel} status`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuth();
    return () => clearLoginTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginPolling = () => {
    const timeoutId = setTimeout(() => {
      clearLoginTimers();
      setLoginLoading(false);
    }, 180_000);
    const intervalId = setInterval(async () => {
      try {
        const st = await getStatus();
        if (st.uiStatus === 'authenticated' || st.oauth?.loggedIn === true) {
          clearLoginTimers();
          setAuth(st);
          setLoginUrl(null);
          setDeviceCode(null);
          setLoginLoading(false);
          setActionMsg({ type: 'success', msg: `Signed in to ${engineLabel}.` });
        } else if (!st.loginInProgress) {
          clearLoginTimers();
          setAuth(st);
          setLoginUrl(null);
          setDeviceCode(null);
          setLoginLoading(false);
          setActionMsg({
            type: 'error',
            msg: st.statusError || 'Login did not finish — try again.',
          });
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    loginTimersRef.current = { intervalId, timeoutId };
  };

  const handleLogin = async () => {
    clearLoginTimers();
    setLoginLoading(true);
    setLoginUrl(null);
    setDeviceCode(null);
    setActionMsg(null);
    try {
      const data = await startLogin();
      if (loginMode === 'device') {
        if (data.deviceAuthUrl && data.userCode) {
          setLoginUrl(data.deviceAuthUrl);
          setDeviceCode(data.userCode);
          window.open(data.deviceAuthUrl, '_blank');
          beginPolling();
        } else {
          setLoginLoading(false);
          setActionMsg({
            type: 'error',
            msg: data.output || `Could not start ${engineLabel} device login.`,
          });
        }
      } else {
        if (data.loginUrl) {
          setLoginUrl(data.loginUrl);
          window.open(data.loginUrl, '_blank');
          beginPolling();
        } else if (data.completed) {
          await fetchAuth();
          setLoginLoading(false);
          setActionMsg({ type: 'success', msg: `Signed in to ${engineLabel}.` });
        } else {
          setLoginLoading(false);
          setActionMsg({
            type: 'error',
            msg: data.output || `Could not start ${engineLabel} login.`,
          });
        }
      }
    } catch (err: any) {
      setLoginLoading(false);
      setActionMsg({ type: 'error', msg: err.message || 'Login failed' });
    }
  };

  const handleCancel = async () => {
    clearLoginTimers();
    try {
      await cancelLogin();
    } catch {
      /* ignore */
    }
    setLoginLoading(false);
    setLoginUrl(null);
    setDeviceCode(null);
    setActionMsg({ type: 'info', msg: 'Login cancelled.' });
    await fetchAuth();
  };

  const handleLogout = async () => {
    setLogoutLoading(true);
    setActionMsg(null);
    try {
      const result = await logout();
      setActionMsg({
        type: 'success',
        msg: result.output || `Signed out of ${engineLabel}.`,
      });
      await fetchAuth();
    } catch (err: any) {
      setActionMsg({ type: 'error', msg: err.message || 'Logout failed' });
    } finally {
      setLogoutLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        Loading {engineLabel} sign-in…
      </div>
    );
  }

  const binaryMissing = auth && auth.binary && auth.binary.present === false;
  const signedIn = auth && auth.oauth && auth.oauth.loggedIn === true;
  const Icon = engine === 'codex' ? Shield : Terminal;

  return (
    <div className="bg-gray-800 rounded-xl p-4" data-testid={`my-browser-auth-${engine}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Icon size={14} /> {engineLabel} — sign in with browser
        </h4>
        {signedIn && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            Signed in
          </span>
        )}
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
        Pop a browser window and sign in to {engineLabel} under your own account. The CLI tokens are
        stored under your per-user cache (
        <code className="text-gray-400">{`<dataDir>/per-user-creds/<your id>/home`}</code>), so
        every spawn owned by you uses the same credentials. The host-wide <em>{hostSettingHint}</em>{' '}
        stays available for Admins who want a shared operator account.
      </p>

      {binaryMissing && (
        <div
          role="alert"
          className="mb-3 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 flex items-start gap-2"
        >
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            CLI binary not found at <code>{auth.binary.path}</code>. Configure the binary path in
            Settings → General before signing in.
          </span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-3 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
        >
          {error}
        </div>
      )}

      {actionMsg && (
        <div
          role="status"
          className={`mb-3 text-[11px] rounded px-2 py-1 border ${
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

      {loginUrl && (
        <div className="mb-3 border border-indigo-500/30 bg-indigo-500/10 rounded p-3 space-y-2">
          {deviceCode && (
            <div>
              <div className="text-[11px] text-gray-400 mb-1">Enter this code in the browser:</div>
              <div className="font-mono text-base text-white tracking-wider bg-gray-900 border border-gray-700 rounded px-3 py-2 inline-block select-all">
                {deviceCode}
              </div>
            </div>
          )}
          <a
            href={loginUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200 underline break-all"
          >
            <ExternalLink size={12} /> {loginUrl}
          </a>
          <div className="text-[11px] text-gray-400">
            Polling for completion… you can close this tab once you&apos;ve finished signing in.
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {signedIn ? (
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutLoading}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
          >
            {logoutLoading ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
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
            onClick={handleLogin}
            disabled={binaryMissing}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
          >
            <LogIn size={12} /> Sign in with browser
          </button>
        )}
      </div>
    </div>
  );
}
