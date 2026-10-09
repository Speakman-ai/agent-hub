import { useEffect, useState } from 'react';
import { Building2, Cloud, Monitor, Pencil, ChevronDown, Loader2, Check, X } from 'lucide-react';
import { fetchOrgs, switchOrg, updateOrg } from '../utils/orgs';
import { getConnectionConfig, saveConnectionConfig, reloadForOrgSwitch } from '../utils/connection';
import {
  isServerOriginChange,
  loginOrgUrl,
  resolveLoginServerOptions,
  normalizeServerUrl,
  validateServerUrl,
  type LoginServerOptions,
} from '@shared/utils/loginServerPicker';

/**
 * Login-screen escape hatch for the Electron desktop app.
 *
 * In remote mode Electron loads the remote server's bundle, so when the user
 * doesn't hold credentials for that org the login page is the only thing they
 * can reach — and without this picker there is no way back (AuthGate only
 * offers "Switch to local" when the remote is *unreachable*). This lets them
 * swap to another bookmarked org, edit the current server URL, or fall back
 * to the local server, all before signing in.
 *
 * Rendered only inside Electron (the caller gates on `isElectron()`); in a
 * browser you're already on the server's own origin, so switching is moot.
 */
interface Props {
  /**
   * Called synchronously before any switch work. The login screen owns the
   * transition: false (a sign-in is in flight) cancels the switch, true
   * blocks sign-in until the window reloads or `onServerChangeEnd` runs.
   */
  onServerChangeStart: () => boolean;
  /** Called when a switch fails, so the login screen can accept sign-in again. */
  onServerChangeEnd: () => void;
  /** Lock the picker, e.g. while the login form is submitting. */
  disabled?: boolean;
}

