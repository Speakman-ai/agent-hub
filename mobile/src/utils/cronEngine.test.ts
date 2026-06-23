// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { CRON_DEFAULT_ENGINE, cronEngineChoices, defaultModelForCronEngine, effectiveCronEngine, inheritedCronEngineForHelper, modelsForCronEngine, resolveCronSkillPrincipalEngine, } from './cronEngine';
/**
 * Pinned against the precedence chain in `server/cron-engine.ts` —
 * `card 70b5ac8c` added the per-row engine column, and the mobile UI
 * has to mirror the server's resolution so the model dropdown filters
 * to the engine the cron will actually run under.
 */
const MODEL_CONFIG: Record<string, any> = {
    defaultModel: 'claude-opus-4-8',
    engineDefaultModels: {
        'claude-code': 'claude-opus-4-8',
        'cursor-agent': 'cursor-default',
        'gemini-cli': 'gemini-2.5-pro',
        'codex-cli': 'gpt-5-codex',
    },
    engineValidModels: {
        'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-5'],
        'cursor-agent': ['cursor-default'],
        'gemini-cli': ['gemini-2.5-pro'],
        'codex-cli': ['gpt-5-codex', 'gpt-5'],
    },
};
const PROJECT_CODEX: Record<string, any> = {
    id: 'codex-project',
    // Sole-agent project — the resolver falls back to the only agent
    // when neither the cron row nor `cronSkillPrincipalAgentId` is set.
    agents: [{ id: 'codex-agent', engine: 'codex-cli' }],
};
const PROJECT_MULTI: Record<string, any> = {
    id: 'multi-project',
    // Multi-agent project with an explicit `cronSkillPrincipalAgentId` —
    // the resolver picks that agent.
    cronSkillPrincipalAgentId: 'cursor-agent-id',
    agents: [
        { id: 'claude-agent-id', engine: 'claude-code' },
        { id: 'cursor-agent-id', engine: 'cursor-agent' },
    ],
};
describe('cronEngineChoices', () => {
    it('lists every engine with at least one configured model', () => {
        expect(cronEngineChoices(MODEL_CONFIG)).toEqual([
            'claude-code',
            'cursor-agent',
            'gemini-cli',
            'codex-cli',
        ]);
    });
    it('drops engines whose allowlist is empty', () => {
        const cfg = {
            engineValidModels: {
                'claude-code': ['claude-opus-4-8'],
                'cursor-agent': [],
            },
        };
        expect(cronEngineChoices(cfg)).toEqual(['claude-code']);
    });
    it('returns an empty list when modelConfig has not loaded yet', () => {
        expect(cronEngineChoices(null)).toEqual([]);
        expect(cronEngineChoices(undefined)).toEqual([]);
        expect(cronEngineChoices({})).toEqual([]);
    });
});
describe('modelsForCronEngine / defaultModelForCronEngine', () => {
    it('falls back to claude-code when the engine slot is blank', () => {
        expect(modelsForCronEngine(MODEL_CONFIG, '')).toEqual([
            'claude-opus-4-8',
            'claude-sonnet-4-5',
        ]);
        expect(defaultModelForCronEngine(MODEL_CONFIG, '')).toBe('claude-opus-4-8');
    });
    it('returns the allowlist + default for an explicit engine', () => {
        expect(modelsForCronEngine(MODEL_CONFIG, 'codex-cli')).toEqual(['gpt-5-codex', 'gpt-5']);
        expect(defaultModelForCronEngine(MODEL_CONFIG, 'codex-cli')).toBe('gpt-5-codex');
    });
});
describe('resolveCronSkillPrincipalEngine — server-parity resolution', () => {
    it('uses the cron row’s skill_principal_agent_id when set', () => {
        const result = resolveCronSkillPrincipalEngine({ project_id: 'multi-project', skill_principal_agent_id: 'claude-agent-id' }, [PROJECT_MULTI]);
        expect(result).toBe('claude-code');
    });
    it('falls back to project.cronSkillPrincipalAgentId when the row is blank', () => {
        const result = resolveCronSkillPrincipalEngine({ project_id: 'multi-project', skill_principal_agent_id: '' }, [PROJECT_MULTI]);
        expect(result).toBe('cursor-agent');
    });
    it('falls back to the sole project agent when nothing else is set', () => {
        const result = resolveCronSkillPrincipalEngine({ project_id: 'codex-project' }, [PROJECT_CODEX]);
        expect(result).toBe('codex-cli');
    });
    it('returns null when the project is unresolvable', () => {
        expect(resolveCronSkillPrincipalEngine({ project_id: 'nope' }, [PROJECT_CODEX])).toBeNull();
        expect(resolveCronSkillPrincipalEngine({}, [])).toBeNull();
    });
});
describe('effectiveCronEngine', () => {
    it('honors the explicit per-row engine first', () => {
        expect(effectiveCronEngine({ engine: 'gemini-cli', project_id: 'codex-project' }, [PROJECT_CODEX])).toBe('gemini-cli');
    });
    it('inherits from the skill principal when engine is blank', () => {
        expect(effectiveCronEngine({ engine: '', project_id: 'codex-project' }, [PROJECT_CODEX])).toBe('codex-cli');
    });
    it('falls back to claude-code when nothing else resolves', () => {
        expect(effectiveCronEngine({}, [])).toBe(CRON_DEFAULT_ENGINE);
    });
});
describe('inheritedCronEngineForHelper', () => {
    it('returns the inherited engine when it differs from the default', () => {
        expect(inheritedCronEngineForHelper({ project_id: 'codex-project' }, [PROJECT_CODEX])).toBe('codex-cli');
    });
    it('returns null when the inherited engine equals claude-code (no helper text needed)', () => {
        expect(inheritedCronEngineForHelper({ project_id: 'multi-project', skill_principal_agent_id: 'claude-agent-id' }, [PROJECT_MULTI])).toBeNull();
    });
    it('returns null when the picker already has an explicit engine', () => {
        expect(inheritedCronEngineForHelper({ engine: 'codex-cli', project_id: 'codex-project' }, [PROJECT_CODEX])).toBeNull();
    });
});
