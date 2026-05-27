import { useCallback, useEffect, useState } from 'react';
import {
  Copy,
  Key,
  Loader2,
  LogOut,
  Plus,
  Sparkles,
  SquareKanban,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import RoleBadge from './RoleBadge.jsx';
import MyClaudeAuthSection from './MyClaudeAuthSection.jsx';
import MySingleKeyAuthSection from './MySingleKeyAuthSection.jsx';
import MyCursorAuthSection from './MyCursorAuthSection.jsx';
import MyCodexAuthSection from './MyCodexAuthSection.jsx';
import MySkillCredentialSection from './MySkillCredentialSection.jsx';
import { api } from '../utils/api.js';
import { getAuthHeaders, getApiBase } from '../utils/connection.js';
import { hasRole, getUserRole, logout } from '../utils/auth.js';

const ALL_ROLES = ['Owner', 'Admin', 'User'];

/**
 * Returns the list of roles a caller is allowed to assign when creating a new
 * user. Owner can assign any role; Admin can create Admin + User but not
 * Owner; lower roles can't create users at all. The server enforces the same
 * gate (Owner-only) — this helper exists so the UI mirrors the rule and
 * tests can pin it down.
 *
 * @param {string|null|undefined} callerRole
 * @returns {Array<'Owner' | 'Admin' | 'User'>}
 */
export function roleOptionsFor(callerRole) {
  if (callerRole === 'Owner') return ['Owner', 'Admin', 'User'];
  if (callerRole === 'Admin') return ['Admin', 'User'];
  return [];
}

/**
 * Account tab — surfaces the current user's role and, for Admin+ callers,
 * the roster of configured users with create / change-role / remove
 * controls.
 */
export default function AccountSection() {
  const [me, setMe] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [rowErrors, setRowErrors] = useState({});
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout({ baseUrl: getApiBase() });
    } catch {
      /* logout is best-effort; the local token is dropped regardless */
    }
    // Reload so the AuthGate re-evaluates and surfaces the login screen.
    if (typeof window !== 'undefined' && window.location?.reload) {
      window.location.reload();
    }
  }, [loggingOut]);

  const loadUsers = useCallback(async () => {
    const usersRes = await fetch(`${getApiBase()}/auth/users`, {
      headers: getAuthHeaders(),
    });
    if (usersRes.ok) {
      const body = await usersRes.json();
      setUsers(body.users || []);
    } else if (usersRes.status !== 403) {
      setError(`GET /auth/users → ${usersRes.status}`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const meRes = await fetch(`${getApiBase()}/auth/me`, { headers: getAuthHeaders() });
        if (!meRes.ok) throw new Error(`GET /auth/me → ${meRes.status}`);
        const meBody = await meRes.json();
        if (cancelled) return;
        setMe(meBody.user || null);

        // Only Admin+ can fetch the users roster — the server enforces
        // this; we skip the request otherwise to avoid noisy 403s.
        if (hasRole('Admin') || meBody.user?.role === 'Owner' || meBody.user?.role === 'Admin') {
          await loadUsers();
        }
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadUsers]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        Loading account…
      </div>
    );
  }

  const currentRole = me?.role || getUserRole();
  const isOwner = currentRole === 'Owner';
  const isAdminPlus = currentRole === 'Owner' || currentRole === 'Admin';

  const setRowError = (id, msg) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });

  const handleRoleChange = async (user, nextRole) => {
    if (!user.id || nextRole === user.role) return;
    setRowError(user.id, null);
    try {
      const res = await fetch(`${getApiBase()}/auth/users/${user.id}/role`, {
        method: 'PUT',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowError(user.id, body.error || `PUT /auth/users → ${res.status}`);
        return;
      }
      await loadUsers();
    } catch (err) {
      setRowError(user.id, err.message || String(err));
    }
  };

  const handleRemove = async (user) => {
    if (!user.id) return;
    if (!window.confirm(`Remove ${user.username}? This can't be undone.`)) return;
    setRowError(user.id, null);
    try {
      const res = await fetch(`${getApiBase()}/auth/users/${user.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowError(user.id, body.error || `DELETE /auth/users → ${res.status}`);
        return;
      }
      await loadUsers();
    } catch (err) {
      setRowError(user.id, err.message || String(err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h4 className="text-sm font-medium text-gray-300">Your account</h4>
          {me && (
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-50"
              aria-label="Log out"
            >
              {loggingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
              Log out
            </button>
          )}
        </div>
        {me ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-white">{me.username}</span>
            <RoleBadge role={currentRole} />
          </div>
        ) : (
          <p className="text-xs text-gray-500">Not authenticated.</p>
        )}
        <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
          Roles are hierarchical: <span className="text-emerald-300">Owner</span> {'>'}{' '}
          <span className="text-indigo-300">Admin</span> {'>'}{' '}
          <span className="text-gray-300">User</span>. Owner has full control and cannot be demoted
          while they're the only one.
        </p>
      </div>

      {me && <MyClaudeAuthSection />}

      {me && <MyCursorAuthSection />}

      {me && (
        <MySingleKeyAuthSection
          engineLabel="Gemini"
          Icon={Sparkles}
          placeholder="AIza..."
          hostSettingHint="Settings → Gemini Auth"
          getter={() => api.getMyGeminiAuth()}
          setter={(body) => api.putMyGeminiAuth(body)}
        />
      )}

      {me && <MyCodexAuthSection />}

      {me && (
        <MySkillCredentialSection
          skillId="linear"
          keyName="LINEAR_API_KEY"
          label="Linear API key"
          placeholder="lin_api_..."
          Icon={SquareKanban}
          docsUrl="https://linear.app/settings/api"
          description={
            <>
              Personal API key from Linear (Settings → API → Personal API keys). When set, sessions
              you own will have <code>LINEAR_API_KEY</code> injected so the Linear skill can query
              your workspace.
            </>
          }
        />
      )}

      {me && <ApiKeysSection />}

      {users !== null && (
        <div className="bg-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
              <Users size={14} /> Configured users
            </h4>
            {isOwner && (
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white"
                aria-label="Add user"
              >
                <Plus size={12} /> Add user
              </button>
            )}
          </div>
          {users.length === 0 ? (
            <p className="text-xs text-gray-500">No users configured.</p>
          ) : (
            <ul className="space-y-2">
              {users.map((u) => {
                const rowError = u.id ? rowErrors[u.id] : null;
                return (
                  <li key={u.id || u.username} className="border border-gray-700 rounded px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-sm text-white">{u.username}</span>
                      <div className="flex items-center gap-2">
                        {isAdminPlus && u.id ? (
                          <select
                            aria-label={`Role for ${u.username}`}
                            value={u.role}
                            onChange={(e) => handleRoleChange(u, e.target.value)}
                            className="bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 px-2 py-1"
                          >
                            {ALL_ROLES.map((r) => (
                              <option key={r} value={r} disabled={r === 'Owner' && !isOwner}>
                                {r}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <RoleBadge role={u.role} />
                        )}
                        {isOwner && u.id && (
                          <button
                            type="button"
                            onClick={() => handleRemove(u)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-500/40 text-red-300 hover:bg-red-500/10"
                            aria-label={`Remove ${u.username}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                    {rowError && (
                      <div
                        role="alert"
                        className="mt-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
                      >
                        {rowError}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
          {error}
        </div>
      )}

      {showAddModal && (
        <AddUserModal
          callerRole={currentRole}
          onClose={() => setShowAddModal(false)}
          onCreated={async () => {
            setShowAddModal(false);
            await loadUsers();
          }}
        />
      )}
    </div>
  );
}

function AddUserModal({ callerRole, onClose, onCreated }) {
  const options = roleOptionsFor(callerRole);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(options[options.length - 1] || 'User');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${getApiBase()}/auth/users`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `POST /auth/users → ${res.status}`);
        setBusy(false);
        return;
      }
      await onCreated();
    } catch (err) {
      setError(err.message || String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-label="Add user"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-sm shadow-xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-white">Add user</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
            aria-label="Close add-user dialog"
          >
            <X size={16} />
          </button>
        </div>

        <label className="block text-xs text-gray-400 mb-1" htmlFor="add-user-username">
          Username
        </label>
        <input
          id="add-user-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
          required
          className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
        />

        <label className="block text-xs text-gray-400 mb-1" htmlFor="add-user-password">
          Password
        </label>
        <input
          id="add-user-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
        />

        <label className="block text-xs text-gray-400 mb-1" htmlFor="add-user-role">
          Role
        </label>
        <select
          id="add-user-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
        >
          {options.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        {error && (
          <div
            role="alert"
            className="mb-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2"
          >
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function formatRelative(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return new Date(iso).toLocaleString();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Per-user API keys panel — exported for direct testing without
 * mounting the whole AccountSection tree.
 */
export function ApiKeysSection() {
  const [keys, setKeys] = useState(null);
  const [error, setError] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [rowErrors, setRowErrors] = useState({});

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/auth/keys`, { headers: getAuthHeaders() });
      if (!res.ok) {
        if (res.status === 401) {
          // Not authenticated — caller is using the legacy global apiKey
          // path which has no per-user identity. Just hide the panel.
          setKeys([]);
          return;
        }
        throw new Error(`GET /auth/keys → ${res.status}`);
      }
      const body = await res.json();
      setKeys(body.keys || []);
    } catch (err) {
      setError(err.message || String(err));
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleRevoke = async (key) => {
    if (
      !window.confirm(
        `Revoke API key "${key.name}"? Any client using this key will immediately lose access.`,
      )
    ) {
      return;
    }
    setRowErrors((prev) => ({ ...prev, [key.id]: null }));
    try {
      const res = await fetch(`${getApiBase()}/auth/keys/${key.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowErrors((prev) => ({
          ...prev,
          [key.id]: body.error || `DELETE /auth/keys → ${res.status}`,
        }));
        return;
      }
      await loadKeys();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [key.id]: err.message || String(err) }));
    }
  };

  // Hide the panel entirely on the legacy global-apiKey auth path
  // (no per-user identity, server returned 401 above and we set [] —
  // distinguishing here would require an extra round-trip to /auth/me
  // which the parent already did, so we just render the section if the
  // parent decided to mount us at all).
  return (
    <div className="bg-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Key size={14} /> API Keys
        </h4>
        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white"
          aria-label="Generate API key"
        >
          <Plus size={12} /> Generate
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-3 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
        >
          {error}
        </div>
      )}
      {keys === null ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Loading keys…
        </div>
      ) : keys.length === 0 ? (
        <p className="text-xs text-gray-500">
          No API keys yet. Generate one to use Agent Hub from scripts, CI, or remote Electron
          clients.
        </p>
      ) : (
        <ul className="space-y-2">
          {keys.map((k) => {
            const rowError = rowErrors[k.id];
            return (
              <li key={k.id} className="border border-gray-700 rounded px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white truncate">{k.name}</div>
                    <div className="text-[11px] text-gray-500 font-mono">{k.prefix}…</div>
                    <div className="text-[11px] text-gray-500 mt-1 flex flex-wrap gap-x-3">
                      <span>Created {formatRelative(k.createdAt)}</span>
                      <span>Last used {k.lastUsedAt ? formatRelative(k.lastUsedAt) : 'never'}</span>
                      {k.expiresAt && (
                        <span>Expires {new Date(k.expiresAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRevoke(k)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-500/40 text-red-300 hover:bg-red-500/10"
                    aria-label={`Revoke ${k.name}`}
                  >
                    <Trash2 size={12} /> Revoke
                  </button>
                </div>
                {rowError && (
                  <div
                    role="alert"
                    className="mt-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
                  >
                    {rowError}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
        API keys grant your full access to this org. Use{' '}
        <code className="text-gray-400">Authorization: Bearer ahub_…</code> on REST calls or{' '}
        <code className="text-gray-400">?apiKey=ahub_…</code> on WebSocket handshakes.
      </p>

      {showCreateModal && (
        <CreateApiKeyModal
          onClose={() => setShowCreateModal(false)}
          onCreated={async () => {
            await loadKeys();
          }}
        />
      )}
    </div>
  );
}

function CreateApiKeyModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = { name: name.trim() };
      if (expiresInDays.trim()) {
        body.expiresInDays = Number(expiresInDays);
      }
      const res = await fetch(`${getApiBase()}/auth/keys`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.error || `POST /auth/keys → ${res.status}`);
        setBusy(false);
        return;
      }
      const responseBody = await res.json();
      setCreated(responseBody);
      setBusy(false);
      // Refresh parent list so the new key shows immediately on close.
      await onCreated();
    } catch (err) {
      setError(err.message || String(err));
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!created?.token) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setError('Copy failed — select the token manually.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-label={created ? 'API key created' : 'Generate API key'}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-white">
            {created ? 'API key created' : 'Generate API key'}
          </h3>
          {!created && (
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-200"
              aria-label="Close generate-key dialog"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {created ? (
          <div className="space-y-3">
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2">
              This token will only be shown once. Copy it now and store it somewhere safe.
            </div>
            <div className="font-mono text-xs text-white bg-gray-800 border border-gray-700 rounded p-2 break-all select-all">
              {created.token}
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                <Copy size={12} /> {copied ? 'Copied!' : 'Copy token'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
              >
                I&apos;ve copied it
              </button>
            </div>
            {error && (
              <div
                role="alert"
                className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2"
              >
                {error}
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="block text-xs text-gray-400 mb-1" htmlFor="apikey-name">
              Name
            </label>
            <input
              id="apikey-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My CI server"
              maxLength={100}
              required
              autoComplete="off"
              className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
            />

            <label className="block text-xs text-gray-400 mb-1" htmlFor="apikey-expires">
              Expires in (days, optional)
            </label>
            <input
              id="apikey-expires"
              type="number"
              min="1"
              max="3650"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              placeholder="Leave blank for no expiry"
              className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
            />

            {error && (
              <div
                role="alert"
                className="mb-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2"
              >
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Generate
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
