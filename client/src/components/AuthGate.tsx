import { useEffect, useState } from 'react';
import { Loader2, WifiOff, Settings as SettingsIcon, Monitor } from 'lucide-react';
import LoginScreen from './LoginScreen';
import { isAuthenticated, getAuthStatus, setActiveOrgIsLocal } from '../utils/auth';
import { getApiBase, getConnectionConfig, saveConnectionConfig } from '../utils/connection';

/**
 * Wraps the main app and blocks rendering until we know whether auth is
 * needed. If the server reports `authConfigured: true` and we don't have a
 * valid token, we render <LoginScreen /> instead of children.
 *
 * When we're in remote mode and the server is unreachable, we render a
 * dedicated error screen with escape hatches instead of silently falling
 * through. Falling through previously led the user to an empty-local-server
 * setup wizard, which was the underlying bug behind "why is it asking me
 * to create an account when I already have one?".
 *
 * The legacy apiKey flow (via the SetupWizard / connection.js) is preserved:
 * when the server reports `authConfigured: false`, this gate is a no-op and
 * children render immediately.
 *
 * Local-mode orgs: when `activeOrgIsLocal` is true, the server bypasses
 * auth for that org. We mirror that on the client by skipping the
 * LoginScreen render, so single-user local environments don't see a
 * sign-in prompt even when auth is globally configured.
 */
export default function AuthGate({ children }: any) {
  const [status, setStatus] = useState<any>({
    state: 'loading',
    required: false,
    activeOrgIsLocal: false,
  });
  // Counter increments when the user authenticates or edits connection;
  // used to re-check.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAuthStatus(getApiBase());
        if (cancelled) return;
        setActiveOrgIsLocal(!!res.activeOrgIsLocal);
        setStatus({
          state: 'ready',
          required: !!res.authConfigured,
          activeOrgIsLocal: !!res.activeOrgIsLocal,
        });
      } catch (err: any) {
        if (cancelled) return;
        const config = getConnectionConfig();
        if (config.mode === 'remote' && config.remoteUrl) {
          // Remote mode with an unreachable server — surface it so the
          // user can fix the URL or fall back to local. Letting this
          // fall through to `required: false` sends them to the local
          // setup wizard against the wrong server.
          setStatus({
            state: 'unreachable',
            required: false,
            activeOrgIsLocal: false,
            error: err?.message || 'Unknown error',
            url: config.remoteUrl,
          });
          return;
        }
        // Local mode status endpoint down — legacy behavior: don't
        // hard-block. The main app's connection handling will surface
        // the underlying issue.
        setStatus({
          state: 'ready',
          required: false,
          activeOrgIsLocal: false,
          error: err?.message,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  if (status.state === 'loading') {
    return (
      <div
        data-testid="auth-gate-loading"
        className="flex flex-col h-screen bg-gray-950 text-gray-100 items-center justify-center gap-3"
      >
        <Loader2 size={24} className="animate-spin text-indigo-400" />
        <p className="text-xs text-gray-500">Checking authentication…</p>
      </div>
    );
  }

  if (status.state === 'unreachable') {
    const onSwitchToLocal = () => {
      saveConnectionConfig({ mode: 'local', remoteUrl: '', apiKey: '' });
      if (window.electronAPI?.navigateToOrg) {
        (window.electronAPI as any)?.navigateToOrg?.();
      } else {
        window.location.reload();
      }
    };
    const onEditConnection = () => {
      // Clearing remoteUrl drops us back into the ConnectFirstScreen
      // chooser on the next mount, where the user can re-enter the URL.
      saveConnectionConfig({ mode: 'local', remoteUrl: '', apiKey: '' });
      if (window.electronAPI?.navigateToOrg) {
        (window.electronAPI as any)?.navigateToOrg?.();
      } else {
        setNonce((n: any) => n + 1);
      }
    };
    return (
      <div
        data-testid="remote-unreachable-screen"
        className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-4"
      >
        <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl p-6 space-y-4">
          <div className="flex flex-col items-center gap-2">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
              <WifiOff size={22} className="text-red-400" />
            </div>
            <h1 className="text-lg font-semibold text-white">Can&apos;t reach server</h1>
          </div>
          <div className="text-sm text-gray-300 space-y-1 text-center">
            <p>
              We couldn&apos;t reach{' '}
              <span className="font-mono text-gray-100 break-all">{status.url}</span>.
            </p>
            {status.error && (
              <p className="text-xs text-gray-500 font-mono break-words">{status.error}</p>
            )}
          </div>
          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={onEditConnection}
              className="w-full flex items-center justify-center gap-2 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors"
            >
              <SettingsIcon size={14} />
              Edit connection
            </button>
            <button
              onClick={onSwitchToLocal}
              className="w-full flex items-center justify-center gap-2 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 text-sm font-medium rounded transition-colors"
            >
              <Monitor size={14} />
              Switch to local server
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Skip the login prompt entirely when the active org is local-mode —
  // the server is already letting those requests through without a token.
  // Note: `nonce` only re-checks auth status on login success / connection
  // edit. If the active org changes mid-session (e.g. via the org switcher),
  // `reloadForOrgSwitch()` triggers a full app reload, so the gate is
  // re-evaluated naturally — no explicit event wiring needed.
  if (status.required && !status.activeOrgIsLocal && !isAuthenticated()) {
    return <LoginScreen onAuthenticated={() => setNonce((n: any) => n + 1)} />;
  }

  return children;
}
