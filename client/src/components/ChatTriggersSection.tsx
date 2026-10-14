import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Loader2, Plus, Trash2, Zap } from 'lucide-react';
import { api } from '../utils/api';
import {
  CHAT_TRIGGER_EVENTS,
  CHAT_TRIGGER_EVENT_INFO,
  type ChatTriggerEvent,
  type ChatTriggerFilter,
} from '@shared/utils/chatTriggers';

interface TriggerWire {
  id: string;
  event: ChatTriggerEvent;
  filter: ChatTriggerFilter;
  channelId: string | null;
  channel: { id: string; name: string; kind: string; isPrivate: boolean; archived: boolean } | null;
  enabled: boolean;
  canManage: boolean;
}

interface ChannelOption {
  id: string;
  name: string;
  kind: string;
}

const NEW_CHANNEL = '__new__';

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One-line summary of a trigger's filter, or null when it matches everything. */
export function describeTriggerFilter(
  filter: ChatTriggerFilter,
  epicNames: ReadonlyMap<string, string> = new Map(),
  agentNames: ReadonlyMap<string, string> = new Map(),
): string | null {
  const parts: string[] = [];
  if (filter.columns?.length) parts.push(`column: ${filter.columns.join(', ')}`);
  if (filter.epicId) parts.push(`epic: ${epicNames.get(filter.epicId) ?? filter.epicId}`);
  if (filter.labels?.length) parts.push(`labels: ${filter.labels.join(', ')}`);
  if (filter.outcome) parts.push(`only ${filter.outcome}`);
  if (filter.agentIds?.length) {
    parts.push(`agents: ${filter.agentIds.map((id) => agentNames.get(id) ?? id).join(', ')}`);
  }
  if (filter.severities?.length) parts.push(`severity: ${filter.severities.join(', ')}`);
  return parts.length ? parts.join(' · ') : null;
}

const INPUT =
  'w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200 focus:border-blue-500 focus:outline-none';

/**
 * Project Settings > Chat triggers: route project events (sessions, Finalize,
 * PRs, cards, tickets, crons, infra alerts) into Agent Hub chat channels.
 */
