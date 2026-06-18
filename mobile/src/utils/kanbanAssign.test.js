import { describe, it, expect } from 'vitest';
import {
  findAgentByName,
  hasActiveSession,
  buildAssigneeOptions,
  filterAgentsByProject,
  validModelsForAgent,
  engineEntriesWithModels,
  effectiveAssignEngine,
  assignedSessionId,
} from './kanbanAssign.js';

describe('assignedSessionId', () => {
  it('reads the top-level camelCase sessionId (current server shape)', () => {
    expect(assignedSessionId({ sessionId: 's1', card: { id: 'c1' } })).toBe('s1');
  });

  it('falls back to a top-level snake_case session_id', () => {
    expect(assignedSessionId({ session_id: 's2' })).toBe('s2');
  });

  it('falls back to the embedded card.session_id', () => {
    expect(assignedSessionId({ card: { session_id: 's3' } })).toBe('s3');
  });

  it('prefers sessionId over the embedded card row when both exist', () => {
    expect(assignedSessionId({ sessionId: 's1', card: { session_id: 's3' } })).toBe('s1');
  });

  it('returns null when no session id is present', () => {
    expect(assignedSessionId({ card: { id: 'c1' } })).toBeNull();
    expect(assignedSessionId({})).toBeNull();
    expect(assignedSessionId(null)).toBeNull();
    expect(assignedSessionId(undefined)).toBeNull();
  });
});

describe('filterAgentsByProject', () => {
  const agents = [
    { id: 'a1', name: 'Alpha', projectId: 'proj-1' },
    { id: 'a2', name: 'Beta', projectId: 'proj-2' },
    { id: 'a3', name: 'Gamma', projectId: 'proj-1' },
  ];

  it('returns only agents belonging to the given project', () => {
    expect(filterAgentsByProject(agents, 'proj-1').map((a) => a.id)).toEqual(['a1', 'a3']);
  });

  it('does not leak agents from other projects (regression for the assign picker)', () => {
    const result = filterAgentsByProject(agents, 'proj-2');
    expect(result).toHaveLength(1);
    expect(result.some((a) => a.projectId !== 'proj-2')).toBe(false);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterAgentsByProject(agents, 'nope')).toEqual([]);
  });

  it('returns the full list when projectId is missing', () => {
    expect(filterAgentsByProject(agents, undefined)).toEqual(agents);
    expect(filterAgentsByProject(agents, '')).toEqual(agents);
  });

  it('handles nullish / non-array input safely', () => {
    expect(filterAgentsByProject(null, 'proj-1')).toEqual([]);
    expect(filterAgentsByProject(undefined, 'proj-1')).toEqual([]);
    expect(filterAgentsByProject([null, { id: 'a1', projectId: 'proj-1' }], 'proj-1')).toEqual([
      { id: 'a1', projectId: 'proj-1' },
    ]);
  });

  it('composes with buildAssigneeOptions to scope the picker', () => {
    const opts = buildAssigneeOptions(filterAgentsByProject(agents, 'proj-1'));
    expect(opts.map((o) => o.name)).toEqual(['Unassigned', 'Alpha', 'Gamma']);
  });
});

describe('findAgentByName', () => {
  const agents = [
    { id: 'a1', name: 'Hub Lead' },
    { id: 'a2', name: 'Hub Backend' },
    { id: 'a3', name: 'Hub Mobile' },
  ];

  it('returns the matching agent by name', () => {
    expect(findAgentByName(agents, 'Hub Mobile')).toEqual({
      id: 'a3',
      name: 'Hub Mobile',
    });
  });

  it('returns undefined when no match', () => {
    expect(findAgentByName(agents, 'Nobody')).toBeUndefined();
  });

  it('returns undefined for empty inputs', () => {
    expect(findAgentByName([], 'Hub Lead')).toBeUndefined();
    expect(findAgentByName(null, 'Hub Lead')).toBeUndefined();
    expect(findAgentByName(agents, '')).toBeUndefined();
    expect(findAgentByName(agents, null)).toBeUndefined();
  });
});

describe('hasActiveSession', () => {
  it('is true when card has a session_id', () => {
    expect(hasActiveSession({ id: 'c1', session_id: 's1' })).toBe(true);
  });

  it('is false when session_id is missing or null', () => {
    expect(hasActiveSession({ id: 'c1' })).toBe(false);
    expect(hasActiveSession({ id: 'c1', session_id: null })).toBe(false);
    expect(hasActiveSession({ id: 'c1', session_id: '' })).toBe(false);
  });

  it('is false for null/undefined card', () => {
    expect(hasActiveSession(null)).toBe(false);
    expect(hasActiveSession(undefined)).toBe(false);
  });
});

