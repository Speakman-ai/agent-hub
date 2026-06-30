import { useEffect, useState } from 'react';
import { Loader2, WifiOff, Settings as SettingsIcon, Monitor, Mail } from 'lucide-react';
import LoginScreen from './LoginScreen';
import InviteAcceptPage from './InviteAcceptPage';
import ResetPasswordPage from './ResetPasswordPage';
import {
  isAuthenticated,
  getAuthStatus,
  getAuthRecord,
  setActiveOrgIsLocal,
  needsEmailUpdate,
  updateEmail,
} from '../utils/auth';
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
  const inviteToken =
    typeof window !== 'undefined'
      ? window.location.pathname.match(/^\/invite\/([^/?#]+)\/?$/)?.[1]
      : null;
  const resetToken =
    typeof window !== 'undefined' && window.location.pathname === '/reset'
      ? new URLSearchParams(window.location.search).get('token')
      : null;
  const renderResetPasswordPage = () => (
    <ResetPasswordPage
      token={resetToken}
      onComplete={() => {
        window.history.replaceState({}, '', '/');
        setNonce((n: any) => n + 1);
      }}
    />
  );
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
          needsEmailUpdate: !!res.needsEmailUpdate,
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
    if (resetToken) {
      return renderResetPasswordPage();
    }
    if (inviteToken) {
      return <InviteAcceptPage token={decodeURIComponent(inviteToken)} />;
    }
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

  if (resetToken) {
    return renderResetPasswordPage();
  }

  if (inviteToken) {
    return <InviteAcceptPage token={decodeURIComponent(inviteToken)} />;
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

  const shouldPromptForEmailUpdate = shouldShowEmailUpdatePrompt(status);
  if (shouldPromptForEmailUpdate) {
    return (
      <LegacyEmailPrompt
        onComplete={() => {
          // Drop stale status from the first /auth/status fetch so we don't
          // re-render this form while the nonce-triggered refetch is in flight.
          setStatus((prev: any) => ({ ...prev, needsEmailUpdate: false }));
          setNonce((n: any) => n + 1);
        }}
      />
    );
  }

  return children;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Decide whether to block the app behind the legacy-email migration prompt.
 *
 * Once PUT /auth/me/email succeeds, `updateEmail` persists a JWT whose
 * `user.needsEmailUpdate` is explicitly `false`. That must win over a stale
 * `needsEmailUpdate` flag from the earlier GET /auth/status response — the
 * OR that caused the prompt to stick after a successful save.
 */
export function shouldShowEmailUpdatePrompt(status: {
  required?: boolean;
  needsEmailUpdate?: boolean;
  activeOrgIsLocal?: boolean;
}) {
  if (!status.required) return false;

  if (isAuthenticated()) {
    // auth.json is the migration source of truth once /auth/status has loaded.
    if (!status.needsEmailUpdate) return false;

    const tokenUser = getAuthRecord()?.user;
    if (tokenUser?.needsEmailUpdate === false) return false;
    if (needsEmailUpdate()) return true;
    return !!status.needsEmailUpdate;
  }

  return !!status.activeOrgIsLocal && !!status.needsEmailUpdate;
}

function LegacyEmailPrompt({ onComplete }: any) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: any) => {
    event.preventDefault();
    const nextEmail = email.trim();
    setError(null);
    if (!isValidEmail(nextEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    setSaving(true);
    try {
      await updateEmail({ baseUrl: getApiBase(), email: nextEmail });
      onComplete?.();
    } catch (err: any) {
      setError(err?.message || 'Failed to save email');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-lg p-6 shadow-lg"
      >
        <div className="flex flex-col items-center gap-2 mb-5">
          <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            <Mail className="w-6 h-6 text-emerald-400" />
          </div>
          <h1 className="text-lg font-semibold text-white">Set your email</h1>
          <p className="text-xs text-gray-400 text-center">
            Agent Hub now uses email as the sign-in identifier.
          </p>
        </div>
        <label className="block text-xs text-gray-400 mb-1" htmlFor="legacy-email-update">
          Email
        </label>
        <input
          id="legacy-email-update"
          type="email"
          value={email}
          onChange={(e: any) => setEmail(e.target.value)}
          autoComplete="email"
          required
          autoFocus
          className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
        />
        {error && (
          <div
            role="alert"
            className="mt-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300"
          >
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={saving || !email.trim()}
          className="mt-4 w-full flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded transition-colors"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save email
        </button>
      </form>
    </div>
  );
}
