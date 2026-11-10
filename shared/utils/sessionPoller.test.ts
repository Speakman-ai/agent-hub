import { describe, expect, it } from 'vitest';
import {
  expectedPollerRuns,
  extractPollerBlocks,
  formatPollerMinutes,
  parsePollerEnvelope,
  parsePollerUntil,
  parsePollerAnchor,
  planPollerSchedule,
  pollerStartDurationMinutes,
  shouldReconcilePoller,
  type SessionPoller,
} from './sessionPoller';

const fence = (body: string) => '```agenthub:poller\n' + body + '\n```';

describe('extractPollerBlocks', () => {
  it('pulls a poller block out of prose and keeps the rest', () => {
    const text = `Setting that up.\n\n${fence(
      JSON.stringify({
        pollerId: 'dev-tickets',
        task: 'Check dev for new tickets',
        intervalMinutes: 30,
        durationMinutes: 120,
        notifyEachRun: true,
      }),
    )}\n\nClick Start when ready.`;
    const { strippedText, pollers } = extractPollerBlocks(text);
    expect(strippedText).toBe('Setting that up.\n\nClick Start when ready.');
    expect(pollers).toEqual([
      {
        pollerId: 'dev-tickets',
        task: 'Check dev for new tickets',
        intervalMinutes: 30,
        durationMinutes: 120,
        until: null,
        notifyEachRun: true,
        notifyOnComplete: true,
      },
    ]);
  });

  it('leaves malformed blocks in place', () => {
    const text = fence('{not json');
    expect(extractPollerBlocks(text)).toEqual({ strippedText: text, pollers: [] });
    expect(extractPollerBlocks(fence('{"intervalMinutes":5}')).pollers).toEqual([]);
  });
});

describe('parsePollerEnvelope', () => {
  it('drops out-of-range minutes so the card asks instead', () => {
    const p = parsePollerEnvelope(
      JSON.stringify({ task: 't', intervalMinutes: 0, durationMinutes: -5 }),
    );
    expect(p?.intervalMinutes).toBeNull();
    expect(p?.durationMinutes).toBeNull();
  });

  it('accepts numeric strings and mints an id when missing', () => {
    const p = parsePollerEnvelope(JSON.stringify({ task: 't', intervalMinutes: '15' }));
    expect(p?.intervalMinutes).toBe(15);
    expect(p?.pollerId).toMatch(/^poller-/);
    expect(p?.notifyOnComplete).toBe(true);
    expect(p?.notifyEachRun).toBe(false);
  });

  it('ignores an until it cannot read', () => {
    expect(parsePollerEnvelope(JSON.stringify({ task: 't', until: 'soonish' }))?.until).toBeNull();
  });
});

describe('parsePollerUntil', () => {
  // 2026-11-10 14:20 local time.
  const now = new Date(2026, 10, 10, 14, 20);

  it('resolves "tomorrow 09:00" to 9am the next local day', () => {
    expect(parsePollerUntil('tomorrow 09:00', now)).toEqual(new Date(2026, 10, 11, 9, 0));
    expect(parsePollerUntil('tomorrow at 9am', now)).toEqual(new Date(2026, 10, 11, 9, 0));
  });

  it('reads a bare time as its next occurrence', () => {
    expect(parsePollerUntil('17:00', now)).toEqual(new Date(2026, 10, 10, 17, 0));
    expect(parsePollerUntil('09:00', now)).toEqual(new Date(2026, 10, 11, 9, 0));
    expect(parsePollerUntil('today 6pm', now)).toEqual(new Date(2026, 10, 10, 18, 0));
    expect(parsePollerUntil('12am', now)).toEqual(new Date(2026, 10, 11, 0, 0));
  });

  it('reads offset-less ISO as local time and offset ISO as absolute', () => {
    expect(parsePollerUntil('2026-11-11T09:00', now)).toEqual(new Date(2026, 10, 11, 9, 0));
    expect(parsePollerUntil('2026-11-11T09:00:00Z', now)?.toISOString()).toBe(
      '2026-11-11T09:00:00.000Z',
    );
  });

  it('rejects ambiguous or invalid values', () => {
    expect(parsePollerUntil('9', now)).toBeNull();
    expect(parsePollerUntil('25:00', now)).toBeNull();
    expect(parsePollerUntil('13pm', now)).toBeNull();
    expect(parsePollerUntil('next week', now)).toBeNull();
  });
});

