/**
 * Project chat triggers: the events a project can route into a chat channel,
 * the filters each one accepts, and the structured card a trigger message
 * carries in `payload`. Shared by the server router, the web settings UI and
 * the web/mobile message renderers.
 */

export const CHAT_TRIGGER_EVENTS = [
  'session_awaiting_input',
  'session_completed',
  'finalize_run_completed',
  'pr_opened',
  'pr_review_requested',
  'pr_merged',
  'card_created',
  'card_moved',
  'support_ticket_created',
  'cron_finished',
  'infra_alert',
] as const;

export type ChatTriggerEvent = (typeof CHAT_TRIGGER_EVENTS)[number];

/** Filter fields; each event reads only the ones listed in its `filters`. */
export interface ChatTriggerFilter {
  /** Card events: column names (case-insensitive). Card moved matches the destination. */
  columns?: string[];
  /** Card events: only cards in this epic. */
  epicId?: string;
  /** Card events: cards carrying any of these labels (case-insensitive). */
  labels?: string[];
  /** Finalize runs: pass or fail. Cron runs: success or error. */
  outcome?: 'pass' | 'fail' | 'success' | 'error';
  /** Session events: only sessions of these agents. */
  agentIds?: string[];
  /** Infra alerts: severities (case-insensitive), e.g. critical, warning. */
  severities?: string[];
}

export type ChatTriggerFilterField = keyof ChatTriggerFilter;

export interface ChatTriggerEventInfo {
  id: ChatTriggerEvent;
  label: string;
  description: string;
  filters: ChatTriggerFilterField[];
  /** Allowed `outcome` values when `filters` includes it. */
  outcomes?: ('pass' | 'fail' | 'success' | 'error')[];
}

export const CHAT_TRIGGER_EVENT_INFO: Record<ChatTriggerEvent, ChatTriggerEventInfo> = {
  session_awaiting_input: {
    id: 'session_awaiting_input',
    label: 'Session awaiting input',
    description: 'A session asked a question and is waiting for an answer.',
    filters: ['agentIds'],
  },
  session_completed: {
    id: 'session_completed',
    label: 'Session turn completed',
    description: 'An agent finished a turn in a session.',
    filters: ['agentIds'],
  },
  finalize_run_completed: {
    id: 'finalize_run_completed',
    label: 'Finalize run completed',
    description: 'A Finalize run passed (ready to push or pushed) or failed.',
    filters: ['outcome'],
    outcomes: ['pass', 'fail'],
  },
  pr_opened: {
    id: 'pr_opened',
    label: 'Pull request opened',
    description: 'A pull request was opened on the Agent Hub git host.',
    filters: [],
  },
  pr_review_requested: {
    id: 'pr_review_requested',
    label: 'Pull request review requested',
    description: 'Someone asked for a review on a pull request.',
    filters: [],
  },
  pr_merged: {
    id: 'pr_merged',
    label: 'Pull request merged',
    description: 'A pull request was merged.',
    filters: [],
  },
  card_created: {
    id: 'card_created',
    label: 'Card created',
    description: 'A kanban card was created.',
    filters: ['columns', 'epicId', 'labels'],
  },
  card_moved: {
    id: 'card_moved',
    label: 'Card moved',
    description: 'A kanban card moved to another column.',
    filters: ['columns', 'epicId', 'labels'],
  },
  support_ticket_created: {
    id: 'support_ticket_created',
    label: 'Support ticket created',
    description: 'A support ticket was filed.',
    filters: [],
  },
  cron_finished: {
    id: 'cron_finished',
    label: 'Cron finished',
    description: 'A scheduled job finished, successfully or with an error.',
    filters: ['outcome'],
    outcomes: ['success', 'error'],
  },
  infra_alert: {
    id: 'infra_alert',
    label: 'Infrastructure alert',
    description: 'An infrastructure alert changed state or an AWS Health event arrived.',
    filters: ['severities'],
  },
};

export function isChatTriggerEvent(value: unknown): value is ChatTriggerEvent {
  return typeof value === 'string' && (CHAT_TRIGGER_EVENTS as readonly string[]).includes(value);
}

/** Tone of a trigger card's status badge. */
export type ChatTriggerStatus = 'success' | 'failure' | 'warning' | 'info' | 'waiting';

export interface ChatTriggerCardRef {
  kind: 'session' | 'card' | 'ticket' | 'pr';
  targetId: string;
  label: string;
}

/** `payload` of a message posted by a trigger (`authorKind: 'trigger'`). */
export interface ChatTriggerCard {
  type: 'trigger';
  event: ChatTriggerEvent;
  triggerId: string;
  projectId: string;
  title: string;
  status: ChatTriggerStatus;
  /** Short status text for the badge, e.g. "Passed", "Review". */
  statusLabel: string;
  /** Optional one-line detail (no ref tokens). */
  detail: string | null;
  refs: ChatTriggerCardRef[];
}

export function readChatTriggerCard(payload: unknown): ChatTriggerCard | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Partial<ChatTriggerCard>;
  if (p.type !== 'trigger' || !isChatTriggerEvent(p.event) || typeof p.title !== 'string') {
    return null;
  }
  return {
    type: 'trigger',
    event: p.event,
    triggerId: typeof p.triggerId === 'string' ? p.triggerId : '',
    projectId: typeof p.projectId === 'string' ? p.projectId : '',
    title: p.title,
    status: p.status ?? 'info',
    statusLabel: typeof p.statusLabel === 'string' ? p.statusLabel : '',
    detail: typeof p.detail === 'string' ? p.detail : null,
    refs: Array.isArray(p.refs)
      ? p.refs.filter(
          (r): r is ChatTriggerCardRef =>
            !!r &&
            typeof r === 'object' &&
            typeof r.targetId === 'string' &&
            typeof r.label === 'string' &&
            ['session', 'card', 'ticket', 'pr'].includes(r.kind),
        )
      : [],
  };
}

/** Suggested name for a project's first trigger channel. */
export function defaultTriggerChannelName(projectId: string): string {
  const slug = projectId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'project'}-activity`;
}
