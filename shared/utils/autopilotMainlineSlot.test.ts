import { describe, it, expect } from 'vitest';
import {
  MAINLINE_SLOT_PHASES,
  MAINLINE_SLOT_TRANSITIONS,
  type MainlineSlot,
  type MainlineSlotEvent,
  type MainlineSlotEventType,
  type MainlineSlotPhase,
  applyMainlineSlotEvent,
  idleMainlineSlot,
  mainlineLandingKey,
  mainlineSlotMatches,
  parseAutopilotMainlineConfig,
  parseMainlineSlot,
  withMainlineSlot,
} from './autopilotMainlineSlot';

const NOW = '2026-09-27T12:00:00.000Z';
const SHA = 'a'.repeat(40);

function slotIn(phase: MainlineSlotPhase): MainlineSlot {
  if (phase === 'idle') return idleMainlineSlot();
  return {
    phase,
    attemptId: 'att-1',
    sha: SHA,
    deploymentId: phase === 'deploying' || phase === 'reporting' ? 'dep-1' : null,
    outcome:
      phase === 'reporting'
        ? { status: 'succeeded', detail: null, origin: null, readiness: null }
        : null,
    escalatedAt: null,
    enteredAt: '2026-09-27T11:00:00.000Z',
  };
}

const SAMPLE_EVENTS: Record<MainlineSlotEventType, MainlineSlotEvent> = {
  begin_push: { type: 'begin_push', attemptId: 'att-2', sha: SHA },
  push_landed: { type: 'push_landed' },
  push_rejected: { type: 'push_rejected' },
  push_already_landed: { type: 'push_already_landed' },
  remote_already_landed: { type: 'remote_already_landed' },
  push_unknown: { type: 'push_unknown' },
  remote_present: { type: 'remote_present' },
  remote_absent: { type: 'remote_absent' },
  deploy_started: { type: 'deploy_started', deploymentId: 'dep-9' },
  deploy_undeployable: { type: 'deploy_undeployable', detail: 'env not declared' },
  deploy_finished: { type: 'deploy_finished', status: 'failed', detail: 'health check' },
  report_delivered: { type: 'report_delivered' },
  escalate: { type: 'escalate' },
};

const EXPECTED_MOVES: Array<[MainlineSlotEventType, MainlineSlotPhase, MainlineSlotPhase]> = [
  ['begin_push', 'idle', 'pushing'],
  ['push_landed', 'pushing', 'landed'],
  ['push_rejected', 'pushing', 'idle'],
  ['push_already_landed', 'pushing', 'idle'],
  ['remote_already_landed', 'uncertain', 'idle'],
  ['push_unknown', 'pushing', 'uncertain'],
  ['remote_present', 'uncertain', 'landed'],
  ['remote_absent', 'uncertain', 'idle'],
  ['deploy_started', 'landed', 'deploying'],
  ['deploy_undeployable', 'landed', 'reporting'],
  ['deploy_finished', 'deploying', 'reporting'],
  ['report_delivered', 'reporting', 'idle'],
  ['escalate', 'pushing', 'pushing'],
  ['escalate', 'uncertain', 'uncertain'],
  ['escalate', 'landed', 'landed'],
  ['escalate', 'deploying', 'deploying'],
  ['escalate', 'reporting', 'reporting'],
];

describe('mainline slot transition table', () => {
  it('matches the spec table exactly', () => {
    const encoded: Array<[string, string, string]> = [];
    for (const [type, rule] of Object.entries(MAINLINE_SLOT_TRANSITIONS)) {
      for (const from of rule.from) encoded.push([type, from, rule.to === 'same' ? from : rule.to]);
    }
    expect(new Set(encoded.map((m) => m.join('>')))).toEqual(
      new Set(EXPECTED_MOVES.map((m) => m.join('>'))),
    );
  });

  describe.each(MAINLINE_SLOT_PHASES)('from %s', (phase) => {
    it.each(Object.keys(SAMPLE_EVENTS) as MainlineSlotEventType[])(
      '%s is applied only when legal',
      (type) => {
        const legal = EXPECTED_MOVES.find(([t, from]) => t === type && from === phase);
        const res = applyMainlineSlotEvent(slotIn(phase), SAMPLE_EVENTS[type], NOW);
        if (!legal) {
          expect(res).toMatchObject({ ok: false, reason: 'illegal_transition', phase });
          return;
        }
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.slot.phase).toBe(legal[2]);
      },
    );
  });
});

