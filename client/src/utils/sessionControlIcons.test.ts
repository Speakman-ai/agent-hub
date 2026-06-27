import { describe, it, expect } from 'vitest';
import { SESSION_CONTROL_ICON_MAP, sessionControlIcon } from './sessionControlIcons';

describe('sessionControlIcons', () => {
  it('maps every session-control value to an icon', () => {
    const values = [
      'consult',
      'design',
      'scoping',
      'skill-builder',
      'manual',
      'review',
      'push',
      'merge',
    ];
    for (const value of values) {
      expect(SESSION_CONTROL_ICON_MAP[value]).toBeTruthy();
      expect(sessionControlIcon(value)).toBe(SESSION_CONTROL_ICON_MAP[value]);
    }
  });

  it('returns null for unknown values', () => {
    expect(sessionControlIcon('bogus')).toBeNull();
  });
});