export default function LoginServerPicker({
  onServerChangeStart,
  onServerChangeEnd,
  disabled = false,
}: Props) {
  const [options, setOptions] = useState<LoginServerOptions | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const connection = getConnectionConfig();
      let orgs: any[] = [];
      let activeOrgId: string | null = null;
      try {
        const res = await fetchOrgs();
        orgs = res?.orgs ?? [];
        activeOrgId = res?.activeOrgId ?? null;
      } catch {
        // No bookmarks available — still show the connection URL so it can be edited.
      }
      if (cancelled) return;
      setOptions(resolveLoginServerOptions({ connection, orgs, activeOrgId }));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!options) return null;
  const { current, others } = options;
  const isRemote = Boolean(current.url);
  const locked = busy || disabled;

  /**
   * Run one server transition. On success the window reloads onto the new
   * server, so the login screen stays locked until then; on failure the
   * transition is handed back so sign-in works again.
   */
  const runTransition = async (work: () => Promise<void> | void, failMessage: string) => {
    if (locked || !onServerChangeStart()) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      reloadForOrgSwitch();
    } catch (err: any) {
      setError(err?.message || failMessage);
      setBusy(false);
      onServerChangeEnd();
    }
  };

  const handleSwitch = (orgId: string) =>
    runTransition(() => switchOrg(orgId), 'Failed to switch organization');

  const handleSwitchToLocal = () =>
    runTransition(
      () => saveConnectionConfig({ mode: 'local', remoteUrl: '', apiKey: '' }),
      'Failed to switch to the local server',
    );

  const handleSaveUrl = async () => {
    if (locked) return;
    const problem = validateServerUrl(urlDraft);
    if (problem) {
      setError(problem);
      return;
    }
    const nextUrl = normalizeServerUrl(urlDraft);
    // An API key belongs to the server that issued it. Pointing the URL at a
    // different origin must not carry it along: Electron injects the
    // connection's key into every request to the configured host. (Electron
    // also scopes the cached JWT to its origin, so that one can't follow.)
    const keepKey = !isServerOriginChange(current.url, nextUrl);
    await runTransition(async () => {
      if (current.id) {
        // Bookmarked org: update it; `updateOrg` syncs the connection when
        // the edited org is the active one, but the active id can be stale,
        // so make the switch explicit.
        await updateOrg(
          current.id,
          keepKey ? { remoteUrl: nextUrl } : { remoteUrl: nextUrl, apiKey: '' },
        );
        await switchOrg(current.id);
      } else {
        const existing = getConnectionConfig();
        saveConnectionConfig({
          mode: 'remote',
          remoteUrl: nextUrl,
          apiKey: keepKey ? existing.apiKey || '' : '',
        });
      }
    }, 'Failed to save server URL');
  };

  const startEditing = () => {
    setUrlDraft(current.url);
    setError(null);
    setEditing(true);
    setOpen(true);
  };

  return (
    <div
      data-testid="login-server-picker"
      className="mb-5 rounded-lg border border-gray-700 bg-gray-900/60 text-xs"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 bg-gray-700">
          {isRemote ? (
            <Cloud size={12} className="text-gray-200" />
          ) : (
            <Monitor size={12} className="text-gray-200" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-gray-400">Signing in to</div>
          <div className="text-gray-100 font-medium truncate" data-testid="login-server-name">
            {current.name}
          </div>
          {isRemote && (
            <div className="text-gray-500 font-mono truncate" data-testid="login-server-url">
              {current.url}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            setError(null);
          }}
          disabled={locked}
          className="flex items-center gap-1 px-2 py-1 rounded text-gray-300 hover:text-white hover:bg-gray-700/60 transition-colors disabled:opacity-50"
          aria-expanded={open}
          data-testid="login-server-change"
        >
          Change
          <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="border-t border-gray-700 px-3 py-2 space-y-2">
          {editing ? (
            <div className="space-y-2">
              <label className="block text-gray-400" htmlFor="login-server-url-input">
                Server URL
              </label>
              <input
                id="login-server-url-input"
                type="text"
                value={urlDraft}
                onChange={(e) => {
                  setUrlDraft(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleSaveUrl();
                  }
                }}
                placeholder="https://my-server.example.com"
                autoFocus
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSaveUrl()}
                  disabled={locked || !urlDraft.trim()}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-colors"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Save &amp; connect
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                  disabled={locked}
                  className="flex items-center gap-1 px-2 py-1 rounded text-gray-400 hover:text-gray-200 transition-colors"
                >
                  <X size={12} />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {others.length > 0 && (
                <div className="space-y-1">
                  <div className="text-gray-500">Other organizations</div>
                  {others.map((org) => (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => void handleSwitch(org.id)}
                      disabled={locked}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-gray-200 hover:bg-gray-700/50 transition-colors disabled:opacity-50"
                      data-testid={`login-server-org-${org.id}`}
                    >
                      <span
                        className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: org.color || '#6366f1' }}
                      >
                        <Building2 size={10} className="text-white" />
                      </span>
                      <span className="flex-1 truncate">{org.name}</span>
                      <span className="text-gray-500 font-mono truncate max-w-[45%]">
                        {loginOrgUrl(org)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={startEditing}
                  disabled={locked}
                  className="flex items-center gap-1 px-2 py-1 rounded border border-gray-700 text-gray-300 hover:text-white hover:bg-gray-700/50 transition-colors disabled:opacity-50"
                  data-testid="login-server-edit"
                >
                  <Pencil size={12} />
                  {isRemote ? 'Edit server URL' : 'Connect to a server'}
                </button>
                {isRemote && (
                  <button
                    type="button"
                    onClick={handleSwitchToLocal}
                    disabled={locked}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-gray-700 text-gray-300 hover:text-white hover:bg-gray-700/50 transition-colors disabled:opacity-50"
                    data-testid="login-server-local"
                  >
                    <Monitor size={12} />
                    Use local server
                  </button>
                )}
              </div>
            </>
          )}
          {error && (
            <div role="alert" className="text-red-300">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