describe('buildAssigneeOptions', () => {
  it('always prefixes an Unassigned row', () => {
    const opts = buildAssigneeOptions([{ id: 'a1', name: 'Foo' }]);
    expect(opts[0]).toEqual({ id: '', name: 'Unassigned' });
    expect(opts[1]).toEqual({ id: 'a1', name: 'Foo' });
  });

  it('filters out agents missing id or name', () => {
    const opts = buildAssigneeOptions([
      { id: 'a1', name: 'Foo' },
      { id: '', name: 'Bad' },
      { id: 'a2', name: '' },
      null,
      { id: 'a3', name: 'Bar' },
    ]);
    expect(opts).toEqual([
      { id: '', name: 'Unassigned' },
      { id: 'a1', name: 'Foo' },
      { id: 'a3', name: 'Bar' },
    ]);
  });

  it('handles non-array input gracefully', () => {
    expect(buildAssigneeOptions(null)).toEqual([
      { id: '', name: 'Unassigned' },
    ]);
    expect(buildAssigneeOptions(undefined)).toEqual([
      { id: '', name: 'Unassigned' },
    ]);
  });
});

describe('validModelsForAgent', () => {
  const agents = [
    { id: 'a1', name: 'ClaudeAgent', engine: 'claude-code' },
    { id: 'a2', name: 'CodexAgent', engine: 'codex-cli' },
  ];
  const modelConfig = {
    engineValidModels: {
      'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-20250514'],
      'codex-cli': ['gpt-5-codex'],
      'cursor-agent': [],
    },
  };

  it('returns models for the agents own engine when no override is set', () => {
    expect(validModelsForAgent(agents, modelConfig, 'ClaudeAgent')).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-4-20250514',
    ]);
    expect(validModelsForAgent(agents, modelConfig, 'CodexAgent')).toEqual([
      'gpt-5-codex',
    ]);
  });

  it('returns models for the override engine instead of the agents own', () => {
    // Reassigning a Claude agent under codex-cli — picker should show
    // codex models, not claude models.
    expect(
      validModelsForAgent(agents, modelConfig, 'ClaudeAgent', 'codex-cli'),
    ).toEqual(['gpt-5-codex']);
  });

  it('trims and ignores blank overrides (falls back to the agent default)', () => {
    expect(
      validModelsForAgent(agents, modelConfig, 'ClaudeAgent', '   '),
    ).toEqual(['claude-opus-4-8', 'claude-sonnet-4-20250514']);
    expect(
      validModelsForAgent(agents, modelConfig, 'ClaudeAgent', ''),
    ).toEqual(['claude-opus-4-8', 'claude-sonnet-4-20250514']);
  });

  it('returns [] when modelConfig is missing or the engine has no models', () => {
    expect(validModelsForAgent(agents, null, 'ClaudeAgent')).toEqual([]);
    expect(validModelsForAgent(agents, {}, 'ClaudeAgent')).toEqual([]);
    expect(
      validModelsForAgent(agents, modelConfig, 'ClaudeAgent', 'cursor-agent'),
    ).toEqual([]);
  });

  it('returns [] when neither agent nor override resolves an engine', () => {
    expect(validModelsForAgent(agents, modelConfig, 'Nobody')).toEqual([]);
    expect(validModelsForAgent(agents, modelConfig, '')).toEqual([]);
  });
});

describe('engineEntriesWithModels', () => {
  it('returns engine keys whose model arrays are non-empty', () => {
    expect(
      engineEntriesWithModels({
        engineValidModels: {
          'claude-code': ['claude-opus-4-8'],
          'codex-cli': ['gpt-5-codex'],
          'cursor-agent': [],
          gemini: [],
        },
      }),
    ).toEqual(['claude-code', 'codex-cli']);
  });

  it('returns [] when modelConfig is missing or malformed', () => {
    expect(engineEntriesWithModels(null)).toEqual([]);
    expect(engineEntriesWithModels(undefined)).toEqual([]);
    expect(engineEntriesWithModels({})).toEqual([]);
    expect(engineEntriesWithModels({ engineValidModels: null })).toEqual([]);
  });
});

describe('effectiveAssignEngine', () => {
  const agents = [
    { id: 'a1', name: 'ClaudeAgent', engine: 'claude-code' },
    { id: 'a2', name: 'CodexAgent', engine: 'codex-cli' },
  ];

  it('returns the override when set (non-blank)', () => {
    expect(effectiveAssignEngine(agents, 'ClaudeAgent', 'codex-cli')).toBe(
      'codex-cli',
    );
  });

  it('falls back to the agents configured engine when override is blank', () => {
    expect(effectiveAssignEngine(agents, 'ClaudeAgent', '')).toBe('claude-code');
    expect(effectiveAssignEngine(agents, 'CodexAgent', '   ')).toBe('codex-cli');
    expect(effectiveAssignEngine(agents, 'CodexAgent')).toBe('codex-cli');
  });

  it('falls back to claude-code when the agent is unknown and no override', () => {
    expect(effectiveAssignEngine(agents, 'Nobody', '')).toBe('claude-code');
    expect(effectiveAssignEngine([], 'ClaudeAgent', '')).toBe('claude-code');
  });
});
