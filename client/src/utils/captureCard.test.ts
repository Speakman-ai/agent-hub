import { describe, it, expect } from 'vitest';
import {
  buildEmailCardDraft,
  buildCalendarCardDraft,
  cardOriginLabel,
  cardOriginDeepLink,
} from '@shared/utils/captureCard';

// The direct capture mapping (spec CAPTURE-PROVENANCE): Gmail message / Calendar
// event -> kanban-card create draft, with the provenance triple preserved so the
// board endpoint can stamp `source` on the new card. Imports `@shared` so it runs
// in the CI client suite (shared's own *.test.ts are not in the Finalize matrix).

describe('buildEmailCardDraft', () => {
  it('maps a Gmail message into a card draft with provenance and a source link', () => {
    const draft = buildEmailCardDraft({
      threadId: 'thread-1',
      messageId: 'msg-9',
      subject: 'Ship the release',
      from: 'ceo@example.com',
      snippet: 'Please cut it today',
    });

    expect(draft.title).toBe('Ship the release');
    // The description folds in the sender note and a reopen deep link.
    expect(draft.description).toContain('From ceo@example.com');
    expect(draft.description).toContain('Source: https://mail.google.com/mail/u/0/#all/thread-1');
    expect(draft.source).toEqual({
      sourceType: 'email',
      // Prefers the more-specific message id over the thread id.
      sourceId: 'msg-9',
      sourceMeta: expect.objectContaining({
        kind: 'gmail',
        threadId: 'thread-1',
        messageId: 'msg-9',
        subject: 'Ship the release',
        from: 'ceo@example.com',
        deepLink: 'https://mail.google.com/mail/u/0/#all/thread-1',
      }),
    });
  });

  it('falls back to the thread id and a generic title when fields are missing', () => {
    const draft = buildEmailCardDraft({ threadId: 'thread-only' });
    expect(draft.title).toBe('Email');
    expect(draft.source.sourceType).toBe('email');
    expect(draft.source.sourceId).toBe('thread-only');
    // No sender note -> description is only the source link.
    expect(draft.description).toBe('Source: https://mail.google.com/mail/u/0/#all/thread-only');
  });

  it('omits the description when there is neither a note nor a deep link', () => {
    const draft = buildEmailCardDraft({ subject: 'No links here' });
    expect(draft.title).toBe('No links here');
    expect(draft.description).toBeUndefined();
    expect(draft.source.sourceId).toBeNull();
  });
});

describe('buildCalendarCardDraft', () => {
  it('maps a Calendar event into a card draft with the event deep link', () => {
    const draft = buildCalendarCardDraft({
      id: 'event-42',
      summary: 'Design sync',
      location: 'Room 4',
      htmlLink: 'https://calendar.google.com/event?eid=event-42',
      start: { dateTime: '2026-07-09T10:00:00Z' },
      end: { dateTime: '2026-07-09T11:00:00Z' },
    });

    expect(draft.title).toBe('Design sync');
    expect(draft.description).toContain('At Room 4');
    expect(draft.description).toContain('Source: https://calendar.google.com/event?eid=event-42');
    expect(draft.source).toEqual({
      sourceType: 'calendar',
      sourceId: 'event-42',
      sourceMeta: expect.objectContaining({
        kind: 'calendar',
        eventId: 'event-42',
        summary: 'Design sync',
        location: 'Room 4',
        deepLink: 'https://calendar.google.com/event?eid=event-42',
      }),
    });
  });

  it('uses a generic title and null source id for an empty event', () => {
    const draft = buildCalendarCardDraft({ id: null, start: {}, end: {} });
    expect(draft.title).toBe('Calendar event');
    expect(draft.source.sourceType).toBe('calendar');
    expect(draft.source.sourceId).toBeNull();
    expect(draft.description).toBeUndefined();
  });
});

describe('cardOriginLabel / cardOriginDeepLink — card provenance display', () => {
  it('labels a card promoted from a todo', () => {
    // A todo-promoted card stamps { todoId, userId } — no reopen deep link.
    const card = { source_type: 'todo', source_meta: { todoId: 't1', userId: 'u1' } };
    expect(cardOriginLabel(card)).toBe('From todo');
    expect(cardOriginDeepLink(card)).toBeNull();
  });

  it('never makes a todo-origin card clickable, even with an injected Google deep link', () => {
    // source_type gates the link: a todo (or manual) card has no reopen target,
    // so a smuggled-but-valid Google URL must not turn the badge actionable.
    expect(
      cardOriginDeepLink({
        source_type: 'todo',
        source_meta: { deepLink: 'https://calendar.google.com/event?eid=evil' },
      }),
    ).toBeNull();
    expect(
      cardOriginDeepLink({
        source_type: 'manual',
        source_meta: { deepLink: 'https://mail.google.com/mail/u/0/#all/x' },
      }),
    ).toBeNull();
  });

  it('labels an email-captured card and surfaces its reopen link', () => {
    const card = {
      source_type: 'email',
      source_meta: { kind: 'gmail', deepLink: 'https://mail.google.com/mail/u/0/#all/t1' },
    };
    expect(cardOriginLabel(card)).toBe('From email');
    expect(cardOriginDeepLink(card)).toBe('https://mail.google.com/mail/u/0/#all/t1');
  });

  it('labels a calendar-captured card and surfaces its event link', () => {
    const card = {
      source_type: 'calendar',
      source_meta: { deepLink: 'https://calendar.google.com/event?eid=e1' },
    };
    expect(cardOriginLabel(card)).toBe('From calendar');
    expect(cardOriginDeepLink(card)).toBe('https://calendar.google.com/event?eid=e1');
  });

  it('returns null for a manual card with no capture origin', () => {
    expect(cardOriginLabel({ source_type: 'manual' })).toBeNull();
    expect(cardOriginLabel({})).toBeNull();
    expect(cardOriginDeepLink({ source_type: 'todo', source_meta: null })).toBeNull();
    // A non-string / blank deep link is ignored.
    expect(
      cardOriginDeepLink({ source_type: 'email', source_meta: { deepLink: '  ' } }),
    ).toBeNull();
  });

  it('refuses unsafe / non-Google deep links from an injected provenance payload', () => {
    const unsafe = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'app://open/thing',
      'http://mail.google.com/mail', // non-https is rejected
      'https://evil.com/phish',
      'https://google.com.evil.com/phish', // look-alike host
      'https://notgoogle.com/x',
      42,
      null,
    ];
    for (const deepLink of unsafe) {
      expect(
        cardOriginDeepLink({ source_type: 'email', source_meta: { deepLink } as any }),
        `expected ${String(deepLink)} to be rejected`,
      ).toBeNull();
    }
  });
});
