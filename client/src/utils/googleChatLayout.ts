import { compareRfc3339 } from '@shared/utils/rfc3339';
import { parseDate } from './time';
import { chatSenderLabel, type ChatMessage, type ChatUser } from './googleChat';

// Literal class names so Tailwind keeps them in the build.
const AVATAR_COLORS = [
  'bg-rose-600',
  'bg-orange-600',
  'bg-amber-600',
  'bg-lime-700',
  'bg-emerald-600',
  'bg-teal-600',
  'bg-cyan-700',
  'bg-sky-600',
  'bg-indigo-600',
  'bg-violet-600',
  'bg-fuchsia-600',
  'bg-pink-600',
];

/** Consecutive messages from one sender closer together than this share a header. */
const GROUP_GAP_MS = 5 * 60_000;

/** The quick-pick row in the reaction menu, in Google Chat's order. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '👀'];

function senderKey(sender: ChatUser | null | undefined): string {
  return sender?.name || chatSenderLabel(sender);
}

/** A stable color per sender, so the same person always gets the same avatar. */
export function avatarColor(sender: ChatUser | null | undefined): string {
  const key = senderKey(sender);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Up to two initials from a display label ("Kevin Woeste" -> "KW"). */
export function avatarInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0])[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function isOwnMessage(message: ChatMessage, selfUserName: string | null): boolean {
  return !!selfUserName && message.sender?.name === selfUserName;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday", or a date, the way Chat labels its day separators. */
export function chatDayLabel(d: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: diffDays < 7 ? 'long' : undefined,
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export type ChatRow = {
  message: ChatMessage;
  own: boolean;
  /** First message of a run from one sender: show avatar, name, and time. */
  showHeader: boolean;
  /** Set on the first message of each local day. */
  dayLabel: string | null;
  /** True on the first message from someone else after the caller's read position. */
  unreadDivider: boolean;
};

/**
 * Lay out an oldest-first message list the way Google Chat does: day
 * separators, an "Unread" line at the caller's read position, and runs of
 * messages from one sender collapsed under a single header.
 */
export function layoutChatMessages(
  messages: ChatMessage[],
  opts: { selfUserName: string | null; lastReadTime: string | null; now?: Date },
): ChatRow[] {
  const now = opts.now ?? new Date();
  const rows: ChatRow[] = [];
  let unreadPlaced = false;
  let prev: ChatMessage | null = null;
  let prevDate: Date | null = null;
  for (const message of messages) {
    const parsed = parseDate(message.createTime);
    const date = parsed && !isNaN(parsed.getTime()) ? parsed : null;
    const own = isOwnMessage(message, opts.selfUserName);

    const newDay = !!date && (!prevDate || localDayKey(date) !== localDayKey(prevDate));
    let unreadDivider = false;
    // Google's space read state only covers top-level messages; a thread
    // reply's read state is per thread, so it is never judged by this one.
    if (
      !unreadPlaced &&
      opts.lastReadTime &&
      !own &&
      !message.deleted &&
      !message.threadReply &&
      message.createTime &&
      compareRfc3339(message.createTime, opts.lastReadTime) > 0
    ) {
      unreadDivider = true;
      unreadPlaced = true;
    }
    const sameRun =
      !!prev &&
      !newDay &&
      !unreadDivider &&
      senderKey(prev.sender) === senderKey(message.sender) &&
      prev.threadReply === message.threadReply &&
      !!date &&
      !!prevDate &&
      date.getTime() - prevDate.getTime() < GROUP_GAP_MS;

    rows.push({
      message,
      own,
      showHeader: !sameRun,
      dayLabel: newDay && date ? chatDayLabel(date, now) : null,
      unreadDivider,
    });
    prev = message;
    if (date) prevDate = date;
  }
  return rows;
}

/**
 * Keep reaction summaries the caller's own toggles set after `sinceEpoch`.
 * A message list requested before a toggle's response can still carry the
 * old counts; the toggle response is Google's summary read back after the
 * change, so it wins for that message until a later read replaces it.
 */
export function keepNewerReactions(
  fresh: ChatMessage[],
  current: ChatMessage[],
  touched: ReadonlyMap<string, number>,
  sinceEpoch: number,
): ChatMessage[] {
  if (!touched.size) return fresh;
  const byName = new Map(current.map((m) => [m.name, m]));
  return fresh.map((m) => {
    const epoch = m.name ? touched.get(m.name) : undefined;
    if (epoch === undefined || epoch <= sinceEpoch) return m;
    const kept = byName.get(m.name);
    return kept ? { ...m, reactions: kept.reactions } : m;
  });
}

/**
 * The newest top-level message time: the furthest point the space read state
 * can be moved to from what is loaded. Thread replies don't count, since
 * Google tracks their read state per thread.
 */
export function newestTopLevelTime(messages: ChatMessage[]): string | null {
  let newest: string | null = null;
  for (const m of messages) {
    if (m.threadReply || m.deleted || !m.createTime) continue;
    if (!newest || compareRfc3339(m.createTime, newest) > 0) newest = m.createTime;
  }
  return newest;
}
