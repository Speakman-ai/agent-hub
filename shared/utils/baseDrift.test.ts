import { describe, expect, it } from 'vitest';
import {
  baseDriftFormDirty,
  baseDriftFormFromSettings,
  baseDriftListsPatch,
  baseDriftMode,
} from './baseDrift';

describe('baseDrift form helpers', () => {
  it('reads an unknown mode as full', () => {
    expect(baseDriftMode(undefined)).toBe('full');
    expect(baseDriftMode({ mode: 'weird' })).toBe('full');
    expect(baseDriftMode({ mode: 'fast' })).toBe('fast');
  });

  it('round-trips lists, defaulting hazard paths but honoring an explicit empty list', () => {
    const form = baseDriftFormFromSettings({ mergeCheckJobs: ['backend-checks'] });
    expect(form).toEqual({
      reuseText: '',
      hazardText: '**/migrations/**, **/db/migrate/**',
      mergeCheckText: 'backend-checks',
    });
    expect(baseDriftFormFromSettings({ hazardPaths: [] }).hazardText).toBe('');
    expect(baseDriftListsPatch({ ...form, mergeCheckText: 'a,\nb , ', reuseText: 'e2e' })).toEqual({
      reuseJobs: ['e2e'],
      hazardPaths: ['**/migrations/**', '**/db/migrate/**'],
      mergeCheckJobs: ['a', 'b'],
    });
  });

  it('is dirty only when a list differs from the stored value', () => {
    const value = { mergeCheckJobs: ['x'] };
    const form = baseDriftFormFromSettings(value);
    expect(baseDriftFormDirty(form, value)).toBe(false);
    expect(baseDriftFormDirty({ ...form, mergeCheckText: 'y' }, value)).toBe(true);
  });
});
