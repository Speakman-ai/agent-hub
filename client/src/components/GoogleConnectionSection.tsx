import { useEffect, useState, useCallback } from 'react';
import { Loader2, ExternalLink, CheckCircle2, AlertCircle, Mail, Plus, Star } from 'lucide-react';
import { api } from '../utils/api';
import { formatDate } from '../utils/time';
import GoogleChatAccountPicker from './GoogleChatAccountPicker';

/**
 * GoogleConnectionSection — per-user "Connect Google" UI.
 *
 * Lives in Settings -> Account (the same per-user area that hosts each user's
 * CLI creds), NOT a top-level tab and NOT project settings — the connection is
 * per-USER (mirrors GitHub).
 *
 * A user can link several Google accounts; one is the default that agents and
 * the Workspace views use when no account is named. Each account row shows its
 * own granted scopes, one button per surface it hasn't granted yet, Make default,
 * and Disconnect.
 *
 * Calls (via the api helper):
 *   GET    /api/auth/google/status                        — { accounts, serverConfigured, … }
 *   GET    /api/auth/google/start?intent=add              — link another account (chooser forced)
 *   GET    /api/auth/google/start?accountId=…&scopes=…    — incremental consent for one account
 *   POST   /api/auth/google/accounts/:accountId/default   — make default
 *   DELETE /api/auth/google/accounts/:accountId           — disconnect one account
 *
 * Scopes are requested incrementally per surface (Calendar / Gmail / Sheets /
 * Drive / Docs) per the epic's sensitive-scope tiering. Google keeps
 * already-granted scopes via include_granted_scopes.
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
    // calendarlist.readonly lists shared and subscribed calendars, not just the primary.
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ],
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

// Union of every surface scope. The consent contract test asserts the proxy
// routes' required scopes are all offered here.
export const ALL_SURFACE_SCOPES: string[] = GOOGLE_SURFACES.flatMap((s) => s.scopes);

/** Strip the long Google scope URL prefix to a readable suffix for display. */
export function scopeLabel(scope: string): string {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
}

/** One linked Google account, as listed by GET /api/auth/google/status. */
export interface GoogleAccountSummary {
  accountId: string;
  email: string;
  grantedScopes: string[];
  isDefault: boolean;
  connectedAt: string | null;
  tokenExpiresAt?: string | null;
}

/**
 * Shape returned by GET /api/auth/google/status (never includes tokens). The
 * top-level email/scopes describe the default account.
 * Mirrors the route's Zod response schema in server/routes/google-oauth.ts.
 */
export interface GoogleStatus {
  connected: boolean;
  email: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  tokenExpiresAt: string | null;
  serverConfigured: boolean;
  defaultAccountId?: string | null;
  accounts?: GoogleAccountSummary[];
}

/**
 * Accounts from a status payload. A server without multi-account support only
 * sends the top-level fields, which become a single default account with no id.
 */
export function accountsFromStatus(status: GoogleStatus | null): GoogleAccountSummary[] {
  if (!status) return [];
  if (Array.isArray(status.accounts)) return status.accounts;
  if (!status.connected) return [];
  return [
    {
      accountId: '',
      email: status.email || 'Google account',
      grantedScopes: Array.isArray(status.grantedScopes) ? status.grantedScopes : [],
      isDefault: true,
      connectedAt: status.connectedAt,
    },
  ];
}

/** Surfaces whose scopes this account hasn't fully granted. */
export function missingSurfaces(grantedScopes: string[]): GoogleSurface[] {
  const granted = new Set(grantedScopes);
  return GOOGLE_SURFACES.filter((s) => !s.scopes.every((scope) => granted.has(scope)));
}

const SMALL_BTN =
  'flex items-center gap-1.5 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-2.5 py-1 rounded-lg transition-colors';

