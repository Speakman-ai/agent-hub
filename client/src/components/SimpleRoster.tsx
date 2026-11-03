import { useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  BarChart3,
  BellRing,
  CalendarDays,
  GripVertical,
  ListTodo,
  Mail,
  MessageCircle,
  MessagesSquare,
  Search,
} from 'lucide-react';
import type { HubWorkspacePane } from '@shared/utils/hub';
import { groupSimpleChats } from '@shared/utils/simpleRosterGroups';
import AgentAvatar from './AgentAvatar';
import BrandLogo from './BrandLogo';
import { api } from '../utils/api';
import {
  buildSimpleContacts,
  filterSimpleContacts,
  moveSimpleContact,
  orderSimpleContacts,
  readSimpleOrgOrder,
  readSimpleProjectOrder,
  readSimpleRosterOrder,
  reconcileSimpleRosterOrder,
  simpleSessionKey,
  writeSimpleOrgOrder,
  writeSimpleProjectOrder,
  writeSimpleRosterOrder,
  type SimpleAgent,
  type SimpleContact,
  type SimpleContactStatus,
  type SimpleSession,
} from '../utils/shellMode';

export type SimpleServerAgent = {
  id: string;
  name: string;
  preview: string;
  status: SimpleContactStatus;
  selected: boolean;
};

type SimpleRosterProps = {
  agents: readonly SimpleAgent[];
  loadedSessionsAgentId?: string | null;
  activeSessions?: readonly SimpleSession[] | null;
  sessionsByAgentId?: Readonly<Record<string, readonly SimpleSession[] | undefined>>;
  activeTaskSessionIds?: Readonly<Record<string, unknown>>;
  finalizeStatusBySession?: Readonly<Record<string, string | null | undefined>>;
  needsInputBySession?: Readonly<Record<string, unknown>>;
  activeAgentId?: string | null;
  activeSessionId?: string | null;
  apiBase?: string;
  serverAgent?: SimpleServerAgent | null;
  onOpenServerAgent?: () => void;
  onOpenAgent: (agentId: string) => void;
  onOpenFullHub: () => void;
  onEnsureSessions?: (agentId: string) => void;
  /** Hub page currently showing beside the roster, so its icon stays selected. */
  activePane?: HubWorkspacePane | null;
  /** Google Chat is offered only when the signed-in account can read it. */
  googleChatAvailable?: boolean;
  onOpenPane?: (pane: HubWorkspacePane) => void;
  /**
   * Organizations that own the projects. Omit it to load them. `null` keeps
   * the flat list (no organizations on this server).
   */
  organizations?: readonly { id: string; name: string }[] | null;
  /** Organization id → project ids linked to it. Used with `organizations`. */
  projectMembership?: Readonly<Record<string, readonly string[] | undefined>>;
};

const SIMPLE_HOME_LINKS: Array<{
  pane: HubWorkspacePane;
  label: string;
  icon: typeof MessagesSquare;
}> = [
  { pane: 'chat', label: 'Chat', icon: MessagesSquare },
  { pane: 'google-chat', label: 'Google Chat', icon: MessageCircle },
  { pane: 'todos', label: 'Todos', icon: ListTodo },
  { pane: 'reminders', label: 'Reminders', icon: BellRing },
  { pane: 'calendar', label: 'Calendar', icon: CalendarDays },
  { pane: 'mail', label: 'Mail', icon: Mail },
  { pane: 'org', label: 'Server', icon: BarChart3 },
];

