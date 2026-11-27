/**
 * Server Agent proactive mode: preference shape, offer kinds and the quiet
 * hours rule. Shared by the server (scheduler, routes), web and mobile so the
 * settings form, offer cards and the check loop agree on every value.
 */

export const PROACTIVE_AREAS = ['dev', 'google', 'infra', 'todos'] as const;
export type ProactiveArea = (typeof PROACTIVE_AREAS)[number];

export const PROACTIVE_AREA_LABELS: Record<ProactiveArea, string> = {
  dev: 'Dev work',
  google: 'Gmail and Calendar',
  infra: 'Infra and deploys',
  todos: 'Todos and reminders',
};

/**
 * Every kind of thing the Server Agent can offer to help with. The kind comes
 * from the fact the offer was raised for (never from the model), so "Never for
 * this kind" suppressions are reliable.
 */
export const PROACTIVE_OFFER_KINDS = {
  finalize_failed: { area: 'dev', label: 'Failed Finalize runs' },
  session_needs_input: { area: 'dev', label: 'Sessions waiting on you' },
  session_stuck: { area: 'dev', label: 'Stuck sessions' },
  pr_review: { area: 'dev', label: 'PRs awaiting your review' },
  stale_card: { area: 'dev', label: 'Stale In Progress cards' },
  idle_epic: { area: 'dev', label: 'Idle autonomous epics' },
  email_reply: { area: 'google', label: 'Emails needing a reply' },
  meeting_prep: { area: 'google', label: 'Meeting prep' },
  calendar_conflict: { area: 'google', label: 'Calendar conflicts' },
  infra_alert: { area: 'infra', label: 'Infra alerts' },
  deploy_failed: { area: 'infra', label: 'Failed deploys' },
  aws_sso_expiring: { area: 'infra', label: 'Expiring AWS sign-ins' },
  todo_overdue: { area: 'todos', label: 'Overdue todos' },
  follow_up: { area: 'todos', label: 'Quiet follow-ups' },
} as const satisfies Record<string, { area: ProactiveArea; label: string }>;

export type ProactiveOfferKind = keyof typeof PROACTIVE_OFFER_KINDS;
export const PROACTIVE_OFFER_KIND_IDS = Object.keys(PROACTIVE_OFFER_KINDS) as ProactiveOfferKind[];

export function isProactiveOfferKind(value: unknown): value is ProactiveOfferKind {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROACTIVE_OFFER_KINDS, value)
  );
}

export function proactiveKindLabel(kind: string): string {
  return isProactiveOfferKind(kind) ? PROACTIVE_OFFER_KINDS[kind].label : kind;
}

export const PROACTIVE_OFFER_STATUSES = [
  'open',
  'accepted',
  'dismissed',
  'expired',
  'suppressed',
] as const;
export type ProactiveOfferStatus = (typeof PROACTIVE_OFFER_STATUSES)[number];

export const PROACTIVE_URGENCIES = ['low', 'normal', 'high', 'urgent'] as const;
export type ProactiveUrgency = (typeof PROACTIVE_URGENCIES)[number];

/** What the three offer buttons send. */
export const PROACTIVE_OFFER_ACTIONS = ['accept', 'snooze', 'never'] as const;
export type ProactiveOfferAction = (typeof PROACTIVE_OFFER_ACTIONS)[number];

export const PROACTIVE_OFFER_BUTTON_LABELS: Record<ProactiveOfferAction, string> = {
  accept: 'Do it',
  snooze: 'Not now',
  never: 'Never for this kind',
};

/** A proactive offer as the REST API and the WebSocket event carry it. */
export interface ProactiveOffer {
  id: string;
  kind: ProactiveOfferKind;
  area: ProactiveArea;
  title: string;
  reason: string;
  action: string;
  urgency: ProactiveUrgency;
  status: ProactiveOfferStatus;
  source: 'scheduled' | 'event' | 'manual';
  target: ProactiveOfferTarget;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  snoozedUntil: string | null;
  actedAt: string | null;
  /** The session "Do it" ran in, once accepted. */
  actionSessionId: string | null;
  /**
   * Bumped by the server on every write. Clients order updates for one offer
   * by it, so an older HTTP response can't overwrite a newer event.
   */
  revision: number;
}

/** Ids the offer is about, taken from the fact (never from model output). */
/**
 * Ids the offer is about, taken from the fact (never from model output). Each
 * kind sets the ids that identify its subject without relying on a title:
 * todos `todoId`, reminders `reminderId`, mail `threadId` + `accountId`,
 * calendar `eventId` + `accountId` (+ `secondEventId` / `secondAccountId` for a
 * conflict), infra
 * `alertId`, deploys `deploymentId`, Finalize `finalizeRunId`.
 */
export interface ProactiveOfferTarget {
  projectId?: string;
  sessionId?: string;
  cardId?: string;
  epicId?: string;
  todoId?: string;
  reminderId?: string;
  threadId?: string;
  eventId?: string;
  secondEventId?: string;
  accountId?: string;
  /** Account of `secondEventId` (a conflict can span two linked accounts). */
  secondAccountId?: string;
  alertId?: string;
  deploymentId?: string;
  finalizeRunId?: string;
  url?: string;
}

