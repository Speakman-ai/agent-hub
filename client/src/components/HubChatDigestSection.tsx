import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react';
import { api } from '../utils/api';
import { isHubSystemProject } from '@shared/utils/hub';
import type { ProjectWire } from '@shared/types';
import {
  CHAT_DIGEST_PRESETS,
  MAX_CHAT_DIGESTS_PER_CHANNEL,
  MAX_CHAT_DIGEST_PROMPT_CHARS,
  builtInDigestDescription,
  chatDigestAgents,
  chatDigestDraftFrom as draftFrom,
  chatDigestDraftIsBuiltIn,
  chatDigestDraftReady,
  chatDigestSaveBody as saveBody,
  chatDigestRunResultText,
  chatDigestStatusText,
  describeDigestSchedule,
  type ChatDigest,
  type ChatDigestDraft as Draft,
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

interface DigestAgent {
  id: string;
  name?: string;
  role?: unknown;
  allowedSkills?: unknown;
}

interface SkillOption {
  id: string;
  description?: string;
}

/**
 * Channel settings: scheduled digests posted into the channel. A digest runs
 * its prompt as a session of the chosen project agent, with the chosen skills
 * loaded, and posts the agent's reply here. Saving a digest makes the caller
 * its owner (their engine credentials and access run it).
 */
export function HubChatDigestSection({
  channelId,
  channelProjectId,
}: {
  channelId: string;
  channelProjectId: string | null;
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
        An agent runs your prompt on a schedule and posts its reply here.
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
  const [draft, setDraft] = useState<Draft>(() => draftFrom(digest, channelProjectId));
  const [busy, setBusy] = useState<'save' | 'run' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skillOptions, setSkillOptions] = useState<SkillOption[] | 'error' | null>(null);

  useEffect(() => {
    if (open) onNeedProjects();
  }, [open, onNeedProjects]);

  const project = projects?.find((p) => String(p.id) === draft.projectId) ?? null;
  const agents = chatDigestAgents((project?.agents as DigestAgent[] | undefined) ?? []);
  const agent = agents.find((a) => a.id === draft.agentId) ?? null;

  // Skills the chosen agent can load: the merged list, narrowed by its allowlist.
  const allowedSkills = Array.isArray(agent?.allowedSkills)
    ? (agent.allowedSkills as string[])
    : null;
  useEffect(() => {
    if (!open || !draft.agentId) {
      setSkillOptions(null);
      return;
    }
    let live = true;
    setSkillOptions(null);
    api
      .getSkills(draft.agentId)
      .then((list: unknown) => {
        if (live) setSkillOptions(Array.isArray(list) ? (list as SkillOption[]) : []);
      })
      .catch(() => {
        if (live) setSkillOptions('error');
      });
    return () => {
      live = false;
    };
  }, [open, draft.agentId]);
  const skills = Array.isArray(skillOptions)
    ? skillOptions.filter((sk) => !allowedSkills || allowedSkills.includes(sk.id))
    : [];

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

  const builtIn = chatDigestDraftIsBuiltIn(draft);
  const builtInText = builtIn ? builtInDigestDescription(draft.scope) : null;
  const title = digest?.name || 'New digest';
  const schedule = digest
    ? describeDigestSchedule(digest.cron, digest.timeZone)
    : describeDigestSchedule(draft.cron, draft.timeZone.trim());
  const status = digest ? chatDigestStatusText(digest) : 'Not saved yet.';
  const presetIndex = CHAT_DIGEST_PRESETS.findIndex((p) => p.cron === draft.cron.trim());
  const canSave = !busy && chatDigestDraftReady(draft);

  const projectOptions: { id: string; name: string }[] = (projects ?? []).map((p) => ({
    id: String(p.id),
    name: p.name || String(p.id),
  }));
  // A saved project the caller can no longer see still shows, so saving
  // does not silently drop it.
  if (projects && draft.projectId && !projectOptions.some((p) => p.id === draft.projectId)) {
    projectOptions.push({ id: draft.projectId, name: draft.projectId });
  }

  const toggleSkill = (id: string) =>
    setDraft((d) => ({
      ...d,
      skills: d.skills.includes(id) ? d.skills.filter((x) => x !== id) : [...d.skills, id],
    }));

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
              placeholder="Agent digest"
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
          {builtInText && (
            <p className="text-xs text-gray-500" data-testid="hub-chat-digest-builtin">
              {builtInText} Pick a project and agent to run your own prompt instead.
            </p>
          )}
          {projectsError && <p className="text-xs text-red-300">{projectsError}</p>}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-gray-400">
              Project
              <select
                value={draft.projectId}
                aria-label="Digest project"
                disabled={!projects}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, projectId: e.target.value, agentId: '', skills: [] }))
                }
                className={`mt-1 ${inputClass}`}
              >
                <option value="">{projects ? 'Pick a project' : 'Loading projects...'}</option>
                {projectOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-400">
              Agent
              <select
                value={draft.agentId}
                aria-label="Digest agent"
                disabled={!project}
                onChange={(e) => setDraft((d) => ({ ...d, agentId: e.target.value, skills: [] }))}
                className={`mt-1 ${inputClass}`}
              >
                <option value="">
                  {!project
                    ? 'Pick a project first'
                    : agents.length > 0
                      ? 'Pick an agent'
                      : 'No agent can run digests here'}
                </option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.id}
                  </option>
                ))}
                {draft.agentId && !agent && <option value={draft.agentId}>{draft.agentId}</option>}
              </select>
            </label>
          </div>
          {draft.agentId && (
            <fieldset className="text-xs text-gray-400">
              <legend>
                Skills ({draft.skills.length} selected, loaded before the prompt runs)
              </legend>
              {skillOptions === 'error' ? (
                <p className="mt-1 text-red-300">Couldn&apos;t load skills.</p>
              ) : !skillOptions ? (
                <p className="mt-1 flex items-center gap-2 text-gray-500">
                  <Loader2 size={12} className="animate-spin" /> Loading skills...
                </p>
              ) : skills.length === 0 ? (
                <p className="mt-1 text-gray-500">No skills available.</p>
              ) : (
                <div
                  className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto rounded border border-gray-800 p-2"
                  data-testid="hub-chat-digest-skills"
                >
                  {skills.map((sk) => (
                    <label key={sk.id} className="flex items-start gap-2 text-sm text-gray-300">
                      <input
                        type="checkbox"
                        checked={draft.skills.includes(sk.id)}
                        onChange={() => toggleSkill(sk.id)}
                        aria-label={`Skill ${sk.id}`}
                        className="mt-0.5 accent-blue-500"
                      />
                      <span className="min-w-0">
                        <span className="font-mono">{sk.id}</span>
                        {sk.description && (
                          <span className="block truncate text-xs text-gray-500">
                            {sk.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
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
            Prompt
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
              aria-label="Digest prompt"
              placeholder="What should the agent do? Its final reply is posted in this channel."
              rows={5}
              className={`mt-1 resize-y ${inputClass}`}
            />
            <span
              className={`mt-1 block ${draft.prompt.length > MAX_CHAT_DIGEST_PROMPT_CHARS ? 'text-red-300' : 'text-gray-500'}`}
            >
              {draft.prompt.length}/{MAX_CHAT_DIGEST_PROMPT_CHARS}
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
                    setNotice(chatDigestRunResultText(res.result ?? {}));
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
                  setDraft(draftFrom(res.digest, channelProjectId));
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
