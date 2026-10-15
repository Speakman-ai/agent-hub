/**
 * Channel digest settings shared by web and mobile: the wire shape, schedule
 * presets, and the one-line status shown under the form.
 */
import humanCron from './humanCron.js';

/** `my_work` is only allowed on the owner's own Summaries channel. */
export type ChatDigestScope = 'channel' | 'project' | 'my_work';

export interface ChatDigest {
  id: string;
  channelId: string;
  name: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChatDigestScope;
  projectIds: string[];
  /** Custom summary instructions, or null for the default. */
  prompt: string | null;
  ownerUserId: string;
  windowStart: string;
  lastRunAt: string | null;
  lastStatus: 'posted' | 'skipped' | 'error' | null;
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
  /**
   * Custom summary instructions; null or blank restores the default. Omitted
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
    digest.lastStatus === 'posted' ? 'posted a digest' : 'nothing new, skipped posting';
  return `${paused}Last run ${formatTime(digest.lastRunAt)}: ${outcome}.`;
}

/**
 * Whether a channel's digest editor may offer the `my_work` scope: only the
 * viewer's own Summaries channel, matching the server's `my_work_not_allowed`
 * check.
 */
export function canUseMyWorkDigestScope(
  channel: { kind: string; createdByUserId: string | null },
  viewerUserId: string | null,
): boolean {
  return channel.kind === 'summary' && !!viewerUserId && channel.createdByUserId === viewerUserId;
}

/** Whether a draft has the projects its scope needs to be saved. */
export function digestScopeReady(scope: ChatDigestScope, projectIds: readonly string[]): boolean {
  return scope !== 'project' || projectIds.length > 0;
}

export const MY_WORK_DIGEST_SCOPE_LABEL = 'My work (daily summary)';
