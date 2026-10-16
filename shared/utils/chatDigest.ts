/**
 * Channel digest settings shared by web and mobile: the wire shape, schedule
 * presets, and the one-line status shown under the form.
 */
import humanCron from './humanCron.js';

/**
 * `agent` runs the digest's prompt as a session of a project agent and posts
 * its reply. The other scopes are built-in summaries; `my_work` is only
 * allowed on the owner's own Summaries channel.
 */
export type ChatDigestScope = 'channel' | 'project' | 'my_work' | 'agent';

export interface ChatDigest {
  id: string;
  channelId: string;
  name: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChatDigestScope;
  projectIds: string[];
  /** The agent's task (`agent`), or custom summary instructions / null for the default. */
  prompt: string | null;
  /** Agent scope: the project agent that runs the prompt. */
  agentId: string | null;
  /** Agent scope: skill ids preloaded into the session. */
  skills: string[];
  ownerUserId: string;
  windowStart: string;
  lastRunAt: string | null;
  lastStatus: 'posted' | 'skipped' | 'started' | 'error' | null;
  lastError: string | null;
  lastMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CHAT_DIGEST_PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: 'Weekdays at 9:00 AM', cron: '0 9 * * 1-5' },
  { label: 'Every day at 9:00 AM', cron: '0 9 * * *' },
  { label: 'Every day at 5:00 PM', cron: '0 17 * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Mondays at 9:00 AM', cron: '0 9 * * 1' },
];

export const DEFAULT_CHAT_DIGEST_CRON = '0 9 * * 1-5';

/**
 * A digest schedule is one or more 5-field cron expressions joined by `|`;
 * the digest runs whenever any of them fires. Several expressions let one
 * digest run at times no single cron can express (08:05 and 13:40).
 */
export const CHAT_DIGEST_CRON_SEPARATOR = ' | ';

/** Most cron expressions one digest schedule can join. */
export const MAX_CHAT_DIGEST_CRON_EXPRESSIONS = 12;

/** The expressions of a digest schedule, whitespace-normalized, blanks dropped. */
export function splitDigestCron(cron: string): string[] {
  return cron
    .split('|')
    .map((part) => part.trim().split(/\s+/).join(' '))
    .filter((part) => part.length > 0);
}

/** Longest custom digest prompt the server accepts. */
export const MAX_CHAT_DIGEST_PROMPT_CHARS = 4000;

/** Most digests one channel can hold. */
export const MAX_CHAT_DIGESTS_PER_CHANNEL = 10;

/** Most projects one project digest can cover. */
export const MAX_CHAT_DIGEST_PROJECTS = 10;

/**
 * The instruction paragraph a digest uses when it has no custom prompt. A
 * custom prompt replaces exactly this text; editors show it as placeholder.
 */
export const DEFAULT_CHAT_DIGEST_INSTRUCTIONS = [
  'Lead with the most important outcomes, then group the rest in a short bullet list.',
  'Keep it under 200 words.',
].join('\n');

/** Body of a digest create (POST) or replace (PUT). */
export interface ChatDigestSaveRequest {
  name?: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChatDigestScope;
  projectIds?: string[];
  /** Required for `agent`. */
  agentId?: string | null;
  /** Agent scope: skills preloaded into the session. */
  skills?: string[];
  /**
   * The agent's task (required for `agent`), or custom summary instructions; null or blank restores the default. Omitted
   * on a replace (PUT), the saved prompt is kept.
   */
  prompt?: string | null;
}

/** The device's IANA timezone, or UTC when it cannot be read. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Human description of a schedule, falling back to the raw expression. */
export function describeDigestSchedule(cron: string, timeZone: string): string {
  const parts = splitDigestCron(cron);
  const text =
    parts.length > 0 ? parts.map((part) => humanCron(part) || part).join('; ') : cron.trim();
  return timeZone ? `${text} (${timeZone})` : text;
}

/** Status line for a saved digest, e.g. "Last run Oct 14, 9:00 AM: posted". */
export function chatDigestStatusText(
  digest: Pick<ChatDigest, 'enabled' | 'lastRunAt' | 'lastStatus' | 'lastError'> | null,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): string {
  if (!digest) return 'No digest scheduled.';
  const paused = digest.enabled ? '' : 'Paused. ';
  if (digest.lastStatus === 'error') {
    return `${paused}Last run failed: ${digest.lastError || 'unknown error'}`;
  }
  if (!digest.lastRunAt || !digest.lastStatus) return `${paused}Not run yet.`;
  const outcome =
    digest.lastStatus === 'posted'
      ? 'posted a digest'
      : digest.lastStatus === 'started'
        ? 'started the agent'
        : 'nothing new, skipped posting';
  return `${paused}Last run ${formatTime(digest.lastRunAt)}: ${outcome}.`;
}