export default function GoogleConnectionSection({ bare = false }: { bare?: boolean } = {}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // When embedded in a shared Google card the outer chrome is dropped so this
  // section reads as one row inside the parent card.
  const shellClass = bare ? '' : 'bg-gray-800 rounded-xl p-4';

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
  // status on window focus to pick up a newly linked account without a manual
  // reload. Silent so we don't flash the loading spinner on every tab focus.
  useEffect(() => {
    const onFocus = () => load({ silent: true });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const startOAuth = async (
    opts: { scopes?: string[]; intent?: 'add'; accountId?: string } = {},
  ) => {
    setBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const body = await api.startGoogleOAuth({
        returnTo,
        ...(opts.scopes && { scopes: opts.scopes }),
        ...(opts.intent && { intent: opts.intent }),
        ...(opts.accountId && { accountId: opts.accountId }),
      });
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err.message || String(err));
      setBusy(false);
    }
    // On success the browser navigates away, so we intentionally leave `busy`
    // set — the redirect tears down the component.
  };

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load({ silent: true });
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = (account: GoogleAccountSummary) => {
    if (!window.confirm(`Disconnect ${account.email} from Agent Hub?`)) return;
    return runAction(() =>
      account.accountId ? api.disconnectGoogleAccount(account.accountId) : api.disconnectGoogle(),
    );
  };

  const handleMakeDefault = (account: GoogleAccountSummary) =>
    runAction(() => api.setDefaultGoogleAccount(account.accountId));

  if (loading) {
    return (
      <div className={shellClass}>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading Google connection…
        </div>
      </div>
    );
  }

  const accounts = accountsFromStatus(status);
  const connected = accounts.length > 0;
  const serverConfigured = status?.serverConfigured !== false;
  const multi = accounts.length > 1;

  return (
    <div className={shellClass}>
      <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
        <Mail size={14} /> {multi ? 'Google Accounts' : 'Google Account'}
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
          <ul className="space-y-3">
            {accounts.map((account) => {
              const missing = missingSurfaces(account.grantedScopes);
              return (
                <li
                  key={account.accountId || account.email}
                  data-testid="google-account-row"
                  className={
                    multi ? 'border border-gray-700 rounded-lg p-3 space-y-3' : 'space-y-3'
                  }
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm text-white flex items-center gap-2 flex-wrap">
                        {!multi && <span>Connected as</span>}
                        <span className="font-mono text-emerald-300 truncate">{account.email}</span>
                        {multi && account.isDefault && (
                          <span className="text-[10px] uppercase tracking-wide bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 rounded px-1.5 py-0.5">
                            Default
                          </span>
                        )}
                      </div>
                      {account.connectedAt && (
                        <div className="text-[11px] text-gray-500">
                          Connected {formatDate(account.connectedAt)}
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] text-gray-400 mb-1">Granted access</div>
                    {account.grantedScopes.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {account.grantedScopes.map((scope: string) => (
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
                    {serverConfigured &&
                      missing.map((surface) => (
                        <button
                          key={surface.key}
                          onClick={() =>
                            startOAuth({
                              scopes: surface.scopes,
                              ...(account.accountId && { accountId: account.accountId }),
                            })
                          }
                          disabled={busy}
                          aria-label={`Enable ${surface.label} for ${account.email}`}
                          className={SMALL_BTN}
                        >
                          <Plus size={12} />
                          {surface.label}
                        </button>
                      ))}
                    {multi && !account.isDefault && account.accountId && (
                      <button
                        onClick={() => handleMakeDefault(account)}
                        disabled={busy}
                        aria-label={`Make ${account.email} the default`}
                        className={SMALL_BTN}
                      >
                        <Star size={12} />
                        Make default
                      </button>
                    )}
                    <button
                      onClick={() => handleDisconnect(account)}
                      disabled={busy}
                      aria-label={`Disconnect ${account.email}`}
                      className={SMALL_BTN}
                    >
                      {busy && <Loader2 size={12} className="animate-spin" />}
                      Disconnect
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <GoogleChatAccountPicker reloadKey={status} />

          {serverConfigured && (
            <button
              onClick={() => startOAuth({ intent: 'add' })}
              disabled={busy}
              className="flex items-center gap-2 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Add another account
              <ExternalLink size={12} className="opacity-60" />
            </button>
          )}
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
