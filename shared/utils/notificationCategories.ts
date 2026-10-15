/**
 * The single notification category catalog shared by server, web and mobile.
 *
 * Categories are what users toggle in notification settings (one switch per
 * channel). Push event keys are the wire-level `event` strings the server
 * dispatches to Expo and that mobile routes on tap; each maps onto one or more
 * categories.
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'desktop', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type ChannelDefaults = Record<NotificationChannel, boolean>;

export interface NotificationCategory {
  id: string;
  label: string;
  description: string;
  defaults: ChannelDefaults;
}

export interface NotificationSection {
  id: string;
  label: string;
  categories: readonly NotificationCategory[];
}

const QUIET: ChannelDefaults = { in_app: true, desktop: false, push: false };
const LOUD: ChannelDefaults = { in_app: true, desktop: true, push: true };

export const NOTIFICATION_SECTIONS = [
  {
    id: 'sessions',
    label: 'Sessions',
    categories: [
      {
        id: 'awaiting_feedback',
        label: 'Awaiting feedback',
        description: 'An agent needs your input',
        defaults: LOUD,
      },
      {
        id: 'session_completed',
        label: 'Session completed',
        description: 'An agent finished its turn',
        defaults: QUIET,
      },
    ],
  },
  {
    id: 'code',
    label: 'Code',
    categories: [
      {
        id: 'ready_to_push',
        label: 'Ready to push',
        description: 'Finalize passed and changes are ready to ship',
        defaults: QUIET,
      },
      {
        id: 'pushed',
        label: 'Pushed',
        description: 'Changes were pushed',
        defaults: QUIET,
      },
      {
        id: 'finalize_failed',
        label: 'Finalize failed',
        description: 'Finalize checks failed on a session',
        defaults: QUIET,
      },
      {
        id: 'review_assigned_to_you',
        label: 'Review assigned to you',
        description: 'A PR or card needs your review',
        defaults: LOUD,
      },
      {
        id: 'pr_merged',
        label: 'PR merged',
        description: 'A linked PR was merged',
        defaults: QUIET,
      },
    ],
  },
  {
    id: 'board',
    label: 'Board',
    categories: [
      {
        id: 'card_assigned_to_you',
        label: 'Card assigned to you',
        description: 'A kanban card was assigned to you',
        defaults: QUIET,
      },
      {
        id: 'escalation',
        label: 'Escalations',
        description: 'A card or session was escalated for human attention',
        defaults: QUIET,
      },
    ],
  },
  {
    id: 'support',
    label: 'Support',
    categories: [
      {
        id: 'support_ticket_created',
        label: 'Support ticket created',
        description: 'A new support ticket came in',
        defaults: QUIET,
      },
    ],
  },
  {
    id: 'infra',
    label: 'Infra',
    categories: [
      {
        id: 'infra_alert',
        label: 'Infrastructure alerts',
        description: 'AWS monitoring state changes',
        defaults: LOUD,
      },
      {
        id: 'deploy_outcome',
        label: 'Deploy outcomes',
        description: 'A deployment succeeded or failed',
        defaults: QUIET,
      },
    ],
  },
  {
    id: 'chat',
    label: 'Chat',
    categories: [
      {
        id: 'dm',
        label: 'Direct messages',
        description: 'Someone sent you a direct message',
        defaults: LOUD,
      },
      {
        id: 'mention',
        label: 'Mentions',
        description: 'Someone @mentioned you in a channel',
        defaults: LOUD,
      },
    ],
  },
] as const satisfies readonly NotificationSection[];

export type NotificationSectionId = (typeof NOTIFICATION_SECTIONS)[number]['id'];
export type NotificationCategoryId =
  (typeof NOTIFICATION_SECTIONS)[number]['categories'][number]['id'];

export const NOTIFICATION_CATEGORIES: readonly (NotificationCategory & {
  id: NotificationCategoryId;
  section: NotificationSectionId;
})[] = NOTIFICATION_SECTIONS.flatMap((s) =>
  s.categories.map((c) => ({ ...c, defaults: { ...c.defaults }, section: s.id })),
);

export const NOTIFICATION_CATEGORY_IDS: readonly NotificationCategoryId[] =
  NOTIFICATION_CATEGORIES.map((c) => c.id);

export function getNotificationCategory(
  id: string,
): (typeof NOTIFICATION_CATEGORIES)[number] | undefined {
  return NOTIFICATION_CATEGORIES.find((c) => c.id === id);
}

export function isNotificationCategoryId(id: unknown): id is NotificationCategoryId {
  return typeof id === 'string' && NOTIFICATION_CATEGORY_IDS.includes(id as NotificationCategoryId);
}

export function categoryChannelDefault(
  id: NotificationCategoryId,
  channel: NotificationChannel,
): boolean {
  return getNotificationCategory(id)?.defaults[channel] ?? false;
}

/**
 * Push events the server dispatches today. `chat_message` covers both DMs and
 * @mentions until chat pushes are split per category; it also stays a valid
 * key because device rows persist it in `enabled_events`.
 */
export const PUSH_EVENT_TYPES = [
  'awaiting_feedback',
  'ready_to_push',
  'pushed',
  'support_ticket_created',
  'review_assigned_to_you',
  'pr_merged',
  'infra_alert',
  'chat_message',
] as const;

export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];

export const PUSH_EVENT_CATEGORIES: Record<PushEventType, readonly NotificationCategoryId[]> = {
  awaiting_feedback: ['awaiting_feedback'],
  ready_to_push: ['ready_to_push'],
  pushed: ['pushed'],
  support_ticket_created: ['support_ticket_created'],
  review_assigned_to_you: ['review_assigned_to_you'],
  pr_merged: ['pr_merged'],
  infra_alert: ['infra_alert'],
  chat_message: ['dm', 'mention'],
};

export interface PushEventOption {
  key: PushEventType;
  label: string;
  desc: string;
}

/** Per-device push toggle rows, labelled from the catalog. */
export const PUSH_EVENT_OPTIONS: readonly PushEventOption[] = PUSH_EVENT_TYPES.map((key) => {
  if (key === 'chat_message') {
    return {
      key,
      label: 'Chat messages',
      desc: 'Direct messages, mentions, and channels set to all',
    };
  }
  const cat = getNotificationCategory(PUSH_EVENT_CATEGORIES[key][0]);
  return { key, label: cat?.label ?? key, desc: cat?.description ?? '' };
});
