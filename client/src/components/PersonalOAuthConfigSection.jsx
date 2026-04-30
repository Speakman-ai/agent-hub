import { useEffect, useState, useCallback } from 'react';
import { Loader2, KeyRound, ExternalLink, CheckCircle2 } from 'lucide-react';
import { getAuthHeaders, getApiBase } from '../utils/connection.js';

/**
 * PersonalOAuthConfigSection — server-level OAuth App credentials.
 *
 * This is the **OAuth App** registration (separate from the GitHub App that
 * powers reviewer-bot reviews). Once a clientId + clientSecret are configured
 * here, end users can use the "Sign in with GitHub" button on
 * GithubConnectionSection without falling back to the PAT path.
 *
 * Calls:
 *   GET    /api/config/personal-oauth   — { configured, clientId }
 *   PUT    /api/config/personal-oauth   — { clientId, clientSecret }
 *   DELETE /api/config/personal-oauth   — clear
 */
export default function PersonalOAuthConfigSection() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/personal-oauth`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`GET /config/personal-oauth → ${res.status}`);
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

  const handleSave = async () => {
    const cid = clientId.trim();
    const cs = clientSecret.trim();
    if (!cid || !cs) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/personal-oauth`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ clientId: cid, clientSecret: cs }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `PUT /config/personal-oauth → ${res.status}`);
      }
      setClientId('');
      setClientSecret('');
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Remove the OAuth App credentials? Sign-in will fall back to PAT.')) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/personal-oauth`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`DELETE /config/personal-oauth → ${res.status}`);
      await load();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading OAuth App status…
        </div>
      </div>
    );
  }

  const configured = !!status?.configured;

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <KeyRound size={14} /> Personal OAuth App
        </h4>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Server-wide OAuth App credentials so users can <strong>Sign in with GitHub</strong>{' '}
          without pasting a token. Separate from the GitHub App below — register one at{' '}
          <a
            href="https://github.com/settings/applications/new"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-300"
          >
            github.com/settings/applications/new
          </a>
          .
        </p>
      </div>

      {configured ? (
        <div className="flex items-center gap-2">
          <CheckCircle2 size={14} className="text-emerald-400" />
          <span className="text-sm text-emerald-400">
            Configured — client ID{' '}
            <code className="bg-gray-900/50 px-1 rounded font-mono text-[11px]">
              {status.clientId}
            </code>
          </span>
          <button
            onClick={handleClear}
            disabled={saving}
            className="text-xs text-red-400 hover:text-red-300 ml-auto disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : showForm ? (
        <div className="bg-gray-900/50 rounded-lg p-3 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Client ID</label>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Iv1.abc123…"
              autoComplete="off"
              data-testid="personal-oauth-client-id"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Client Secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="••••••••••••••••"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-testid="personal-oauth-client-secret"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            When registering the OAuth App, set the authorization callback URL to{' '}
            <code className="bg-gray-900/80 px-1 rounded">
              {`${window.location.origin}/api/auth/github/callback`}
            </code>
            .
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!clientId.trim() || !clientSecret.trim() || saving}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setClientId('');
                setClientSecret('');
                setError(null);
              }}
              disabled={saving}
              className="text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 px-3 py-1.5 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          <ExternalLink size={14} />
          Configure OAuth App
        </button>
      )}

      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
          {error}
        </div>
      )}
    </div>
  );
}
