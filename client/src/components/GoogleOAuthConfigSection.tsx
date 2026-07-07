import { useEffect, useState, useCallback } from 'react';
import { Loader2, KeyRound, ExternalLink, CheckCircle2 } from 'lucide-react';
import { getAuthHeaders, getApiBase } from '../utils/connection';

/**
 * GoogleOAuthConfigSection — server-global Google OAuth *app* credentials.
 *
 * Admin/Owner-only. This is the OAuth client (web app) registered in Google
 * Cloud Console that the per-user "Connect Google" flow signs in against. When
 * unset, the connect surfaces degrade to "not configured" and
 * `/api/auth/google/start` returns 503. Distinct from a user's per-user Google
 * *connection* (linked account + tokens), which lives in Account settings.
 *
 * Calls:
 *   GET    /api/config/google-oauth   — { configured, clientId }
 *   PUT    /api/config/google-oauth   — { clientId, clientSecret }
 *   DELETE /api/config/google-oauth   — clear
 */
export default function GoogleOAuthConfigSection({ bare = false }: { bare?: boolean } = {}) {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [showForm, setShowForm] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);

  // When embedded in a shared Google card the outer chrome is dropped so this
  // section reads as one row inside the parent card.
  const shellClass = bare ? '' : 'bg-gray-800 rounded-xl p-4';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/google-oauth`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`GET /config/google-oauth → ${res.status}`);
      setStatus(await res.json());
    } catch (err: any) {
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
      const res = await fetch(`${getApiBase()}/config/google-oauth`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ clientId: cid, clientSecret: cs }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `PUT /config/google-oauth → ${res.status}`);
      }
      setClientId('');
      setClientSecret('');
      setShowForm(false);
      await load();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (
      !window.confirm(
        'Remove the Google OAuth app credentials? Users will no longer be able to connect Google until it is reconfigured.',
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/google-oauth`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`DELETE /config/google-oauth → ${res.status}`);
      await load();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className={shellClass}>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading Google OAuth status…
        </div>
      </div>
    );
  }

  const configured = !!status?.configured;
  // The redirect URI is resolved server-side from publicUrl (see GET
  // /config/google-oauth). Never reconstruct it from window.location.origin —
  // when publicUrl diverges from the browser origin (nginx, path prefix) the
  // admin would register the wrong value and OAuth fails with
  // redirect_uri_mismatch. Fall back to the origin only if the server omitted it.
  const redirectUri =
    status?.redirectUri ||
    (typeof window !== 'undefined'
      ? `${window.location.origin}/api/auth/google/callback`
      : '/api/auth/google/callback');

  return (
    <div className={`${shellClass} space-y-4`}>
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <KeyRound size={14} /> Google OAuth App
        </h4>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Server-wide Google OAuth client so users can <strong>Connect Google</strong> from their
          Account settings (Calendar, Gmail, Sheets). Create a Web application OAuth client at{' '}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-300"
          >
            console.cloud.google.com/apis/credentials
          </a>
          . Until this is set, the Connect Google button shows &ldquo;not configured&rdquo;.
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
              onChange={(e: any) => setClientId(e.target.value)}
              placeholder="1234567890-abc.apps.googleusercontent.com"
              autoComplete="off"
              data-testid="google-oauth-client-id"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Client Secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e: any) => setClientSecret(e.target.value)}
              placeholder="••••••••••••••••"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-testid="google-oauth-client-secret"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            In the Google Cloud Console OAuth client, set the authorized redirect URI to{' '}
            <code className="bg-gray-900/80 px-1 rounded" data-testid="google-oauth-redirect-uri">
              {redirectUri}
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
