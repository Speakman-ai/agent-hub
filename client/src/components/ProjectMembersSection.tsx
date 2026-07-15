/**
 * ProjectMembersSection — Owner-managed per-project visibility ACL.
 *
 * A user sees a project only if assigned to it. This panel lets an Owner
 * manage that assignment set: list current members, add an org user, remove
 * one. It is self-contained (fetches its own data) and hides itself for
 * non-Owner callers — the backend returns 403 on the members endpoint, which
 * we treat as "you can't manage this," so the section renders nothing.
 *
 * A shared project with no restriction is visible to the whole org. A
 * restricted project stays restricted even when its last assigned user is
 * removed. We surface that distinction so the Owner understands the effect of
 * assignment changes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, UserPlus, X, Users, Globe, Lock } from 'lucide-react';
import { api } from '../utils/api';

interface Member {
  userId: string;
  username: string;
  addedBy: string | null;
  createdAt: string;
}

interface ProjectMembersSectionProps {
  project: {
    id: string;
    name: string;
    visibility?: 'shared' | 'private';
  };
  showToast?: (msg: string, kind?: 'error' | 'success') => void;
}

export default function ProjectMembersSection({ project, showToast }: ProjectMembersSectionProps) {
  const projectId = project?.id;
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [restricted, setRestricted] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [projectVisibility, setProjectVisibility] = useState<'shared' | 'private'>(
    project?.visibility === 'private' ? 'private' : 'shared',
  );
  const [roster, setRoster] = useState<Array<{ id: string; username: string }>>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [busy, setBusy] = useState(false);

  const notify = useCallback(
    (msg: string, kind: 'error' | 'success' = 'error') => {
      if (showToast) showToast(msg, kind);
    },
    [showToast],
  );

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await api.getProjectMembers(projectId);
      setMembers(res.members || []);
      setRestricted(Boolean(res.restricted));
      setOwnerUserId(res.ownerUserId ?? null);
      setProjectVisibility(res.visibility === 'private' ? 'private' : 'shared');
      setVisible(true);
    } catch {
      // 403 → caller is not an Owner; hide the whole section rather than
      // showing an error. Any other failure also just hides it (best-effort
      // settings surface).
      setVisible(false);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // Load the org roster lazily once the section is known to be visible.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    api
      .getOrgUsers()
      .then((res) => {
        if (cancelled) return;
        const users = (res.users || [])
          .filter((u) => Boolean(u.id))
          // Label with the login username, falling back to email (or the id) so
          // the option is never blank — email-only responses used to render as
          // empty options, making the picker look like it had no users.
          .map((u) => ({
            id: u.id as string,
            username: u.username || u.email || (u.id as string),
          }));
        setRoster(users);
      })
      .catch(() => {
        /* roster is a convenience; leave empty on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);
  const assignable = useMemo(() => roster.filter((u) => !memberIds.has(u.id)), [roster, memberIds]);
  const isPrivateProject = projectVisibility === 'private';
  const hasMembers = members.length > 0;

  const add = useCallback(async () => {
    if (!projectId || !selectedUserId) return;
    setBusy(true);
    try {
      await api.addProjectMember(projectId, selectedUserId);
      setSelectedUserId('');
      await load();
      notify('User assigned to project.', 'success');
    } catch (err: any) {
      notify(String(err?.message || 'Failed to assign user.'));
    } finally {
      setBusy(false);
    }
  }, [projectId, selectedUserId, load, notify]);

  const remove = useCallback(
    async (userId: string) => {
      if (!projectId) return;
      setBusy(true);
      try {
        await api.removeProjectMember(projectId, userId);
        await load();
      } catch (err: any) {
        notify(String(err?.message || 'Failed to remove user.'));
      } finally {
        setBusy(false);
      }
    },
    [projectId, load, notify],
  );

  if (!visible) return null;

  return (
    <div className="border border-gray-700 rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-gray-400" />
        <span className="text-sm text-gray-200 font-medium">Members</span>
        {loading && <Loader2 className="w-3.5 h-3.5 text-gray-500 animate-spin" />}
      </div>

      <div className="flex items-start gap-2 text-xs text-gray-500">
        {restricted ? (
          <>
            <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            {isPrivateProject ? (
              hasMembers ? (
                <span>
                  This private project is <strong className="text-gray-300">restricted</strong>:
                  assigned users and the creator can see and open it. Removing the last member makes
                  it owner-only.
                </span>
              ) : (
                <span>
                  This private project is <strong className="text-gray-300">restricted</strong> but
                  has no assigned users, so only the creator can see and open it. Add a user to
                  grant access.
                </span>
              )
            ) : hasMembers ? (
              <span>
                This shared project is <strong className="text-gray-300">restricted</strong>: only
                assigned users (plus Owners) can see and open it. Removing members keeps it
                restricted.
              </span>
            ) : (
              <span>
                This shared project is <strong className="text-gray-300">restricted</strong> but has
                no assigned users. Only Owners and the creator can see and open it. Add a user to
                grant access.
              </span>
            )}
          </>
        ) : (
          <>
            {isPrivateProject ? (
              <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            ) : (
              <Globe className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-emerald-500" />
            )}
            {isPrivateProject ? (
              <span>
                This private project has no assigned members, so only the creator can see and open
                it. Assign a user to grant access.
              </span>
            ) : (
              <span>
                This shared project has no members, so it is visible to{' '}
                <strong className="text-gray-300">everyone</strong> in the org. Assign a user to
                restrict it to members only.
              </span>
            )}
          </>
        )}
      </div>

      {members.length > 0 && (
        <ul className="space-y-1">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between bg-gray-900 rounded px-2 py-1.5"
            >
              <span className="text-sm text-gray-200 truncate">
                {m.username}
                {m.userId === ownerUserId && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">
                    creator
                  </span>
                )}
              </span>
              <button
                onClick={() => remove(m.userId)}
                disabled={busy}
                title="Remove from project"
                data-testid={`project-member-remove-${m.userId}`}
                className="text-gray-500 hover:text-red-400 disabled:opacity-40"
              >
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          disabled={busy || assignable.length === 0}
          data-testid={`project-member-select-${projectId}`}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-gray-600 disabled:opacity-50"
        >
          <option value="">
            {assignable.length === 0 ? 'No more users to assign' : 'Select a user…'}
          </option>
          {assignable.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <button
          onClick={add}
          disabled={busy || !selectedUserId}
          data-testid={`project-member-add-${projectId}`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          <UserPlus className="w-4 h-4" />
          Assign
        </button>
      </div>
    </div>
  );
}
