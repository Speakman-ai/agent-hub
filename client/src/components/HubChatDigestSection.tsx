import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react';
import { api } from '../utils/api';
import { isHubSystemProject } from '@shared/utils/hub';
import type { ProjectWire } from '@shared/types';
import {
  CHAT_DIGEST_PRESETS,
  DEFAULT_CHAT_DIGEST_CRON,
  DEFAULT_CHAT_DIGEST_INSTRUCTIONS,
  MAX_CHAT_DIGESTS_PER_CHANNEL,
  MAX_CHAT_DIGEST_PROJECTS,
  MAX_CHAT_DIGEST_PROMPT_CHARS,
  MY_WORK_DIGEST_SCOPE_LABEL,
  chatDigestStatusText,
  digestScopeReady,
  describeDigestSchedule,
  deviceTimeZone,
  type ChatDigest,
  type ChatDigestSaveRequest,
  type ChatDigestScope,
} from '@shared/utils/chatDigest';

const inputClass =
  'w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500';
const primaryButton =
  'inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50';
const secondaryButton =
  'inline-flex items-center gap-1 rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50';

/** Key of the unsaved digest being added; saved digests use their id. */
const NEW_KEY = '__new__';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Request failed');
}

interface Draft {
  name: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChatDigestScope;
  projectIds: string[];
  prompt: string;
}

function draftFrom(
  digest: ChatDigest | null,
  defaultProjectId: string | null,
  defaultScope: ChatDigestScope = 'channel',
): Draft {
  return {
    name: digest?.name ?? '',
    enabled: digest?.enabled ?? true,
    cron: digest?.cron ?? DEFAULT_CHAT_DIGEST_CRON,
    timeZone: digest?.timeZone ?? deviceTimeZone(),
    scope: digest?.scope ?? defaultScope,
    projectIds: digest ? [...digest.projectIds] : defaultProjectId ? [defaultProjectId] : [],
    prompt: digest?.prompt ?? '',
  };
}

function saveBody(draft: Draft): ChatDigestSaveRequest {
  return {
    name: draft.name.trim() || undefined,
    enabled: draft.enabled,
    cron: draft.cron.trim(),
    timeZone: draft.timeZone.trim(),
    scope: draft.scope,
    projectIds: draft.scope === 'project' ? draft.projectIds : [],
    prompt: draft.prompt.trim() || null,
  };
}

function runResultText(result: { status: string; reason?: string; error?: string }): string {
  switch (result.status) {
    case 'posted':
      return 'Posted a digest.';
    case 'skipped':
      return 'Nothing new, skipped posting.';
    case 'cancelled':
      return `Run cancelled: ${result.reason || 'digest changed'}`;
    default:
      return `Run failed: ${result.error || 'unknown error'}`;
  }
}

/**
 * Channel settings: scheduled AI digests of this channel's messages, of
 * projects' activity, or (on the viewer's own Summaries channel) of their own
 * work, posted into the channel. Saving a digest makes the caller its owner
 * (their engine credentials run it).
 */