describe('applyMainlineSlotEvent', () => {
  it('mints identity on begin_push and keeps it through deploy', () => {
    let slot = idleMainlineSlot();
    const steps: MainlineSlotEvent[] = [
      { type: 'begin_push', attemptId: 'att-7', sha: SHA },
      { type: 'push_landed' },
      { type: 'deploy_started', deploymentId: 'dep-7' },
      { type: 'deploy_finished', status: 'succeeded' },
    ];
    for (const ev of steps) {
      const res = applyMainlineSlotEvent(slot, ev, NOW);
      if (!res.ok) throw new Error(JSON.stringify(res));
      slot = res.slot;
    }
    expect(slot).toEqual({
      phase: 'reporting',
      attemptId: 'att-7',
      sha: SHA,
      deploymentId: 'dep-7',
      outcome: { status: 'succeeded', detail: null, origin: null, readiness: null },
      escalatedAt: null,
      enteredAt: NOW,
    });
    const done = applyMainlineSlotEvent(slot, { type: 'report_delivered' }, NOW);
    expect(done).toEqual({ ok: true, slot: idleMainlineSlot(NOW) });
  });

  it('records undeployable without a deployment', () => {
    const res = applyMainlineSlotEvent(
      slotIn('landed'),
      { type: 'deploy_undeployable', detail: 'no prod env' },
      NOW,
    );
    expect(res.ok && res.slot).toMatchObject({
      phase: 'reporting',
      deploymentId: null,
      outcome: { status: 'undeployable', detail: 'no prod env', origin: null, readiness: null },
    });
  });

  it('refuses malformed payloads', () => {
    const idle = idleMainlineSlot();
    expect(
      applyMainlineSlotEvent(idle, { type: 'begin_push', attemptId: '', sha: SHA }, NOW),
    ).toMatchObject({ ok: false, reason: 'invalid_event' });
    expect(
      applyMainlineSlotEvent(idle, { type: 'begin_push', attemptId: 'a', sha: 'not-a-sha' }, NOW),
    ).toMatchObject({ ok: false, reason: 'invalid_event' });
    expect(
      applyMainlineSlotEvent(slotIn('landed'), { type: 'deploy_started', deploymentId: ' ' }, NOW),
    ).toMatchObject({ ok: false, reason: 'invalid_event' });
    expect(
      applyMainlineSlotEvent(
        slotIn('deploying'),
        { type: 'deploy_finished', status: 'undeployable' as never },
        NOW,
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_event' });
    expect(applyMainlineSlotEvent(idle, { type: 'bogus' } as never, NOW)).toMatchObject({
      ok: false,
      reason: 'invalid_event',
    });
  });

  it('escalates a stuck phase once and clears the mark on the next phase', () => {
    const first = applyMainlineSlotEvent(slotIn('uncertain'), { type: 'escalate' }, NOW);
    expect(first.ok && first.slot).toMatchObject({ phase: 'uncertain', escalatedAt: NOW });
    if (!first.ok) return;
    expect(applyMainlineSlotEvent(first.slot, { type: 'escalate' }, NOW)).toMatchObject({
      ok: false,
      reason: 'already_escalated',
    });
    const moved = applyMainlineSlotEvent(first.slot, { type: 'remote_present' }, NOW);
    expect(moved.ok && moved.slot.escalatedAt).toBeNull();
  });
});

describe('mainlineSlotMatches', () => {
  it('requires both phase and attemptId', () => {
    const slot = slotIn('pushing');
    expect(mainlineSlotMatches(slot, { phase: 'pushing', attemptId: 'att-1' })).toBe(true);
    expect(mainlineSlotMatches(slot, { phase: 'pushing', attemptId: 'att-0' })).toBe(false);
    expect(mainlineSlotMatches(slot, { phase: 'uncertain', attemptId: 'att-1' })).toBe(false);
    expect(mainlineSlotMatches(idleMainlineSlot(), { phase: 'idle', attemptId: null })).toBe(true);
  });
});

describe('parseMainlineSlot', () => {
  it('round-trips every well-formed phase', () => {
    for (const phase of MAINLINE_SLOT_PHASES) {
      const slot = slotIn(phase);
      expect(parseMainlineSlot(JSON.parse(JSON.stringify(slot)))).toEqual(slot);
    }
  });

  it('keeps an undeployable report without a deployment id', () => {
    const slot = { ...slotIn('reporting'), deploymentId: null };
    expect(parseMainlineSlot(slot)).toEqual(slot);
  });

  it('reads missing or garbage as idle', () => {
    expect(parseMainlineSlot(undefined)).toEqual(idleMainlineSlot());
    expect(parseMainlineSlot('x')).toEqual(idleMainlineSlot());
    expect(parseMainlineSlot({ phase: 'nope' })).toEqual(idleMainlineSlot());
  });

  it('turns a corrupt slot that still names an attempt into uncertain, not idle', () => {
    expect(parseMainlineSlot({ ...slotIn('deploying'), deploymentId: null })).toMatchObject({
      phase: 'uncertain',
      attemptId: 'att-1',
      sha: SHA,
      deploymentId: null,
    });
    expect(parseMainlineSlot({ ...slotIn('reporting'), outcome: null }).phase).toBe('uncertain');
    expect(parseMainlineSlot({ phase: 'landed', attemptId: 'att-1' }).phase).toBe('idle');
  });
});

describe('parseAutopilotMainlineConfig / withMainlineSlot', () => {
  it('needs a deploy environment', () => {
    expect(parseAutopilotMainlineConfig({ slot: slotIn('idle') })).toBeNull();
    expect(parseAutopilotMainlineConfig({ deployEnvironment: 'prod' })).toEqual({
      deployEnvironment: 'prod',
      slot: idleMainlineSlot(),
      landedCount: 0,
    });
  });

  it('counts a landing once per attempt', () => {
    const cfg = { deployEnvironment: 'prod', slot: slotIn('pushing'), landedCount: 2 };
    const landed = withMainlineSlot(cfg, slotIn('landed'));
    expect(landed.landedCount).toBe(3);
    const escalated = withMainlineSlot(landed, { ...slotIn('landed'), escalatedAt: NOW });
    expect(escalated.landedCount).toBe(3);
    expect(withMainlineSlot(landed, slotIn('deploying')).landedCount).toBe(3);
  });

  it('remembers the last landed commit across the rest of the cycle and the stored JSON', () => {
    const cfg = { deployEnvironment: 'prod', slot: slotIn('uncertain'), landedCount: 0 };
    const landed = withMainlineSlot(cfg, slotIn('landed'), 'remote_present');
    expect(landed.lastLandedSha).toBe(SHA);
    const idle = withMainlineSlot(
      withMainlineSlot(landed, slotIn('reporting')),
      idleMainlineSlot(NOW),
      'report_delivered',
    );
    expect(idle.lastLandedSha).toBe(SHA);
    expect(parseAutopilotMainlineConfig(JSON.parse(JSON.stringify(idle)))?.lastLandedSha).toBe(SHA);
  });

  it('an uncertain push that was already landed frees the slot without owing a restart', () => {
    const cfg = { deployEnvironment: 'prod', slot: slotIn('uncertain'), landedCount: 1 };
    const freed = withMainlineSlot(cfg, idleMainlineSlot(NOW), 'remote_already_landed');
    expect(freed.restartOwed).toBeUndefined();
    expect(freed.landedCount).toBe(1);
  });

  it('records an owed restart on uncertain → idle, keeps it, and drops it on the next push', () => {
    const cfg = { deployEnvironment: 'prod', slot: slotIn('uncertain'), landedCount: 0 };
    const freed = withMainlineSlot(cfg, idleMainlineSlot(NOW));
    expect(freed.restartOwed).toEqual({ attemptId: 'att-1', sha: SHA, since: NOW });
    // Round-trips through the stored JSON.
    expect(parseAutopilotMainlineConfig(JSON.parse(JSON.stringify(freed)))?.restartOwed).toEqual(
      freed.restartOwed,
    );
    const pushing = withMainlineSlot(freed, { ...slotIn('pushing'), attemptId: 'att-2' });
    expect(pushing.restartOwed).toBeNull();
    // Other ways back to idle owe nothing.
    const rejected = withMainlineSlot(
      { deployEnvironment: 'prod', slot: slotIn('pushing'), landedCount: 0 },
      idleMainlineSlot(NOW),
    );
    expect(rejected.restartOwed).toBeUndefined();
    expect(
      parseAutopilotMainlineConfig({ deployEnvironment: 'prod', restartOwed: { sha: 'x' } }),
    ).not.toHaveProperty('restartOwed');
  });

  it('builds the landing key from session and attempt', () => {
    expect(mainlineLandingKey('s1', 'att-1')).toBe('s1:att-1');
  });
});
