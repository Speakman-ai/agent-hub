import { useEffect, useState, useCallback } from 'react';
import { Loader2, ExternalLink, CheckCircle2, AlertCircle, Mail } from 'lucide-react';
import { api } from '../utils/api';
import { formatDate } from '../utils/time';

/**
 * GoogleConnectionSection — per-user "Connect Google" UI.
 *
 * Lives in Settings -> Account (the same per-user area that hosts each user's
 * CLI creds), NOT a top-level tab and NOT project settings — the connection is
 * per-USER (mirrors GitHub).
 *
 * Calls (via the api helper):
 *   GET    /api/auth/google/status   — { connected, email, grantedScopes, serverConfigured, … }
 *   GET    /api/auth/google/start    — { authorizeUrl } → full-page redirect
 *   DELETE /api/auth/google/connect  — disconnect
 *
 * Scopes are requested incrementally per surface (Calendar / Gmail / Sheets /
 * Drive / Docs) per the epic's sensitive-scope tiering. The connect button requests
 * identity-only; the "re-consent / upgrade access" button requests the full
 * surface set in one consent round (Google keeps already-granted scopes via
 * include_granted_scopes). The individual surface views own their own inline
 * "Enable <surface>" affordances.
 *
 * Degrades to a "not configured" message when the server has no Google OAuth
 * app credentials (status.serverConfigured === false). The Admin-only OAuth
 * *app* client id/secret config lives in the same Account page (Google OAuth
 * App section, Admin/Owner-gated).
 */

interface GoogleSurface {
  key: string;
  label: string;
  scopes: string[];
}

// Surface → sensitive scopes (v1 avoids restricted scopes to dodge annual CASA).
export const GOOGLE_SURFACES: GoogleSurface[] = [
  {
    key: 'calendar',
    label: 'Calendar',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  },
  {
    key: 'gmail',
    label: 'Gmail (send + modify)',
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
  },
  {
    key: 'sheets',
    label: 'Sheets',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  },
  {
    key: 'drive',
    label: 'Drive / Docs (app files)',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  },
];

// Union of every surface scope — requested in one round by the upgrade button.
// Exported so the test can assert the upgrade button passes exactly this set.
export const ALL_SURFACE_SCOPES: string[] = GOOGLE_SURFACES.flatMap((s) => s.scopes);

/** Strip the long Google scope URL prefix to a readable suffix for display. */
export function scopeLabel(scope: string): string {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
}

/**
 * Shape returned by GET /api/auth/google/status (never includes tokens).
 * Mirrors the route's Zod response schema in server/routes/google-oauth.ts.
 */
export interface GoogleStatus {
  connected: boolean;
  email: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  tokenExpiresAt: string | null;
  serverConfigured: boolean;
}

export default function GoogleConnectionSection() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    const { silent = false } = opts;
    if (!silent) setLoading(true);
    setError(null);
    try {
      setStatus(await api.getGoogleStatus());
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The OAuth callback opens in this same tab and redirects back here, so refetch
  // status on window focus to flip "Connect" → "Connected as …" without a manual
  // reload. Silent so we don't flash the loading spinner on every tab focus.
  useEffect(() => {
    const onFocus = () => load({ silent: true });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const startOAuth = async (scopes?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const body = await api.startGoogleOAuth({ returnTo, scopes });
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err.message || String(err));
      setBusy(false);
    }
    // On success the browser navigates away, so we intentionally leave `busy`
    // set — the redirect tears down the component.
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect your Google account from Agent Hub?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.disconnectGoogle();
      await load({ silent: true });
    } catch (err: any) {
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
          Loading Google connection…
        </div>
      </div>
    );
  }

  const connected = !!status?.connected;
  const serverConfigured = status?.serverConfigured !== false;
  const grantedScopes: string[] = Array.isArray(status?.grantedScopes) ? status.grantedScopes : [];

  return (
    <div className="bg-gray-800 rounded-xl p-4">
      <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
        <Mail size={14} /> Google Account
      </h4>

      {!serverConfigured && !connected && (
        <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span>
            Google is not configured on this server. An Admin needs to set the Google OAuth app
            credentials in the <strong>Google OAuth App</strong> section of Account settings before
            you can connect.
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
                <span className="font-mono text-emerald-300">
                  {status.email || 'Google account'}
                </span>
              </div>
              {status.connectedAt && (
                <div className="text-[11px] text-gray-500">
                  Connected {formatDate(status.connectedAt)}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="text-[11px] text-gray-400 mb-1">Granted access</div>
            {grantedScopes.length ? (
              <div className="flex flex-wrap gap-1.5">
                {grantedScopes.map((scope: string) => (
                  <span
                    key={scope}
                    className="text-[10px] font-mono bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300"
                  >
                    {scopeLabel(scope)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-gray-500">
                Identity only (no data scopes granted yet).
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {serverConfigured && (
              <button
                onClick={() => startOAuth(ALL_SURFACE_SCOPES)}
                disabled={busy}
                className="flex items-center gap-2 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
                Re-consent / upgrade access
              </button>
            )}
            <button
              onClick={handleDisconnect}
              disabled={busy}
              className="flex items-center gap-2 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-400 leading-relaxed">
            Link your Google account so Agent Hub can work with your Calendar, Gmail, Sheets, Drive,
            and Docs on your behalf. You can grant individual surfaces later here.
          </p>
          {serverConfigured && (
            <button
              onClick={() => startOAuth()}
              disabled={busy}
              className="flex items-center gap-2 text-sm bg-[#1a73e8] hover:bg-[#1765cc] disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
              Connect Google
              <ExternalLink size={12} className="opacity-60" />
            </button>
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
