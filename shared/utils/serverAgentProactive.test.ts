import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROACTIVE_PREFS,
  applyOfferUpdate,
  isWithinQuietHours,
  quietHoursEnd,
  normalizeProactivePrefs,
  sortOpenOffers,
  type ProactiveOffer,
} from './serverAgentProactive';

function offer(id: string, over: Partial<ProactiveOffer> = {}): ProactiveOffer {
  return {
    id,
    kind: 'stale_card',
    area: 'dev',
    title: id,
    reason: '',
    action: '',
    urgency: 'normal',
    status: 'open',
    source: 'scheduled',
    target: {},
    createdAt: '2026-11-27T10:00:00Z',
    updatedAt: '2026-11-27T10:00:00Z',
    expiresAt: null,
    snoozedUntil: null,
    actedAt: null,
    actionSessionId: null,
    revision: 1,
    ...over,
  };
}

describe('normalizeProactivePrefs', () => {
  it('defaults to off with a 3h interval and 5 offers a day', () => {
    expect(normalizeProactivePrefs(undefined)).toEqual(DEFAULT_PROACTIVE_PREFS);
    expect(DEFAULT_PROACTIVE_PREFS).toMatchObject({
      enabled: false,
      intervalHours: 3,
      maxOffersPerDay: 5,
    });
  });

  it('rejects out-of-range values field by field', () => {
    const p = normalizeProactivePrefs({
      enabled: true,
      intervalHours: 5,
      timeZone: 'Nope/Zone',
      quietHours: { start: '25:00', end: '07:30' },
      areas: { google: false, bogus: true },
      maxOffersPerDay: 999,
    });
    expect(p).toMatchObject({
      enabled: true,
      intervalHours: 3,
      timeZone: 'UTC',
      quietHours: { start: '22:00', end: '07:30' },
      areas: { dev: true, google: false },
      maxOffersPerDay: 20,
    });
  });
});

describe('isWithinQuietHours', () => {
  it('handles a same-day window and treats equal bounds as off', () => {
    const p = normalizeProactivePrefs({
      quietHours: { enabled: true, start: '12:00', end: '13:00' },
    });
    expect(isWithinQuietHours(p, new Date('2026-11-27T12:30:00Z'))).toBe(true);
    expect(isWithinQuietHours(p, new Date('2026-11-27T13:00:00Z'))).toBe(false);
    const same = normalizeProactivePrefs({
      quietHours: { enabled: true, start: '12:00', end: '12:00' },
    });
    expect(isWithinQuietHours(same, new Date('2026-11-27T12:30:00Z'))).toBe(false);
  });
});

describe('offer list helpers', () => {
  it('sorts by urgency then newest', () => {
    const list = sortOpenOffers([
      offer('a', { urgency: 'low' }),
      offer('b', { urgency: 'urgent' }),
      offer('c', { createdAt: '2026-11-27T11:00:00Z' }),
      offer('d'),
    ]);
    expect(list.map((o) => o.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('adds open offers and drops acted-on ones', () => {
    const added = applyOfferUpdate([offer('a')], { offer: offer('b', { urgency: 'high' }) });
    expect(added.map((o) => o.id)).toEqual(['b', 'a']);
    const removed = applyOfferUpdate(added, { offer: offer('b', { status: 'accepted' }) });
    expect(removed.map((o) => o.id)).toEqual(['a']);
    expect(applyOfferUpdate(removed, null).map((o) => o.id)).toEqual(['a']);
  });
});

describe('quietHoursEnd', () => {
  it('returns the end of a window that wraps midnight, in the user time zone', () => {
    const p = normalizeProactivePrefs({
      timeZone: 'America/New_York',
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
    });
    // 23:30 New York (EST = UTC-5) → ends 08:00 New York = 13:00 UTC.
    expect(quietHoursEnd(p, new Date('2026-11-28T04:30:00Z')).toISOString()).toBe(
      '2026-11-28T13:00:00.000Z',
    );
  });

  it('is now when outside quiet hours', () => {
    const p = normalizeProactivePrefs({
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
    });
    const now = new Date('2026-11-27T12:00:00Z');
    expect(quietHoursEnd(p, now)).toEqual(now);
  });
});
