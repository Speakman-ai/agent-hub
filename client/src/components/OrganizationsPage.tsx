import { useEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react';
import OrganizationAgentsPanel, { type OrganizationChatTarget } from './OrganizationAgentsPanel';
import OrganizationPortfolioPanel from './OrganizationPortfolioPanel';
import { createUseOrganizations } from '@shared/hooks/useOrganizations';
import type {
  OrganizationRole,
  OrganizationState,
  OrganizationController,
} from '@shared/utils/organizations';
import { api } from '../utils/api';
import { getApiBase } from '../utils/connection';
import { getActiveOrg } from '../utils/orgs';
import { getAuthRecord } from '../utils/auth';

const useOrganizations = createUseOrganizations({ useEffect, useMemo, useSyncExternalStore });
const scope = () => JSON.stringify([getApiBase(), getActiveOrg()?.id, getAuthRecord()?.user?.id]);
const button =
  'rounded-lg border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';
const input = 'rounded-lg border border-gray-700 bg-gray-900 p-2 text-sm';
const roles: OrganizationRole[] = ['Owner', 'Admin', 'Member'];
const toggle = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];

type PageProps = {
  projectId?: string;
  /** Deep-linked organization to select once the list loads. */
  initialOrganizationId?: string | null;
  onSelectOrganization?: (organizationId: string | null) => void;
  onOpenChat?: (target: OrganizationChatTarget) => void;
  onOpenProject?: (projectId: string) => void;
  onOpenSession?: (agentId: string, sessionId: string) => void;
};
export default function OrganizationsPage({
  projectId,
  initialOrganizationId,
  onSelectOrganization,
  onOpenChat,
  onOpenProject,
  onOpenSession,
}: PageProps) {
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const invalidate = () => setRefresh((value) => value + 1);
    window.addEventListener('organizations_changed', invalidate);
    return () => window.removeEventListener('organizations_changed', invalidate);
  }, []);
  const { state, controller } = useOrganizations(api.organizations, scope, refresh);
  // Follow every change of the routed organization (deep link, Back/Forward), not just the first.
  // Selections made on this page round-trip through onSelectOrganization and match already.
  const appliedRoute = useRef<string | null | undefined>(undefined);
  // While a routed selection is loading, the controller still holds the previous selection.
  // Reporting it would write the stale value back into the route, so reporting waits.
  const pendingRoute = useRef<object | null>(null);
  const [routeSettled, setRouteSettled] = useState(0);
  useEffect(() => {
    if (!state.ready || state.busy || projectId) return;
    const target = initialOrganizationId ?? null;
    if (appliedRoute.current === target) return;
    appliedRoute.current = target;
    // An unknown or inaccessible organization shows the plain list rather than the old selection.
    const wanted =
      target !== null && state.organizations.some((o) => o.id === target) ? target : null;
    if (state.selectedId === wanted) {
      // Nothing to load, but report so App corrects a route naming an unavailable organization.
      if (wanted !== target) setRouteSettled((value) => value + 1);
      return;
    }
    const token = {};
    pendingRoute.current = token;
    void controller.load(wanted).finally(() => {
      if (pendingRoute.current !== token) return;
      pendingRoute.current = null;
      setRouteSettled((value) => value + 1);
    });
  }, [state, initialOrganizationId, controller, projectId]);
  useEffect(() => {
    if (pendingRoute.current || !state.ready || state.busy) return;
    onSelectOrganization?.(state.selectedId);
  }, [state.ready, state.busy, state.selectedId, onSelectOrganization, routeSettled]);
  return (
    <section
      className={projectId ? 'space-y-3' : 'flex-1 overflow-y-auto p-4 md:p-6 space-y-4'}
      aria-label="Organizations"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Organizations</h2>
        <button className={button} disabled={state.busy} onClick={() => void controller.load()}>
          Refresh organizations
        </button>
      </div>
      <p className="text-sm text-gray-400">
        Organizations group projects within this Server. Projects can belong to several
        organizations or remain independent. Linking never grants project access.
      </p>
      {state.error && (
        <div role="alert" className="text-red-300">
          {state.error} Refresh to retry. Check your Server sign-in and organization permissions if
          access is denied.
        </div>
      )}
      {state.busy && <p role="status">Loading organizations…</p>}
      {state.ready &&
        !state.busy &&
        (projectId ? (
          <ProjectOrganizations
            key={projectId}
            projectId={projectId}
            state={state}
            controller={controller}
          />
        ) : (
          <OrganizationManager
            state={state}
            controller={controller}
            onOpenChat={onOpenChat}
            onOpenProject={onOpenProject}
            onOpenSession={onOpenSession}
          />
        ))}
    </section>
  );
}

