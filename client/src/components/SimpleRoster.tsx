import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { GripVertical, Search } from 'lucide-react';
import AgentAvatar from './AgentAvatar';
import BrandLogo from './BrandLogo';
import {
  buildSimpleContacts,
  filterSimpleContacts,
  moveSimpleContact,
  orderSimpleContacts,
  readSimpleRosterOrder,
  reconcileSimpleRosterOrder,
  simpleSessionKey,
  writeSimpleRosterOrder,
  type SimpleAgent,
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
};

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
}: SimpleRosterProps) {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<string[]>(readSimpleRosterOrder);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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
  const reorderable = query.trim() === '';
  useEffect(() => {
    if (!onEnsureSessions) return;
    for (const contact of contacts) onEnsureSessions(contact.agentId);
  }, [contacts, onEnsureSessions]);

  const dropOn = (targetId: string, event: DragEvent<HTMLLIElement>) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('text/plain') || draggedId;
    setDraggedId(null);
    setDragOverId(null);
    if (!sourceId) return;
    const next = moveSimpleContact(
      ordered.map((contact) => contact.agentId),
      sourceId,
      targetId,
    );
    if (!next) return;
    setOrder(next);
    writeSimpleRosterOrder(next);
  };

  return (
    <aside
      className="flex h-full w-[min(18rem,100vw)] max-w-full md:w-[300px] flex-col overflow-x-hidden border-r border-gray-800 bg-gray-950 text-gray-100 electron-no-drag"
      data-testid="simple-roster"
      aria-label="Agents"
    >
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
        {visible.map((contact) => {
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
                      if (!draggedId || draggedId === contact.agentId) return;
                      event.preventDefault();
                      setDragOverId(contact.agentId);
                    }
                  : undefined
              }
              onDragLeave={
                reorderable
                  ? (event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      if (dragOverId === contact.agentId) setDragOverId(null);
                    }
                  : undefined
              }
              onDrop={reorderable ? (event) => dropOn(contact.agentId, event) : undefined}
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
