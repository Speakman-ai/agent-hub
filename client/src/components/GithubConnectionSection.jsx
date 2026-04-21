import { useEffect, useState, useCallback } from 'react';
import { Loader2, GitPullRequest, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react';
import { getAuthHeaders, getApiBase } from '../utils/connection.js';

/**
 * GithubConnectionSection — "Sign in with GitHub" UI.
 *
 * Calls:
 *   GET    /api/auth/github/status    — whether the caller is linked
 *   GET    /api/auth/github/start     — returns the authorize URL to redirect to
 *   DELETE /api/auth/github           — disconnect
 *
 * Does NOT interact with the GitHub App install flow — that's a separate
 * per-project concern covered on the project settings page.
 */
export default function GithubConnectionSection() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/auth/github/status`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`GET /auth/github/status → ${res.status}`);
      setStatus(await res.json());
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // If the user just returned from the OAuth round-trip (our callback
  // redirects back here), refetch status so the UI flips from
  // "Connect" to "Connected as @…" without a manual reload.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const res = await fetch(
        `${getApiBase()}/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`,
        { headers: getAuthHeaders() },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.code === 'github_oauth_not_configured') {
          throw new Error(
            'The server is missing GitHub OAuth credentials. Add a `clientId` and `clientSecret` under `githubApp` in config.json.',
          );
        }
        throw new Error(body.error || `GET /auth/github/start → ${res.status}`);
      }
      const body = await res.json();
      window.location.href = body.authorizeUrl;
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect your GitHub account from Agent Hub?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/auth/github`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`DELETE /auth/github → ${res.status}`);
      await load();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading GitHub connection…
        </div>
      </div>
    );
  }

  const connected = !!status?.connected;
  const serverConfigured = status?.serverConfigured !== false;

  return (
    <div className="bg-gray-800 rounded-xl p-4">
      <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
        <GitPullRequest size={14} /> GitHub Account
      </h4>

      {!serverConfigured && (
        <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2 mb-3 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span>
            GitHub OAuth is not configured on this server. Add <code>clientId</code> and{' '}
            <code>clientSecret</code> under <code>githubApp</code> in config.json to enable "Sign in
            with GitHub".
          </span>
        </div>
      )}

      {connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={16} className="text-emerald-400" />
            <div>
              <div className="text-sm text-white">
                Connected as{' '}
                <a
                  href={`https://github.com/${status.login}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-emerald-300 hover:underline"
                >
                  @{status.login}
                </a>
              </div>
              {status.connectedAt && (
                <div className="text-[11px] text-gray-500">
                  Connected {new Date(status.connectedAt).toLocaleDateString()}
                </div>
              )}
            </div>
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            PR list, merge, close, and comment actions are attributed to this GitHub identity.
            Formal PR reviews (if enabled per-project) are still posted by the Agent Hub bot.
          </p>
          <button
            onClick={handleDisconnect}
            disabled={busy}
            className="flex items-center gap-2 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Disconnect
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-400 leading-relaxed">
            Link your GitHub account so Agent Hub can list your PRs and merge/close/comment as you.
            No repo install required — just sign in.
          </p>
          <button
            onClick={handleConnect}
            disabled={busy || !serverConfigured}
            className="flex items-center gap-2 text-sm bg-[#24292f] hover:bg-[#1c2024] disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <GitPullRequest size={14} />}
            Sign in with GitHub
            <ExternalLink size={12} className="opacity-60" />
          </button>
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
          {error}
        </div>
      )}
    </div>
  );
}
