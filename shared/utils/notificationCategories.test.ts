import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_SECTIONS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_IDS,
  PUSH_EVENT_TYPES,
  PUSH_EVENT_CATEGORIES,
  categoryChannelDefault,
  isNotificationCategoryId,
} from './notificationCategories';

describe('notification category catalog', () => {
  it('groups categories into the spec sections in order', () => {
    expect(NOTIFICATION_SECTIONS.map((s) => s.label)).toEqual([
      'Sessions',
      'Reminders',
      'Code',
      'Board',
      'Support',
      'Infra',
      'Chat',
    ]);
    const bySection = Object.fromEntries(
      NOTIFICATION_SECTIONS.map((s) => [s.id, s.categories.map((c) => c.id)]),
    );
    expect(bySection).toEqual({
      sessions: [
        'awaiting_feedback',
        'browser_sign_in',
        'approval_requested',
        'session_completed',
        'routine_run',
      ],
      reminders: ['reminder'],
      code: [
        'ready_to_push',
        'pushed',
        'finalize_failed',
        'review_assigned_to_you',
        'pr_environment_ready',
        'pr_merged',
      ],
      board: ['card_assigned_to_you', 'escalation'],
      support: ['support_ticket_created'],
      infra: ['infra_alert', 'deploy_outcome'],
      chat: ['dm', 'mention'],
    });
  });

  it('has unique ids with a label and description each', () => {
    expect(new Set(NOTIFICATION_CATEGORY_IDS).size).toBe(NOTIFICATION_CATEGORY_IDS.length);
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(c.label).toBeTruthy();
      expect(c.description).toBeTruthy();
    }
  });

  it('defaults in_app on everywhere and push+desktop on only for the loud set', () => {
    const loud = new Set([
      'awaiting_feedback',
      'browser_sign_in',
      'approval_requested',
      'reminder',
      'review_assigned_to_you',
      'pr_environment_ready',
      'dm',
      'mention',
      'infra_alert',
    ]);
    for (const id of NOTIFICATION_CATEGORY_IDS) {
      expect(categoryChannelDefault(id, 'in_app')).toBe(true);
      expect(categoryChannelDefault(id, 'push')).toBe(loud.has(id));
      expect(categoryChannelDefault(id, 'desktop')).toBe(loud.has(id));
    }
  });

  it('does not share default objects between categories', () => {
    const [a, b] = NOTIFICATION_CATEGORIES.filter((c) => c.defaults.push);
    expect(a.defaults).not.toBe(b.defaults);
  });

  it('maps every push event to at least one known category', () => {
    for (const e of PUSH_EVENT_TYPES) {
      const cats = PUSH_EVENT_CATEGORIES[e];
      expect(cats.length).toBeGreaterThan(0);
      for (const c of cats) expect(isNotificationCategoryId(c)).toBe(true);
    }
    expect(PUSH_EVENT_CATEGORIES.chat_message).toEqual(['dm', 'mention']);
  });

  it('rejects unknown category ids', () => {
    expect(isNotificationCategoryId('chat_message')).toBe(false);
    expect(isNotificationCategoryId(42)).toBe(false);
  });
});
