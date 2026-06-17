import { describe, it, expect } from 'vitest';
import {
  groupAgentsByProject,
  resolveNewAgentForm,
  validateNewAgentForm,
  buildCreateAgentPayload,
  buildUpdateAgentPayload,
  settingsEngineChoices,
  settingsModelsForEngine,
  settingsDefaultModelForEngine,
  PER_USER_DEFAULT_MODEL,
  settingsSelectedModelChip,
  settingsResolveModelChip,
  settingsEffectiveEngine,
  settingsModelOverrideIsStale,
} from './settingsAgents.js';

const projects = [
  { id: 'p1', name: 'Survey Tracker', color: '#f00' },
  { id: 'p2', name: 'Agent Hub' },
];

describe('groupAgentsByProject', () => {
  it('groups agents under their project and keeps empty projects', () => {
    const agents = [
      { id: 'a1', projectId: 'p1' },
      { id: 'a2', projectId: 'p1' },
    ];
    const groups = groupAgentsByProject(agents, projects);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ projectId: 'p1', projectName: 'Survey Tracker', color: '#f00' });
    expect(groups[0].agents.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(groups[1].agents).toEqual([]);
  });

  it('puts agents with unknown projectId in an Other bucket', () => {
    const groups = groupAgentsByProject([{ id: 'x', projectId: 'gone' }], projects);
    const other = groups[groups.length - 1];
    expect(other.projectName).toBe('Other');
    expect(other.projectId).toBeNull();
    expect(other.agents.map((a) => a.id)).toEqual(['x']);
  });

  it('handles non-array inputs', () => {
    expect(groupAgentsByProject(null, null)).toEqual([]);
    expect(groupAgentsByProject(undefined, projects)).toHaveLength(2);
  });

  it('falls back to project id when name missing', () => {
    const groups = groupAgentsByProject([], [{ id: 'p9' }]);
    expect(groups[0].projectName).toBe('p9');
    expect(groups[0].color).toBeNull();
  });
});

describe('resolveNewAgentForm', () => {
  it('forces the scoped project onto the form when filterProjectId is set', () => {
    // Project-scoped mode hides the picker, so form.projectId is empty; the
    // scoped project must win so the agent lands under the right project.
    const form = { id: 'a1', projectId: '', name: 'A1' };
    expect(resolveNewAgentForm(form, 'p2')).toEqual({ id: 'a1', projectId: 'p2', name: 'A1' });
  });

  it('overrides a stale default projectId with the scoped project', () => {
    const form = { id: 'a1', projectId: 'p1' };
    expect(resolveNewAgentForm(form, 'p2').projectId).toBe('p2');
  });

  it('returns the form unchanged when there is no scope', () => {
    const form = { id: 'a1', projectId: 'p1' };
    expect(resolveNewAgentForm(form, null)).toBe(form);
    expect(resolveNewAgentForm(form, undefined)).toBe(form);
    expect(resolveNewAgentForm(form, '')).toBe(form);
  });
});

describe('validateNewAgentForm', () => {
  it('requires id', () => {
    expect(validateNewAgentForm({ id: '', projectId: 'p1' })).toMatch(/ID is required/);
    expect(validateNewAgentForm({ id: '   ', projectId: 'p1' })).toMatch(/ID is required/);
  });

  it('rejects malformed ids', () => {
    expect(validateNewAgentForm({ id: 'has spaces', projectId: 'p1' })).toMatch(/alphanumeric/);
    expect(validateNewAgentForm({ id: '-leading', projectId: 'p1' })).toMatch(/alphanumeric/);
  });

  it('requires projectId', () => {
    expect(validateNewAgentForm({ id: 'ok-agent', projectId: '' })).toMatch(/project/i);
  });

  it('passes a valid form', () => {
    expect(validateNewAgentForm({ id: 'my-agent_2', projectId: 'p1' })).toBeNull();
  });
});

describe('buildCreateAgentPayload', () => {
  it('includes required fields and omits empty optionals', () => {
    expect(buildCreateAgentPayload({ id: ' a1 ', projectId: 'p1', name: '', model: '' })).toEqual({
      id: 'a1',
      projectId: 'p1',
    });
  });

  it('carries optional fields when set', () => {
    expect(
      buildCreateAgentPayload({
        id: 'a1',
        projectId: 'p1',
        name: ' Bot ',
        engine: 'codex-cli',
        model: 'gpt-5.5',
        systemPrompt: ' do things ',
      }),
    ).toEqual({
      id: 'a1',
      projectId: 'p1',
      name: 'Bot',
      engine: 'codex-cli',
      model: 'gpt-5.5',
      systemPrompt: 'do things',
    });
  });
});