export function HubChatDigestSection({
  channelId,
  channelProjectId,
  allowMyWork = false,
}: {
  channelId: string;
  channelProjectId: string | null;
  /** Offer the `my_work` scope; only true on the viewer's own Summaries channel. */
  allowMyWork?: boolean;
}) {
  const [digests, setDigests] = useState<ChatDigest[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectWire[] | null>(null);
  const [needsProjects, setNeedsProjects] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestProjects = useCallback(() => setNeedsProjects(true), []);

  useEffect(() => {
    let live = true;
    setDigests(null);
    setAdding(false);
    setOpenKey(null);
    api.hubChat
      .digests(channelId)
      .then((res: { digests: ChatDigest[] }) => {
        if (live) setDigests(res.digests);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [channelId]);

  useEffect(() => {
    if (!needsProjects || projects) return;
    let live = true;
    api
      .getProjects()
      .then((p: unknown) => {
        if (!live) return;
        setProjects(
          (Array.isArray(p) ? (p as ProjectWire[]) : []).filter((x) => !isHubSystemProject(x)),
        );
      })
      .catch((err: unknown) => {
        if (live) setProjectsError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [needsProjects, projects]);

  if (!digests) {
    return loadError ? (
      <p role="alert" className="text-xs text-red-300">
        {loadError}
      </p>
    ) : (
      <section className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Loading digests...
      </section>
    );
  }

  const atCap = digests.length + (adding ? 1 : 0) >= MAX_CHAT_DIGESTS_PER_CHANNEL;
  const toggle = (key: string) => setOpenKey((k) => (k === key ? null : key));
  const cardProps = {
    channelId,
    channelProjectId,
    allowMyWork,
    projects,
    projectsError,
    onNeedProjects: requestProjects,
  };

  return (
    <section className="flex flex-col gap-2" data-testid="hub-chat-digest">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Scheduled digests
        </h3>
        <button
          type="button"
          disabled={atCap}
          title={atCap ? `A channel can hold at most ${MAX_CHAT_DIGESTS_PER_CHANNEL} digests` : ''}
          onClick={() => {
            setAdding(true);
            setOpenKey(NEW_KEY);
          }}
          className={secondaryButton}
        >
          <Plus size={14} /> Add digest
        </button>
      </div>
      <p className="text-xs text-gray-500">
        AI summaries posted here on a schedule. Nothing is posted when nothing happened.
      </p>
      {digests.length === 0 && !adding && (
        <p className="text-xs text-gray-400">No digests scheduled.</p>
      )}
      <ul className="flex flex-col gap-2">
        {digests.map((d) => (
          <DigestCard
            key={d.id}
            {...cardProps}
            digest={d}
            open={openKey === d.id}
            onToggle={() => toggle(d.id)}
            onSaved={(next) =>
              setDigests((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null)
            }
            onRemoved={() => {
              setDigests((list) => list?.filter((x) => x.id !== d.id) ?? null);
              setOpenKey(null);
            }}
          />
        ))}
        {adding && (
          <DigestCard
            key={NEW_KEY}
            {...cardProps}
            digest={null}
            open={openKey === NEW_KEY}
            onToggle={() => toggle(NEW_KEY)}
            onSaved={(next) => {
              setDigests((list) => [...(list ?? []), next]);
              setAdding(false);
              setOpenKey(next.id);
            }}
            onRemoved={() => {
              setAdding(false);
              setOpenKey(null);
            }}
          />
        )}
      </ul>
    </section>
  );
}

function DigestCard({
  channelId,
  channelProjectId,
  allowMyWork,
  digest,
  open,
  projects,
  projectsError,
  onNeedProjects,
  onToggle,
  onSaved,
  onRemoved,
}: {
  channelId: string;
  channelProjectId: string | null;
  allowMyWork: boolean;
  /** Null for a digest being added and not yet saved. */
  digest: ChatDigest | null;
  open: boolean;
  projects: ProjectWire[] | null;
  projectsError: string | null;
  onNeedProjects: () => void;
  onToggle: () => void;
  onSaved: (digest: ChatDigest) => void;
  onRemoved: () => void;
}) {
  const defaultScope: ChatDigestScope = allowMyWork ? 'my_work' : 'channel';
  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(digest, channelProjectId, defaultScope),
  );
  // A saved my_work digest keeps its option visible even if the channel
  // check fails, so the editor never shows a scope the select cannot hold.
  const showMyWork = allowMyWork || digest?.scope === 'my_work';
  const [busy, setBusy] = useState<'save' | 'run' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const needsProjects = open && draft.scope === 'project';
  useEffect(() => {
    if (needsProjects) onNeedProjects();
  }, [needsProjects, onNeedProjects]);

  const act = async (kind: 'save' | 'run' | 'remove', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const title = digest?.name || 'New digest';
  const schedule = digest
    ? describeDigestSchedule(digest.cron, digest.timeZone)
    : describeDigestSchedule(draft.cron, draft.timeZone.trim());
  const status = digest ? chatDigestStatusText(digest) : 'Not saved yet.';
  const presetIndex = CHAT_DIGEST_PRESETS.findIndex((p) => p.cron === draft.cron.trim());
  const canSave =
    !busy &&
    draft.cron.trim().length > 0 &&
    draft.timeZone.trim().length > 0 &&
    draft.prompt.length <= MAX_CHAT_DIGEST_PROMPT_CHARS &&
    digestScopeReady(draft.scope, draft.projectIds);

  const toggleProject = (id: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      projectIds: on
        ? d.projectIds.includes(id)
          ? d.projectIds
          : [...d.projectIds, id]
        : d.projectIds.filter((p) => p !== id),
    }));

  // Saved project ids the caller can no longer see still show, so saving
  // does not silently drop them.
  const projectOptions: { id: string; name: string }[] = [
    ...(projects ?? []).map((p) => ({ id: String(p.id), name: p.name || String(p.id) })),
  ];
  for (const id of draft.projectIds) {
    if (projects && !projectOptions.some((p) => p.id === id)) projectOptions.push({ id, name: id });
  }

  return (
    <li
      className="rounded border border-gray-800 bg-gray-900/40"
      data-testid={`hub-chat-digest-${digest?.id ?? 'new'}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-gray-800/40"
      >
        {open ? (
          <ChevronDown size={14} className="mt-0.5 shrink-0 text-gray-400" />
        ) : (
          <ChevronRight size={14} className="mt-0.5 shrink-0 text-gray-400" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-white">
            {title}
            {digest && !digest.enabled && (
              <span className="ml-2 text-xs text-gray-500">Paused</span>
            )}
          </span>
          <span className="truncate text-xs text-gray-500">{schedule}</span>
          <span className="truncate text-xs text-gray-400" data-testid="hub-chat-digest-status">
            {status}
          </span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-gray-800 px-3 py-3">
          <label className="text-xs text-gray-400">
            Name
            <input
              value={draft.name}
              maxLength={80}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              aria-label="Digest name"
              placeholder="Defaults from the scope"
              className={`mt-1 ${inputClass}`}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              className="accent-blue-500"
            />
            Enabled
          </label>
          <label className="text-xs text-gray-400">
            Summarize
            <select
              value={draft.scope}
              aria-label="Digest scope"
              onChange={(e) =>
                setDraft((d) => ({ ...d, scope: e.target.value as ChatDigestScope }))
              }
              className={`mt-1 ${inputClass}`}
            >
              <option value="channel">Messages in this channel since the last digest</option>
              <option value="project">Project activity</option>
              {showMyWork && <option value="my_work">{MY_WORK_DIGEST_SCOPE_LABEL}</option>}
            </select>
          </label>
          {draft.scope === 'my_work' && (
            <p className="text-xs text-gray-500">
              Your sessions, assigned cards and todos since the last summary. Only you can see this
              channel.
            </p>
          )}
          {draft.scope === 'project' && (
            <fieldset className="text-xs text-gray-400">
              <legend>
                Projects ({draft.projectIds.length}/{MAX_CHAT_DIGEST_PROJECTS})
              </legend>
              {!projects && !projectsError && (
                <p className="mt-1 flex items-center gap-2 text-gray-500">
                  <Loader2 size={12} className="animate-spin" /> Loading projects...
                </p>
              )}
              {projectsError && <p className="mt-1 text-red-300">{projectsError}</p>}
              {projects && (
                <div className="mt-1 grid max-h-40 grid-cols-1 gap-1 overflow-y-auto rounded border border-gray-800 p-2 sm:grid-cols-2">
                  {projectOptions.map((p) => {
                    const checked = draft.projectIds.includes(p.id);
                    return (
                      <label key={p.id} className="flex items-center gap-2 text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && draft.projectIds.length >= MAX_CHAT_DIGEST_PROJECTS}
                          onChange={(e) => toggleProject(p.id, e.target.checked)}
                          className="accent-blue-500"
                        />
                        <span className="truncate">{p.name}</span>
                      </label>
                    );
                  })}
                  {projectOptions.length === 0 && (
                    <p className="text-gray-500">No projects available.</p>
                  )}
                </div>
              )}
            </fieldset>
          )}
          <label className="text-xs text-gray-400">
            Schedule
            <select
              value={presetIndex >= 0 ? String(presetIndex) : 'custom'}
              aria-label="Digest schedule preset"
              onChange={(e) => {
                const preset = CHAT_DIGEST_PRESETS[Number(e.target.value)];
                if (preset) setDraft((d) => ({ ...d, cron: preset.cron }));
              }}
              className={`mt-1 ${inputClass}`}
            >
              {CHAT_DIGEST_PRESETS.map((p, i) => (
                <option key={p.cron} value={i}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom (cron)</option>
            </select>
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-gray-400">
              Cron
              <input
                value={draft.cron}
                onChange={(e) => setDraft((d) => ({ ...d, cron: e.target.value }))}
                aria-label="Digest cron"
                placeholder="0 9 * * 1-5"
                className={`mt-1 font-mono ${inputClass}`}
              />
            </label>
            <label className="text-xs text-gray-400">
              Timezone
              <input
                value={draft.timeZone}
                onChange={(e) => setDraft((d) => ({ ...d, timeZone: e.target.value }))}
                aria-label="Digest timezone"
                className={`mt-1 ${inputClass}`}
              />
            </label>
          </div>
          <p className="text-xs text-gray-500">
            {describeDigestSchedule(draft.cron, draft.timeZone.trim())}
          </p>
          <label className="text-xs text-gray-400">
            Instructions
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
              aria-label="Digest instructions"
              placeholder={DEFAULT_CHAT_DIGEST_INSTRUCTIONS}
              rows={4}
              className={`mt-1 resize-y ${inputClass}`}
            />
            <span
              className={`mt-1 block ${draft.prompt.length > MAX_CHAT_DIGEST_PROMPT_CHARS ? 'text-red-300' : 'text-gray-500'}`}
            >
              Leave blank for the default. {draft.prompt.length}/{MAX_CHAT_DIGEST_PROMPT_CHARS}
            </span>
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={!!busy}
              onClick={() =>
                digest
                  ? void act('remove', async () => {
                      await api.hubChat.removeDigest(channelId, digest.id);
                      onRemoved();
                    })
                  : onRemoved()
              }
              className={secondaryButton}
            >
              {busy === 'remove' && <Loader2 size={14} className="animate-spin" />}
              {digest ? 'Remove' : 'Cancel'}
            </button>
            {digest && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void act('run', async () => {
                    const res = await api.hubChat.runDigest(channelId, digest.id);
                    if (res.digest) onSaved(res.digest);
                    setNotice(runResultText(res.result ?? {}));
                  })
                }
                className={secondaryButton}
              >
                {busy === 'run' && <Loader2 size={14} className="animate-spin" />}
                Run now
              </button>
            )}
            <button
              type="button"
              disabled={!canSave}
              onClick={() =>
                void act('save', async () => {
                  const body = saveBody(draft);
                  const res = digest
                    ? await api.hubChat.updateDigest(channelId, digest.id, body)
                    : await api.hubChat.createDigest(channelId, body);
                  setDraft(draftFrom(res.digest, channelProjectId, defaultScope));
                  onSaved(res.digest);
                  setNotice('Saved.');
                })
              }
              className={primaryButton}
            >
              {busy === 'save' && <Loader2 size={14} className="animate-spin" />}
              {digest ? 'Save digest' : 'Schedule digest'}
            </button>
          </div>
          {notice && !error && (
            <p className="text-xs text-gray-400" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-300">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
