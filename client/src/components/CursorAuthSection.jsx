import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api.js';
import { Loader2, Shield, AlertCircle, Copy, ExternalLink, LogIn, LogOut } from 'lucide-react';

/**
 * Cursor Agent — `cursor-agent login` with NO_OPEN_BROWSER on the Hub host
 * (see `agent login --help` from the Cursor Agent CLI).
 *
 * Props:
 *   onAuthChange — optional callback fired with the latest auth payload
 *     after every internal fetch. The setup wizard uses this so its own
 *     `cursorCredsConfigured` gate refreshes when the user completes the
 *     browser-login flow inside an embedded copy of this section.
 */
export default function CursorAuthSection({ onAuthChange }) {
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [loginUrl, setLoginUrl] = useState(null);
  const [copied, setCopied] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const loginTimersRef = useRef({ intervalId: null, timeoutId: null });

  const clearLoginTimers = () => {
    const { intervalId, timeoutId } = loginTimersRef.current;
    if (intervalId !== null) clearInterval(intervalId);
    if (timeoutId !== null) clearTimeout(timeoutId);
    loginTimersRef.current = { intervalId: null, timeoutId: null };
  };

  const fetchAuth = async () => {
    setError(null);
    try {
      const data = await api.getCursorAuth();
      setAuth(data);
      if (typeof onAuthChange === 'function') onAuthChange(data);
    } catch (err) {
      setAuth(null);
      setError(err.message || 'Failed to load Cursor Agent auth status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuth();
  }, []);

  useEffect(
    () => () => {
      clearLoginTimers();
    },
    [],
  );

  const handleLogin = async () => {
    clearLoginTimers();
    setLoginLoading(true);
    setLoginUrl(null);
    setActionMsg(null);
    try {
      const data = await api.startCursorLogin();
      if (data.loginUrl) {
        setLoginUrl(data.loginUrl);
        window.open(data.loginUrl, '_blank');
        const timeoutId = setTimeout(() => {
          clearLoginTimers();
          setLoginLoading(false);
        }, 120_000);
        const intervalId = setInterval(async () => {
          try {
            const st = await api.getCursorAuth();
            if (st.uiStatus === 'authenticated') {
              clearLoginTimers();
              setAuth(st);
              if (typeof onAuthChange === 'function') onAuthChange(st);
              setLoginUrl(null);
              setLoginLoading(false);
              setActionMsg({ type: 'success', msg: 'Authenticated with Cursor Agent.' });
            } else if (!st.loginInProgress) {
              clearLoginTimers();
              setAuth(st);
              if (typeof onAuthChange === 'function') onAuthChange(st);
              setLoginUrl(null);
              setLoginLoading(false);
              if (st.uiStatus !== 'authenticated') {
                setActionMsg({
                  type: 'error',
                  msg: st.statusError || 'Login did not finish — try again or check the link.',
                });
              }
            }
          } catch {
            /* keep polling */
          }
        }, 3000);
        loginTimersRef.current = { intervalId, timeoutId };
      } else if (data.completed) {
        await fetchAuth();
        setLoginLoading(false);
      } else {
        setLoginLoading(false);
        setActionMsg({ type: 'error', msg: data.output || 'Could not start Cursor login.' });
      }
    } catch (err) {
      setLoginLoading(false);
      setActionMsg({ type: 'error', msg: err.message || 'Login failed' });
    }
  };

  const handleCancel = async () => {
    clearLoginTimers();
    try {
      await api.cancelCursorLogin();
    } catch {
      /* ignore */
    }
    setLoginLoading(false);
    setLoginUrl(null);
    setActionMsg(null);
  };

  const handleLogout = async () => {
    setLogoutLoading(true);
    setActionMsg(null);
    try {
      await api.logoutCursor();
      await fetchAuth();
      setActionMsg({ type: 'success', msg: 'Signed out of Cursor Agent on this host.' });
    } catch (err) {
      setActionMsg({ type: 'error', msg: err.message || 'Logout failed' });
    }
    setLogoutLoading(false);
  };

  const handleCopyUrl = () => {
    if (!loginUrl) return;
    navigator.clipboard.writeText(loginUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
        <Loader2 size={16} className="animate-spin" />
        <span>Loading Cursor Agent auth…</span>
      </div>
    );
  }

  if (error && !auth) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
        <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
          <AlertCircle size={16} />
          <span className="font-medium">Failed to load Cursor Agent auth</span>
        </div>
        <p className="text-xs text-gray-400">{error}</p>
      </div>
    );
  }

  const ui = auth?.uiStatus || 'missing';
  const badge =
    ui === 'authenticated'
      ? 'bg-emerald-500/15 text-emerald-400'
      : ui === 'pending'
        ? 'bg-amber-500/15 text-amber-400'
        : 'bg-red-500/15 text-red-400';

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">Cursor Agent Authentication</h3>
        <p className="text-xs text-gray-500 mb-4">
          Runs <code>cursor-agent login</code> on the Agent Hub host with{' '}
          <code>NO_OPEN_BROWSER=1</code>. Open the link in your browser (see{' '}
          <code>agent login --help</code>). Tokens stay on the server under your Cursor account for
          this machine.
        </p>
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <Shield size={16} /> Status
          </h4>
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${badge}`}>
            {ui === 'authenticated'
              ? 'Authenticated'
              : ui === 'pending'
                ? 'Pending login'
                : 'Missing'}
          </span>
        </div>
        {auth?.statusError && ui !== 'authenticated' && (
          <p className="text-xs text-amber-400/90">{auth.statusError}</p>
        )}
        {auth?.oauth?.email && (
          <p className="text-xs text-gray-400">
            Signed in as <span className="text-gray-200">{auth.oauth.email}</span>
          </p>
        )}
        <p className="text-xs text-gray-500 font-mono break-all">Binary: {auth?.binary?.path}</p>
      </div>

      {loginUrl && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-2">
          <p className="text-xs text-gray-400">Complete sign-in in your browser:</p>
          <a
            href={loginUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-400 hover:underline break-all flex items-center gap-1"
          >
            {loginUrl} <ExternalLink size={12} />
          </a>
          <button
            type="button"
            onClick={handleCopyUrl}
            className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
          >
            <Copy size={12} /> {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleLogin}
          disabled={loginLoading || !auth?.binary?.present}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
        >
          {loginLoading && <Loader2 size={14} className="animate-spin" />}
          <LogIn size={14} />
          {loginLoading ? 'Waiting…' : 'Sign in with browser'}
        </button>
        {loginLoading && (
          <button
            type="button"
            onClick={handleCancel}
            className="text-sm text-gray-400 hover:text-white px-3 py-2"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleLogout}
          disabled={logoutLoading || ui !== 'authenticated'}
          className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg"
        >
          {logoutLoading && <Loader2 size={14} className="animate-spin" />}
          <LogOut size={14} />
          Sign out on host
        </button>
      </div>

      {actionMsg && (
        <p
          className={`text-xs ${actionMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {actionMsg.msg}
        </p>
      )}
    </div>
  );
}
