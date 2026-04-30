import { useEffect, useState, useCallback } from 'react';
import {
  Loader2,
  GitPullRequest,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Key,
} from 'lucide-react';
import { getAuthHeaders, getApiBase } from '../utils/connection.js';

/**
 * GithubConnectionSection — "Sign in with GitHub" UI.
 *
 * Calls:
 *   GET    /api/auth/github/status        — whether the caller is linked
 *   GET    /api/auth/github/start         — returns the authorize URL to redirect to
 *   POST   /api/auth/github/connect-token — paste a PAT (works without server OAuth config)
 *   DELETE /api/auth/github               — disconnect
 *
 * Two paths to connect:
 *   1. OAuth (preferred when server has githubApp.clientId/clientSecret)
 *   2. Personal Access Token paste (always works — used during setup, in
 *      local-only Electron installs, and any time the server hasn't been
 *      configured with a GitHub App yet).
 *
 * Does NOT interact with the GitHub App install flow — that's a separate
 * per-project concern covered on the project settings page.
 */
export default function GithubConnectionSection({ embedded = false } = {}) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenSaving, setTokenSaving] = useState(false);

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
          // Pivot to the PAT path automatically — the user can still
          // sign in without OAuth credentials being configured.
          setShowTokenInput(true);
          throw new Error(
            'OAuth is not configured on this server. Use a personal access token instead.',
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

  const handleSaveToken = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setTokenSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/auth/github/connect-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `POST /auth/github/connect-token → ${res.status}`);
      }
      setTokenInput('');
      setShowTokenInput(false);
      await load();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setTokenSaving(false);
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

  const containerClass = embedded ? '' : 'bg-gray-800 rounded-xl p-4';

  if (loading) {
    return (
      <div className={containerClass}>
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
    <div className={containerClass}>
      {!embedded && (
        <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
          <GitPullRequest size={14} /> GitHub Account
        </h4>
      )}

      {!serverConfigured && !connected && !showTokenInput && (
        <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2 mb-3 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span>
            OAuth is not configured on this server, but you can still sign in by pasting a{' '}
            <a
              href="https://github.com/settings/tokens?type=beta"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-amber-200"
            >
              personal access token
            </a>
            .
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

          {showTokenInput ? (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-400">
                Personal access token
              </label>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ghp_… or github_pat_…"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-testid="github-pat-input"
                className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
              />
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Generate one at{' '}
                <a
                  href="https://github.com/settings/tokens?type=beta"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-300"
                >
                  github.com/settings/tokens
                </a>
                . A fine-grained token with read access to your repositories is enough for PR
                listing; add <code>contents:write</code> + <code>pull_requests:write</code> if you
                want merge/comment to work.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveToken}
                  disabled={!tokenInput.trim() || tokenSaving}
                  className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
                >
                  {tokenSaving && <Loader2 size={12} className="animate-spin" />}
                  {tokenSaving ? 'Saving…' : 'Save token'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowTokenInput(false);
                    setTokenInput('');
                    setError(null);
                  }}
                  disabled={tokenSaving}
                  className="text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {serverConfigured && (
                <button
                  onClick={handleConnect}
                  disabled={busy}
                  className="flex items-center gap-2 text-sm bg-[#24292f] hover:bg-[#1c2024] disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors"
                >
                  {busy ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <GitPullRequest size={14} />
                  )}
                  Sign in with GitHub
                  <ExternalLink size={12} className="opacity-60" />
                </button>
              )}
              <button
                onClick={() => {
                  setShowTokenInput(true);
                  setError(null);
                }}
                disabled={busy}
                className="flex items-center gap-2 text-sm bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors"
              >
                <Key size={14} />
                {serverConfigured ? 'Use a token instead' : 'Paste a personal access token'}
              </button>
            </div>
          )}
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