/** What a built-in (non-agent) digest summarizes, for its editor. */
export function builtInDigestDescription(scope: ChatDigestScope): string | null {
  switch (scope) {
    case 'channel':
      return 'Built-in summary of messages in this channel since the last run.';
    case 'project':
      return "Built-in summary of the selected projects' cards, PRs and tickets.";
    case 'my_work':
      return 'Built-in summary of your sessions, assigned cards and todos.';
    default:
      return null;
  }
}

/** Roles that cannot run a digest session (matches the server's background-session rule). */
const DIGEST_INELIGIBLE_ROLES = new Set(['reviewer', 'docs', 'hub-assistant', 'skill-builder']);

/** A project's agents that can run an agent digest. */
export function chatDigestAgents<T extends { id: string; role?: unknown }>(
  agents: readonly T[] | null | undefined,
): T[] {
  return (agents ?? []).filter(
    (a) =>
      !!a &&
      !DIGEST_INELIGIBLE_ROLES.has(
        String(a.role ?? '')
          .trim()
          .toLowerCase(),
      ),
  );
}

/** Text shown for a "Run now" result. */
export function chatDigestRunResultText(result: {
  status?: string;
  reason?: string;
  error?: string;
  skippedSkills?: string[];
}): string {
  switch (result.status) {
    case 'posted':
      return 'Posted a digest.';
    case 'started': {
      const skipped = result.skippedSkills?.length
        ? ` Skills not loaded: ${result.skippedSkills.join(', ')}.`
        : '';
      return `Started the agent. Its reply will be posted here when it finishes.${skipped}`;
    }
    case 'skipped':
      return 'Nothing new, skipped posting.';
    case 'cancelled':
      return `Run cancelled: ${result.reason || 'digest changed'}`;
    default:
      return `Run failed: ${result.error || 'unknown error'}`;
  }
}

/** Editor state for one digest, shared by web and mobile. */
export interface ChatDigestDraft {
  name: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  /** The saved scope; a built-in digest keeps it until an agent is picked. */
  scope: ChatDigestScope;
  /** A built-in project digest keeps its projects untouched. */
  builtInProjectIds: string[];
  projectId: string;
  agentId: string;
  skills: string[];
  prompt: string;
}

export function chatDigestDraftFrom(
  digest: ChatDigest | null,
  defaultProjectId: string | null,
): ChatDigestDraft {
  const isAgent = !digest || digest.scope === 'agent';
  return {
    name: digest?.name ?? '',
    enabled: digest?.enabled ?? true,
    cron: digest?.cron ?? DEFAULT_CHAT_DIGEST_CRON,
    timeZone: digest?.timeZone ?? deviceTimeZone(),
    scope: digest?.scope ?? 'agent',
    builtInProjectIds: digest && !isAgent ? [...digest.projectIds] : [],
    projectId: isAgent ? (digest?.projectIds[0] ?? defaultProjectId ?? '') : '',
    agentId: digest?.agentId ?? '',
    skills: digest?.skills ? [...digest.skills] : [],
    prompt: digest?.prompt ?? '',
  };
}

/** A built-in digest no agent was picked for yet; it saves under its own scope. */
export function chatDigestDraftIsBuiltIn(draft: ChatDigestDraft): boolean {
  return draft.scope !== 'agent' && !(draft.projectId && draft.agentId);
}

/** Whether the editor may save: an agent digest needs a project, an agent and a prompt. */
export function chatDigestDraftReady(draft: ChatDigestDraft): boolean {
  if (!draft.cron.trim() || !draft.timeZone.trim()) return false;
  if (draft.prompt.length > MAX_CHAT_DIGEST_PROMPT_CHARS) return false;
  if (chatDigestDraftIsBuiltIn(draft)) return true;
  return !!draft.projectId && !!draft.agentId && draft.prompt.trim().length > 0;
}

export function chatDigestSaveBody(draft: ChatDigestDraft): ChatDigestSaveRequest {
  const common = {
    name: draft.name.trim() || undefined,
    enabled: draft.enabled,
    cron: draft.cron.trim(),
    timeZone: draft.timeZone.trim(),
    prompt: draft.prompt.trim() || null,
  };
  if (chatDigestDraftIsBuiltIn(draft)) {
    return { ...common, scope: draft.scope, projectIds: draft.builtInProjectIds };
  }
  return {
    ...common,
    scope: 'agent',
    projectIds: draft.projectId ? [draft.projectId] : [],
    agentId: draft.agentId || null,
    skills: draft.skills,
  };
}
