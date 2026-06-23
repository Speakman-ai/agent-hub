import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert, UserPlus, X } from 'lucide-react';
import { getAuthStatus, setToken } from '../utils/auth';
import { getConnectionConfig, getLocalApiBase } from '../utils/connection';

/**
 * Phase 3 auth migration — upgrade banner.
 *
 * Deployments running on the legacy apiKey-only model have no in-app path
 * to upgrade to the JWT-backed multi-user model because SetupWizard is a
 * first-run wizard that never re-opens. This banner polls
 * `GET /api/auth/status` on mount; when the server reports
 * `needsMigration: true` it surfaces an inline "set up a user account"
 * flow that calls `POST /api/auth/setup` with the stored API key as the
 * `X-API-Key` header.
 *
 * The API key stays put after a successful upgrade — it remains as a
 * break-glass credential for this release.
 */
export default function AuthUpgradeBanner() {
  const [needsMigration, setNeedsMigration] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<any>(null);

  async function refreshStatus() {
    try {
      const status = await getAuthStatus(getLocalApiBase());
      setNeedsMigration(!!status.needsMigration);
    } catch {
      // If the status endpoint fails, just hide the banner — the rest of
      // the app's connection handling will surface the real problem.
      setNeedsMigration(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getAuthStatus(getLocalApiBase());
        if (cancelled) return;
        setNeedsMigration(!!status.needsMigration);
      } catch {
        if (cancelled) return;
        setNeedsMigration(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: any) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const config = getConnectionConfig();
      const apiKey = config.apiKey || '';
      const res = await fetch(`${getLocalApiBase()}/auth/setup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Setup failed: ${res.status}`);
      }
      const data = await res.json();
      // Persist the JWT under the canonical `agent-hub-jwt` storage key.
      // getAuthHeaders() in connection.js prefers the JWT over the API key
      // once it's stored, so subsequent requests automatically switch to
      // Authorization: Bearer — no change needed in connection.js.
      setToken(data);
      await refreshStatus();
      // Hide the inline form after a successful upgrade.
      setExpanded(false);
      setUsername('');
      setPassword('');
    } catch (err: any) {
      setError(err?.message || 'Account setup failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !needsMigration || dismissed) {
    return null;
  }

  return (
    <div
      className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6"
      data-testid="auth-upgrade-banner"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-amber-100">Upgrade to user accounts</h4>
          <p className="text-xs text-amber-200/80 mt-1 leading-relaxed">
            You&apos;re running on an API key. Set up a user account to enable per-user permissions,
            invites, and audit trails. Your API key will keep working as a fallback.
          </p>

          {!expanded && (
            <div className="flex items-center gap-2 mt-3">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-gray-900 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Set up account
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="text-xs text-amber-200/60 hover:text-amber-100 px-2 py-1.5"
              >
                Not now
              </button>
            </div>
          )}

          {expanded && (
            <form onSubmit={handleSubmit} className="space-y-3 mt-3">
              <div>
                <label
                  htmlFor="auth-upgrade-username"
                  className="block text-xs text-amber-200/80 mb-1"
                >
                  Username
                </label>
                <input
                  id="auth-upgrade-username"
                  type="text"
                  value={username}
                  onChange={(e: any) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label
                  htmlFor="auth-upgrade-password"
                  className="block text-xs text-amber-200/80 mb-1"
                >
                  Password
                </label>
                <input
                  id="auth-upgrade-password"
                  type="password"
                  value={password}
                  onChange={(e: any) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={256}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
                />
                <p className="text-[10px] text-amber-200/60 mt-1">
                  12–256 characters. This credential becomes the Owner of this deployment.
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300"
                >
                  <span>{error}</span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={submitting || !username || !password}
                  className="flex items-center justify-center gap-2 py-2 px-3 bg-amber-500 hover:bg-amber-400 disabled:bg-gray-700 disabled:text-gray-500 text-gray-900 text-xs font-medium rounded transition-colors"
                >
                  {submitting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <UserPlus className="w-3.5 h-3.5" />
                  )}
                  Create account
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(false);
                    setError(null);
                  }}
                  disabled={submitting}
                  className="text-xs text-amber-200/70 hover:text-amber-100 px-2 py-1.5"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss upgrade banner"
          className="text-amber-200/60 hover:text-amber-100 p-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
