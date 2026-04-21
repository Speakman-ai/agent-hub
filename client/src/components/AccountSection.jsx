import { useEffect, useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import RoleBadge from './RoleBadge.jsx';
import GithubConnectionSection from './GithubConnectionSection.jsx';
import { getAuthHeaders, getApiBase } from '../utils/connection.js';
import { hasRole, getUserRole } from '../utils/auth.js';

/**
 * Account tab — surfaces the current user's role (Phase 2 auth) and,
 * for Admin+ callers, the roster of configured users.
 *
 * Single-user today: the list has exactly one row. The component is
 * designed to keep working when multi-user arrives — it just renders
 * whatever `/api/auth/users` returns.
 */
export default function AccountSection() {
  const [me, setMe] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

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
          const usersRes = await fetch(`${getApiBase()}/auth/users`, {
            headers: getAuthHeaders(),
          });
          if (usersRes.ok) {
            const body = await usersRes.json();
            if (!cancelled) setUsers(body.users || []);
          } else if (usersRes.status !== 403 && !cancelled) {
            setError(`GET /auth/users → ${usersRes.status}`);
          }
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
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        Loading account…
      </div>
    );
  }

  const currentRole = me?.role || getUserRole();

  return (
    <div className="space-y-6">
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-sm font-medium text-gray-300 mb-3">Your account</h4>
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
          while they're the only one. Multi-user management arrives in Phase 3.
        </p>
      </div>

      <GithubConnectionSection />

      {users !== null && (
        <div className="bg-gray-800 rounded-xl p-4">
          <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
            <Users size={14} /> Configured users
          </h4>
          {users.length === 0 ? (
            <p className="text-xs text-gray-500">No users configured.</p>
          ) : (
            <ul className="space-y-2">
              {users.map((u) => (
                <li
                  key={u.username}
                  className="flex items-center justify-between border border-gray-700 rounded px-3 py-2"
                >
                  <span className="font-mono text-sm text-white">{u.username}</span>
                  <RoleBadge role={u.role} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
          {error}
        </div>
      )}
    </div>
  );
}
