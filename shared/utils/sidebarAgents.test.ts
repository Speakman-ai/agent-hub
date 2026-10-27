import { describe, expect, it } from 'vitest';
import { isSidebarHiddenAgent } from './sidebarAgents';

describe('isSidebarHiddenAgent', () => {
  it('hides reviewer, skill-builder, and qa agents', () => {
    expect(isSidebarHiddenAgent({ role: 'reviewer' })).toBe(true);
    expect(isSidebarHiddenAgent({ role: 'skill-builder' })).toBe(true);
    expect(isSidebarHiddenAgent({ role: 'qa' })).toBe(true);
  });

  it('keeps dev, docs, lead, and role-less agents', () => {
    expect(isSidebarHiddenAgent({ role: 'dev' })).toBe(false);
    expect(isSidebarHiddenAgent({ role: 'docs' })).toBe(false);
    expect(isSidebarHiddenAgent({ role: 'lead' })).toBe(false);
    expect(isSidebarHiddenAgent({})).toBe(false);
    expect(isSidebarHiddenAgent(null)).toBe(false);
  });
});
