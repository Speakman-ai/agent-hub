import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Copy, ExternalLink, Loader2, LogIn, LogOut, Sparkles } from 'lucide-react';
import { api } from '../utils/api';
import { notifyEngineAuthChanged } from '../utils/engineAuthEvents';

/** How often to re-check status while the user approves the device code. */
const POLL_MS = 3000;
/** Muse device codes expire after at most 30 minutes; stop polling then. */
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

interface MuseBrowserAuth {
  uiStatus: 'missing' | 'pending' | 'authenticated';
  binary: { present: boolean; path: string };
  auth: { loggedIn: boolean | null; mode: 'oauth' | 'apikey' | 'unknown' | null };
  loginInProgress: boolean;
  statusError: string | null;
}

type ActionMsg = { type: 'success' | 'error' | 'info'; msg: string } | null;

/**
 * Per-user Muse Code (Meta) sign-in. `muse login` runs on the Hub under the
 * caller's own HOME and prints a Meta device code; the user approves it in
 * their browser and every Muse session they own picks up the token.
 * Routes: server/routes/per-user-muse-auth.ts.
 */
export default function MyMuseAuthSection({ bare = false }: { bare?: boolean } = {}) {
  const shellClass = bare ? '' : 'bg-gray-800 rounded-xl p-4';
  const [status, setStatus] = useState<MuseBrowserAuth | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [device, setDevice] = useState<{ url: string; code: string } | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [actionMsg, setActionMsg] = useState<ActionMsg>(null);
  // Async results are only committed when they still belong to the current
  // state of the panel:
  //   - `statusSeq` numbers every status request; only the newest one may write
  //     state, so an older response that lands late cannot undo a newer one.
  //   - `loginGen` names the current sign-in flow. Starting, finishing,
  //     cancelling, and unmounting all move it on, which turns any step still
  //     in flight from the previous flow into a no-op.
  //   - `loginId` is the server's id for the running `muse login`. Cancels name
  //     it, so a cancel can only ever stop the attempt it was meant for; the
  //     generation counter alone cannot stop a server-side kill.
  const mounted = useRef(true);
  const loginId = useRef<string | null>(null);
  const statusSeq = useRef(0);
  const loginGen = useRef(0);
  const pollTimer = useRef<number | null>(null);
  const expiryTimer = useRef<number | null>(null);

  const stopTimers = () => {
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    if (expiryTimer.current !== null) window.clearTimeout(expiryTimer.current);
    pollTimer.current = null;
    expiryTimer.current = null;
  };

  /** Fetch status; resolves to null when the response was superseded or failed. */
  const fetchStatus = useCallback(async (): Promise<MuseBrowserAuth | null> => {
    const seq = ++statusSeq.current;
    const isLatest = () => mounted.current && statusSeq.current === seq;
    try {
      const data = (await api.getMyMuseBrowserAuth()) as MuseBrowserAuth;
      if (!isLatest()) return null;
      setStatus(data);
      setUnauthenticated(false);
      setLoadError(null);
      return data;
    } catch (err: any) {
      if (!isLatest()) return null;
      const msg = err?.message || String(err);
      if (/^401[:\s]/.test(msg) || /authentication required/i.test(msg)) {
        setUnauthenticated(true);
      } else {
        setLoadError(msg || 'Failed to load Muse sign-in status');
      }
      setStatus(null);
      return null;
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    fetchStatus();
    return () => {
      mounted.current = false;
      loginGen.current += 1;
      stopTimers();
    };
  }, [fetchStatus]);

  /** End the current sign-in flow; anything still in flight for it is dropped. */
  const endLogin = (msg: ActionMsg) => {
    loginGen.current += 1;
    loginId.current = null;
    stopTimers();
    if (!mounted.current) return;
    setDevice(null);
    setLoginLoading(false);
    setActionMsg(msg);
    if (msg?.type === 'success') notifyEngineAuthChanged();
  };

  const handleLogin = async () => {
    if (cancelling) return;
    stopTimers();
    const gen = ++loginGen.current;
    const isCurrent = () => mounted.current && loginGen.current === gen;
    setLoginLoading(true);
    setDevice(null);
    setActionMsg(null);
    let data: any;
    try {
      data = await api.startMyMuseDeviceLogin();
    } catch (err: any) {
      if (isCurrent()) endLogin({ type: 'error', msg: err?.message || 'Muse sign-in failed' });
      return;
    }
    if (!isCurrent()) {
      // Abandoned while the request was in flight (cancel or unmount). Stop
      // exactly that server-side login so it is not left waiting.
      if (typeof data?.loginId === 'string') {
        api.cancelMyMuseDeviceLogin(data.loginId).catch(() => {});
      }
      return;
    }
    if (typeof data?.loginId === 'string') loginId.current = data.loginId;
    if (!data?.deviceAuthUrl || !data?.userCode) {
      endLogin({
        type: 'error',
        msg: data?.output || data?.error || 'Could not start Muse login.',
      });
      return;
    }
    setDevice({ url: data.deviceAuthUrl, code: data.userCode });
    // The URL comes from CLI output; the server only passes Meta hosts, and
    // noopener keeps the new tab from reaching back into this one.
    const win = window.open(data.deviceAuthUrl, '_blank', 'noopener,noreferrer');
    if (win) win.opener = null;

    expiryTimer.current = window.setTimeout(() => {
      if (isCurrent())
        endLogin({ type: 'error', msg: 'The Muse sign-in code expired. Try again.' });
    }, POLL_TIMEOUT_MS);

    // One status request at a time: the next poll is scheduled only after the
    // previous one has settled.
    const poll = async () => {
      pollTimer.current = null;
      const st = await fetchStatus();
      if (!isCurrent()) return;
      if (st?.uiStatus === 'authenticated') {
        endLogin({ type: 'success', msg: 'Signed in to Muse Code.' });
      } else if (st && !st.loginInProgress) {
        endLogin({ type: 'error', msg: 'Muse sign-in did not finish. Try again.' });
      } else {
        pollTimer.current = window.setTimeout(poll, POLL_MS);
      }
    };
    pollTimer.current = window.setTimeout(poll, POLL_MS);
  };

  const handleCancel = async () => {
    // Null when the start request has not answered yet; the unscoped cancel is
    // safe then because sign-in stays disabled until this cancel settles.
    const id = loginId.current;
    endLogin({ type: 'info', msg: 'Sign-in cancelled.' });
    setCancelling(true);
    try {
      await api.cancelMyMuseDeviceLogin(id ?? undefined);
    } catch {
      /* the login may already have ended */
    } finally {
      if (mounted.current) setCancelling(false);
    }
    if (mounted.current) await fetchStatus();
  };

  const handleLogout = async () => {
    setLogoutLoading(true);
    setActionMsg(null);
    try {
      const result = await api.logoutMyMuse();
      if (!mounted.current) return;
      setActionMsg({ type: 'success', msg: result?.output || 'Signed out of Muse Code.' });
      notifyEngineAuthChanged();
      await fetchStatus();
    } catch (err: any) {
      if (mounted.current) setActionMsg({ type: 'error', msg: err?.message || 'Sign-out failed' });
    } finally {
      if (mounted.current) setLogoutLoading(false);
    }
  };

  const handleCopyCode = async () => {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.code);
      if (!mounted.current) return;
      setCodeCopied(true);
      window.setTimeout(() => {
        if (mounted.current) setCodeCopied(false);
      }, 2000);
    } catch {
      /* clipboard blocked; the code is still selectable */
    }
  };

  const heading = (
    <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
      <Sparkles size={14} /> Muse Code (Meta)
    </h4>
  );

  if (loading) {
    return (
      <div className={`${shellClass} flex items-center gap-2 text-sm text-gray-400`}>
        <Loader2 size={14} className="animate-spin" />
        Loading your Muse Code sign-in…
      </div>
    );
  }

  if (unauthenticated) {
    return (
      <div className={shellClass}>
        {heading}
        <p className="text-xs text-gray-500 mt-2">
          Sign in as a user to connect your own Meta account for Muse Code sessions.
        </p>
      </div>
    );
  }

  const binaryMissing = status?.binary?.present === false;
  const signedIn = status?.uiStatus === 'authenticated';

  return (
    <div className={`${shellClass} space-y-3`} data-testid="my-muse-auth">
      <div className="flex items-center justify-between">
        {heading}
        {signedIn && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            {status?.auth?.mode === 'apikey' ? 'API key' : 'Signed in'}
          </span>
        )}
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Sign in with your Meta developer account. Muse Code sessions you own run on this login.
      </p>

      {loadError && (
        <div
          role="alert"
          className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
        >
          {loadError}
        </div>
      )}

      {binaryMissing && (
        <div
          role="alert"
          className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 flex items-start gap-2"
        >
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            Muse CLI not found at <code>{status?.binary?.path}</code>. Set the path in{' '}
            <span className="text-gray-400">Settings → General</span> before signing in.
          </span>
        </div>
      )}

      {device && (
        <div className="border border-indigo-500/30 bg-indigo-500/10 rounded p-3 space-y-2">
          <div className="text-[11px] text-gray-400">
            Confirm this code on the Meta sign-in page:
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="font-mono text-base text-white tracking-wider bg-gray-900 border border-gray-700 rounded px-3 py-2 select-all"
              data-testid="muse-device-code"
            >
              {device.code}
            </code>
            <button
              type="button"
              onClick={handleCopyCode}
              aria-label="Copy Muse device code"
              className="text-[11px] text-gray-400 hover:text-white flex items-center gap-1 px-2 py-1 rounded border border-gray-700 hover:bg-gray-700"
            >
              <Copy size={12} /> {codeCopied ? 'Copied' : 'Copy code'}
            </button>
          </div>
          <a
            href={device.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-indigo-300 hover:text-indigo-200 underline break-all flex items-center gap-1"
          >
            {device.url} <ExternalLink size={12} />
          </a>
          <div className="text-[11px] text-gray-400">Waiting for you to approve…</div>
        </div>
      )}

      <div className="flex items-center gap-2">
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
            disabled={binaryMissing || cancelling}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
          >
            <LogIn size={12} /> Sign in with Meta
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
  );
}