export default function SimpleRoster({
  agents,
  loadedSessionsAgentId = null,
  activeSessions = null,
  sessionsByAgentId = {},
  activeTaskSessionIds = {},
  finalizeStatusBySession = {},
  needsInputBySession = {},
  activeAgentId = null,
  activeSessionId = null,
  apiBase = '',
  serverAgent = null,
  onOpenServerAgent,
  onOpenAgent,
  onOpenFullHub,
  onEnsureSessions,
  activePane = null,
  googleChatAvailable = false,
  onOpenPane,
  organizations,
  projectMembership = {},
}: SimpleRosterProps) {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<string[]>(readSimpleRosterOrder);
  const [orgOrder, setOrgOrder] = useState<string[]>(readSimpleOrgOrder);
  const [projectOrderByOrg, setProjectOrderByOrg] =
    useState<Record<string, string[]>>(readSimpleProjectOrder);
  const [loadedOrgs, setLoadedOrgs] = useState<{
    organizations: { id: string; name: string }[];
    membership: Record<string, string[]>;
  } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  useEffect(() => {
    if (organizations !== undefined) return;
    let live = true;
    void (async () => {
      try {
        const result = await api.organizations.list();
        const rows = Array.isArray(result?.organizations) ? result.organizations : [];
        if (rows.length === 0) {
          if (live) setLoadedOrgs(null);
          return;
        }
        const membership: Record<string, string[]> = {};
        await Promise.all(
          rows.map(async (org) => {
            try {
              const linked = await api.organizations.linked(org.id);
              membership[org.id] = (Array.isArray(linked?.projects) ? linked.projects : []).map(
                (project) => project.id,
              );
            } catch {
              membership[org.id] = [];
            }
          }),
        );
        if (!live) return;
        setLoadedOrgs({
          organizations: rows.map((org) => ({ id: org.id, name: org.name })),
          membership,
        });
      } catch {
        if (live) setLoadedOrgs(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [organizations]);
  const rememberedSessionIds = useMemo(() => {
    const ids: Record<string, string> = {};
    for (const agent of agents) {
      try {
        const stored = localStorage.getItem(simpleSessionKey(agent.id));
        if (stored) ids[agent.id] = stored;
      } catch {
        // Storage can be blocked; the newest session is the fallback.
      }
    }
    return ids;
  }, [agents]);
  const contacts = useMemo(
    () =>
      buildSimpleContacts({
        agents,
        loadedSessionsAgentId,
        activeSessions,
        sessionsByAgentId,
        activeTaskSessionIds,
        finalizeStatusBySession,
        needsInputBySession,
        rememberedSessionIds,
        activeAgentId,
        activeSessionId,
      }),
    [
      agents,
      loadedSessionsAgentId,
      activeSessions,
      sessionsByAgentId,
      activeTaskSessionIds,
      finalizeStatusBySession,
      needsInputBySession,
      rememberedSessionIds,
      activeAgentId,
      activeSessionId,
    ],
  );
  const contactKey = contacts.map((contact) => contact.agentId).join('\0');
  useEffect(() => {
    const ids = contactKey ? contactKey.split('\0') : [];
    if (ids.length === 0) return;
    setOrder((prev) => {
      const next = reconcileSimpleRosterOrder(prev, ids);
      if (next.length === prev.length && next.every((id, index) => id === prev[index])) {
        return prev;
      }
      writeSimpleRosterOrder(next);
      return next;
    });
  }, [contactKey]);
  const ordered = useMemo(() => orderSimpleContacts(contacts, order), [contacts, order]);
  const visible = useMemo(() => filterSimpleContacts(ordered, query), [ordered, query]);
  const directory =
    organizations === undefined
      ? loadedOrgs
      : organizations === null
        ? null
        : { organizations, membership: projectMembership };
  const groups = useMemo(
    () =>
      groupSimpleChats({
        items: visible,
        projectId: (contact) => contact.projectId,
        projectName: (contact) => contact.projectName,
        organizations: directory?.organizations,
        membership: directory?.membership ?? {},
        orgOrder,
        projectOrderByOrg,
      }),
    [visible, directory, orgOrder, projectOrderByOrg],
  );
  const reorderable = query.trim() === '';
  useEffect(() => {
    if (!onEnsureSessions) return;
    for (const contact of contacts) onEnsureSessions(contact.agentId);
  }, [contacts, onEnsureSessions]);

  const dropOnAgent = (targetId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('text/plain') || draggedId;
    setDraggedId(null);
    setDragOverId(null);
    if (!sourceId || sourceId.startsWith('org\n') || sourceId.startsWith('project\n')) return;
    const next = moveSimpleContact(
      ordered.map((contact) => contact.agentId),
      sourceId,
      targetId,
    );
    if (!next) return;
    setOrder(next);
    writeSimpleRosterOrder(next);
  };
  const dropOnOrg = (targetId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('text/plain') || draggedId || '';
    setDraggedId(null);
    setDragOverId(null);
    if (!raw.startsWith('org\n') || !groups) return;
    const sourceId = raw.slice(4);
    const next = moveSimpleContact(
      groups.map((group) => group.id),
      sourceId,
      targetId,
    );
    if (!next) return;
    setOrgOrder(next);
    writeSimpleOrgOrder(next);
  };
  const dropOnProject = (orgId: string, targetId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData('text/plain') || draggedId || '';
    setDraggedId(null);
    setDragOverId(null);
    if (!raw.startsWith('project\n') || !groups) return;
    const [, sourceOrgId, sourceId] = raw.split('\n');
    if (sourceOrgId !== orgId || !sourceId) return;
    const group = groups.find((item) => item.id === orgId);
    if (!group) return;
    const next = moveSimpleContact(
      group.projects.map((project) => project.id),
      sourceId,
      targetId,
    );
    if (!next) return;
    const orderByOrg = { ...projectOrderByOrg, [orgId]: next };
    setProjectOrderByOrg(orderByOrg);
    writeSimpleProjectOrder(orderByOrg);
  };

  return (
    <aside
      className="flex h-full w-[min(18rem,100vw)] max-w-full md:w-[300px] flex-col overflow-x-hidden border-r border-gray-800 bg-gray-950 text-gray-100 electron-no-drag"
      data-testid="simple-roster"
      aria-label="Agents"
    >
      <nav
        aria-label="Home"
        data-testid="simple-home-nav"
        className="flex items-center justify-between gap-0.5 px-3 pt-3"
      >
        {SIMPLE_HOME_LINKS.filter((item) => item.pane !== 'google-chat' || googleChatAvailable).map(
          (item) => {
            const Icon = item.icon;
            const active = activePane === item.pane;
            return (
              <button
                key={item.pane}
                type="button"
                title={item.label}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                data-testid={`simple-home-${item.pane}`}
                onClick={() => onOpenPane?.(item.pane)}
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                  active
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:bg-gray-900 hover:text-white'
                }`}
              >
                <Icon size={16} aria-hidden />
              </button>
            );
          },
        )}
      </nav>
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold tracking-tight text-gray-100">Chats</h1>
          <p className="break-words text-[11px] text-gray-500">
            Chat here. Hand off a build when you need one.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenFullHub}
          className="rounded-full border border-gray-700 px-2.5 py-1 text-[12px] text-gray-300 hover:bg-gray-800 hover:text-white"
          data-testid="simple-open-full-hub"
        >
          Full Hub
        </button>
      </header>

      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-full bg-gray-900 px-3">
          <Search size={14} className="shrink-0 text-gray-500" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents"
            aria-label="Search agents"
            data-testid="simple-search"
            className="w-full bg-transparent text-[13px] text-gray-100 outline-none placeholder:text-gray-600"
          />
        </label>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {serverAgent &&
          filterSimpleContacts(
            [
              {
                agentId: serverAgent.id,
                name: serverAgent.name,
                projectId: '',
                projectName: '',
                color: '#38bdf8',
                avatar: null,
                preview: serverAgent.preview,
                status: serverAgent.status,
                sessionId: null,
                updatedAt: '',
              },
            ],
            query,
          ).map((contact) => (
            <li key={contact.agentId}>
              <button
                type="button"
                onClick={onOpenServerAgent}
                aria-current={serverAgent.selected ? 'true' : undefined}
                data-testid="simple-server-agent"
                className={`flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors ${
                  serverAgent.selected
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-300 hover:bg-gray-900'
                }`}
              >
                <BrandLogo variant="mark" size="lg" alt="" className="size-9 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{contact.name}</span>
                  <span className="block truncate text-[12px] text-gray-500">
                    {contact.preview}
                  </span>
                </span>
              </button>
            </li>
          ))}
        {groups
          ? groups.map((group) => (
              <li
                key={group.id}
                data-testid={`simple-org-${group.id}`}
                onDragOver={
                  reorderable
                    ? (event) => {
                        if (!draggedId?.startsWith('org\n') || draggedId === `org\n${group.id}`)
                          return;
                        event.preventDefault();
                        setDragOverId(`org:${group.id}`);
                      }
                    : undefined
                }
                onDrop={reorderable ? (event) => dropOnOrg(group.id, event) : undefined}
              >
                <div
                  className={`mt-3 mb-1 flex items-center gap-1 rounded-lg px-1 ${
                    dragOverId === `org:${group.id}` ? 'ring-1 ring-sky-500/70' : ''
                  }`}
                >
                  {reorderable && (
                    <span
                      draggable
                      data-testid={`simple-org-drag-${group.id}`}
                      role="button"
                      tabIndex={-1}
                      aria-label={`Drag to reorder ${group.name}`}
                      onDragStart={(event) => {
                        event.stopPropagation();
                        event.dataTransfer.effectAllowed = 'move';
                        try {
                          event.dataTransfer.setData('text/plain', `org\n${group.id}`);
                        } catch {
                          // Some browsers block setData. The in-memory id still works.
                        }
                        setDraggedId(`org\n${group.id}`);
                      }}
                      onDragEnd={() => {
                        setDraggedId(null);
                        setDragOverId(null);
                      }}
                      className="shrink-0 cursor-grab text-gray-600 hover:text-gray-300 active:cursor-grabbing"
                    >
                      <GripVertical size={14} />
                    </span>
                  )}
                  <h2 className="truncate text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    {group.name}
                  </h2>
                </div>
                <ul>
                  {group.projects.map((project) => {
                    const single = project.items.length === 1;
                    return (
                      <li
                        key={project.id}
                        data-testid={`simple-project-${project.id}`}
                        className={
                          dragOverId === `project:${group.id}:${project.id}`
                            ? 'rounded-2xl ring-1 ring-sky-500/70'
                            : undefined
                        }
                        onDragOver={
                          reorderable
                            ? (event) => {
                                const source = `project\n${group.id}\n`;
                                if (
                                  !draggedId?.startsWith(source) ||
                                  draggedId === `project\n${group.id}\n${project.id}`
                                ) {
                                  return;
                                }
                                event.preventDefault();
                                event.stopPropagation();
                                setDragOverId(`project:${group.id}:${project.id}`);
                              }
                            : undefined
                        }
                        onDrop={
                          reorderable
                            ? (event) => dropOnProject(group.id, project.id, event)
                            : undefined
                        }
                      >
                        {!single && (
                          <div className="flex items-center gap-1 px-1 py-1">
                            {reorderable && (
                              <ProjectGrip
                                label={project.name}
                                testId={`simple-project-drag-${project.id}`}
                                payload={`project\n${group.id}\n${project.id}`}
                                onDragStart={() =>
                                  setDraggedId(`project\n${group.id}\n${project.id}`)
                                }
                                onDragEnd={() => {
                                  setDraggedId(null);
                                  setDragOverId(null);
                                }}
                              />
                            )}
                            <span className="truncate text-[11px] font-medium text-gray-400">
                              {project.name}
                            </span>
                          </div>
                        )}
                        {project.items.map((contact) => (
                          <div key={contact.agentId} className="flex items-center">
                            {single && reorderable && (
                              <ProjectGrip
                                label={project.name}
                                testId={`simple-project-drag-${project.id}`}
                                payload={`project\n${group.id}\n${project.id}`}
                                onDragStart={() =>
                                  setDraggedId(`project\n${group.id}\n${project.id}`)
                                }
                                onDragEnd={() => {
                                  setDraggedId(null);
                                  setDragOverId(null);
                                }}
                              />
                            )}
                            <button
                              type="button"
                              onClick={() => onOpenAgent(contact.agentId)}
                              aria-current={contact.agentId === activeAgentId ? 'true' : undefined}
                              data-testid={`simple-agent-${contact.agentId}`}
                              className={`flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors ${
                                contact.agentId === activeAgentId
                                  ? 'bg-gray-800 text-white'
                                  : 'text-gray-300 hover:bg-gray-900'
                              }`}
                            >
                              <ContactFace contact={contact} apiBase={apiBase} />
                              <ContactText contact={contact} />
                            </button>
                          </div>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          : null}
        {!groups &&
          visible.map((contact) => {
            const selected = contact.agentId === activeAgentId;
            const dropTarget = dragOverId === contact.agentId;
            return (
              <li
                key={contact.agentId}
                data-testid={`simple-agent-row-${contact.agentId}`}
                className={`flex items-center rounded-2xl ${dropTarget ? 'ring-1 ring-sky-500/70' : ''}`}
                onDragOver={
                  reorderable
                    ? (event) => {
                        if (!draggedId || draggedId.includes('\n') || draggedId === contact.agentId)
                          return;
                        event.preventDefault();
                        setDragOverId(contact.agentId);
                      }
                    : undefined
                }
                onDragLeave={
                  reorderable
                    ? (event) => {
                        if (event.currentTarget.contains(event.relatedTarget as Node | null))
                          return;
                        if (dragOverId === contact.agentId) setDragOverId(null);
                      }
                    : undefined
                }
                onDrop={reorderable ? (event) => dropOnAgent(contact.agentId, event) : undefined}
              >
                {reorderable && (
                  <span
                    draggable
                    data-drag-handle
                    data-testid={`simple-agent-drag-${contact.agentId}`}
                    role="button"
                    tabIndex={-1}
                    aria-label={`Drag to reorder ${contact.name}`}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      event.dataTransfer.effectAllowed = 'move';
                      try {
                        event.dataTransfer.setData('text/plain', contact.agentId);
                      } catch {
                        // Some browsers block setData. The in-memory id still works.
                      }
                      const row = event.currentTarget.closest(
                        `[data-testid="simple-agent-row-${contact.agentId}"]`,
                      );
                      if (row) {
                        try {
                          event.dataTransfer.setDragImage(row, 0, 0);
                        } catch {
                          // setDragImage can throw in embedded contexts.
                        }
                      }
                      setDraggedId(contact.agentId);
                    }}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setDragOverId(null);
                    }}
                    className="shrink-0 cursor-grab px-0.5 text-gray-600 hover:text-gray-300 active:cursor-grabbing"
                  >
                    <GripVertical size={14} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onOpenAgent(contact.agentId)}
                  aria-current={selected ? 'true' : undefined}
                  data-testid={`simple-agent-${contact.agentId}`}
                  className={`flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors ${
                    selected ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-900'
                  }`}
                >
                  <span className="relative shrink-0">
                    <AgentAvatar
                      avatar={contact.avatar}
                      color={contact.color}
                      size={36}
                      apiBase={apiBase}
                      fallback={
                        <span
                          className="inline-flex size-9 items-center justify-center rounded-full text-[13px] font-semibold text-white"
                          style={{ backgroundColor: contact.color }}
                        >
                          {contact.name.slice(0, 1).toUpperCase()}
                        </span>
                      }
                    />
                    {contact.status !== 'idle' && (
                      <span
                        aria-hidden
                        data-testid={`simple-status-${contact.agentId}`}
                        className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-gray-950 ${
                          contact.status === 'needs-you' ? 'bg-rose-400' : 'bg-emerald-400'
                        }`}
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{contact.name}</span>
                    <span
                      className={`block truncate text-[12px] ${
                        contact.status === 'needs-you'
                          ? 'text-rose-300'
                          : contact.status === 'working'
                            ? 'text-emerald-300/90'
                            : 'text-gray-500'
                      }`}
                    >
                      {contact.preview}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        {visible.length === 0 && (
          <li
            className="px-3 py-6 text-center text-[13px] text-gray-500"
            data-testid="simple-empty"
          >
            {contacts.length === 0 ? 'No agents yet' : 'No matching agents'}
          </li>
        )}
      </ul>
    </aside>
  );
}

function ProjectGrip({
  label,
  testId,
  payload,
  onDragStart,
  onDragEnd,
}: {
  label: string;
  testId: string;
  payload: string;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <span
      draggable
      data-testid={testId}
      role="button"
      tabIndex={-1}
      aria-label={`Drag to reorder ${label}`}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'move';
        try {
          event.dataTransfer.setData('text/plain', payload);
        } catch {
          // Some browsers block setData. The in-memory id still works.
        }
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="shrink-0 cursor-grab px-0.5 text-gray-600 hover:text-gray-300 active:cursor-grabbing"
    >
      <GripVertical size={14} />
    </span>
  );
}

function ContactFace({ contact, apiBase }: { contact: SimpleContact; apiBase: string }) {
  return (
    <span className="relative shrink-0">
      <AgentAvatar
        avatar={contact.avatar}
        color={contact.color}
        size={36}
        apiBase={apiBase}
        fallback={
          <span
            className="inline-flex size-9 items-center justify-center rounded-full text-[13px] font-semibold text-white"
            style={{ backgroundColor: contact.color }}
          >
            {contact.name.slice(0, 1).toUpperCase()}
          </span>
        }
      />
      {contact.status !== 'idle' && (
        <span
          aria-hidden
          data-testid={`simple-status-${contact.agentId}`}
          className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-gray-950 ${
            contact.status === 'needs-you' ? 'bg-rose-400' : 'bg-emerald-400'
          }`}
        />
      )}
    </span>
  );
}

function ContactText({ contact }: { contact: SimpleContact }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[14px] font-medium">{contact.name}</span>
      <span
        className={`block truncate text-[12px] ${
          contact.status === 'needs-you'
            ? 'text-rose-300'
            : contact.status === 'working'
              ? 'text-emerald-300/90'
              : 'text-gray-500'
        }`}
      >
        {contact.preview}
      </span>
    </span>
  );
}
