import { describe, it, expect } from 'vitest';
import { deriveSessionState } from './deriveSessionState';

describe('deriveSessionState', () => {
  it('defaults to waiting for an idle session with no signals', () => {
    expect(deriveSessionState({ id: 's1' })).toBe('waiting_for_user_input');
  });

  it('returns working when the session has an active task', () => {
    expect(deriveSessionState({ id: 's1' }, { activeTaskSessionIds: { s1: true } })).toBe(
      'working',
    );
  });

  it('prefers a live finalize status over the payload seed', () => {
    expect(
      deriveSessionState(
        { id: 's1', finalize_status: 'reviewing' },
        { finalizeStatusBySession: { s1: 'pushed' } },
      ),
    ).toBe('pushed');
  });

  it('uses the payload finalize_status when no live signal is present', () => {
    expect(deriveSessionState({ id: 's1', finalize_status: 'running' })).toBe('running_tests');
  });

  it('maps ready_to_push to pending_push', () => {
    expect(
      deriveSessionState({ id: 's1' }, { finalizeStatusBySession: { s1: 'ready_to_push' } }),
    ).toBe('pending_push');
  });

  it('treats a merged seed as merged (no live client signal exists)', () => {
    expect(deriveSessionState({ id: 's1', state: 'merged' })).toBe('merged');
  });

  it('keeps an advanced settled server state when no live signal contradicts it', () => {
    // server resolved `pushed`, but the client has no finalize_status / live map yet
    expect(deriveSessionState({ id: 's1', state: 'pushed' })).toBe('pushed');
  });

  it('lets an active task override a stale settled seed', () => {
    expect(
      deriveSessionState({ id: 's1', state: 'pushed' }, { activeTaskSessionIds: { s1: true } }),
    ).toBe('working');
  });

  it('is robust to a null session', () => {
    expect(deriveSessionState(null)).toBe('waiting_for_user_input');
  });
});
