import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { api } from '../utils/api';
import { isHubSystemProject } from '@shared/utils/hub';
import type { ProjectWire } from '@shared/types';
import {
  MUTE_PRESETS,
  agentChannelAgentOptions,
  channelLabel,
  isChannelMuted,
  muteUntilIso,
  type HubChatChannel,
  type HubChatMember,
  type HubChatMembership,
  type HubChatNotifyLevel,
  type HubChatOrgMember,
} from '../utils/hubChat';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Request failed');
}

function Dialog({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500';
const primaryButton =
  'inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50';

function UserPicker({
  members,
  selected,
  onToggle,
  exclude,
}: {
  members: HubChatOrgMember[];
  selected: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  exclude: ReadonlySet<string>;
}) {
  const [filter, setFilter] = useState('');
  const shown = members.filter(
    (m) => !exclude.has(m.userId) && m.username.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div>
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search people"
        aria-label="Search people"
        className={inputClass}
      />
      <ul className="mt-2 max-h-48 overflow-y-auto">
        {shown.map((m) => (
          <li key={m.userId}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-gray-200 hover:bg-gray-800">
              <input
                type="checkbox"
                checked={selected.has(m.userId)}
                onChange={() => onToggle(m.userId)}
                className="accent-blue-500"
              />
              {m.username}
            </label>
          </li>
        ))}
        {!shown.length && <li className="px-2 py-1 text-xs text-gray-500">No one matches.</li>}
      </ul>
    </div>
  );
}

/**
 * Returns the page's change clock. Dialogs read it when a request starts and
 * hand it back with the response, so the page can tell which local changes
 * are newer than the server object it got.
 */
export type RequestClock = () => number;

export function NewChannelDialog({
  members,
  viewerUserId,
  clock,
  onClose,
  onCreated,
}: {
  members: HubChatOrgMember[];
  viewerUserId: string | null;
  clock: RequestClock;
  onClose: () => void;
  onCreated: (channel: HubChatChannel, issuedAt: number) => void;
}) {
  const [kind, setKind] = useState<'channel' | 'agent'>('channel');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentPick, setAgentPick] = useState<{ projectId: string; agentId: string }>({
    projectId: '',
    agentId: '',
  });
  const exclude = useMemo(() => new Set(viewerUserId ? [viewerUserId] : []), [viewerUserId]);
  const isAgent = kind === 'agent';
  const canSubmit = isAgent ? !!agentPick.agentId : !!name.trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    const issuedAt = clock();
    try {
      const res = await api.hubChat.createChannel({
        kind,
        name: name.trim() || undefined,
        topic: topic.trim() || null,
        isPrivate,
        ...(isAgent ? { projectId: agentPick.projectId, agentId: agentPick.agentId } : {}),
        memberUserIds: [...picked],
      });
      onCreated(res.channel, issuedAt);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title="New channel" onClose={onClose} testId="hub-chat-new-channel">
      <form
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        {/* Locked while creating: the dialog closes on success, so anything
            typed meanwhile would be lost. */}
        <fieldset disabled={busy} className="contents">
          <div role="radiogroup" aria-label="Channel type" className="flex gap-1 text-xs">
            {(
              [
                ['channel', 'Channel'],
                ['agent', 'Agent channel'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                onClick={() => setKind(value)}
                className={`rounded px-2 py-1 ${
                  kind === value
                    ? 'bg-blue-600 text-white'
                    : 'border border-gray-700 text-gray-300 hover:bg-gray-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {isAgent && (
            <>
              <p className="text-xs text-gray-500">
                Posts run in one session on this agent, owned by you. Replies from the agent are
                posted back into the channel.
              </p>
              <AgentChannelPicker value={agentPick} onChange={setAgentPick} />
            </>
          )}
          <label className="text-xs text-gray-400">
            {isAgent ? 'Name (optional, defaults to the agent)' : 'Name'}
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              aria-label="Channel name"
              className={`mt-1 ${inputClass}`}
            />
          </label>
          <label className="text-xs text-gray-400">
            Topic (optional)
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={250}
              aria-label="Channel topic"
              className={`mt-1 ${inputClass}`}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="accent-blue-500"
            />
            Private (only invited members can see it)
          </label>
          <div className="text-xs text-gray-400">
            Add people
            <div className="mt-1">
              <UserPicker
                members={members}
                selected={picked}
                exclude={exclude}
                onToggle={(id) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-300">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <button type="submit" disabled={busy || !canSubmit} className={primaryButton}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              Create
            </button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

/** Project and agent selects for an agent channel. */
function AgentChannelPicker({
  value,
  onChange,
}: {
  value: { projectId: string; agentId: string };
  onChange: (next: { projectId: string; agentId: string }) => void;
}) {
  const [projects, setProjects] = useState<ProjectWire[] | null>(null);
  const [agents, setAgents] = useState<unknown[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getProjects(), api.getAgents()])
      .then(([p, a]) => {
        if (cancelled) return;
        const list = (Array.isArray(p) ? (p as ProjectWire[]) : []).filter(
          (x) => !isHubSystemProject(x),
        );
        const agentList = Array.isArray(a) ? (a as unknown[]) : [];
        setProjects(list);
        setAgents(agentList);
        const first = list.find((x) => agentChannelAgentOptions(agentList, String(x.id)).length);
        if (first) {
          const pid = String(first.id);
          onChangeRef.current({
            projectId: pid,
            agentId: agentChannelAgentOptions(agentList, pid)[0]?.id ?? '',
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agentOptions = useMemo(
    () => agentChannelAgentOptions(agents ?? [], value.projectId),
    [agents, value.projectId],
  );

  if (loadError) {
    return (
      <p role="alert" className="text-xs text-red-300">
        {loadError}
      </p>
    );
  }
  if (!projects || !agents) {
    return (
      <p className="flex items-center gap-1 text-xs text-gray-500">
        <Loader2 size={12} className="animate-spin" /> Loading projects…
      </p>
    );
  }
  return (
    <div className="flex gap-2">
      <label className="flex-1 text-xs text-gray-400">
        Project
        <select
          value={value.projectId}
          onChange={(e) => {
            const pid = e.target.value;
            onChange({
              projectId: pid,
              agentId: agentChannelAgentOptions(agents, pid)[0]?.id ?? '',
            });
          }}
          aria-label="Agent channel project"
          className={`mt-1 ${inputClass}`}
        >
          {!projects.length && <option value="">No projects</option>}
          {projects.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name || p.id}
            </option>
          ))}
        </select>
      </label>
      <label className="flex-1 text-xs text-gray-400">
        Agent
        <select
          value={value.agentId}
          onChange={(e) => onChange({ ...value, agentId: e.target.value })}
          aria-label="Agent channel agent"
          disabled={!agentOptions.length}
          className={`mt-1 ${inputClass}`}
        >
          {!agentOptions.length && <option value="">No agents</option>}
          {agentOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function NewDmDialog({
  members,
  clock,
  onClose,
  onOpened,
}: {
  members: HubChatOrgMember[];
  clock: RequestClock;
  onClose: () => void;
  onOpened: (channel: HubChatChannel, issuedAt: number) => void;
}) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = members.filter((m) =>
    m.username.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const open = async (userId: string) => {
    setBusy(userId);
    setError(null);
    const issuedAt = clock();
    try {
      const res = await api.hubChat.openDm(userId);
      onOpened(res.channel, issuedAt);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <Dialog title="New direct message" onClose={onClose} testId="hub-chat-new-dm">
      <input
        autoFocus
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search people"
        aria-label="Search people"
        className={inputClass}
      />
      <ul className="mt-2 max-h-64 overflow-y-auto">
        {shown.map((m) => (
          <li key={m.userId}>
            <button
              type="button"
              onClick={() => void open(m.userId)}
              disabled={busy !== null}
              data-testid={`hub-chat-dm-pick-${m.userId}`}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50"
            >
              {busy === m.userId && <Loader2 size={12} className="animate-spin" />}
              {m.username}
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-2 py-1 text-xs text-gray-500">No one matches.</li>}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function BrowseChannelsDialog({
  clock,
  onClose,
  onJoined,
}: {
  clock: RequestClock;
  onClose: () => void;
  onJoined: (channel: HubChatChannel, issuedAt: number) => void;
}) {
  const [channels, setChannels] = useState<HubChatChannel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.hubChat
      .browse()
      .then((res: { channels: HubChatChannel[] }) => live && setChannels(res.channels))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, []);

  const join = async (channelId: string) => {
    setBusy(channelId);
    setError(null);
    const issuedAt = clock();
    try {
      const res = await api.hubChat.join(channelId);
      onJoined(res.channel, issuedAt);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <Dialog title="Browse channels" onClose={onClose} testId="hub-chat-browse">
      {channels === null && !error && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading...
        </div>
      )}
      {channels && !channels.length && (
        <p className="text-sm text-gray-500">No public channels left to join.</p>
      )}
      <ul className="flex flex-col gap-1">
        {channels?.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-800">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-gray-200"># {c.name}</div>
              {c.topic && <div className="truncate text-xs text-gray-500">{c.topic}</div>}
            </div>
            <button
              type="button"
              onClick={() => void join(c.id)}
              disabled={busy !== null}
              className="rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50"
            >
              {busy === c.id ? 'Joining...' : 'Join'}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function ChannelSettingsDialog({
  channel,
  usernames,
  orgMembers,
  viewerUserId,
  clock,
  onClose,
  onChanged,
  onMembershipChanged,
  onLeft,
}: {
  channel: HubChatChannel;
  usernames: ReadonlyMap<string, string>;
  orgMembers: HubChatOrgMember[];
  viewerUserId: string | null;
  clock: RequestClock;
  onClose: () => void;
  /** The channel as the server returned it after a rename or topic change. */
  onChanged: (channel: HubChatChannel, issuedAt: number) => void;
  /** The caller's membership as the server returned it after a prefs change. */
  onMembershipChanged: (channelId: string, membership: HubChatMembership, issuedAt: number) => void;
  onLeft: (channelId: string) => void;
}) {
  const isDm = channel.kind === 'dm';
  // Only fields the user touched hold an edit; untouched inputs show the
  // live server value, so a rename by someone else while this is open shows
  // up here and is never sent back by a save of another field.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [topicEdit, setTopicEdit] = useState<string | null>(null);
  const serverTopic = channel.topic ?? '';
  const name = nameEdit ?? channel.name;
  const topic = topicEdit ?? serverTopic;
  const nameDirty = nameEdit !== null && nameEdit.trim() !== channel.name;
  const topicDirty = topicEdit !== null && topicEdit.trim() !== serverTopic;
  const [members, setMembers] = useState<HubChatMember[] | null>(null);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const membership = channel.membership;
  const muted = isChannelMuted(channel);
  const isOwner = membership?.role === 'owner';

  // The member list follows the server while open: refetch when this
  // channel's membership changes. Fetches and add responses share one
  // counter, so only the most recently requested list is ever applied.
  const membersRequestRef = useRef(0);
  useEffect(() => {
    let live = true;
    const load = () => {
      const request = ++membersRequestRef.current;
      api.hubChat
        .channel(channel.id)
        .then((res: { members: HubChatMember[] }) => {
          if (live && request === membersRequestRef.current) setMembers(res.members);
        })
        .catch((err: unknown) => {
          if (live && request === membersRequestRef.current) setError(errorText(err));
        });
    };
    load();
    const onUpdate = (e: Event) => {
      const data = (e as CustomEvent).detail ?? {};
      if (
        data.channelId === channel.id &&
        (data.reason === 'member_added' || data.reason === 'member_removed')
      ) {
        load();
      }
    };
    window.addEventListener('hub_chat_channel_update', onUpdate);
    return () => {
      live = false;
      window.removeEventListener('hub_chat_channel_update', onUpdate);
    };
  }, [channel.id]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const memberIds = new Set((members ?? []).map((m) => m.userId));
  const detailsDirty = nameDirty || topicDirty;

  return (
    <Dialog
      title={`${channelLabel(channel, usernames, viewerUserId)} settings`}
      onClose={onClose}
      testId="hub-chat-settings"
    >
      <div className="flex flex-col gap-4">
        {!isDm && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              // What this save submits; text typed while it is in flight is
              // kept, since only edits still equal to these are cleared.
              const sentName = nameDirty ? nameEdit : null;
              const sentTopic = topicDirty ? topicEdit : null;
              void run('details', async () => {
                const issuedAt = clock();
                const res = await api.hubChat.updateChannel(channel.id, {
                  ...(sentName !== null && sentName.trim() ? { name: sentName.trim() } : {}),
                  ...(sentTopic !== null ? { topic: sentTopic.trim() || null } : {}),
                });
                onChanged(res.channel, issuedAt);
                if (sentName !== null) setNameEdit((cur) => (cur === sentName ? null : cur));
                if (sentTopic !== null) setTopicEdit((cur) => (cur === sentTopic ? null : cur));
              });
            }}
          >
            <label className="text-xs text-gray-400">
              Name
              <input
                value={name}
                onChange={(e) => setNameEdit(e.target.value)}
                maxLength={80}
                aria-label="Channel name"
                className={`mt-1 ${inputClass}`}
              />
            </label>
            <label className="text-xs text-gray-400">
              Topic
              <input
                value={topic}
                onChange={(e) => setTopicEdit(e.target.value)}
                maxLength={250}
                aria-label="Channel topic"
                className={`mt-1 ${inputClass}`}
              />
            </label>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={
                  busy !== null || !detailsDirty || (channel.kind === 'channel' && !name.trim())
                }
                className={primaryButton}
              >
                {busy === 'details' && <Loader2 size={14} className="animate-spin" />}
                Save
              </button>
            </div>
          </form>
        )}

        {membership && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Notifications
            </h3>
            <label className="text-xs text-gray-400">
              Notify me about
              <select
                value={membership.notifyLevel}
                aria-label="Notify level"
                disabled={busy !== null}
                onChange={(e) =>
                  void run('notify', async () => {
                    const issuedAt = clock();
                    const res = await api.hubChat.setNotifyLevel(
                      channel.id,
                      e.target.value as HubChatNotifyLevel,
                    );
                    onMembershipChanged(channel.id, res.membership, issuedAt);
                  })
                }
                className={`mt-1 ${inputClass}`}
              >
                <option value="all">All messages</option>
                <option value="mentions">Mentions only</option>
                <option value="none">Nothing</option>
              </select>
            </label>
            {muted ? (
              <div className="flex items-center justify-between text-sm text-gray-300">
                <span>Muted</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('mute', async () => {
                      const issuedAt = clock();
                      const res = await api.hubChat.setMute(channel.id, null);
                      onMembershipChanged(channel.id, res.membership, issuedAt);
                    })
                  }
                  className="rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
                >
                  Unmute
                </button>
              </div>
            ) : (
              <label className="text-xs text-gray-400">
                Mute
                <select
                  value=""
                  aria-label="Mute"
                  disabled={busy !== null}
                  onChange={(e) => {
                    const preset = MUTE_PRESETS[Number(e.target.value)];
                    if (!preset) return;
                    void run('mute', async () => {
                      const issuedAt = clock();
                      const res = await api.hubChat.setMute(channel.id, muteUntilIso(preset.hours));
                      onMembershipChanged(channel.id, res.membership, issuedAt);
                    });
                  }}
                  className={`mt-1 ${inputClass}`}
                >
                  <option value="">Not muted</option>
                  {MUTE_PRESETS.map((p, i) => (
                    <option key={p.label} value={i}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Members</h3>
          {members === null ? (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Loading...
            </div>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="hub-chat-settings-members">
              {members.map((m) => {
                const self = m.userId === viewerUserId;
                const canRemove = !isDm && !self && isOwner;
                return (
                  <li key={m.userId} className="flex items-center gap-2 text-sm text-gray-200">
                    <span className="min-w-0 flex-1 truncate">
                      {m.username || usernames.get(m.userId) || m.userId}
                      {self && <span className="text-gray-500"> (you)</span>}
                      {m.role === 'owner' && <span className="text-gray-500"> · owner</span>}
                    </span>
                    {canRemove && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`remove:${m.userId}`, async () => {
                            await api.hubChat.removeMember(channel.id, m.userId);
                            setMembers(
                              (prev) => prev?.filter((x) => x.userId !== m.userId) ?? prev,
                            );
                          })
                        }
                        className="text-xs text-gray-400 hover:text-red-300 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!isDm && membership && members && (
            <div className="mt-1">
              <UserPicker
                members={orgMembers}
                selected={adding}
                exclude={memberIds}
                onToggle={(id) =>
                  setAdding((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={busy !== null || adding.size === 0}
                  onClick={() =>
                    void run('add', async () => {
                      const sent = [...adding];
                      const request = ++membersRequestRef.current;
                      const res = await api.hubChat.addMembers(channel.id, sent);
                      if (request === membersRequestRef.current) setMembers(res.members);
                      // Keep people picked while the request was in flight.
                      setAdding((prev) => {
                        const next = new Set(prev);
                        for (const id of sent) next.delete(id);
                        return next;
                      });
                    })
                  }
                  className={primaryButton}
                >
                  {busy === 'add' && <Loader2 size={14} className="animate-spin" />}
                  Add {adding.size || ''}
                </button>
              </div>
            </div>
          )}
        </section>

        {!isDm && membership && viewerUserId && (
          <div className="border-t border-gray-800 pt-3">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run('leave', async () => {
                  await api.hubChat.removeMember(channel.id, viewerUserId);
                  onLeft(channel.id);
                })
              }
              className="text-sm text-red-300 hover:text-red-200 disabled:opacity-50"
            >
              Leave {channel.kind === 'group' ? 'group' : 'channel'}
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
