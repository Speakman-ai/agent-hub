import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRACKS,
  suggestRoster,
  initialRoster,
  setRosterAgent,
  addCustomTrack,
  removeRosterTrack,
  rosterToPayload,
  hasAnyAssignment,
} from './rosterSuggest.js';

describe('rosterSuggest — DEFAULT_TRACKS', () => {
  it('exposes 6 core tracks from the storyboard', () => {
    expect(DEFAULT_TRACKS.map((t) => t.id)).toEqual([
      'architect',
      'backend',
      'frontend',
      'qa',
      'devex',
      'deploy',
    ]);
  });

  it('each track carries rationale + keyword list', () => {
    for (const t of DEFAULT_TRACKS) {
      expect(typeof t.rationale).toBe('string');
      expect(Array.isArray(t.keywords)).toBe(true);
      expect(t.keywords.length).toBeGreaterThan(0);
    }
  });
});

describe('rosterSuggest — suggestRoster', () => {
  const agents = [
    { id: 'hub-lead', name: 'Hub Lead Dev', role: 'lead' },
    { id: 'hub-backend', name: 'Hub Backend', role: 'sub' },
    { id: 'hub-frontend', name: 'Hub Frontend', role: 'sub' },
    { id: 'hub-reviewer', name: 'Agent Hub Reviewer', role: 'reviewer' },
    { id: 'hub-cto', name: 'Hub CTO', role: 'sub' },
  ];

  it('matches backend track to the backend agent by keyword', () => {
    const s = suggestRoster({ agents });
    const backend = s.find((t) => t.id === 'backend');
    expect(backend.suggestedAgentId).toBe('hub-backend');
  });

  it('matches frontend track to the frontend agent', () => {
    const s = suggestRoster({ agents });
    const frontend = s.find((t) => t.id === 'frontend');
    expect(frontend.suggestedAgentId).toBe('hub-frontend');
  });

  it('matches qa track to reviewer via "review" keyword', () => {
    const s = suggestRoster({ agents });
    const qa = s.find((t) => t.id === 'qa');
    expect(qa.suggestedAgentId).toBe('hub-reviewer');
  });

  it('matches architect track to lead/cto agent via keyword', () => {
    const s = suggestRoster({ agents });
    const arch = s.find((t) => t.id === 'architect');
    // 'hub-lead' has role:'lead' — matches the 'lead' keyword first.
    expect(arch.suggestedAgentId).toBe('hub-lead');
  });

  it('returns null suggestedAgentId when no agent matches a track', () => {
    const s = suggestRoster({ agents: [{ id: 'a', name: 'Random Agent' }] });
    for (const t of s) {
      expect(t.suggestedAgentId).toBeNull();
    }
  });

  it('does not mutate the tracks list', () => {
    const tracks = [{ id: 'x', label: 'X', keywords: ['foo'] }];
    const snapshot = JSON.parse(JSON.stringify(tracks));
    suggestRoster({ tracks, agents });
    expect(tracks).toEqual(snapshot);
  });

  it('handles missing agents gracefully', () => {
    const s = suggestRoster({});
    expect(s).toHaveLength(DEFAULT_TRACKS.length);
    for (const t of s) {
      expect(t.suggestedAgentId).toBeNull();
    }
  });

  it('matches against tags array', () => {
    const s = suggestRoster({
      agents: [{ id: 'ops-bot', name: 'Ops Bot', tags: ['sre', 'aws'] }],
    });
    const deploy = s.find((t) => t.id === 'deploy');
    expect(deploy.suggestedAgentId).toBe('ops-bot');
  });
});

describe('rosterSuggest — roster state helpers', () => {
  const suggestions = [
    { id: 'architect', label: 'Architect', rationale: 'a', suggestedAgentId: 'hub-cto' },
    { id: 'backend', label: 'Backend', rationale: 'b', suggestedAgentId: 'hub-backend' },
    { id: 'qa', label: 'QA', rationale: 'q', suggestedAgentId: null },
  ];

  it('initialRoster pre-fills suggested agents', () => {
    const r = initialRoster(suggestions);
    expect(r[0].agentId).toBe('hub-cto');
    expect(r[1].agentId).toBe('hub-backend');
    expect(r[2].agentId).toBeNull();
    expect(r.every((row) => row.custom === false)).toBe(true);
  });

  it('setRosterAgent updates the named track only', () => {
    const r = initialRoster(suggestions);
    const next = setRosterAgent(r, 'backend', 'hub-lead');
    expect(next[1].agentId).toBe('hub-lead');
    expect(next[0].agentId).toBe('hub-cto'); // untouched
    expect(r[1].agentId).toBe('hub-backend'); // input unmutated
  });

  it('setRosterAgent with null clears the assignment', () => {
    const r = initialRoster(suggestions);
    const next = setRosterAgent(r, 'backend', null);
    expect(next[1].agentId).toBeNull();
  });

  it('addCustomTrack appends a custom row', () => {
    const r = initialRoster(suggestions);
    const next = addCustomTrack(r, { id: 'custom-123', label: 'Docs' });
    expect(next).toHaveLength(4);
    expect(next[3]).toEqual({
      trackId: 'custom-123',
      label: 'Docs',
      rationale: 'Custom track',
      agentId: null,
      custom: true,
    });
  });

  it('addCustomTrack rejects duplicates and empty input', () => {
    const r = initialRoster(suggestions);
    expect(addCustomTrack(r, { id: 'architect', label: 'Dup' })).toEqual(r);
    expect(addCustomTrack(r, { id: '', label: 'X' })).toEqual(r);
    expect(addCustomTrack(r, { id: 'x', label: '' })).toEqual(r);
  });

  it('removeRosterTrack filters by trackId', () => {
    const r = initialRoster(suggestions);
    const next = removeRosterTrack(r, 'qa');
    expect(next).toHaveLength(2);
    expect(next.find((t) => t.trackId === 'qa')).toBeUndefined();
  });
});

describe('rosterSuggest — rosterToPayload + hasAnyAssignment', () => {
  it('payload drops rows with no label but keeps unassigned tracks', () => {
    const roster = [
      { trackId: 'architect', label: 'Architect', agentId: 'a', custom: false },
      { trackId: 'qa', label: 'QA', agentId: null, custom: false },
      { trackId: 'empty', label: '', agentId: null, custom: true },
    ];
    const payload = rosterToPayload(roster);
    expect(payload.tracks).toHaveLength(2);
    expect(payload.tracks[0]).toEqual({
      id: 'architect',
      label: 'Architect',
      agentId: 'a',
      custom: false,
    });
    expect(payload.tracks[1].agentId).toBeNull();
  });

  it('hasAnyAssignment true iff at least one agentId is set', () => {
    expect(
      hasAnyAssignment([
        { trackId: 'a', agentId: null },
        { trackId: 'b', agentId: 'x' },
      ]),
    ).toBe(true);
    expect(hasAnyAssignment([{ trackId: 'a', agentId: null }])).toBe(false);
    expect(hasAnyAssignment([])).toBe(false);
  });
});
