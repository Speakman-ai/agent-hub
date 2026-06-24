import { describe, expect, it } from 'vitest';
import { isScopingModeActive, normalizeSessionMode, SESSION_MODES } from './session-mode.js';

describe('session-mode scoping', () => {
  it('includes scoping in SESSION_MODES', () => {
    expect(SESSION_MODES).toContain('scoping');
  });

  it('normalizes scoping mode', () => {
    expect(normalizeSessionMode('scoping')).toBe('scoping');
  });

  it('detects scoping mode active', () => {
    expect(isScopingModeActive({ session_mode: 'scoping' })).toBe(true);
    expect(isScopingModeActive({ session_mode: 'chat' })).toBe(false);
  });
});
