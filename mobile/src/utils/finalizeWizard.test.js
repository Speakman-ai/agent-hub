import { describe, it, expect } from 'vitest';
import {
  pickInitialProjectId,
  describeResolvedTarget,
  pickFinalizeStatus,
  shouldRefreshOnWizardComplete,
} from './finalizeWizard.js';

describe('pickInitialProjectId', () => {
  it('returns empty string for null / undefined / empty list', () => {
    expect(pickInitialProjectId(null, 'whatever')).toBe('');
    expect(pickInitialProjectId(undefined, '')).toBe('');
    expect(pickInitialProjectId([], 'x')).toBe('');
  });

  it('keeps the current id when it still exists in the list', () => {
    const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(pickInitialProjectId(projects, 'b')).toBe('b');
  });

  it('falls back to the first project when the current id is unknown', () => {
    const projects = [{ id: 'a' }, { id: 'b' }];
    expect(pickInitialProjectId(projects, 'gone')).toBe('a');
  });

  it('falls back to first when no current id is provided', () => {
    expect(pickInitialProjectId([{ id: 'first' }, { id: 'second' }], '')).toBe('first');
    expect(pickInitialProjectId([{ id: 'first' }, { id: 'second' }], null)).toBe('first');
    expect(pickInitialProjectId([{ id: 'first' }, { id: 'second' }], undefined)).toBe('first');
  });

  it('tolerates falsy entries in the projects array', () => {
    expect(pickInitialProjectId([null, undefined, { id: 'a' }], 'a')).toBe('a');
  });
});

describe('describeResolvedTarget', () => {
  it('returns null for missing / wrong-shape target', () => {
    expect(describeResolvedTarget(null)).toBeNull();
    expect(describeResolvedTarget(undefined)).toBeNull();
    expect(describeResolvedTarget('string')).toBeNull();
    expect(describeResolvedTarget({})).toBeNull();
    expect(describeResolvedTarget({ branch: 'x' })).toBeNull();
    expect(describeResolvedTarget({ sessionId: 'y' })).toBeNull();
  });

  it('rejects empty / whitespace branch or session id', () => {
    expect(describeResolvedTarget({ branch: '   ', sessionId: 'y' })).toBeNull();
    expect(describeResolvedTarget({ branch: 'x', sessionId: '' })).toBeNull();
  });

  it('formats a plain-text description for the RN <Text> child', () => {
    expect(
      describeResolvedTarget({ branch: 'feat/ci', sessionId: 'sess-1' }),
    ).toBe('Branch feat/ci in session sess-1');
  });
});

describe('pickFinalizeStatus', () => {
  it('returns null when no wizard has been spawned yet', () => {
    expect(pickFinalizeStatus({ lastSessionId: null, target: null })).toBeNull();
    expect(pickFinalizeStatus({ lastSessionId: '', target: { branch: 'x', sessionId: 'y' } })).toBeNull();
  });

  it('returns target kind when a resolved target was returned', () => {
    expect(
      pickFinalizeStatus({
        lastSessionId: 'wiz-1',
        target: { branch: 'feat/ci', sessionId: 'sess-1' },
      }),
    ).toEqual({ kind: 'target', text: 'Branch feat/ci in session sess-1' });
  });

  it('returns no_worktree when wizard ran but target is null', () => {
    expect(pickFinalizeStatus({ lastSessionId: 'wiz-1', target: null })).toEqual({
      kind: 'no_worktree',
    });
  });

  it('returns no_worktree when target is malformed (missing branch/session)', () => {
    expect(pickFinalizeStatus({ lastSessionId: 'wiz-1', target: { branch: 'x' } })).toEqual({
      kind: 'no_worktree',
    });
  });
});

describe('shouldRefreshOnWizardComplete', () => {
  it('returns false for the started event (refresh only on complete)', () => {
    expect(
      shouldRefreshOnWizardComplete(
        { type: 'finalize_wizard_started', projectId: 'p1' },
        'p1',
      ),
    ).toBe(false);
  });

  it('returns true when the complete event matches the current project', () => {
    expect(
      shouldRefreshOnWizardComplete(
        { type: 'finalize_wizard_complete', projectId: 'p1' },
        'p1',
      ),
    ).toBe(true);
  });

  it('returns false when the event is for a different project', () => {
    expect(
      shouldRefreshOnWizardComplete(
        { type: 'finalize_wizard_complete', projectId: 'other' },
        'p1',
      ),
    ).toBe(false);
  });

  it('returns false for malformed / missing payloads', () => {
    expect(shouldRefreshOnWizardComplete(null, 'p1')).toBe(false);
    expect(shouldRefreshOnWizardComplete(undefined, 'p1')).toBe(false);
    expect(shouldRefreshOnWizardComplete('string', 'p1')).toBe(false);
    expect(shouldRefreshOnWizardComplete({}, 'p1')).toBe(false);
  });

  it('returns false when no current project is selected', () => {
    expect(
      shouldRefreshOnWizardComplete(
        { type: 'finalize_wizard_complete', projectId: 'p1' },
        '',
      ),
    ).toBe(false);
  });
});
