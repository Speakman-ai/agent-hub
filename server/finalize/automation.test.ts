import { describe, it, expect } from 'vitest';
import {
  parseFinalizeAutomation,
  resolveSessionFinalizeAutomation,
  shouldAutoStartFinalize,
  shouldAutoPushAfterReady,
  shouldEnableAutoMergeForAutomation,
  finalizeAutomationLabel,
  assignedFinalizeAutomationLevel,
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

  it('labels levels with the Build / Auto Merge scheme', () => {
    expect(finalizeAutomationLabel('manual')).toBe('Build');
    expect(finalizeAutomationLabel('review')).toBe('Build and Review');
    expect(finalizeAutomationLabel('push')).toBe('Build and Push');
    expect(finalizeAutomationLabel('merge')).toBe('Auto Merge');
  });

  it('picks the assigned-card level from the auto-merge decision', () => {
    // Auto-merge off → "Build and Push"; on → "Auto Merge".
    expect(assignedFinalizeAutomationLevel(false)).toBe('push');
    expect(assignedFinalizeAutomationLevel(true)).toBe('merge');
  });
});