export default function ChatTriggersSection({
  projectId,
  agents = [],
  showToast,
}: {
  projectId?: string | null;
  agents?: { id: string; name?: string }[];
  showToast?: (message: string, type?: string) => void;
}) {
  const [triggers, setTriggers] = useState<TriggerWire[]>([]);
  const [defaultChannelName, setDefaultChannelName] = useState('');
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [epics, setEpics] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [event, setEvent] = useState<ChatTriggerEvent>('pr_merged');
  const [destination, setDestination] = useState<string>(NEW_CHANNEL);
  const [newName, setNewName] = useState('');
  const [columns, setColumns] = useState('');
  const [labels, setLabels] = useState('');
  const [epicId, setEpicId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [agentId, setAgentId] = useState('');
  const [severities, setSeverities] = useState('');
  // Every async continuation (load or mutation) writes state only while the
  // project it started for is still the one on screen. `generation` also
  // orders loads for the same project, so only the newest one lands.
  const currentProject = useRef(projectId);
  const generation = useRef(0);
  const isCurrent = (pid: string | null | undefined) => currentProject.current === pid;

  const load = useCallback(async (pid: string) => {
    if (currentProject.current !== pid) return;
    const gen = ++generation.current;
    const live = () => gen === generation.current && currentProject.current === pid;
    setLoading(true);
    setError(null);
    try {
      const [list, chans, epicList] = await Promise.all([
        api.chatTriggers.list(pid) as Promise<{
          triggers: TriggerWire[];
          defaultChannelName: string;
        }>,
        (api.hubChat.channels() as Promise<{ channels: ChannelOption[] }>).catch(() => ({
          channels: [],
        })),
        (api.getEpics(pid) as Promise<unknown>).catch(() => []),
      ]);
      if (!live()) return;
      setTriggers(list.triggers || []);
      setDefaultChannelName(list.defaultChannelName || '');
      setNewName((cur) => cur || list.defaultChannelName || '');
      const usable = (chans.channels || []).filter((c) =>
        ['channel', 'trigger', 'group'].includes(c.kind),
      );
      setChannels(usable);
      // The first trigger offers the default #<project>-activity channel;
      // later ones default to the channel the last trigger used.
      const lastChannel = list.triggers?.[list.triggers.length - 1]?.channelId;
      setDestination(
        lastChannel && usable.some((c) => c.id === lastChannel) ? lastChannel : NEW_CHANNEL,
      );
      const epicRows = Array.isArray(epicList)
        ? epicList
        : ((epicList as { epics?: unknown[] })?.epics ?? []);
      setEpics(
        (epicRows as { id?: unknown; name?: unknown }[])
          .filter((e) => typeof e.id === 'string')
          .map((e) => ({ id: e.id as string, name: String(e.name ?? e.id) })),
      );
    } catch (err: any) {
      if (live()) setError(err?.message || 'Chat triggers are unavailable.');
    } finally {
      if (live()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    currentProject.current = projectId;
    generation.current += 1;
    setTriggers([]);
    setChannels([]);
    setEpics([]);
    // Filter selections name this project's columns, labels, epics and
    // agents; none of them carry over to another project.
    setColumns('');
    setLabels('');
    setEpicId('');
    setOutcome('');
    setAgentId('');
    setSeverities('');
    setNewName('');
    setDestination(NEW_CHANNEL);
    setError(null);
    setBusy(null);
    setLoading(false);
    if (projectId) void load(projectId);
  }, [projectId, load]);

  const info = CHAT_TRIGGER_EVENT_INFO[event];
  const uses = (f: keyof ChatTriggerFilter) => info.filters.includes(f);
  const epicNames = useMemo(() => new Map(epics.map((e) => [e.id, e.name])), [epics]);
  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name || a.id])), [agents]);
  const channelName = (t: TriggerWire) =>
    t.channel
      ? `#${t.channel.name}${t.channel.archived ? ' (archived)' : ''}`
      : 'a channel you have not joined';

  const buildFilter = (): ChatTriggerFilter => {
    const filter: ChatTriggerFilter = {};
    if (uses('columns') && splitList(columns).length) filter.columns = splitList(columns);
    if (uses('labels') && splitList(labels).length) filter.labels = splitList(labels);
    if (uses('epicId') && epicId && epics.some((e) => e.id === epicId)) filter.epicId = epicId;
    if (uses('outcome') && outcome) filter.outcome = outcome as ChatTriggerFilter['outcome'];
    if (uses('agentIds') && agentId && agents.some((a) => a.id === agentId)) {
      filter.agentIds = [agentId];
    }
    if (uses('severities') && splitList(severities).length) {
      filter.severities = splitList(severities);
    }
    return filter;
  };

  const add = async () => {
    if (!projectId || busy) return;
    const body: Record<string, unknown> = { event, filter: buildFilter() };
    if (destination === NEW_CHANNEL) {
      const name = newName.trim().replace(/^#/, '');
      if (!name) {
        setError('Name the new channel.');
        return;
      }
      body.newChannel = { name };
    } else {
      body.channelId = destination;
    }
    const pid = projectId;
    setBusy('add');
    setError(null);
    try {
      await api.chatTriggers.create(pid, body);
      if (!isCurrent(pid)) return;
      showToast?.('Chat trigger added', 'success');
      setColumns('');
      setLabels('');
      setEpicId('');
      setOutcome('');
      setAgentId('');
      setSeverities('');
      await load(pid);
    } catch (err: any) {
      if (isCurrent(pid)) setError(err?.message || 'Could not add the trigger.');
    } finally {
      if (isCurrent(pid)) setBusy(null);
    }
  };

  const toggle = async (t: TriggerWire) => {
    if (!projectId || busy) return;
    const pid = projectId;
    setBusy(t.id);
    try {
      const res = (await api.chatTriggers.update(pid, t.id, { enabled: !t.enabled })) as {
        trigger: TriggerWire;
      };
      if (isCurrent(pid)) setTriggers((cur) => cur.map((x) => (x.id === t.id ? res.trigger : x)));
    } catch (err: any) {
      if (isCurrent(pid)) setError(err?.message || 'Could not update the trigger.');
    } finally {
      if (isCurrent(pid)) setBusy(null);
    }
  };

  const remove = async (t: TriggerWire) => {
    if (!projectId || busy) return;
    const pid = projectId;
    setBusy(t.id);
    try {
      await api.chatTriggers.remove(pid, t.id);
      if (isCurrent(pid)) setTriggers((cur) => cur.filter((x) => x.id !== t.id));
    } catch (err: any) {
      if (isCurrent(pid)) setError(err?.message || 'Could not delete the trigger.');
    } finally {
      if (isCurrent(pid)) setBusy(null);
    }
  };

  if (!projectId) return null;
  return (
    <section
      className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
      data-testid="chat-triggers"
    >
      <div className="mb-1 flex items-center gap-2">
        <Zap size={15} className="text-blue-400" />
        <h3 className="text-sm font-medium text-gray-200">Chat triggers</h3>
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Post project events into Agent Hub chat channels. Session events only post sessions you own.
        New channels are private; add people from Chat.
      </p>
      {error && (
        <p role="alert" className="mb-2 text-xs text-red-400">
          {error}
        </p>
      )}
      {loading && !triggers.length ? (
        <Loader2 size={15} className="animate-spin text-gray-500" />
      ) : (
        <>
          {triggers.length > 0 && (
            <ul className="mb-4 space-y-1.5" data-testid="chat-trigger-list">
              {triggers.map((t) => {
                const summary = describeTriggerFilter(t.filter, epicNames, agentNames);
                return (
                  <li
                    key={t.id}
                    data-testid="chat-trigger"
                    className="flex items-center gap-2 rounded border border-gray-800 px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-gray-200">
                        {CHAT_TRIGGER_EVENT_INFO[t.event]?.label ?? t.event}
                        <span className="text-gray-500"> → </span>
                        <span className="text-gray-300">{channelName(t)}</span>
                      </div>
                      {summary && (
                        <div className="truncate text-[11px] text-gray-500">{summary}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={!t.canManage || busy !== null}
                      onClick={() => void toggle(t)}
                      aria-pressed={t.enabled}
                      aria-label={`${t.enabled ? 'Disable' : 'Enable'} trigger`}
                      className={`rounded border px-2 py-0.5 text-[11px] ${
                        t.enabled
                          ? 'border-emerald-700 bg-emerald-900/30 text-emerald-300'
                          : 'border-gray-700 text-gray-500'
                      } disabled:opacity-50`}
                    >
                      {busy === t.id ? (
                        <Loader2 size={11} className="inline animate-spin" />
                      ) : t.enabled ? (
                        'On'
                      ) : (
                        'Off'
                      )}
                    </button>
                    {t.canManage && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void remove(t)}
                        aria-label="Delete trigger"
                        className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-300 disabled:opacity-50"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-gray-400">
              Event
              <select
                aria-label="Event"
                className={INPUT}
                value={event}
                onChange={(e) => {
                  setEvent(e.target.value as ChatTriggerEvent);
                  setOutcome('');
                }}
              >
                {CHAT_TRIGGER_EVENTS.map((id) => (
                  <option key={id} value={id}>
                    {CHAT_TRIGGER_EVENT_INFO[id].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-400">
              Channel
              <select
                aria-label="Channel"
                className={INPUT}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                <option value={NEW_CHANNEL}>New channel…</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name || 'group'}
                  </option>
                ))}
              </select>
            </label>
            {destination === NEW_CHANNEL && (
              <label className="text-xs text-gray-400 sm:col-span-2">
                New channel name
                <div className="flex items-center gap-1">
                  <Hash size={12} className="text-gray-500" />
                  <input
                    aria-label="New channel name"
                    className={INPUT}
                    value={newName}
                    placeholder={defaultChannelName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
              </label>
            )}
            <p className="text-[11px] text-gray-500 sm:col-span-2">{info.description}</p>
            {uses('columns') && (
              <label className="text-xs text-gray-400">
                Columns (comma separated)
                <input
                  aria-label="Columns"
                  className={INPUT}
                  value={columns}
                  placeholder="Any column"
                  onChange={(e) => setColumns(e.target.value)}
                />
              </label>
            )}
            {uses('labels') && (
              <label className="text-xs text-gray-400">
                Labels (any of)
                <input
                  aria-label="Labels"
                  className={INPUT}
                  value={labels}
                  placeholder="Any label"
                  onChange={(e) => setLabels(e.target.value)}
                />
              </label>
            )}
            {uses('epicId') && epics.length > 0 && (
              <label className="text-xs text-gray-400">
                Epic
                <select
                  aria-label="Epic"
                  className={INPUT}
                  value={epicId}
                  onChange={(e) => setEpicId(e.target.value)}
                >
                  <option value="">Any epic</option>
                  {epics.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {uses('outcome') && (
              <label className="text-xs text-gray-400">
                Outcome
                <select
                  aria-label="Outcome"
                  className={INPUT}
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                >
                  <option value="">Any</option>
                  {(info.outcomes ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {uses('agentIds') && agents.length > 0 && (
              <label className="text-xs text-gray-400">
                Agent
                <select
                  aria-label="Agent"
                  className={INPUT}
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  <option value="">Any agent</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name || a.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {uses('severities') && (
              <label className="text-xs text-gray-400">
                Severities (comma separated)
                <input
                  aria-label="Severities"
                  className={INPUT}
                  value={severities}
                  placeholder="critical, warning"
                  onChange={(e) => setSeverities(e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {busy === 'add' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Add trigger
            </button>
          </div>
        </>
      )}
    </section>
  );
}
