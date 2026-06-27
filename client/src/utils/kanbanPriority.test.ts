import { describe, it, expect } from 'vitest';
import { isHighPriority, toggleHighPriorityValue } from './kanbanPriority';

describe('kanbanPriority', () => {
  it('isHighPriority is true for high and urgent', () => {
    expect(isHighPriority('high')).toBe(true);
    expect(isHighPriority('urgent')).toBe(true);
  });

  it('isHighPriority is false for medium, low, and missing', () => {
    expect(isHighPriority('medium')).toBe(false);
    expect(isHighPriority('low')).toBe(false);
    expect(isHighPriority(undefined)).toBe(false);
    expect(isHighPriority(null)).toBe(false);
  });

  it('toggleHighPriorityValue marks medium/low as high and clears high/urgent to medium', () => {
    expect(toggleHighPriorityValue('medium')).toBe('high');
    expect(toggleHighPriorityValue('low')).toBe('high');
    expect(toggleHighPriorityValue('high')).toBe('medium');
    expect(toggleHighPriorityValue('urgent')).toBe('medium');
  });
});
