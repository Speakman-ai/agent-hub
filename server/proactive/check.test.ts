/**
 * Server Agent proactive checks: snapshot hashing, dedupe / snooze / never,
 * quiet hours, the daily cap and the event-driven single-item path. The model
 * is always the injected `classify` stub: no CLI is spawned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { AppConfig, Stmts } from '../types.js';
import {
  DEFAULT_PROACTIVE_PREFS,
  normalizeProactivePrefs,
  isWithinQuietHours,
  type ServerAgentProactivePrefs,
} from '../../shared/utils/serverAgentProactive.js';
import type { ProactiveFact } from './facts.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { initDb, getStmts } = await import('../db.js');
const { mutateUserPreferencesJson, listUsersWithProactiveEnabled } =
  await import('../user-preferences-store.js');
const check = await import('./check.js');
const store = await import('./offers-store.js');
const events = await import('./events.js');
const { createTodo } = await import('../user-todos-store.js');
const extraFacts = await import('./facts-extra.js');

let userId = '';

function fact(id: string, extra: Partial<ProactiveFact> = {}): ProactiveFact {
  return {
    id: `finalize_failed:${id}`,
    kind: 'finalize_failed',
    fingerprint: '',
    summary: `Finalize failed on ${id}`,
    target: { sessionId: id },
    ...extra,
  };
}

function prefs(over: Partial<ServerAgentProactivePrefs> = {}): ServerAgentProactivePrefs {
  return normalizeProactivePrefs({
    ...DEFAULT_PROACTIVE_PREFS,
    enabled: true,
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    ...over,
  });
}

function deps(
  facts: () => ProactiveFact[],
  classify = vi.fn(async (_u: string, fs: ProactiveFact[]) =>
    fs.map((_, i) => ({
      fact: `f${i + 1}`,
      title: `Fix ${i + 1}`,
      reason: 'it broke',
      action: 'look at the logs',
      urgency: 'normal' as const,
    })),
  ),
  now = new Date('2026-11-27T12:00:00Z'),
) {
  const broadcast = vi.fn();
  return {
    classify,
    broadcast,
    deps: {
      config: {} as AppConfig,
      stmts: getStmts() as Stmts,
      broadcast,
      getProjects: () => [],
      collectors: { dev: () => facts() },
      classify,
      now: () => now,
    },
  };
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proactive-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userId = createUser({
    username: `pro-${Math.random().toString(36).slice(2)}`,
    passwordHash: 'x',
  }).id;
  events.resetProactiveEventsForTests();
});

describe('parseProactiveOutput', () => {
  it('keeps only handles we sent, once each, and clamps urgency', () => {
    const out = check.parseProactiveOutput(
      'Sure:\n```json\n{"offers":[{"fact":"f1","title":"A","urgency":"nope"},{"fact":"f1","title":"dup"},{"fact":"f9","title":"bad"},{"fact":"f2","title":""}]}\n```',
      new Set(['f1', 'f2']),
    );
    expect(out).toEqual([{ fact: 'f1', title: 'A', reason: '', action: '', urgency: 'normal' }]);
  });

  it('throws on non-JSON output', () => {
    expect(() => check.parseProactiveOutput('no thanks', new Set(['f1']))).toThrow();
  });
});

describe('skipping the model for already-decided facts', () => {
  it('classifies a declined fact again once its fingerprint changes', async () => {
    let facts = [fact('a', { fingerprint: 'v1' })];
    const t = deps(
      () => facts,
      vi.fn(async () => []),
    );
    await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(
      (await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' })).status,
    ).toBe('unchanged');
    facts = [fact('a', { fingerprint: 'v2' })];
    await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(t.classify).toHaveBeenCalledTimes(2);
  });

  it('skips the model when the eligible snapshot is unchanged', async () => {
    let facts = [fact('a')];
    const t = deps(
      () => facts,
      vi.fn(async () => []),
    );
    const first = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(first.status).toBe('ok');
    expect(t.classify).toHaveBeenCalledTimes(1);

    const second = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(second.status).toBe('unchanged');
    expect(t.classify).toHaveBeenCalledTimes(1);

    facts = [fact('a'), fact('b')];
    const third = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(third.status).toBe('ok');
    expect(t.classify).toHaveBeenCalledTimes(2);
  });

  it('never calls the model for an empty snapshot', async () => {
    const t = deps(() => []);
    const res = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(res.status).toBe('empty');
    expect(t.classify).not.toHaveBeenCalled();
  });

  it('skips disabled areas', async () => {
    const t = deps(() => [fact('a')]);
    const p = prefs({ areas: { dev: false, google: true, infra: true, todos: true } });
    const res = await check.runProactiveCheck(userId, p, t.deps, { source: 'scheduled' });
    expect(res.status).toBe('empty');
    expect(t.classify).not.toHaveBeenCalled();
  });
});

describe('offers: dedupe, snooze, never', () => {
  it('persists offers with kind and target from the fact and broadcasts them owner-scoped', async () => {
    const t = deps(() => [fact('a')]);
    const res = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(res.offers).toHaveLength(1);
    const [offer] = store.listOffers(userId);
    expect(offer.kind).toBe('finalize_failed');
    expect(offer.target).toEqual({ sessionId: 'a' });
    expect(offer.dedupeKey).toBe('finalize_failed:a');
    expect(t.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'server_agent_offer_update',
        ownerUserId: userId,
        action: 'created',
        push: true,
      }),
    );
  });

  it('does not re-offer an open key, re-offers after a snooze ends', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const t = deps(() => [fact('a')], undefined, now);
    await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    const again = await check.runProactiveCheck(userId, prefs(), t.deps, {
      source: 'scheduled',
      force: true,
    });
    expect(again.status).toBe('empty');

    const [offer] = store.listOffers(userId);
    store.transitionOffer(userId, offer.id, 'dismissed', now, {
      snoozedUntil: new Date(now.getTime() + store.PROACTIVE_SNOOZE_MS).toISOString(),
    });
    const snoozed = await check.runProactiveCheck(userId, prefs(), t.deps, {
      source: 'scheduled',
      force: true,
    });
    expect(snoozed.status).toBe('empty');

    const later = new Date(now.getTime() + store.PROACTIVE_SNOOZE_MS + 60_000);
    const t2 = deps(() => [fact('a')], undefined, later);
    const back = await check.runProactiveCheck(userId, prefs(), t2.deps, { source: 'scheduled' });
    expect(back.offers).toHaveLength(1);
  });

  it('"never" suppresses the kind and retires open offers of it', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const t = deps(() => [fact('a'), fact('b')], undefined, now);
    await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(store.listOffers(userId)).toHaveLength(2);

    const { retired } = store.addSuppression(userId, 'finalize_failed', now);
    expect(retired).toHaveLength(2);
    expect(store.listOffers(userId)).toHaveLength(0);

    const t2 = deps(() => [fact('c')], undefined, now);
    const res = await check.runProactiveCheck(userId, prefs(), t2.deps, { source: 'scheduled' });
    expect(res.status).toBe('empty');
    expect(t2.classify).not.toHaveBeenCalled();

    expect(store.removeSuppression(userId, 'finalize_failed')).toBe(true);
    const res2 = await check.runProactiveCheck(userId, prefs(), t2.deps, { source: 'scheduled' });
    expect(res2.offers).toHaveLength(1);
  });

  it('offers the same original subject again once its "Never" rule is removed', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const t = deps(() => [fact('a')], undefined, now);
    const first = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(first.offers).toHaveLength(1);
    store.addSuppression(userId, 'finalize_failed', now);
    expect(store.getOffer(userId, first.offers[0].id)?.status).toBe('suppressed');
    expect(store.blockedDedupeKeys(userId, now).has('finalize_failed:a')).toBe(true);

    expect(store.removeSuppression(userId, 'finalize_failed')).toBe(true);
    expect(store.blockedDedupeKeys(userId, now).has('finalize_failed:a')).toBe(false);
    const again = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(again.offers.map((o) => o.dedupeKey)).toEqual(['finalize_failed:a']);
  });

  it('holds an accepted subject for the accept cooldown, not forever', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const t = deps(() => [fact('a')], undefined, now);
    const [offer] = (
      await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' })
    ).offers;
    store.transitionOffer(userId, offer.id, 'accepted', now);
    const soon = new Date(now.getTime() + store.PROACTIVE_ACCEPTED_COOLDOWN_MS - 60_000);
    expect(store.blockedDedupeKeys(userId, soon).has('finalize_failed:a')).toBe(true);
    const later = new Date(now.getTime() + store.PROACTIVE_ACCEPTED_COOLDOWN_MS + 60_000);
    expect(store.blockedDedupeKeys(userId, later).has('finalize_failed:a')).toBe(false);
  });

  it('expires ignored offers after 24h and holds the key during the cooldown', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const t = deps(() => [fact('a')], undefined, now);
    await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    const later = new Date(now.getTime() + store.PROACTIVE_EXPIRE_MS + 1000);
    const expired = store.expireOffers(later);
    expect(expired.map((o) => o.status)).toEqual(['expired']);
    expect(store.blockedDedupeKeys(userId, later).has('finalize_failed:a')).toBe(true);
    const muchLater = new Date(later.getTime() + store.PROACTIVE_EXPIRED_COOLDOWN_MS + 1000);
    expect(store.blockedDedupeKeys(userId, muchLater).has('finalize_failed:a')).toBe(false);
  });
});

describe('quiet hours and the daily cap', () => {
  it('quiet hours wrap midnight in the user time zone', () => {
    const p = prefs({
      timeZone: 'America/New_York',
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
    });
    // 03:00 UTC = 22:00 New York (EST)
    expect(isWithinQuietHours(p, new Date('2026-11-27T03:00:00Z'))).toBe(true);
    expect(isWithinQuietHours(p, new Date('2026-11-27T12:59:00Z'))).toBe(true);
    expect(isWithinQuietHours(p, new Date('2026-11-27T13:00:00Z'))).toBe(false);
  });

  it('holds non-urgent facts during quiet hours but lets urgent ones through', async () => {
    const quiet = prefs({ quietHours: { enabled: true, start: '00:00', end: '23:59' } });
    const now = new Date('2026-11-27T12:00:00Z');
    const t = deps(() => [fact('a')], undefined, now);
    const held = await check.runProactiveCheck(userId, quiet, t.deps, { source: 'scheduled' });
    expect(held.status).toBe('quiet');
    expect(t.classify).not.toHaveBeenCalled();

    const t2 = deps(() => [fact('b', { urgent: true })], undefined, now);
    const urgent = await check.runProactiveCheck(userId, quiet, t2.deps, { source: 'scheduled' });
    expect(urgent.offers).toHaveLength(1);
    expect(urgent.offers[0].urgency).toBe('urgent');
  });

  it('caps offers per day and stops calling the model once the cap is hit', async () => {
    const p = prefs({ maxOffersPerDay: 2 });
    const t = deps(() => [fact('a'), fact('b'), fact('c')]);
    const res = await check.runProactiveCheck(userId, p, t.deps, { source: 'scheduled' });
    expect(res.offers).toHaveLength(2);
    const t2 = deps(() => [fact('d')]);
    const capped = await check.runProactiveCheck(userId, p, t2.deps, { source: 'scheduled' });
    expect(capped.status).toBe('capped');
    expect(t2.classify).not.toHaveBeenCalled();
  });
});

describe('scheduled tick', () => {
  it('runs only opted-in users whose interval has elapsed', async () => {
    mutateUserPreferencesJson(userId, (c) => ({
      ...c,
      serverAgent: { proactive: prefs({ intervalHours: 3 }) },
    }));
    expect(listUsersWithProactiveEnabled().map((u) => u.userId)).toContain(userId);
    const now = new Date('2026-11-27T12:00:00Z');
    const t = deps(
      () => [fact('a')],
      vi.fn(async () => []),
      now,
    );
    await check.runProactiveTick(now, t.deps);
    expect(t.classify).toHaveBeenCalledTimes(1);

    const t2 = deps(
      () => [fact('z')],
      vi.fn(async () => []),
      new Date(now.getTime() + 60 * 60_000),
    );
    await check.runProactiveTick(new Date(now.getTime() + 60 * 60_000), t2.deps);
    expect(t2.classify).not.toHaveBeenCalled();

    const due = new Date(now.getTime() + 3 * 60 * 60_000);
    const t3 = deps(
      () => [fact('z')],
      vi.fn(async () => []),
      due,
    );
    await check.runProactiveTick(due, t3.deps);
    expect(t3.classify).toHaveBeenCalledTimes(1);
  });

  it('isProactiveCheckDue respects enabled and interval', () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const st = (
      lastCheckAt: string | null,
      deferredReasons: Array<'quiet' | 'cap' | 'error'> = [],
      deferredAt: string | null = null,
    ) => ({ lastCheckAt, deferredReasons, deferredAt });
    expect(check.isProactiveCheckDue(prefs({ enabled: false }), st(null), now)).toBe(false);
    expect(check.isProactiveCheckDue(prefs(), st(null), now)).toBe(true);
    expect(check.isProactiveCheckDue(prefs(), st('2026-11-27T10:00:00Z'), now)).toBe(false);
    expect(check.isProactiveCheckDue(prefs(), st('2026-11-27T09:00:00Z'), now)).toBe(true);

    // Deferral reasons are judged against the settings passed in now.
    const quietNoon = prefs({ quietHours: { enabled: true, start: '11:00', end: '13:00' } });
    expect(check.isProactiveCheckDue(quietNoon, st('2026-11-27T11:59:00Z', ['quiet']), now)).toBe(
      false,
    );
    expect(check.isProactiveCheckDue(prefs(), st('2026-11-27T11:59:00Z', ['quiet']), now)).toBe(
      true,
    );
    const full = { offersInCapWindow: () => 3 };
    expect(
      check.isProactiveCheckDue(prefs({ maxOffersPerDay: 3 }), st(null, ['cap']), now, full),
    ).toBe(false);
    expect(
      check.isProactiveCheckDue(prefs({ maxOffersPerDay: 5 }), st(null, ['cap']), now, full),
    ).toBe(true);
    expect(
      check.isProactiveCheckDue(prefs(), st(null, ['error'], '2026-11-27T11:50:00Z'), now),
    ).toBe(false);
    expect(
      check.isProactiveCheckDue(prefs(), st(null, ['error'], '2026-11-27T11:00:00Z'), now),
    ).toBe(true);
    // Both reasons must clear.
    expect(
      check.isProactiveCheckDue(quietNoon, st(null, ['quiet', 'cap']), now, {
        offersInCapWindow: () => 0,
      }),
    ).toBe(false);
  });
});

describe('event-driven checks', () => {
  it('maps a failed Finalize broadcast to a single-item check for the session owner', async () => {
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: prefs() } }));
    const triggers = events.mapBroadcastToProactiveTriggers({
      type: 'finalize_run_completed',
      status: 'failed',
      sessionId: 's1',
      ownerUserId: userId,
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].userId).toBe(userId);

    const t = deps(() => [fact('s1'), fact('s2')]);
    const res = await events.runProactiveTrigger(triggers[0], t.deps);
    expect(res?.status).toBe('ok');
    expect(t.classify).toHaveBeenCalledTimes(1);
    const sent = t.classify.mock.calls[0][1] as ProactiveFact[];
    expect(sent.map((f) => f.id)).toEqual(['finalize_failed:s1']);
    expect(store.listOffers(userId)[0].source).toBe('event');
    // Event checks do not move the scheduled check clock.
    expect(store.getProactiveState(userId).lastCheckAt).toBeNull();
  });

  it('ignores passing Finalize runs and users who have not opted in', async () => {
    expect(
      events.mapBroadcastToProactiveTriggers({
        type: 'finalize_run_completed',
        status: 'passed',
        sessionId: 's1',
        ownerUserId: userId,
      }),
    ).toEqual([]);
    const [trigger] = events.mapBroadcastToProactiveTriggers({
      type: 'finalize_run_completed',
      status: 'failed',
      sessionId: 's1',
      ownerUserId: userId,
    });
    const t = deps(() => [fact('s1')]);
    expect(await events.runProactiveTrigger(trigger, t.deps)).toBeNull();
    expect(t.classify).not.toHaveBeenCalled();
  });

  it('debounces a burst of broadcasts into one check', async () => {
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: prefs() } }));
    const needs: ProactiveFact = {
      id: 'session_needs_input:s1:question',
      kind: 'session_needs_input',
      fingerprint: '',
      summary: 'Session waiting',
      target: { sessionId: 's1' },
    };
    const t = deps(() => [needs, fact('s1')]);
    const data = {
      type: 'session_needs_input',
      sessionId: 's1',
      ownerUserId: userId,
      needsInput: 'question',
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      events.noteBroadcastForProactive(data, t.deps, 100);
      events.noteBroadcastForProactive(data, t.deps, 100);
      vi.advanceTimersByTime(150);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(t.classify).toHaveBeenCalledTimes(1));
    const sent = t.classify.mock.calls[0][1] as ProactiveFact[];
    expect(sent.map((f) => f.kind)).toEqual(['session_needs_input']);
  });
});

describe('revalidation after the model call', () => {
  function deferred() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
  }

  it('drops offers whose kind was suppressed while the model was running', async () => {
    const d = deferred();
    let started = false;
    const classify = vi.fn(async (_u: string, fs: ProactiveFact[]) => {
      started = true;
      await d.gate;
      return fs.map((_, i) => ({
        fact: `f${i + 1}`,
        title: 'Fix',
        reason: '',
        action: '',
        urgency: 'normal' as const,
      }));
    });
    const t = deps(() => [fact('a')], classify);
    const run = check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    await vi.waitFor(() => expect(started).toBe(true));
    store.addSuppression(userId, 'finalize_failed', new Date());
    d.release();
    const res = await run;
    expect(res.offers).toEqual([]);
    expect(store.listOffers(userId, { status: 'all' })).toEqual([]);
    expect(t.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'created' }));
  });

  it('drops offers when proactive mode or the area is switched off mid-run', async () => {
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: prefs() } }));
    const d = deferred();
    let started = false;
    const classify = vi.fn(async (_u: string, fs: ProactiveFact[]) => {
      started = true;
      await d.gate;
      return fs.map((_, i) => ({
        fact: `f${i + 1}`,
        title: 'Fix',
        reason: '',
        action: '',
        urgency: 'normal' as const,
      }));
    });
    const t = deps(() => [fact('a')], classify);
    const run = check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    await vi.waitFor(() => expect(started).toBe(true));
    mutateUserPreferencesJson(userId, (c) => ({
      ...c,
      serverAgent: {
        proactive: prefs({ areas: { dev: false, google: true, infra: true, todos: true } }),
      },
    }));
    d.release();
    expect((await run).offers).toEqual([]);
    // The model picked it, so it was never declined: back on, it is shown again.
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: prefs() } }));
    const again = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(again.offers).toHaveLength(1);
  });
});

describe('large snapshots', () => {
  it('shows every eligible fact to the model in batches, then skips them all', async () => {
    const many = Array.from({ length: check.MAX_FACTS_PER_PROMPT + 5 }, (_, i) => fact(`s${i}`));
    const classify = vi.fn(async () => []);
    const t = deps(() => many, classify);
    const res = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(res.status).toBe('ok');
    expect(classify).toHaveBeenCalledTimes(2);
    const seen = classify.mock.calls
      .flatMap((c) => (c as unknown[])[1] as ProactiveFact[])
      .map((f) => f.id);
    expect(new Set(seen).size).toBe(many.length);
    const again = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(again.status).toBe('unchanged');
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('shows the facts a capped run never reached on the next pass', async () => {
    const many = Array.from({ length: check.MAX_FACTS_PER_PROMPT + 5 }, (_, i) => fact(`s${i}`));
    const t = deps(() => many);
    const res = await check.runProactiveCheck(userId, prefs({ maxOffersPerDay: 2 }), t.deps, {
      source: 'scheduled',
    });
    expect(res.offers).toHaveLength(2);
    expect(t.classify).toHaveBeenCalledTimes(1);
    // A day later the cap has room again; the unreached batch is classified.
    const later = new Date('2026-11-28T12:30:00Z');
    const t2 = deps(
      () => many,
      vi.fn(async () => []),
      later,
    );
    await check.runProactiveCheck(userId, prefs({ maxOffersPerDay: 2 }), t2.deps, {
      source: 'scheduled',
    });
    const sent = t2.classify.mock.calls.flatMap((c) => (c as unknown[])[1] as ProactiveFact[]);
    expect(sent.map((f) => f.id)).toContain(`finalize_failed:s${check.MAX_FACTS_PER_PROMPT + 4}`);
  });
});

describe('snooze lifecycle with no check in between', () => {
  it('offers a snoozed fact again at the first check after the snooze ends', async () => {
    const day = 24;
    const p = prefs({ intervalHours: day });
    const t0 = new Date('2026-11-27T12:00:00Z');
    const t = deps(() => [fact('a')], undefined, t0);
    const first = await check.runProactiveCheck(userId, p, t.deps, { source: 'scheduled' });
    expect(first.offers).toHaveLength(1);
    // Snoozed for 1h; the next scheduled check is a day later.
    store.transitionOffer(userId, first.offers[0].id, 'dismissed', t0, {
      snoozedUntil: new Date(t0.getTime() + 60 * 60_000).toISOString(),
    });
    const t1 = new Date(t0.getTime() + day * 60 * 60_000);
    const t2 = deps(() => [fact('a')], undefined, t1);
    const next = await check.runProactiveCheck(userId, p, t2.deps, { source: 'scheduled' });
    expect(t2.classify).toHaveBeenCalledTimes(1);
    expect(next.offers).toHaveLength(1);
  });
});

describe('live clock after the model call', () => {
  it('holds a non-urgent offer when quiet hours start while the model runs', async () => {
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: quietAt22() } }));
    let clock = new Date('2026-11-27T21:59:00Z');
    const classify = vi.fn(async (_u: string, fs: ProactiveFact[]) => {
      clock = new Date('2026-11-27T22:01:00Z');
      return fs.map((_, i) => ({
        fact: `f${i + 1}`,
        title: 'Fix',
        reason: '',
        action: '',
        urgency: 'normal' as const,
      }));
    });
    const t = deps(() => [fact('a')], classify);
    t.deps.now = () => clock;
    await check.runProactiveTick(new Date('2026-11-27T21:59:00Z'), t.deps, () => [
      { userId, prefs: quietAt22() },
    ]);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(store.listOffers(userId)).toEqual([]);
    expect(t.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'created' }));
    // The held work defers to the end of the quiet window that began mid-run,
    // instead of recording a completed check and waiting a day.
    expect(store.getProactiveState(userId)).toMatchObject({
      lastStatus: 'ok',
      lastCheckAt: null,
      deferredReasons: ['quiet'],
    });

    const list = () => [{ userId, prefs: quietAt22() }];
    const before = new Date('2026-11-28T05:59:00Z');
    const early = deps(() => [fact('a')]);
    early.deps.now = () => before;
    await check.runProactiveTick(before, early.deps, list);
    expect(early.classify).not.toHaveBeenCalled();

    const morning = new Date('2026-11-28T06:00:00Z');
    const retry = deps(() => [fact('a')]);
    retry.deps.now = () => morning;
    await check.runProactiveTick(morning, retry.deps, list);
    expect(retry.classify).toHaveBeenCalledTimes(1);
    expect(store.listOffers(userId)).toHaveLength(1);
    expect(store.getProactiveState(userId)).toMatchObject({
      lastCheckAt: morning.toISOString(),
      deferredReasons: [],
    });
  });

  it('defers until the cap frees when the cap stops a run with batches left unshown', async () => {
    const t0 = new Date('2026-11-27T12:00:00Z');
    const many = Array.from({ length: check.MAX_FACTS_PER_PROMPT + 5 }, (_, i) => fact(`c${i}`));
    const t = deps(() => many, undefined, t0);
    const res = await check.runProactiveCheck(userId, prefs({ maxOffersPerDay: 2 }), t.deps, {
      source: 'scheduled',
    });
    expect(res.offers).toHaveLength(2);
    const state = store.getProactiveState(userId);
    expect(state.lastCheckAt).toBeNull();
    expect(state.deferredReasons).toEqual(['cap']);
  });

  function quietAt22() {
    return prefs({
      intervalHours: 24,
      quietHours: { enabled: true, start: '22:00', end: '06:00' },
    });
  }
});

describe('tick reads settings per user', () => {
  it('skips a user who turned proactive mode off after the tick listed them', async () => {
    mutateUserPreferencesJson(userId, (c) => ({
      ...c,
      serverAgent: { proactive: prefs({ enabled: false }) },
    }));
    const t = deps(() => [fact('a')]);
    await check.runProactiveTick(new Date('2026-11-27T12:00:00Z'), t.deps, () => [
      { userId, prefs: prefs() },
    ]);
    expect(t.classify).not.toHaveBeenCalled();
  });
});

describe('per-user slot', () => {
  it('a failing check rejects only to its caller, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const t = deps(() => [fact('a')]);
      t.deps.now = () => {
        throw new Error('clock broke');
      };
      await expect(
        check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' }),
      ).rejects.toThrow('clock broke');
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(check.isProactiveCheckRunning(userId)).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('runs the pre-check refresh inside the reserved slot', async () => {
    let release: () => void = () => undefined;
    const refreshCalendar = vi.fn(() => new Promise<boolean>((r) => (release = () => r(true))));
    const t = deps(() => [fact('a')]);
    const run = check.runProactiveCheck(
      userId,
      prefs(),
      { ...t.deps, refreshCalendar },
      {
        source: 'scheduled',
        refresh: true,
      },
    );
    expect(check.isProactiveCheckRunning(userId)).toBe(true);
    await vi.waitFor(() => expect(refreshCalendar).toHaveBeenCalled());
    expect(t.classify).not.toHaveBeenCalled();
    release();
    await run;
    expect(t.classify).toHaveBeenCalledTimes(1);
  });
});

describe('checks queued behind a long model call', () => {
  function heldScheduledCheck() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const classify = vi.fn(async () => {
      started = true;
      await gate;
      return [];
    });
    return { classify, release, started: () => started };
  }

  async function queueEventBehindModel(change: () => void) {
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: prefs() } }));
    const held = heldScheduledCheck();
    const eventCollector = vi.fn(() => [fact('s1')]);
    const scheduled = check.runProactiveCheck(
      userId,
      prefs(),
      { ...deps(() => [fact('a')], held.classify).deps },
      { source: 'scheduled' },
    );
    await vi.waitFor(() => expect(held.started()).toBe(true));
    const eventDeps = deps(() => [fact('s1')]);
    eventDeps.deps.collectors = { dev: eventCollector };
    const [trigger] = events.mapBroadcastToProactiveTriggers({
      type: 'finalize_run_completed',
      status: 'failed',
      sessionId: 's1',
      ownerUserId: userId,
    });
    const queued = events.runProactiveTrigger(trigger, eventDeps.deps);
    change();
    held.release();
    await scheduled;
    return { result: await queued, eventCollector, eventClassify: eventDeps.classify };
  }

  it('does not collect or classify once proactive mode was switched off', async () => {
    const { result, eventCollector, eventClassify } = await queueEventBehindModel(() =>
      mutateUserPreferencesJson(userId, (c) => ({
        ...c,
        serverAgent: { proactive: prefs({ enabled: false }) },
      })),
    );
    expect(result?.status).toBe('disabled');
    expect(eventCollector).not.toHaveBeenCalled();
    expect(eventClassify).not.toHaveBeenCalled();
  });

  it('does not collect or classify an area switched off while queued', async () => {
    const { result, eventCollector, eventClassify } = await queueEventBehindModel(() =>
      mutateUserPreferencesJson(userId, (c) => ({
        ...c,
        serverAgent: {
          proactive: prefs({ areas: { dev: false, google: true, infra: true, todos: true } }),
        },
      })),
    );
    expect(result?.status).toBe('disabled');
    expect(eventCollector).not.toHaveBeenCalled();
    expect(eventClassify).not.toHaveBeenCalled();
  });

  it('still runs when nothing changed while it was queued', async () => {
    const { result, eventCollector, eventClassify } = await queueEventBehindModel(() => undefined);
    expect(result?.status).toBe('ok');
    // Collected inside the slot, then once more to re-confirm the picked fact.
    expect(eventCollector).toHaveBeenCalledTimes(2);
    expect(eventClassify).toHaveBeenCalledTimes(1);
  });
});

describe('scheduling: deferred checks do not cost an interval', () => {
  it('a daily check enabled inside quiet hours runs when quiet hours end, not a day later', async () => {
    const p = prefs({
      intervalHours: 24,
      timeZone: 'UTC',
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
    });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: p } }));
    const list = () => [{ userId, prefs: p }];

    const night = new Date('2026-11-27T23:00:00Z');
    const t1 = deps(() => [fact('a')], undefined, night);
    await check.runProactiveTick(night, t1.deps, list);
    expect(t1.classify).not.toHaveBeenCalled();
    expect(store.getProactiveState(userId)).toMatchObject({
      lastStatus: 'quiet',
      lastCheckAt: null,
      deferredReasons: ['quiet'],
    });

    const stillNight = new Date('2026-11-28T07:59:00Z');
    const t2 = deps(() => [fact('a')], undefined, stillNight);
    await check.runProactiveTick(stillNight, t2.deps, list);
    expect(t2.classify).not.toHaveBeenCalled();

    const morning = new Date('2026-11-28T08:00:00Z');
    const t3 = deps(() => [fact('a')], undefined, morning);
    await check.runProactiveTick(morning, t3.deps, list);
    expect(t3.classify).toHaveBeenCalledTimes(1);
    expect(store.listOffers(userId)).toHaveLength(1);
    expect(store.getProactiveState(userId)).toMatchObject({
      lastStatus: 'ok',
      lastCheckAt: morning.toISOString(),
      deferredReasons: [],
    });
  });

  it('a capped check retries when the oldest offer leaves the 24h window', async () => {
    const t0 = new Date('2026-11-27T12:00:00Z');
    const p = prefs({ maxOffersPerDay: 1 });
    const t = deps(() => [fact('a')], undefined, t0);
    await check.runProactiveCheck(userId, p, t.deps, { source: 'scheduled' });
    const t1 = new Date('2026-11-27T15:00:00Z');
    const capped = await check.runProactiveCheck(
      userId,
      p,
      deps(() => [fact('b')], undefined, t1).deps,
      {
        source: 'scheduled',
      },
    );
    expect(capped.status).toBe('capped');
    const state = store.getProactiveState(userId);
    expect(state.lastCheckAt).toBe(t0.toISOString());
    expect(state.deferredReasons).toEqual(['cap']);
  });

  it('a failed model run retries after ERROR_RETRY_MS', async () => {
    const t0 = new Date('2026-11-27T12:00:00Z');
    const failing = vi.fn(async () => {
      throw new Error('quota');
    });
    await check.runProactiveCheck(userId, prefs(), deps(() => [fact('a')], failing, t0).deps, {
      source: 'scheduled',
    });
    expect(store.getProactiveState(userId)).toMatchObject({
      lastStatus: 'error',
      lastCheckAt: null,
      deferredReasons: ['error'],
      deferredAt: t0.toISOString(),
    });
  });
});

describe('eligibility applies before collector caps', () => {
  function todoDeps(classify: ReturnType<typeof vi.fn>, now: Date) {
    const t = deps(() => [], classify as never, now);
    (t.deps as { collectors: unknown }).collectors = {
      todos: (ctx: import('./check.js').FactContext) =>
        extraFacts.collectTodoFacts({
          userId: ctx.userId,
          timeZone: 'UTC',
          now: ctx.now,
          match: ctx.match,
          scoped: ctx.scoped,
        }),
    };
    return t;
  }

  function overdueTodos(n: number) {
    return Array.from({ length: n }, (_, i) =>
      createTodo({
        userId,
        title: `Overdue ${i}`,
        doDate: `2026-11-${String(10 + i).padStart(2, '0')}`,
      }),
    );
  }

  it('an eligible todo past the cap is classified when the leading ones are blocked', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const todos = overdueTodos(9);
    // The first 8 (the collector's cap) already have open offers.
    for (const t of todos.slice(0, 8)) {
      store.insertOffer({
        userId,
        dedupeKey: `todo_overdue:${t.id}:${t.updatedAt}`,
        kind: 'todo_overdue',
        title: t.title,
        reason: '',
        action: '',
        urgency: 'normal',
        source: 'scheduled',
        target: { todoId: t.id },
        fact: {},
        now,
      });
    }
    const classify = vi.fn(async () => []);
    const p = prefs({ maxOffersPerDay: 20 });
    await check.runProactiveCheck(userId, p, todoDeps(classify, now).deps, { source: 'scheduled' });
    expect(classify).toHaveBeenCalledTimes(1);
    const sent = (classify.mock.calls[0] as unknown[])[1] as ProactiveFact[];
    expect(sent.map((f) => f.target.todoId)).toEqual([todos[8].id]);
  });

  it('an eligible todo past the cap is classified when the leading ones were declined', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const todos = overdueTodos(9);
    const decline = vi.fn(async () => []);
    // First pass: the collector's cap of 8 reaches the model, which declines them.
    await check.runProactiveCheck(userId, prefs(), todoDeps(decline, now).deps, {
      source: 'scheduled',
    });
    const first = (decline.mock.calls[0] as unknown[])[1] as ProactiveFact[];
    expect(first).toHaveLength(8);
    // Second pass: the ninth is no longer crowded out by the declined eight.
    const classify = vi.fn(async () => []);
    await check.runProactiveCheck(userId, prefs(), todoDeps(classify, now).deps, {
      source: 'scheduled',
    });
    expect(classify).toHaveBeenCalledTimes(1);
    const second = (classify.mock.calls[0] as unknown[])[1] as ProactiveFact[];
    expect(second.map((f) => f.target.todoId)).toEqual([todos[8].id]);
  });
});

describe('settings changes take effect on the next tick', () => {
  it('raising the daily cap ends a cap deferral immediately', async () => {
    const t0 = new Date('2026-11-27T12:00:00Z');
    const low = prefs({ maxOffersPerDay: 1 });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: low } }));
    await check.runProactiveCheck(userId, low, deps(() => [fact('a')], undefined, t0).deps, {
      source: 'scheduled',
    });
    const t1 = new Date('2026-11-27T13:00:00Z');
    await check.runProactiveCheck(userId, low, deps(() => [fact('b')], undefined, t1).deps, {
      source: 'scheduled',
    });
    expect(store.getProactiveState(userId).deferredReasons).toEqual(['cap']);

    const high = prefs({ maxOffersPerDay: 5 });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: high } }));
    const t2 = new Date('2026-11-27T13:01:00Z');
    const tick = deps(() => [fact('b')], undefined, t2);
    await check.runProactiveTick(t2, tick.deps, () => [{ userId, prefs: high }]);
    expect(tick.classify).toHaveBeenCalledTimes(1);
    expect(store.listOffers(userId).map((o) => o.dedupeKey)).toContain('finalize_failed:b');
  });

  it('turning quiet hours off ends a quiet deferral immediately', async () => {
    const night = new Date('2026-11-27T23:00:00Z');
    const quiet = prefs({
      intervalHours: 24,
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
    });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: quiet } }));
    const first = deps(() => [fact('a')], undefined, night);
    await check.runProactiveTick(night, first.deps, () => [{ userId, prefs: quiet }]);
    expect(first.classify).not.toHaveBeenCalled();
    expect(store.getProactiveState(userId).deferredReasons).toEqual(['quiet']);

    const awake = prefs({
      intervalHours: 24,
      quietHours: { enabled: false, start: '22:00', end: '08:00' },
    });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: awake } }));
    const next = new Date('2026-11-27T23:01:00Z');
    const tick = deps(() => [fact('a')], undefined, next);
    await check.runProactiveTick(next, tick.deps, () => [{ userId, prefs: awake }]);
    expect(tick.classify).toHaveBeenCalledTimes(1);
    expect(store.listOffers(userId)).toHaveLength(1);
  });

  it('moving quiet hours later extends a quiet deferral', async () => {
    const night = new Date('2026-11-27T23:00:00Z');
    const quiet = prefs({ quietHours: { enabled: true, start: '22:00', end: '08:00' } });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: quiet } }));
    await check.runProactiveTick(night, deps(() => [fact('a')], undefined, night).deps, () => [
      { userId, prefs: quiet },
    ]);
    const later = prefs({ quietHours: { enabled: true, start: '22:00', end: '10:00' } });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: later } }));
    const nine = new Date('2026-11-28T09:00:00Z');
    const tick = deps(() => [fact('a')], undefined, nine);
    await check.runProactiveTick(nine, tick.deps, () => [{ userId, prefs: later }]);
    expect(tick.classify).not.toHaveBeenCalled();
  });
});

describe('live gate before each model call', () => {
  function todoFact(id: string): ProactiveFact {
    return {
      id: `todo_overdue:${id}`,
      kind: 'todo_overdue',
      fingerprint: '',
      summary: `Todo ${id}`,
      target: { todoId: id },
    };
  }

  it('never sends an area switched off during an earlier batch to a later call', async () => {
    const p = prefs({ maxOffersPerDay: 20 });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: p } }));
    const devFacts = Array.from({ length: check.MAX_FACTS_PER_PROMPT + 6 }, (_, i) =>
      fact(`d${i}`),
    );
    const todos = [todoFact('t1'), todoFact('t2')];
    const classify = vi.fn(async (_u: string, batch: ProactiveFact[]) => {
      if (classify.mock.calls.length === 1) {
        // The user switches dev work off while the first call runs.
        mutateUserPreferencesJson(userId, (c) => ({
          ...c,
          serverAgent: {
            proactive: prefs({
              maxOffersPerDay: 20,
              areas: { dev: false, google: true, infra: true, todos: true },
            }),
          },
        }));
      }
      return batch.map((_, i) => ({
        fact: `f${i + 1}`,
        title: 'Do',
        reason: '',
        action: '',
        urgency: 'normal' as const,
      }));
    });
    const t = deps(() => devFacts, classify);
    (t.deps as { collectors: unknown }).collectors = { dev: () => devFacts, todos: () => todos };
    const res = await check.runProactiveCheck(userId, p, t.deps, { source: 'scheduled' });

    const calls = classify.mock.calls.map((c) => (c as unknown[])[1] as ProactiveFact[]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const later of calls.slice(1)) {
      expect(later.some((f) => f.kind === 'finalize_failed')).toBe(false);
    }
    const sentLater = calls
      .slice(1)
      .flat()
      .map((f) => f.id);
    expect(sentLater).toEqual(expect.arrayContaining(todos.map((f) => f.id)));
    // Nothing from dev was offered: the first batch's picks were dropped at insert.
    expect(res.offers.every((o) => o.kind === 'todo_overdue')).toBe(true);
  });

  it('holds facts for quiet hours that began during an earlier batch instead of sending them', async () => {
    const p = prefs({
      maxOffersPerDay: 20,
      quietHours: { enabled: true, start: '22:00', end: '06:00' },
    });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: p } }));
    let clock = new Date('2026-11-27T21:59:00Z');
    const many = Array.from({ length: check.MAX_FACTS_PER_PROMPT + 3 }, (_, i) => fact(`q${i}`));
    const classify = vi.fn(async () => {
      clock = new Date('2026-11-27T22:01:00Z');
      return [];
    });
    const t = deps(() => many, classify);
    t.deps.now = () => clock;
    await check.runProactiveCheck(userId, p, t.deps, {
      source: 'scheduled',
      startedAt: new Date('2026-11-27T21:59:00Z'),
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(store.getProactiveState(userId).deferredReasons).toEqual(['quiet']);
  });
});

describe('access re-checked before each model call', () => {
  const pick = (batch: ProactiveFact[]) =>
    batch.map((_, i) => ({
      fact: `f${i + 1}`,
      title: 'Do',
      reason: '',
      action: '',
      urgency: 'normal' as const,
    }));

  function googleFact(kind: 'email_reply' | 'calendar_conflict', id: string, accounts: string[]) {
    return {
      id: `${kind}:${id}`,
      kind,
      fingerprint: '',
      summary: id,
      target:
        kind === 'email_reply'
          ? { accountId: accounts[0], threadId: id }
          : {
              accountId: accounts[0],
              secondAccountId: accounts[1],
              eventId: `${id}-a`,
              secondEventId: `${id}-b`,
            },
      untrusted: true,
    } as ProactiveFact;
  }

  it('never sends queued facts of a Google account disconnected during an earlier batch', async () => {
    const p = prefs({ maxOffersPerDay: 20 });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: p } }));
    let connected = new Set(['work', 'home']);
    const filler = Array.from({ length: check.MAX_FACTS_PER_PROMPT }, (_, i) => fact(`d${i}`));
    const google = [
      googleFact('email_reply', 'mail-home', ['home']),
      googleFact('email_reply', 'mail-work', ['work']),
      googleFact('calendar_conflict', 'clash', ['work', 'home']),
    ];
    const classify = vi.fn(async (_u: string, batch: ProactiveFact[]) => {
      // "home" is disconnected while the first call runs; that call declines
      // its batch so the cap stays free for the queued Google facts.
      if (classify.mock.calls.length === 1) {
        connected = new Set(['work']);
        return [];
      }
      return pick(batch);
    });
    const t = deps(() => [], classify);
    (t.deps as { collectors: unknown }).collectors = {
      dev: () => filler,
      google: () => google,
    };
    (t.deps as unknown as { googleAccess: unknown }).googleAccess = () => connected;
    const res = await check.runProactiveCheck(userId, p, t.deps, { source: 'scheduled' });

    const calls = classify.mock.calls.map((c) => (c as unknown[])[1] as ProactiveFact[]);
    const later = calls.slice(1).flat();
    expect(later.map((f) => f.id)).toEqual(['email_reply:mail-work']);
    // Neither the home-only mail nor the conflict touching "home" was sent or offered.
    expect(res.offers.map((o) => o.dedupeKey)).not.toContain('email_reply:mail-home');
    expect(res.offers.map((o) => o.dedupeKey)).not.toContain('calendar_conflict:clash');
  });

  it('never sends or offers facts of a project the user lost access to mid-run', async () => {
    const p = prefs({ maxOffersPerDay: 20 });
    mutateUserPreferencesJson(userId, (c) => ({ ...c, serverAgent: { proactive: p } }));
    let canSee = true;
    const projectFacts = Array.from({ length: check.MAX_FACTS_PER_PROMPT + 3 }, (_, i) =>
      fact(`p${i}`, { target: { sessionId: `p${i}`, projectId: 'secret' } }),
    );
    const classify = vi.fn(async (_u: string, batch: ProactiveFact[]) => {
      if (classify.mock.calls.length === 1) canSee = false;
      return pick(batch);
    });
    const t = deps(() => projectFacts, classify);
    t.deps.getProjects = () => [{ id: 'secret', name: 'Secret' } as never];
    (t.deps as unknown as { visibilityCaller: unknown }).visibilityCaller = () =>
      canSee
        ? { userId, localBypass: true }
        : {
            userId,
            localBypass: false,
            assignedProjectIds: new Set(),
            restrictedProjectIds: new Set(['secret']),
          };
    const res = await check.runProactiveCheck(userId, p, t.deps, { source: 'scheduled' });
    // The first batch's picks are dropped at insert, and no later batch is sent.
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.offers).toEqual([]);
  });
});

describe('picked facts are re-confirmed at their source before insert', () => {
  const pickAll = (batch: ProactiveFact[]) =>
    batch.map((_, i) => ({
      fact: `f${i + 1}`,
      title: 'Do it',
      reason: '',
      action: '',
      urgency: 'normal' as const,
    }));

  it('a todo completed while the model ran gets no offer and uses no cap slot', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const todo = createTodo({ userId, title: 'File taxes', doDate: '2026-11-20' });
    const { updateTodo } = await import('../user-todos-store.js');
    const classify = vi.fn(async (_u: string, batch: ProactiveFact[]) => {
      // The user completes the todo while classification is paused.
      updateTodo(userId, todo.id, { status: 'done' });
      return pickAll(batch);
    });
    const t = deps(() => [], classify, now);
    (t.deps as { collectors: unknown }).collectors = {
      todos: (ctx: import('./check.js').FactContext) =>
        extraFacts.collectTodoFacts({
          userId,
          timeZone: 'UTC',
          now: ctx.now,
          match: ctx.match,
          scoped: ctx.scoped,
        }),
    };
    const res = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.offers).toEqual([]);
    expect(t.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'created' }));
    expect(store.countOffersSince(userId, '2026-11-26T00:00:00.000Z')).toBe(0);
  });

  it('a meeting that starts while the model ran gets no prep offer', async () => {
    let clock = new Date('2026-11-27T12:00:00Z');
    const meeting = {
      id: 'm1',
      accountId: 'acct',
      accountEmail: 'me@example.com',
      summary: 'Board',
      location: null,
      allDay: false,
      start: '2026-11-27T12:05:00Z',
      end: '2026-11-27T13:00:00Z',
      htmlLink: null,
    };
    const classify = vi.fn(async (_u: string, batch: ProactiveFact[]) => {
      clock = new Date('2026-11-27T12:06:00Z');
      return pickAll(batch);
    });
    const t = deps(() => [], classify);
    t.deps.now = () => clock;
    (t.deps as { collectors: unknown }).collectors = {
      google: (ctx: import('./check.js').FactContext) =>
        extraFacts.calendarFactsFromEvents([meeting], ctx.now, {
          match: ctx.match,
          scoped: ctx.scoped,
        }),
    };
    (t.deps as unknown as { googleAccess: unknown }).googleAccess = () => new Set(['acct']);
    const res = await check.runProactiveCheck(userId, prefs(), t.deps, {
      source: 'scheduled',
      startedAt: new Date('2026-11-27T12:00:00Z'),
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.offers).toEqual([]);
  });

  it('a Finalize failure superseded by a newer run gets no offer', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const { collectDevFacts } = await import('./facts.js');
    const { getDb } = await import('../db.js');
    const { setSessionOwner } = await import('../session-ownership.js');
    getStmts().createSession.run('fs1', 'agent-x', 'Session', 'claude-code', 'm', 0, 0, 1);
    setSessionOwner('fs1', userId);
    const run = getDb().prepare(
      `INSERT INTO finalize_runs (id, card_id, session_id, project_id, branch, head_sha,
         idempotency_key, status, trigger_source, triggered_by_user_id, author_name, author_email, started_at)
       VALUES (?, '', 'fs1', 'proj', 'b', 'sha', ?, ?, 'manual', ?, 'a', 'a@x', ?)`,
    );
    run.run('old', 'idem-old', 'failed', userId, now.getTime() - 60_000);
    const classify = vi.fn(async (_u: string, batch: ProactiveFact[]) => {
      // A new run starts (and passes) while the model is deciding.
      run.run('new', 'idem-new', 'passed', userId, now.getTime() - 1_000);
      return pickAll(batch);
    });
    const t = deps(() => [], classify, now);
    (t.deps as { collectors: unknown }).collectors = {
      dev: (ctx: import('./check.js').FactContext) =>
        collectDevFacts({
          userId,
          caller: { userId, localBypass: true },
          getProjects: () => [],
          stmts: getStmts() as Stmts,
          now: ctx.now,
          match: ctx.match,
          scoped: ctx.scoped,
        }),
    };
    const res = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(classify).toHaveBeenCalledTimes(1);
    const sent = (classify.mock.calls[0] as unknown[])[1] as ProactiveFact[];
    expect(sent.map((f) => f.id)).toEqual(['finalize_failed:old']);
    expect(res.offers).toEqual([]);
  });

  it('a fact still current at its source is offered as before', async () => {
    const now = new Date('2026-11-27T12:00:00Z');
    createTodo({ userId, title: 'Still overdue', doDate: '2026-11-20' });
    const classify = vi.fn(async (_u: string, batch: ProactiveFact[]) => pickAll(batch));
    const t = deps(() => [], classify, now);
    (t.deps as { collectors: unknown }).collectors = {
      todos: (ctx: import('./check.js').FactContext) =>
        extraFacts.collectTodoFacts({
          userId,
          timeZone: 'UTC',
          now: ctx.now,
          match: ctx.match,
          scoped: ctx.scoped,
        }),
    };
    const res = await check.runProactiveCheck(userId, prefs(), t.deps, { source: 'scheduled' });
    expect(res.offers.map((o) => o.kind)).toEqual(['todo_overdue']);
  });
});

describe('offer deadline is part of "open"', () => {
  it('transitionOffer refuses an overdue offer atomically, without a sweep', () => {
    const created = new Date('2026-11-26T10:00:00Z');
    const offer = store.insertOffer({
      userId,
      dedupeKey: 'finalize_failed:x',
      kind: 'finalize_failed',
      title: 'x',
      reason: '',
      action: '',
      urgency: 'normal',
      source: 'scheduled',
      target: {},
      fact: {},
      now: created,
    });
    const afterDeadline = new Date(created.getTime() + store.PROACTIVE_EXPIRE_MS + 1000);
    expect(store.transitionOffer(userId, offer.id, 'accepted', afterDeadline)).toBeNull();
    expect(store.getOffer(userId, offer.id)?.status).toBe('open');
    const beforeDeadline = new Date(created.getTime() + store.PROACTIVE_EXPIRE_MS - 1000);
    expect(store.transitionOffer(userId, offer.id, 'accepted', beforeDeadline)?.status).toBe(
      'accepted',
    );
  });
});