export const PROACTIVE_TARGET_KEYS = [
  'projectId',
  'sessionId',
  'cardId',
  'epicId',
  'todoId',
  'reminderId',
  'threadId',
  'eventId',
  'secondEventId',
  'accountId',
  'secondAccountId',
  'alertId',
  'deploymentId',
  'finalizeRunId',
  'url',
] as const satisfies ReadonlyArray<keyof ProactiveOfferTarget>;

export const PROACTIVE_OFFER_EVENT = 'server_agent_offer_update';

export const PROACTIVE_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export const PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT = 20;

export interface ProactiveQuietHours {
  enabled: boolean;
  /** `HH:MM`, local to `timeZone`. */
  start: string;
  end: string;
}

export interface ServerAgentProactivePrefs {
  enabled: boolean;
  intervalHours: number;
  timeZone: string;
  quietHours: ProactiveQuietHours;
  areas: Record<ProactiveArea, boolean>;
  maxOffersPerDay: number;
  push: boolean;
}

export const DEFAULT_PROACTIVE_PREFS: ServerAgentProactivePrefs = {
  enabled: false,
  intervalHours: 3,
  timeZone: 'UTC',
  quietHours: { enabled: true, start: '22:00', end: '08:00' },
  areas: { dev: true, google: true, infra: true, todos: true },
  maxOffersPerDay: 5,
  push: true,
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fill defaults and clamp every field. Unknown keys are dropped. Never throws:
 * a malformed stored blob degrades to defaults (proactive mode off).
 */
export function normalizeProactivePrefs(raw: unknown): ServerAgentProactivePrefs {
  const d = DEFAULT_PROACTIVE_PREFS;
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const interval = Number(obj.intervalHours);
  const intervalHours = (PROACTIVE_INTERVAL_HOURS as readonly number[]).includes(interval)
    ? interval
    : d.intervalHours;
  const qhRaw =
    obj.quietHours && typeof obj.quietHours === 'object' && !Array.isArray(obj.quietHours)
      ? (obj.quietHours as Record<string, unknown>)
      : {};
  const quietHours: ProactiveQuietHours = {
    enabled: typeof qhRaw.enabled === 'boolean' ? qhRaw.enabled : d.quietHours.enabled,
    start:
      typeof qhRaw.start === 'string' && HHMM_RE.test(qhRaw.start)
        ? qhRaw.start
        : d.quietHours.start,
    end: typeof qhRaw.end === 'string' && HHMM_RE.test(qhRaw.end) ? qhRaw.end : d.quietHours.end,
  };
  const areasRaw =
    obj.areas && typeof obj.areas === 'object' && !Array.isArray(obj.areas)
      ? (obj.areas as Record<string, unknown>)
      : {};
  const areas = { ...d.areas };
  for (const a of PROACTIVE_AREAS) {
    if (typeof areasRaw[a] === 'boolean') areas[a] = areasRaw[a] as boolean;
  }
  const max = Math.round(Number(obj.maxOffersPerDay));
  const maxOffersPerDay =
    Number.isFinite(max) && max >= 1
      ? Math.min(PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT, max)
      : d.maxOffersPerDay;
  return {
    enabled: obj.enabled === true,
    intervalHours,
    timeZone: validTimeZone(obj.timeZone) ? obj.timeZone.trim() : d.timeZone,
    quietHours,
    areas,
    maxOffersPerDay,
    push: typeof obj.push === 'boolean' ? obj.push : d.push,
  };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Minutes past local midnight in `timeZone` for `now`. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/**
 * True when `now` falls inside the quiet window. The window may wrap midnight
 * (22:00 to 08:00). Equal start and end means no quiet time.
 */
export function isWithinQuietHours(prefs: ServerAgentProactivePrefs, now: Date): boolean {
  const qh = prefs.quietHours;
  if (!qh.enabled) return false;
  const start = minutesOf(qh.start);
  const end = minutesOf(qh.end);
  if (start === end) return false;
  const t = localMinutes(now, prefs.timeZone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

const URGENCY_ORDER: Record<ProactiveUrgency, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Open offers, most urgent first, then newest. */
export function sortOpenOffers(offers: readonly ProactiveOffer[]): ProactiveOffer[] {
  return offers
    .filter((o) => o.status === 'open')
    .slice()
    .sort(
      (a, b) =>
        URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

/**
 * Fold a `server_agent_offer_update` event into a client's open-offer list:
 * an open offer is inserted or replaced, anything else is removed.
 */
export function applyOfferUpdate(
  offers: readonly ProactiveOffer[],
  event: { offer?: ProactiveOffer | null; offerId?: string | null } | null | undefined,
): ProactiveOffer[] {
  const offer = event?.offer ?? null;
  const id = offer?.id ?? event?.offerId ?? null;
  if (!id) return offers.slice();
  const rest = offers.filter((o) => o.id !== id);
  return offer && offer.status === 'open' ? sortOpenOffers([...rest, offer]) : rest;
}

/**
 * The first minute at or after `now` that is outside quiet hours (the end of
 * the current quiet window). Returns `now` when not in quiet hours.
 */
export function quietHoursEnd(prefs: ServerAgentProactivePrefs, now: Date): Date {
  const minute = 60_000;
  const start = Math.floor(now.getTime() / minute) * minute;
  for (let i = 0; i <= 24 * 60; i++) {
    const t = new Date(start + i * minute);
    if (t.getTime() >= now.getTime() && !isWithinQuietHours(prefs, t)) return t;
  }
  return now;
}
