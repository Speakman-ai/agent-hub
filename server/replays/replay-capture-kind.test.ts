import { describe, it, expect } from 'vitest';
import {
  classifyReplayCaptureKind,
  isReplayLive,
  replayTrigger,
  parseSqliteUtc,
  CONTINUOUS_TRIGGERS,
  REPLAY_LIVE_FRESHNESS_MS,
} from './replay-capture-kind.js';
import type { SessionReplayRow } from '../types.js';

describe('classifyReplayCaptureKind', () => {
  it('classifies continuous-tier triggers (case/space-insensitive) as continuous', () => {
    for (const t of CONTINUOUS_TRIGGERS) {
      expect(classifyReplayCaptureKind({ trigger: t })).toBe('continuous');
      expect(classifyReplayCaptureKind({ trigger: `  ${t.toUpperCase()}  ` })).toBe('continuous');
    }
  });

  it('defaults to on-error for record-on-error / manual / missing triggers', () => {
    expect(classifyReplayCaptureKind({ trigger: 'error' })).toBe('on-error');
    expect(classifyReplayCaptureKind({ trigger: 'window.error' })).toBe('on-error');
    expect(classifyReplayCaptureKind({ trigger: 'unhandledrejection' })).toBe('on-error');
    expect(classifyReplayCaptureKind({ trigger: 'bug-report' })).toBe('on-error');
    expect(classifyReplayCaptureKind({ trigger: 'manual' })).toBe('on-error');
    expect(classifyReplayCaptureKind(null)).toBe('on-error');
    expect(classifyReplayCaptureKind({})).toBe('on-error');
    expect(classifyReplayCaptureKind({ trigger: '' })).toBe('on-error');
  });

  it('falls back through trigger → reason → source keys', () => {
    expect(replayTrigger({ reason: 'continuous' })).toBe('continuous');
    expect(replayTrigger({ source: 'interval' })).toBe('interval');
    expect(replayTrigger({ trigger: 'error', reason: 'continuous' })).toBe('error');
    expect(classifyReplayCaptureKind({ reason: 'pagehide' })).toBe('continuous');
  });

  it('skips blank / non-string keys and falls through to the next (SQL-parity cases)', () => {
    // A blank trigger must NOT short-circuit the fallback — the reason wins.
    expect(replayTrigger({ trigger: '', reason: 'interval' })).toBe('interval');
    expect(classifyReplayCaptureKind({ trigger: '', reason: 'interval' })).toBe('continuous');
    // Whitespace-only is blank too.
    expect(replayTrigger({ trigger: '   ', source: 'continuous' })).toBe('continuous');
    // Non-string values are skipped (number / boolean / object).
    expect(replayTrigger({ trigger: 5 as any, reason: 'continuous' })).toBe('continuous');
    expect(replayTrigger({ trigger: true as any, reason: 'pagehide' })).toBe('pagehide');
    expect(classifyReplayCaptureKind({ trigger: 5 as any, reason: 'continuous' })).toBe(
      'continuous',
    );
  });
});

describe('parseSqliteUtc', () => {
  it('parses a sqlite datetime("now") string as UTC', () => {
    const ms = parseSqliteUtc('2026-06-25 12:00:00');
    expect(ms).toBe(Date.UTC(2026, 5, 25, 12, 0, 0));
  });
  it('parses ISO strings and returns null for junk', () => {
    expect(parseSqliteUtc('2026-06-25T12:00:00Z')).toBe(Date.UTC(2026, 5, 25, 12, 0, 0));
    expect(parseSqliteUtc(null)).toBeNull();
    expect(parseSqliteUtc('not-a-date')).toBeNull();
  });
});

function row(over: Partial<SessionReplayRow>): SessionReplayRow {
  return {
    id: 'r1',
    project_id: 'p1',
    created_at: '2026-06-25 12:00:00',
    updated_at: '2026-06-25 12:00:00',
    duration_ms: 1000,
    event_count: 10,
    size: 100,
    uncompressed_size: 200,
    storage_kind: 'local',
    storage_key: 'k',
    storage_bucket: null,
    storage_region: null,
    support_ticket_id: null,
    card_id: null,
    meta: null,
    ...over,
  };
}

describe('isReplayLive', () => {
  const base = Date.UTC(2026, 5, 25, 12, 0, 0);

  it('marks a fresh, unfinalized continuous capture as live', () => {
    expect(isReplayLive(row({}), 'continuous', base + 60_000)).toBe(true);
  });

  it('is never live for on-error captures, even when fresh', () => {
    expect(isReplayLive(row({}), 'on-error', base + 60_000)).toBe(false);
  });

  it('drops out of live once the freshness window elapses', () => {
    expect(isReplayLive(row({}), 'continuous', base + REPLAY_LIVE_FRESHNESS_MS + 1)).toBe(false);
  });

  it('is not live once finalized (ticket or card linked)', () => {
    expect(isReplayLive(row({ support_ticket_id: 't1' }), 'continuous', base + 1)).toBe(false);
    expect(isReplayLive(row({ card_id: 'c1' }), 'continuous', base + 1)).toBe(false);
  });

  it('falls back to created_at when updated_at is null (legacy row)', () => {
    expect(isReplayLive(row({ updated_at: null }), 'continuous', base + 60_000)).toBe(true);
  });
});
