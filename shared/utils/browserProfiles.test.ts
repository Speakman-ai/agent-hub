import { describe, expect, it } from 'vitest';
import {
  formatLastUsed,
  groupBrowserProfilesByAgent,
  parseSqliteUtc,
  type BrowserProfileWire,
} from './browserProfiles';

function profile(id: string, agentId: string, agentName: string): BrowserProfileWire {
  return {
    id,
    agentId,
    agentName,
    projectId: 'p',
    projectName: 'P',
    domains: [],
    hasState: true,
    inUse: false,
    lastUsedAt: null,
    createdAt: '2026-10-01 00:00:00',
    updatedAt: '2026-10-01 00:00:00',
  };
}

describe('parseSqliteUtc', () => {
  it('reads a zone-less SQLite timestamp as UTC', () => {
    expect(parseSqliteUtc('2026-10-15 12:00:00')?.toISOString()).toBe('2026-10-15T12:00:00.000Z');
  });
  it('returns null for empty or garbage input', () => {
    expect(parseSqliteUtc(null)).toBeNull();
    expect(parseSqliteUtc('nope')).toBeNull();
  });
});

describe('formatLastUsed', () => {
  it('says Never when the profile was never saved', () => {
    expect(formatLastUsed(null)).toBe('Never');
  });
});

describe('groupBrowserProfilesByAgent', () => {
  it('groups by agent and sorts groups by agent name', () => {
    const groups = groupBrowserProfilesByAgent([
      profile('1', 'b', 'Zed'),
      profile('2', 'a', 'Alpha'),
      profile('3', 'b', 'Zed'),
    ]);
    expect(groups.map((g) => g.agentName)).toEqual(['Alpha', 'Zed']);
    expect(groups[1].profiles.map((p) => p.id)).toEqual(['1', '3']);
  });
});