type Props = {
  state: OrganizationState;
  controller: OrganizationController;
  onOpenChat?: (target: OrganizationChatTarget) => void;
  onOpenProject?: (projectId: string) => void;
  onOpenSession?: (agentId: string, sessionId: string) => void;
};
function ProjectOrganizations({ projectId, state, controller }: Props & { projectId: string }) {
  const [ids, setIds] = useState(() =>
    state.organizations
      .filter((o) => state.links[o.id]?.some((p) => p.id === projectId))
      .map((o) => o.id),
  );
  const accessible = state.projects.some((p) => p.id === projectId);
  return (
    <div className="space-y-3">
      {!state.organizations.length && (
        <p>No organizations available. Create one explicitly from Organizations in the sidebar.</p>
      )}
      {!accessible && (
        <p>This project cannot be linked. Check project access or choose a regular project.</p>
      )}
      {state.organizations.map((o) => (
        <label className="flex items-center gap-2" key={o.id}>
          <input
            type="checkbox"
            checked={ids.includes(o.id)}
            disabled={!o.canManage || !accessible}
            onChange={() => setIds(toggle(ids, o.id))}
          />
          {o.name}
          {!o.canManage && (
            <span className="text-sm text-gray-400">
              Ask an Owner or Admin to change membership.
            </span>
          )}
        </label>
      ))}
      <button
        className={button}
        disabled={!accessible || !state.organizations.some((o) => o.canManage)}
        onClick={() => void controller.saveProjectOrganizations(projectId, ids)}
      >
        Save organization links
      </button>
      <p className="text-sm text-gray-400">
        Clearing links leaves this project in the normal project list.
      </p>
    </div>
  );
}
function OrganizationManager({
  state,
  controller,
  onOpenChat,
  onOpenProject,
  onOpenSession,
}: Props) {
  const [newName, setNewName] = useState('');
  const selected = state.organizations.find((o) => o.id === state.selectedId);
  return (
    <div className="space-y-5">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (newName.trim()) void controller.create(newName);
        }}
      >
        <input
          className={input}
          aria-label="New organization name"
          placeholder="New organization name"
          maxLength={200}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
        />
        <button className={button} disabled={!newName.trim()}>
          Create organization
        </button>
      </form>
      {!state.organizations.length && (
        <p>
          No organizations yet. Create one to start grouping projects. Your existing projects stay
          independent.
        </p>
      )}
      <nav className="flex flex-wrap gap-2" aria-label="Choose organization">
        {state.organizations.map((o) => (
          <button
            key={o.id}
            className={button}
            aria-pressed={o.id === state.selectedId}
            onClick={() => void controller.load(o.id)}
          >
            {o.name}
          </button>
        ))}
      </nav>
      {selected ? (
        <OrganizationDetails
          key={selected.id}
          state={state}
          controller={controller}
          onOpenChat={onOpenChat}
          onOpenProject={onOpenProject}
          onOpenSession={onOpenSession}
        />
      ) : (
        state.organizations.length > 0 && (
          <p>Select an organization to view projects and members.</p>
        )
      )}
    </div>
  );
}
function OrganizationDetails({
  state,
  controller,
  onOpenChat,
  onOpenProject,
  onOpenSession,
}: Props) {
  const organization = state.organizations.find((o) => o.id === state.selectedId)!;
  const [name, setName] = useState(organization.name);
  const [ids, setIds] = useState(() => (state.links[organization.id] || []).map((p) => p.id));
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<OrganizationRole>('Member');
  const [archive, setArchive] = useState(false);
  return (
    <div className="space-y-4 border-t border-gray-800 pt-4">
      <h3 className="font-semibold">{organization.name}</h3>
      {!organization.canManage && (
        <p>Read only. Ask an organization Owner or Admin to edit projects or members.</p>
      )}
      {organization.canManage && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void controller.rename(name);
          }}
        >
          <input
            className={input}
            aria-label="Organization name"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button className={button} disabled={!name.trim() || name.trim() === organization.name}>
            Save name
          </button>
        </form>
      )}
      <h4 className="font-medium">Linked projects</h4>
      {!ids.length && <p>No linked projects. Projects remain independent until attached.</p>}
      {(organization.canManage ? state.projects : state.links[organization.id] || []).map((p) => (
        <label className="flex items-center gap-2" key={p.id}>
          <input
            type="checkbox"
            disabled={!organization.canManage}
            checked={ids.includes(p.id)}
            onChange={() => setIds(toggle(ids, p.id))}
          />
          {p.name}
        </label>
      ))}
      {organization.canManage && (
        <>
          {!state.projects.length && (
            <p>No accessible projects to attach. Create a project or ask its owner for access.</p>
          )}
          <button className={button} onClick={() => void controller.saveProjects(ids)}>
            Save project links
          </button>
        </>
      )}
      <OrganizationPortfolioPanel
        organization={organization}
        scope={scope}
        onOpenProject={onOpenProject}
        onOpenSession={onOpenSession}
        onOpenChat={onOpenChat}
      />
      <OrganizationAgentsPanel
        organization={organization}
        linkedProjects={state.links[organization.id] || []}
        scope={scope}
        onOpenChat={onOpenChat}
      />
      <h4 className="font-medium">Members</h4>
      {state.members.map((member) => (
        <div className="flex flex-wrap items-center gap-2" key={member.userId}>
          <span>{member.username}</span>
          <select
            className={input}
            aria-label={`Role for ${member.username}`}
            value={member.role}
            disabled={!organization.canManage}
            onChange={(event) =>
              void controller.member(member.userId, event.target.value as OrganizationRole)
            }
          >
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          {organization.canManage && (
            <button className={button} onClick={() => void controller.member(member.userId, null)}>
              Remove {member.username}
            </button>
          )}
        </div>
      ))}
      {organization.canManage && (
        <>
          <p className="text-sm text-gray-400">
            Keep at least one Owner. Organization membership does not grant access to private or
            restricted projects.
          </p>
          <div className="flex flex-wrap gap-2">
            <select
              className={input}
              aria-label="Server member"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">Choose a Server member</option>
              {state.candidates
                .filter((c) => !state.members.some((m) => m.userId === c.userId))
                .map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.username}
                  </option>
                ))}
            </select>
            <select
              className={input}
              aria-label="New member role"
              value={role}
              onChange={(event) => setRole(event.target.value as OrganizationRole)}
            >
              {roles.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <button
              className={button}
              disabled={!userId}
              onClick={() => void controller.member(userId, role)}
            >
              Add member
            </button>
          </div>
          {!archive ? (
            <button className={button} onClick={() => setArchive(true)}>
              Archive organization
            </button>
          ) : (
            <div className="space-y-2">
              <p>
                Archive {organization.name}? Members lose organization access. Projects and their
                other organization links are preserved.
              </p>
              <button className={button} onClick={() => void controller.archive()}>
                Confirm archive
              </button>{' '}
              <button className={button} onClick={() => setArchive(false)}>
                Cancel archive
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
