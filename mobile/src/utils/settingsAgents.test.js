import { describe, it, expect } from 'vitest';
import {
  groupAgentsByProject,
  validateNewAgentForm,
  buildCreateAgentPayload,
  buildUpdateAgentPayload,
  settingsEngineChoices,
  settingsModelsForEngine,
  settingsDefaultModelForEngine,
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

  it('returns only changed fields', () => {
    expect(buildUpdateAgentPayload(original, { name: 'New', engine: 'claude-code' })).toEqual({
      name: 'New',
    });
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
