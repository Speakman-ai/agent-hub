import { useEffect, useState } from 'react';
import { Loader2, Monitor, Cloud, Plug, ArrowLeft } from 'lucide-react';
import {
  getConnectionConfig,
  saveConnectionConfig,
  testConnection,
  getApiBase,
  getAuthHeaders,
} from '../utils/connection';
import { isAuthenticated } from '../utils/auth';

/**
 * Pre-setup "Connect to server" gate for Electron.
 *
 * Renders before the first-run SetupWizard so users on a second machine can
 * point the desktop app at an existing remote Agent Hub server instead of
 * being force-marched through creating a new local account.
 *
 * Gating conditions — ALL must be true to show the chooser:
 *   1. Running in Electron (browser users hit a server URL directly; N/A)
 *   2. Connection config is still default (`mode: 'local'`, no remoteUrl)
 *   3. No JWT stored (user isn't already signed in)
 *   4. Local server reports firstRun=true on /api/setup/status
 *
 * If any gate fails we render children immediately — existing installs see
 * zero change. On success of the "connect to existing server" path we
 * persist the connection config and ask Electron to reload the window
 * against the remote URL; the remote server then serves its own React
 * bundle, AuthGate, and LoginScreen.
 */
export default function ConnectFirstScreen({ children }: any) {
  const [phase, setPhase] = useState('loading'); // loading | chooser | remote | passthrough
  const [remoteUrl, setRemoteUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Gate 1 — must be Electron
      if (!window.electronAPI?.isElectron) {
        if (!cancelled) setPhase('passthrough');
        return;
      }
      // Gate 2 — no connection config yet
      const config = getConnectionConfig();
      if (config.mode !== 'local' || config.remoteUrl) {
        if (!cancelled) setPhase('passthrough');
        return;
      }
      // Gate 3 — no JWT
      if (isAuthenticated()) {
        if (!cancelled) setPhase('passthrough');
        return;
      }
      // Gate 4 — local server reports firstRun. If the endpoint is
      // unreachable (e.g. the embedded server hasn't started yet) we
      // conservatively pass through so we never strand a user on this
      // screen when their setup state is ambiguous.
      try {
        const res = await fetch(`${getApiBase()}/setup/status`, {
          headers: getAuthHeaders(),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          if (!cancelled) setPhase('passthrough');
          return;
        }
        const status = await res.json();
        if (!cancelled) setPhase(status.firstRun ? 'chooser' : 'passthrough');
      } catch {
        if (!cancelled) setPhase('passthrough');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTest = async () => {
    if (!remoteUrl.trim()) {
      setTestResult({ ok: false, message: 'Enter a server URL first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const result = await testConnection(remoteUrl, apiKey);
    setTestResult(result);
    setTesting(false);
  };

  const handleConnect = async () => {
    // Require a successful test before committing. This prevents the
    // Electron window from navigating to a garbage URL from which the
    // user can't easily recover — they'd have to manually edit the
    // connection config file on disk.
    if (!testResult?.ok) {
      const result = await testConnection(remoteUrl, apiKey);
      setTestResult(result);
      if (!result.ok) return;
    }
    setConnecting(true);
    saveConnectionConfig({
      mode: 'remote',
      remoteUrl: remoteUrl.trim().replace(/\/+$/, ''),
      apiKey: apiKey.trim(),
    });
    // navigateToOrg clears the HTTP cache and loads the remote URL.
    // From that point on the remote server serves its React bundle and
    // AuthGate → LoginScreen handles sign-in.
    if (window.electronAPI?.navigateToOrg) {
      (window.electronAPI as any)?.navigateToOrg?.();
    } else {
      window.location.reload();
    }
  };

  if (phase === 'loading') {
    return (
      <div
        data-testid="connect-first-loading"
        className="flex flex-col h-screen bg-gray-950 text-gray-100 items-center justify-center gap-3"
      >
        <Loader2 size={24} className="animate-spin text-indigo-400" />
        <p className="text-xs text-gray-500">Detecting environment…</p>
      </div>
    );
  }

  if (phase === 'passthrough') {
    return children;
  }

  return (
    <div
      data-testid="connect-first-screen"
      className="fixed inset-0 z-[70] bg-gray-950 flex items-center justify-center px-4"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-xl p-8 space-y-6">
        {phase === 'chooser' && (
          <>
            <div className="text-center">
              <h1 className="text-xl font-bold text-white mb-1">Welcome to Agent Hub</h1>
              <p className="text-gray-400 text-sm">
                Do you want to run a server on this computer, or sign in to one you already have?
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  // "Use this computer" just passes through to the existing
                  // SetupWizard with local mode pre-selected (which is the
                  // default connection state, so no writes needed).
                  setPhase('passthrough');
                }}
                className="flex-1 py-6 px-4 rounded-lg border-2 border-gray-700 bg-gray-900 text-gray-200 hover:border-blue-500 hover:bg-blue-500/5 transition-all text-left"
                data-testid="use-local-btn"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Monitor size={20} className="text-blue-400" />
                  <span className="font-medium text-sm">Use this computer</span>
                </div>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Start a new Agent Hub server on this machine. You&apos;ll create an owner account
                  for it.
                </p>
              </button>
              <button
                onClick={() => {
                  setPhase('remote');
                  setTestResult(null);
                }}
                className="flex-1 py-6 px-4 rounded-lg border-2 border-gray-700 bg-gray-900 text-gray-200 hover:border-blue-500 hover:bg-blue-500/5 transition-all text-left"
                data-testid="use-remote-btn"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Cloud size={20} className="text-blue-400" />
                  <span className="font-medium text-sm">Connect to existing server</span>
                </div>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Sign in to an Agent Hub server that&apos;s already running — your EC2 host,
                  another computer, etc.
                </p>
              </button>
            </div>
          </>
        )}

        {phase === 'remote' && (
          <>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setPhase('chooser');
                  setTestResult(null);
                }}
                className="text-gray-400 hover:text-white transition-colors"
                aria-label="Back"
              >
                <ArrowLeft size={18} />
              </button>
              <div>
                <h1 className="text-lg font-bold text-white">Connect to existing server</h1>
                <p className="text-xs text-gray-400">
                  Enter the URL of the Agent Hub server you want to sign in to.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="connect-first-url"
                  className="block text-xs font-medium text-gray-400 mb-1"
                >
                  Server URL
                </label>
                <input
                  id="connect-first-url"
                  type="text"
                  value={remoteUrl}
                  onChange={(e: any) => {
                    setRemoteUrl(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="https://my-server.example.com:3051"
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
                  autoFocus
                />
              </div>
              <div>
                <label
                  htmlFor="connect-first-key"
                  className="block text-xs font-medium text-gray-400 mb-1"
                >
                  API Key (optional)
                </label>
                <input
                  id="connect-first-key"
                  type="password"
                  value={apiKey}
                  onChange={(e: any) => {
                    setApiKey(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="Leave blank if the server uses username/password"
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleTest}
                  disabled={testing || !remoteUrl.trim()}
                  className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                  {testing ? 'Testing…' : 'Test Connection'}
                </button>
                {testResult && (
                  <span
                    role="status"
                    className={`text-sm ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}
                  >
                    {testResult.ok ? '✓' : '✕'} {testResult.message}
                  </span>
                )}
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={handleConnect}
                disabled={connecting || !testResult?.ok}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {connecting && <Loader2 size={14} className="animate-spin" />}
                {connecting ? 'Connecting…' : 'Connect & Sign In'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