describe('buildUpdateAgentPayload', () => {
  const original = { id: 'a1', name: 'Old', engine: 'claude-code', model: 'm1', systemPrompt: '' };

  it('returns only changed fields and never includes model (per-user)', () => {
    expect(buildUpdateAgentPayload(original, { name: 'New', engine: 'claude-code' })).toEqual({
      name: 'New',
    });
    expect(buildUpdateAgentPayload(original, { model: 'gpt-5.5' })).toEqual({});
  });

  it('returns empty object when nothing changed or args missing', () => {
    expect(buildUpdateAgentPayload(original, { name: 'Old' })).toEqual({});
    expect(buildUpdateAgentPayload(null, { name: 'x' })).toEqual({});
    expect(buildUpdateAgentPayload(original, null)).toEqual({});
  });

  it('treats missing original field as empty string', () => {
    expect(buildUpdateAgentPayload({ id: 'a' }, { systemPrompt: '' })).toEqual({});
    expect(buildUpdateAgentPayload({ id: 'a' }, { systemPrompt: 'x' })).toEqual({
      systemPrompt: 'x',
    });
  });
});

describe('engine/model option helpers', () => {
  const modelConfig = {
    engineValidModels: { 'claude-code': ['m1', 'm2'], 'codex-cli': [] },
    engineDefaultModels: { 'claude-code': 'm1' },
    defaultModel: 'fallback',
  };

  it('settingsEngineChoices filters engines with no models', () => {
    expect(settingsEngineChoices(modelConfig)).toEqual(['claude-code']);
    expect(settingsEngineChoices(null)).toEqual([]);
  });

  it('settingsModelsForEngine returns list or empty', () => {
    expect(settingsModelsForEngine(modelConfig, 'claude-code')).toEqual(['m1', 'm2']);
    expect(settingsModelsForEngine(modelConfig, 'nope')).toEqual([]);
    expect(settingsModelsForEngine(null, 'claude-code')).toEqual([]);
  });

  it('settingsDefaultModelForEngine falls back through defaults', () => {
    expect(settingsDefaultModelForEngine(modelConfig, 'claude-code')).toBe('m1');
    expect(settingsDefaultModelForEngine(modelConfig, 'codex-cli')).toBe('fallback');
    expect(settingsDefaultModelForEngine(null, 'claude-code')).toBe('');
  });
});

describe('per-user model override chip selection', () => {
  const models = ['m1', 'm2'];

  it('highlights the Default sentinel when there is no override', () => {
    expect(settingsSelectedModelChip('', models)).toBe(PER_USER_DEFAULT_MODEL);
    expect(settingsSelectedModelChip(undefined, models)).toBe(PER_USER_DEFAULT_MODEL);
    expect(settingsSelectedModelChip(null, models)).toBe(PER_USER_DEFAULT_MODEL);
  });

  it('highlights a concrete override when it is valid for the engine', () => {
    expect(settingsSelectedModelChip('m2', models)).toBe('m2');
  });

  it('falls back to Default when the override is stale for the current engine', () => {
    // e.g. the user switched engine and their old model id is no longer valid
    expect(settingsSelectedModelChip('m1', [])).toBe(PER_USER_DEFAULT_MODEL);
    expect(settingsSelectedModelChip('not-a-model', models)).toBe(PER_USER_DEFAULT_MODEL);
  });

  it('resolves the Default sentinel to "" so the override is cleared (reachable delete)', () => {
    // This is the path the reviewer flagged: picking "Default" must clear the
    // personal override (parent maps '' → deleteMyAgentModelOverride), not pin
    // a concrete copy of today's default.
    expect(settingsResolveModelChip(PER_USER_DEFAULT_MODEL)).toBe('');
  });

  it('passes a concrete model id through unchanged', () => {
    expect(settingsResolveModelChip('m2')).toBe('m2');
  });
});

describe('per-user engine/model reconciliation', () => {
  const modelConfig = {
    engineValidModels: {
      'claude-code': ['claude-a', 'claude-b'],
      'codex-cli': ['gpt-a', 'gpt-b'],
    },
    engineDefaultModels: { 'claude-code': 'claude-a', 'codex-cli': 'gpt-a' },
    defaultModel: 'claude-a',
  };

  it('settingsEffectiveEngine prefers the override, then shared, then default', () => {
    expect(settingsEffectiveEngine('codex-cli', 'claude-code')).toBe('codex-cli');
    expect(settingsEffectiveEngine('', 'claude-code')).toBe('claude-code');
    expect(settingsEffectiveEngine('', '')).toBe('claude-code');
  });

  it('flags a model override that is incompatible with the new effective engine', () => {
    // user had a claude model pinned, then switched their engine to codex-cli
    expect(settingsModelOverrideIsStale('claude-b', 'codex-cli', modelConfig)).toBe(true);
  });

  it('does not flag a model override still valid for the effective engine', () => {
    expect(settingsModelOverrideIsStale('gpt-b', 'codex-cli', modelConfig)).toBe(false);
  });

  it('treats an empty override as never stale (nothing to clear)', () => {
    expect(settingsModelOverrideIsStale('', 'codex-cli', modelConfig)).toBe(false);
    expect(settingsModelOverrideIsStale(undefined, 'codex-cli', modelConfig)).toBe(false);
  });

  it('flags any non-empty override when the engine has no known models', () => {
    expect(settingsModelOverrideIsStale('claude-a', 'unknown-engine', modelConfig)).toBe(true);
  });
});
