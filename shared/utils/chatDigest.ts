/**
 * Channel digest settings shared by web and mobile: the wire shape, schedule
 * presets, and the one-line status shown under the form.
 */
import humanCron from './humanCron.js';

export type ChatDigestScope = 'channel' | 'project';

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

/** Longest custom digest prompt the server accepts. */
export const MAX_CHAT_DIGEST_PROMPT_CHARS = 4000;

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
  const text = humanCron(cron.trim()) || cron.trim();
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
