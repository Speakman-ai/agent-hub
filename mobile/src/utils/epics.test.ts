// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { EPIC_COLORS, DEFAULT_EPIC_COLOR, DEFAULT_EPIC_FORM, epicFormFromRow, epicFormToUpdateBody, epicFormToCreateBody, filterCardsByEpic, countOpenCardsForEpic, epicsWithActiveCards, findEpic, epicDropdownLabel, phaseFormToUpdateBody, autonomousModelOptions, defaultAutonomousModel, } from './epics';
describe('EPIC_COLORS', () => {
    it('matches the web palette', () => {
        expect(EPIC_COLORS).toEqual([
            '#6366F1',
            '#8B5CF6',
            '#EC4899',
            '#EF4444',
            '#F97316',
            '#EAB308',
            '#22C55E',
            '#06B6D4',
            '#3B82F6',
        ]);
        expect(EPIC_COLORS).toContain(DEFAULT_EPIC_COLOR);
    });
});
describe('DEFAULT_EPIC_FORM', () => {
    it('defaults autonomous fields to sane values', () => {
        expect(DEFAULT_EPIC_FORM).toEqual({
            name: '',
            description: '',
            color: DEFAULT_EPIC_COLOR,
            pr_base_branch: '',
            autonomous: 0,
            autonomous_interval: 5,
            autonomous_max_concurrent: 1,
            autonomous_model: '',
            autonomous_send_it: 0,
        });
    });
});
describe('epicFormFromRow', () => {
    it('returns defaults for a nullish row', () => {
        expect(epicFormFromRow(null)).toEqual(DEFAULT_EPIC_FORM);
        expect(epicFormFromRow(undefined)).toEqual(DEFAULT_EPIC_FORM);
    });
    it('maps server fields into the form, coercing autonomous to 0/1', () => {
        const row = {
            id: 'e1',
            name: 'Ship the app',
            description: 'big epic',
            color: '#22C55E',
            autonomous: 1,
            autonomous_interval: 10,
            autonomous_max_concurrent: 4,
        };
        expect(epicFormFromRow(row)).toEqual({
            name: 'Ship the app',
            description: 'big epic',
            color: '#22C55E',
            autonomous: 1,
            autonomous_interval: 10,
            autonomous_max_concurrent: 4,
            autonomous_model: '',
            autonomous_send_it: 1,
            pr_base_branch: '',
        });
    });
    it('maps autonomous_send_it from the server row', () => {
        expect(epicFormFromRow({ name: 'x', autonomous_send_it: 1 }).autonomous_send_it).toBe(1);
        expect(epicFormFromRow({ name: 'x', autonomous_send_it: 0 }).autonomous_send_it).toBe(0);
        expect(epicFormFromRow({ name: 'x', autonomous_send_it: null }).autonomous_send_it).toBe(1);
        expect(epicFormFromRow({ name: 'x' }).autonomous_send_it).toBe(1);
    });
    it('coerces truthy autonomous to 1', () => {
        expect(epicFormFromRow({ name: 'x', autonomous: true }).autonomous).toBe(1);
        expect(epicFormFromRow({ name: 'x', autonomous: 0 }).autonomous).toBe(0);
        expect(epicFormFromRow({ name: 'x' }).autonomous).toBe(0);
    });
    it('falls back to DEFAULT_EPIC_COLOR when color is missing', () => {
        expect(epicFormFromRow({ name: 'x' }).color).toBe(DEFAULT_EPIC_COLOR);
    });
    it('maps autonomous_model from the server row', () => {
        expect(epicFormFromRow({ name: 'x', autonomous_model: 'gpt-5.3-codex' }).autonomous_model).toBe('gpt-5.3-codex');
    });
});
describe('epicFormToUpdateBody', () => {
    it('emits the camelCase keys the server PUT endpoint expects', () => {
        const form = {
            name: '  Trim me  ',
            description: 'desc',
            color: '#EC4899',
            autonomous: 1,
            autonomous_interval: 7,
            autonomous_max_concurrent: 3,
        };
        expect(epicFormToUpdateBody(form)).toEqual({
            name: 'Trim me',
            description: 'desc',
            color: '#EC4899',
            autonomous: 1,
            autonomousInterval: 7,
            autonomousMaxConcurrent: 3,
            autonomousModel: null,
            autonomousSendIt: 0,
            prBaseBranch: null,
        });
    });
    it('sends autonomousSendIt 1 when Auto Merge is on (and 0 once autonomous is off)', () => {
        expect(epicFormToUpdateBody({ name: 'x', autonomous: 1, autonomous_send_it: 1 }).autonomousSendIt).toBe(1);
        expect(epicFormToUpdateBody({ name: 'x', autonomous: 0, autonomous_send_it: 1 }).autonomousSendIt).toBe(0);
    });
    it('coerces autonomous falsy values to 0', () => {
        expect(epicFormToUpdateBody({ name: 'a', autonomous: false }).autonomous).toBe(0);
        expect(epicFormToUpdateBody({ name: 'a', autonomous: undefined }).autonomous).toBe(0);
        expect(epicFormToUpdateBody({ name: 'a', autonomous: false }).autonomousModel).toBe(null);
    });
    it('passes trimmed autonomous_model when autonomous is on', () => {
        const body = epicFormToUpdateBody({
            name: 'x',
            autonomous: 1,
            autonomous_model: '  composer-2.5  ',
        });
        expect(body.autonomousModel).toBe('composer-2.5');
    });
});
describe('epicFormToCreateBody', () => {
    it('sends name, description, color; optional prBaseBranch when set', () => {
        const form = {
            name: 'New epic',
            description: 'desc',
            color: '#EAB308',
            autonomous: 1, // ignored for POST
            autonomous_interval: 10,
            pr_base_branch: '  feature/x  ',
        };
        expect(epicFormToCreateBody(form)).toEqual({
            name: 'New epic',
            description: 'desc',
            color: '#EAB308',
            prBaseBranch: 'feature/x',
        });
    });
    it('omits prBaseBranch when branch field empty', () => {
        const form = {
            name: 'New epic',
            description: 'desc',
            color: '#EAB308',
            autonomous: 1,
            pr_base_branch: '',
        };
        expect(epicFormToCreateBody(form)).toEqual({
            name: 'New epic',
            description: 'desc',
            color: '#EAB308',
        });
    });
});
describe('filterCardsByEpic', () => {
    const cards = [
        { id: 1, epic_id: 'e1', column_id: 'todo' },
        { id: 2, epic_id: 'e2', column_id: 'todo' },
        { id: 3, epic_id: null, column_id: 'todo' },
    ];
    it('returns all cards when filter is null/undefined', () => {
        expect(filterCardsByEpic(cards, null)).toEqual(cards);
        expect(filterCardsByEpic(cards, undefined)).toEqual(cards);
    });
    it('returns only cards for the given epic id', () => {
        expect(filterCardsByEpic(cards, 'e1')).toEqual([cards[0]]);
        expect(filterCardsByEpic(cards, 'e2')).toEqual([cards[1]]);
    });
    it('handles non-array input defensively', () => {
        expect(filterCardsByEpic(null, 'e1')).toEqual([]);
    });
});
describe('countOpenCardsForEpic', () => {
    const cards = [
        { id: 1, epic_id: 'e1', column_id: 'in-progress' },
        { id: 2, epic_id: 'e1', column_id: 'done' },
        { id: 3, epic_id: 'e1', column_id: 'todo' },
        { id: 4, epic_id: 'e2', column_id: 'todo' },
    ];
    it('counts non-done cards only', () => {
        expect(countOpenCardsForEpic(cards, 'e1', new Set(['done']))).toBe(2);
    });
    it('accepts a plain array as the done-column ids parameter', () => {
        expect(countOpenCardsForEpic(cards, 'e1', ['done'])).toBe(2);
    });
    it('treats every column as open if no done ids provided', () => {
        expect(countOpenCardsForEpic(cards, 'e1')).toBe(3);
    });
    it('returns 0 for missing epic id', () => {
        expect(countOpenCardsForEpic(cards, null)).toBe(0);
    });
});
describe('epicsWithActiveCards', () => {
    const epics = [
        { id: 'e1', name: 'Alpha' },
        { id: 'e2', name: 'Beta' },
        { id: 'e3', name: 'Empty' },
    ];
    const countFor = (id: any) => ({ e1: 2, e2: 1, e3: 0 })[id] ?? 0;
    it('drops epics with zero active cards', () => {
        expect(epicsWithActiveCards(epics, countFor, null).map((e: any) => e.id)).toEqual(['e1', 'e2']);
    });
    it('keeps the selected epic even when its active count is 0', () => {
        expect(epicsWithActiveCards(epics, countFor, 'e3').map((e: any) => e.id)).toEqual([
            'e1',
            'e2',
            'e3',
        ]);
    });
    it('returns all epics when no count function is provided', () => {
        expect(epicsWithActiveCards(epics, undefined, null)).toEqual(epics);
    });
    it('returns an empty array for a non-array input', () => {
        expect(epicsWithActiveCards(null, countFor, null)).toEqual([]);
    });
});
describe('findEpic', () => {
    const epics = [
        { id: 'e1', name: 'Alpha' },
        { id: 'e2', name: 'Beta' },
    ];
    it('finds an epic by id', () => {
        expect(findEpic(epics, 'e2')).toEqual({ id: 'e2', name: 'Beta' });
    });
    it('returns null for missing input', () => {
        expect(findEpic(epics, 'nope')).toBeNull();
        expect(findEpic(null, 'e1')).toBeNull();
        expect(findEpic(epics, null)).toBeNull();
    });
});
describe('epicDropdownLabel', () => {
    it('prepends Auto: for autonomous epics', () => {
        expect(epicDropdownLabel({ name: 'Live', autonomous: 1 })).toBe('Auto: Live');
    });
    it('omits the prefix for non-autonomous epics', () => {
        expect(epicDropdownLabel({ name: 'Idle', autonomous: 0 })).toBe('Idle');
    });
    it('returns empty for nullish epic', () => {
        expect(epicDropdownLabel(null)).toBe('');
    });
});
describe('phaseFormToUpdateBody', () => {
    it('preserves a selected model even when auto-dispatch is off', () => {
        expect(phaseFormToUpdateBody({
            name: 'Build',
            autonomous: 0,
            autonomous_model: '  gpt-5.5  ',
        }).autonomousModel).toBe('gpt-5.5');
    });
});
describe('autonomous model helpers', () => {
    const modelConfig = {
        defaultModel: 'gpt-5.5',
        engineDefaultModels: {
            'claude-code': 'claude-opus-4-8',
            'codex-cli': 'gpt-5.5',
        },
        engineValidModels: {
            'claude-code': ['claude-opus-4-8'],
            'codex-cli': ['gpt-5.5', 'gpt-5.4'],
        },
    };
    it('flattens authenticated model options across engines', () => {
        expect(autonomousModelOptions(modelConfig)).toEqual([
            'claude-opus-4-8',
            'gpt-5.5',
            'gpt-5.4',
        ]);
    });
    it('uses the configured default model when it is available', () => {
        expect(defaultAutonomousModel(modelConfig)).toBe('gpt-5.5');
    });
});
