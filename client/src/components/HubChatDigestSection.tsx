import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../utils/api';
import { isHubSystemProject } from '@shared/utils/hub';
import type { ProjectWire } from '@shared/types';
import {
  CHAT_DIGEST_PRESETS,
  DEFAULT_CHAT_DIGEST_CRON,
  chatDigestStatusText,
  describeDigestSchedule,
  deviceTimeZone,
  type ChatDigest,
  type ChatDigestScope,
} from '@shared/utils/chatDigest';

const inputClass =
  'w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500';
const primaryButton =
  'inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Request failed');
}

interface Draft {
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChatDigestScope;
  projectId: string;
}

function draftFrom(digest: ChatDigest | null, defaultProjectId: string | null): Draft {
  return {
    enabled: digest?.enabled ?? true,
    cron: digest?.cron ?? DEFAULT_CHAT_DIGEST_CRON,
    timeZone: digest?.timeZone ?? deviceTimeZone(),
    scope: digest?.scope ?? 'channel',
    projectId: digest?.projectId ?? defaultProjectId ?? '',
  };
}

/**
 * Channel settings: a scheduled AI digest of this channel's messages or of a
 * project's activity, posted into the channel. Saving makes the caller the
 * digest owner (their engine credentials run it).
 */
export function HubChatDigestSection({
  channelId,
  channelProjectId,
}: {
  channelId: string;
  channelProjectId: string | null;
}) {
  const [digest, setDigest] = useState<ChatDigest | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null, channelProjectId));
  const [projects, setProjects] = useState<ProjectWire[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.hubChat
      .digest(channelId)
      .then((res: { digest: ChatDigest | null }) => {
        if (!live) return;
        setDigest(res.digest);
        setDraft(draftFrom(res.digest, channelProjectId));
      })
      .catch((err: unknown) => {
        if (live) setError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [channelId, channelProjectId]);

  const needsProjects = draft.scope === 'project';
  useEffect(() => {
    if (!needsProjects || projects) return;
    let live = true;
    api
      .getProjects()
      .then((p: unknown) => {
        if (!live) return;
        const list = (Array.isArray(p) ? (p as ProjectWire[]) : []).filter(
          (x) => !isHubSystemProject(x),
        );
        setProjects(list);
        setDraft((d) => (d.projectId ? d : { ...d, projectId: String(list[0]?.id ?? '') }));
      })
      .catch((err: unknown) => {
        if (live) setError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [needsProjects, projects]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (digest === undefined && !error) {
    return (
      <section className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Loading digest...
      </section>
    );
  }

  const presetIndex = CHAT_DIGEST_PRESETS.findIndex((p) => p.cron === draft.cron.trim());
  const canSave =
    !busy &&
    draft.cron.trim().length > 0 &&
    draft.timeZone.trim().length > 0 &&
    (draft.scope === 'channel' || draft.projectId.length > 0);

  return (
    <section className="flex flex-col gap-2" data-testid="hub-chat-digest">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        Scheduled digest
      </h3>
      <p className="text-xs text-gray-500">
        An AI summary posted here on a schedule. Nothing is posted when nothing happened.
      </p>
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
          onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as ChatDigestScope }))}
          className={`mt-1 ${inputClass}`}
        >
          <option value="channel">Messages in this channel since the last digest</option>
          <option value="project">A project&apos;s activity</option>
        </select>
      </label>
      {draft.scope === 'project' && (
        <label className="text-xs text-gray-400">
          Project
          <select
            value={draft.projectId}
            aria-label="Digest project"
            disabled={!projects}
            onChange={(e) => setDraft((d) => ({ ...d, projectId: e.target.value }))}
            className={`mt-1 ${inputClass}`}
          >
            {!projects && <option value={draft.projectId}>Loading...</option>}
            {projects?.map((p) => (
              <option key={String(p.id)} value={String(p.id)}>
                {p.name || String(p.id)}
              </option>
            ))}
          </select>
        </label>
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
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-gray-400">
          Cron
          <input
            value={draft.cron}
            onChange={(e) => setDraft((d) => ({ ...d, cron: e.target.value }))}
            aria-label="Digest cron"
            placeholder="0 9 * * 1-5"
            className={`mt-1 font-mono ${inputClass}`}
          />
        </label>
        <label className="flex-1 text-xs text-gray-400">
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
      <p className="text-xs text-gray-400" data-testid="hub-chat-digest-status">
        {chatDigestStatusText(digest ?? null)}
      </p>
      <div className="flex justify-end gap-2">
        {digest && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.hubChat.removeDigest(channelId);
                setDigest(null);
                setDraft(draftFrom(null, channelProjectId));
              })
            }
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50"
          >
            Remove
          </button>
        )}
        <button
          type="button"
          disabled={!canSave}
          onClick={() =>
            void run(async () => {
              const res = await api.hubChat.saveDigest(channelId, {
                enabled: draft.enabled,
                cron: draft.cron.trim(),
                timeZone: draft.timeZone.trim(),
                scope: draft.scope,
                projectId: draft.scope === 'project' ? draft.projectId : null,
              });
              setDigest(res.digest);
              setDraft(draftFrom(res.digest, channelProjectId));
            })
          }
          className={primaryButton}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {digest ? 'Save digest' : 'Schedule digest'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
