import { describe, it, expect } from 'vitest';
import {
  parseFinalizeAutomation,
  resolveSessionFinalizeAutomation,
  shouldAutoStartFinalize,
  shouldAutoPushAfterReady,
  shouldEnableAutoMergeForAutomation,
} from './automation.js';

describe('finalize automation', () => {
  it('defaults unknown values to manual', () => {
    expect(parseFinalizeAutomation(null)).toBe('manual');
    expect(parseFinalizeAutomation('bogus')).toBe('manual');
  });

  it('parses valid levels', () => {
    expect(parseFinalizeAutomation('merge')).toBe('merge');
    expect(resolveSessionFinalizeAutomation({ finalize_automation: 'push' })).toBe('push');
  });

  it('gates auto actions by level', () => {
    expect(shouldAutoStartFinalize('manual')).toBe(false);
    expect(shouldAutoStartFinalize('review')).toBe(true);
    expect(shouldAutoPushAfterReady('review')).toBe(false);
    expect(shouldAutoPushAfterReady('push')).toBe(true);
    expect(shouldEnableAutoMergeForAutomation('push')).toBe(false);
    expect(shouldEnableAutoMergeForAutomation('merge')).toBe(true);
  });
});
