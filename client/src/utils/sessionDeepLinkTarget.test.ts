import { describe, it, expect } from 'vitest';
import { resolveDeepLinkTarget, upsertSessionRow } from './sessionDeepLinkTarget';
import type { MinimalSessionRow } from './sessionDeepLinkTarget';

const row = (id: string, extra: Record<string, unknown> = {}): MinimalSessionRow => ({
  id,
  ...extra,
});

describe('resolveDeepLinkTarget', () => {
  it('selects the owned session when the deep-link target is in the list', () => {
    const data = [row('a'), row('b')];
    const res = resolveDeepLinkTarget(data, 'b', null);
    expect(res.target?.id).toBe('b');
    expect(res.deepLinkFetchId).toBeNull();
  });

  it('signals a direct fetch when the deep-link target is NOT owned (dashboard admin click-through)', () => {
    // Regression: previously this snapped activeSessionId to data[0] instead of
    // opening the clicked non-owned session by id.
    const data = [row('mine-1'), row('mine-2')];
    const res = resolveDeepLinkTarget(data, 'kevins-session', null);
    expect(res.deepLinkFetchId).toBe('kevins-session');
    // Fallback stays available in case the read is denied (non-admin caller).
    expect(res.target?.id).toBe('mine-1');
  });

  it('does not signal a fetch for the remembered/newest session when no target requested', () => {
    const data = [row('newest'), row('older')];
    expect(resolveDeepLinkTarget(data, null, row('older')).target?.id).toBe('older');
    expect(resolveDeepLinkTarget(data, null, null).target?.id).toBe('newest');
    expect(resolveDeepLinkTarget(data, null, null).deepLinkFetchId).toBeNull();
  });

  it('returns a null target (and still signals fetch) when the caller owns no sessions for the agent', () => {
    const res = resolveDeepLinkTarget([], 'kevins-session', null);
    expect(res.target).toBeNull();
    expect(res.deepLinkFetchId).toBe('kevins-session');
  });
});

describe('upsertSessionRow', () => {
  it('prepends a new deep-linked row', () => {
    const out = upsertSessionRow([row('a')], row('b', { engine: 'claude-code' }));
    expect(out.map((s) => s.id)).toEqual(['b', 'a']);
    expect(out[0].engine).toBe('claude-code');
  });

  it('replaces an existing row in place', () => {
    const out = upsertSessionRow(
      [row('a', { model: 'old' }), row('b')],
      row('a', { model: 'new' }),
    );
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out[0].model).toBe('new');
  });
});
