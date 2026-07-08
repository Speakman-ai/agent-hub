import { describe, it, expect } from 'vitest';
import {
  buildEmailTodoDraft,
  buildCalendarTodoDraft,
  gmailThreadDeepLink,
  todoOriginLabel,
  todoOriginDeepLink,
} from '@shared/utils/captureTodo';

describe('gmailThreadDeepLink', () => {
  it('builds a Gmail permalink for a thread id', () => {
    expect(gmailThreadDeepLink('18f2abc')).toBe('https://mail.google.com/mail/u/0/#all/18f2abc');
  });

  it('returns null for a blank / missing id', () => {
    expect(gmailThreadDeepLink('')).toBeNull();
    expect(gmailThreadDeepLink('   ')).toBeNull();
    expect(gmailThreadDeepLink(null)).toBeNull();
    expect(gmailThreadDeepLink(undefined)).toBeNull();
  });
});

describe('buildEmailTodoDraft', () => {
  it('maps a full Gmail message to a provenance-stamped todo draft', () => {
    const draft = buildEmailTodoDraft({
      threadId: 'thread-1',
      messageId: 'msg-9',
      subject: 'Review the Q3 budget',
      from: 'Alice <alice@example.com>',
      snippet: 'Can you take a look before Friday?',
    });

    expect(draft.title).toBe('Review the Q3 budget');
    expect(draft.notes).toBe('From Alice <alice@example.com>');
    expect(draft.sourceType).toBe('email');
    // Message id is more specific than the thread id, so it wins as sourceId.
    expect(draft.sourceId).toBe('msg-9');
    expect(draft.sourceMeta).toEqual({
      kind: 'gmail',
      threadId: 'thread-1',
      messageId: 'msg-9',
      subject: 'Review the Q3 budget',
      from: 'Alice <alice@example.com>',
      snippet: 'Can you take a look before Friday?',
      deepLink: 'https://mail.google.com/mail/u/0/#all/thread-1',
    });
  });

  it('falls back to the snippet then a generic title, and to the thread id', () => {
    const fromSnippet = buildEmailTodoDraft({
      threadId: 'thread-2',
      snippet: 'Lunch tomorrow?',
    });
    expect(fromSnippet.title).toBe('Lunch tomorrow?');
    expect(fromSnippet.sourceId).toBe('thread-2');
    expect(fromSnippet.notes).toBeUndefined();

    const empty = buildEmailTodoDraft({});
    expect(empty.title).toBe('Email');
    expect(empty.sourceId).toBeNull();
    expect(empty.sourceMeta).toEqual({ kind: 'gmail' });
  });

  it('ellipsizes an over-long subject and collapses whitespace', () => {
    const long = 'word '.repeat(60); // 300 chars
    const draft = buildEmailTodoDraft({ threadId: 't', subject: long });
    expect(draft.title.length).toBe(140);
    expect(draft.title.endsWith('…')).toBe(true);
    expect(draft.title).not.toContain('  ');
  });
});

describe('buildCalendarTodoDraft', () => {
  it('maps a timed event to a provenance-stamped todo draft', () => {
    const draft = buildCalendarTodoDraft({
      id: 'evt-1',
      summary: 'Design sync',
      location: 'Room 4',
      htmlLink: 'https://calendar.google.com/event?eid=evt-1',
      start: { dateTime: '2026-07-09T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-07-09T11:00:00-07:00' },
    });

    expect(draft.title).toBe('Design sync');
    expect(draft.notes).toBe('At Room 4');
    expect(draft.sourceType).toBe('calendar');
    expect(draft.sourceId).toBe('evt-1');
    expect(draft.sourceMeta).toEqual({
      kind: 'calendar',
      eventId: 'evt-1',
      summary: 'Design sync',
      location: 'Room 4',
      start: '2026-07-09T10:00:00-07:00',
      end: '2026-07-09T11:00:00-07:00',
      deepLink: 'https://calendar.google.com/event?eid=evt-1',
    });
  });

  it('uses the all-day date boundary and a generic title fallback', () => {
    const draft = buildCalendarTodoDraft({
      id: 'evt-2',
      start: { date: '2026-07-10' },
      end: { date: '2026-07-11' },
    });
    expect(draft.title).toBe('Calendar event');
    expect(draft.notes).toBeUndefined();
    expect(draft.sourceMeta.start).toBe('2026-07-10');
    expect(draft.sourceMeta.end).toBe('2026-07-11');
    expect(draft.sourceMeta.deepLink).toBeUndefined();
  });
});

describe('todo origin display helpers', () => {
  it('labels captured todos and reads their reopen link', () => {
    const email = {
      sourceType: 'email',
      sourceMeta: { deepLink: 'https://mail.google.com/mail/u/0/#all/t' },
    };
    expect(todoOriginLabel(email)).toBe('From email');
    expect(todoOriginDeepLink(email)).toBe('https://mail.google.com/mail/u/0/#all/t');

    expect(todoOriginLabel({ sourceType: 'calendar', sourceMeta: null })).toBe('From calendar');
    expect(todoOriginDeepLink({ sourceType: 'calendar', sourceMeta: null })).toBeNull();
  });

  it('returns null for manual / unknown origins', () => {
    expect(todoOriginLabel({ sourceType: 'manual', sourceMeta: null })).toBeNull();
    expect(todoOriginLabel({})).toBeNull();
    expect(todoOriginDeepLink({ sourceType: 'email', sourceMeta: { deepLink: '  ' } })).toBeNull();
  });
});