describe('planPollerSchedule', () => {
  // Proposed Tuesday 14:20 local.
  const anchor = new Date(2026, 10, 10, 14, 20);
  const base = {
    pollerId: 'p',
    task: 't',
    intervalMinutes: 30,
    durationMinutes: 60,
    until: null,
    notifyEachRun: false,
    notifyOnComplete: true,
  };
  const tomorrow9 = { ...base, durationMinutes: null, until: 'tomorrow 09:00' };

  it('uses until over a stated duration', () => {
    const plan = planPollerSchedule(tomorrow9, { anchor, now: anchor });
    expect(plan.deadline).toEqual(new Date(2026, 10, 11, 9, 0));
    expect(plan.initialDurationMinutes).toBe(1120);
    expect(plan.deadlinePassed).toBe(false);
  });

  it('keeps "tomorrow" relative to the proposal when reopened after midnight', () => {
    // Reopened Wednesday 01:00: still Wednesday 09:00, not Thursday.
    const plan = planPollerSchedule(tomorrow9, {
      anchor,
      now: new Date(2026, 10, 11, 1, 0),
    });
    expect(plan.deadline).toEqual(new Date(2026, 10, 11, 9, 0));
    expect(plan.initialDurationMinutes).toBe(480);
  });

  it('reports a deadline already past on reopen instead of rolling it forward', () => {
    for (const until of ['tomorrow 09:00', '09:00']) {
      const plan = planPollerSchedule(
        { ...tomorrow9, until },
        { anchor, now: new Date(2026, 10, 11, 10, 0) },
      );
      expect(plan.deadline).toEqual(new Date(2026, 10, 11, 9, 0));
      expect(plan.deadlinePassed).toBe(true);
      expect(plan.initialDurationMinutes).toBeNull();
    }
  });

  it('falls back to durationMinutes without until', () => {
    expect(planPollerSchedule(base, { anchor, now: anchor })).toEqual({
      deadline: null,
      deadlinePassed: false,
      initialDurationMinutes: 60,
    });
  });
});

describe('parsePollerAnchor', () => {
  it('reads SQLite timestamps as UTC', () => {
    expect(parsePollerAnchor('2026-11-10 22:10:45')?.toISOString()).toBe(
      '2026-11-10T22:10:45.000Z',
    );
    expect(parsePollerAnchor('2026-11-10T22:10:45.123Z')?.toISOString()).toBe(
      '2026-11-10T22:10:45.123Z',
    );
  });

  it('returns null for missing or invalid values', () => {
    expect(parsePollerAnchor(undefined)).toBeNull();
    expect(parsePollerAnchor('')).toBeNull();
    expect(parsePollerAnchor('not a date')).toBeNull();
  });
});

describe('shouldReconcilePoller', () => {
  it('keeps reconciling until the poller is finished', () => {
    const poller = { status: 'active' } as SessionPoller;
    expect(shouldReconcilePoller(null)).toBe(true);
    expect(shouldReconcilePoller(poller)).toBe(true);
    expect(shouldReconcilePoller({ ...poller, status: 'completed' })).toBe(false);
    expect(shouldReconcilePoller({ ...poller, status: 'cancelled' })).toBe(false);
  });
});

describe('helpers', () => {
  it('counts expected runs including the immediate one', () => {
    expect(expectedPollerRuns(30, 60)).toBe(2);
    expect(expectedPollerRuns(30, 45)).toBe(2);
    expect(expectedPollerRuns(30, 1120)).toBe(38);
  });

  it('formats minutes compactly', () => {
    expect(formatPollerMinutes(30)).toBe('30 min');
    expect(formatPollerMinutes(90)).toBe('1h 30m');
    expect(formatPollerMinutes(1440)).toBe('1d');
    expect(formatPollerMinutes(1500)).toBe('1d 1h');
  });
});

describe('pollerStartDurationMinutes', () => {
  const mounted = new Date(2026, 10, 10, 14, 20);
  const proposal = {
    pollerId: 'p',
    task: 't',
    intervalMinutes: 30,
    durationMinutes: null,
    until: 'tomorrow 09:00',
    notifyEachRun: false,
    notifyOnComplete: true,
  };
  const { deadline } = planPollerSchedule(proposal, { anchor: mounted, now: mounted });

  it('recomputes the minutes left to the named deadline at Start', () => {
    expect(deadline).toEqual(new Date(2026, 10, 11, 9, 0));
    const later = new Date(2026, 10, 10, 15, 20);
    expect(
      pollerStartDurationMinutes({
        deadline,
        durationEdited: false,
        formMinutes: 1120,
        now: later,
      }),
    ).toBe(1060);
  });

  it('uses the typed duration once edited, or when there is no deadline', () => {
    const later = new Date(2026, 10, 10, 15, 20);
    expect(
      pollerStartDurationMinutes({ deadline, durationEdited: true, formMinutes: 90, now: later }),
    ).toBe(90);
    expect(
      pollerStartDurationMinutes({
        deadline: null,
        durationEdited: false,
        formMinutes: 45,
        now: later,
      }),
    ).toBe(45);
  });

  it('returns null once the deadline has passed', () => {
    expect(
      pollerStartDurationMinutes({
        deadline,
        durationEdited: false,
        formMinutes: 1120,
        now: new Date(2026, 10, 11, 9, 1),
      }),
    ).toBeNull();
  });
});
