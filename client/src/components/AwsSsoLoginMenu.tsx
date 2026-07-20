import { useCallback, useEffect, useState } from 'react';
import { Cloud, ChevronDown, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../utils/api';

/**
 * Pure helper: given the `{ name: stanza }` map returned by GET
 * /projects/:id/aws-profiles, return the sorted names of the SSO profiles.
 * A profile counts as SSO when its `type` is anything other than the
 * explicit `'static'` (mirrors the backend `isProjectAwsStaticProfile` and
 * the AWS editor, where legacy profiles with no type default to SSO).
 */
export function extractSsoProfileNames(profiles: any): string[] {
  if (!profiles || typeof profiles !== 'object') return [];
  return Object.entries(profiles)
    .filter(([, p]: any) => p && p.type !== 'static')
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * AwsSsoLoginMenu — a "Login to AWS" dropdown for the session toolbar.
 *
 * Renders only when the project has AWS enabled AND has at least one SSO
 * profile configured. Picking a profile walks the same device-code login as
 * the AWS settings page: POST /aws-sso/login returns a device URL we open in
 * a new tab, then the user re-checks status (GET /aws-sso/status) to confirm.
 */
export default function AwsSsoLoginMenu({ projectId, project, disabled = false, onError }: any) {
  const enabled = !!project?.awsEnabled && !!projectId;
  const [names, setNames] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [loginState, setLoginState] = useState<Record<string, any>>({});
  const [statusState, setStatusState] = useState<Record<string, any>>({});

  useEffect(() => {
    // Reset per-profile login/status state whenever the project (or enabled
    // state) changes. The component is rendered in-place from App.tsx, so
    // without this a stale login URL / status for a same-named profile from
    // the previous project could leak into the new project's toolbar.
    setLoginState({});
    setStatusState({});
    setOpen(false);
    if (!enabled) {
      setNames([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const body = await api.getProjectAwsProfiles(projectId);
        if (!cancelled) setNames(extractSsoProfileNames(body?.profiles));
      } catch {
        // A non-Admin caller (403) or transient error just hides the menu —
        // the AWS settings page already requires Admin, so this stays quiet.
        if (!cancelled) setNames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId]);

  // Close the menu when the control becomes disabled (e.g. the session
  // WebSocket drops). This also stops any open profile options from firing a
  // login/status call while disconnected, since the whole popup unmounts.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const checkStatus = useCallback(
    async (profile: string) => {
      setStatusState((s) => ({ ...s, [profile]: { loading: true } }));
      try {
        const st = await api.getProjectAwsSsoStatus(projectId, profile);
        setStatusState((s) => ({ ...s, [profile]: { loading: false, data: st } }));
      } catch (err: any) {
        setStatusState((s) => ({
          ...s,
          [profile]: { loading: false, error: err?.message || String(err) },
        }));
      }
    },
    [projectId],
  );

  const startLogin = useCallback(
    async (profile: string) => {
      setLoginState((s) => ({ ...s, [profile]: { loading: true } }));
      setStatusState((s) => ({ ...s, [profile]: undefined }));
      try {
        const data = await api.startProjectAwsSsoLogin(projectId, profile);
        setLoginState((s) => ({
          ...s,
          [profile]: { loading: false, loginUrl: data.loginUrl, completed: data.completed },
        }));
        if (data.loginUrl) window.open(data.loginUrl, '_blank', 'noopener,noreferrer');
        if (data.completed) await checkStatus(profile);
      } catch (err: any) {
        const msg = err?.message || String(err);
        setLoginState((s) => ({ ...s, [profile]: { loading: false, error: msg } }));
        onError?.(msg);
      }
    },
    [projectId, checkStatus, onError],
  );

  if (!enabled || names.length === 0) return null;

  return (
    <div className="relative flex w-[150px] min-w-[150px] shrink-0 sm:inline-flex sm:w-auto sm:min-w-0">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="aws-sso-login-trigger"
        title="Log in to an AWS SSO profile"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full justify-center items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-slate-700/70 bg-slate-900/50 text-slate-200 hover:bg-slate-800/70 disabled:opacity-60 sm:w-auto sm:inline-flex"
      >
        <Cloud size={14} className="opacity-80 shrink-0" />
        <span>Login to AWS</span>
        <ChevronDown size={14} className="opacity-70 shrink-0" />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close AWS login menu"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul
            role="listbox"
            aria-label="AWS SSO profiles"
            data-testid="aws-sso-login-menu"
            className="absolute left-0 bottom-full mb-1 z-50 min-w-[240px] max-w-[320px] rounded-lg border border-slate-700/80 bg-slate-950 shadow-xl py-1"
          >
            {names.map((name) => {
              const lg = loginState[name];
              const st = statusState[name];
              return (
                <li key={name} className="px-1">
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    disabled={disabled || lg?.loading}
                    data-testid={`aws-sso-login-option-${name}`}
                    onClick={() => startLogin(name)}
                    className="w-full text-left px-2 py-2 rounded text-xs text-slate-200 hover:bg-slate-800/80 disabled:opacity-50 flex items-center gap-2"
                  >
                    {lg?.loading ? (
                      <Loader2 size={13} className="animate-spin shrink-0" />
                    ) : (
                      <Cloud size={13} className="text-slate-400 shrink-0" />
                    )}
                    <span className="font-medium truncate">{name}</span>
                  </button>
                  {(lg?.loginUrl || lg?.error || st) && (
                    <div className="px-2 pb-2 space-y-1">
                      {lg?.loginUrl && (
                        <a
                          href={lg.loginUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={lg.loginUrl}
                          className="text-[11px] text-blue-400 hover:underline inline-flex items-center gap-0.5 break-all max-w-full"
                        >
                          Open SSO link
                          <ExternalLink size={10} className="shrink-0" />
                        </a>
                      )}
                      {lg?.error && <p className="text-[11px] text-red-400">{lg.error}</p>}
                      {lg?.loginUrl && (
                        <button
                          type="button"
                          onClick={() => checkStatus(name)}
                          disabled={disabled || st?.loading}
                          className="block text-[11px] px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800/80 disabled:opacity-50"
                        >
                          {st?.loading ? 'Checking…' : 'Check login'}
                        </button>
                      )}
                      {st?.data && (
                        <p
                          className={`text-[11px] ${st.data.loggedIn ? 'text-emerald-400' : 'text-amber-400'}`}
                        >
                          {st.data.loggedIn
                            ? `Logged in: account ${st.data.account}`
                            : `Not logged in${st.data.error ? `: ${st.data.error}` : ''}`}
                        </p>
                      )}
                      {st?.error && <p className="text-[11px] text-red-400">{st.error}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
