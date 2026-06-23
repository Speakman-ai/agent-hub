// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { isMaskedSlackToken, validateSlackBotForm, buildSlackBotPayload, describeSlackTestResult, } from './settingsSlackBots';
describe('isMaskedSlackToken', () => {
    it('detects the server mask sentinel', () => {
        expect(isMaskedSlackToken('xoxb-****…-ab12cd')).toBe(true);
        expect(isMaskedSlackToken('xoxb-1234-real')).toBe(false);
        expect(isMaskedSlackToken('')).toBe(false);
        expect(isMaskedSlackToken(null)).toBe(false);
    });
});
describe('validateSlackBotForm', () => {
    const valid = {
        name: 'Bot',
        agent_id: 'main',
        bot_token: 'xoxb-1',
        app_token: 'xapp-1',
    };
    it('requires name and agent_id always', () => {
        expect(validateSlackBotForm({ ...valid, name: ' ' })).toMatch(/Name/);
        expect(validateSlackBotForm({ ...valid, agent_id: '' })).toMatch(/Agent ID/);
    });
    it('requires real tokens when creating', () => {
        expect(validateSlackBotForm({ ...valid, bot_token: '' }, { isNew: true })).toMatch(/Bot token/);
        expect(validateSlackBotForm({ ...valid, app_token: 'xapp-****…-x' }, { isNew: true })).toMatch(/App token/);
        expect(validateSlackBotForm(valid, { isNew: true })).toBeNull();
    });
    it('allows masked/blank tokens on update', () => {
        expect(validateSlackBotForm({ ...valid, bot_token: '', app_token: 'xapp-****…-x' })).toBeNull();
    });
});
describe('buildSlackBotPayload', () => {
    it('omits masked or blank tokens on update so the server keeps stored values', () => {
        const payload = buildSlackBotPayload({
            name: ' Bot ',
            agent_id: ' main ',
            bot_token: 'xoxb-****…-ab',
            app_token: '',
            enabled: true,
        });
        expect(payload).toEqual({ name: 'Bot', agent_id: 'main', enabled: true });
    });
    it('includes fresh tokens', () => {
        const payload = buildSlackBotPayload({
            name: 'Bot',
            agent_id: 'main',
            bot_token: ' xoxb-new ',
            app_token: 'xapp-new',
        });
        expect(payload.bot_token).toBe('xoxb-new');
        expect(payload.app_token).toBe('xapp-new');
        expect(payload.enabled).toBeUndefined();
    });
    it('always includes tokens on create', () => {
        const payload = buildSlackBotPayload({ name: 'Bot', agent_id: 'main', bot_token: 'xoxb-1', app_token: 'xapp-1' }, { isNew: true });
        expect(payload.bot_token).toBe('xoxb-1');
        expect(payload.app_token).toBe('xapp-1');
    });
});
describe('describeSlackTestResult', () => {
    it('summarizes success with team and user', () => {
        expect(describeSlackTestResult({ ok: true, team: 'Acme', user: 'bot' })).toBe('Connected to team "Acme" as bot');
        expect(describeSlackTestResult({ ok: true })).toBe('Connected to');
    });
    it('falls back to error text', () => {
        expect(describeSlackTestResult({ ok: false, error: 'invalid_auth' })).toBe('invalid_auth');
        expect(describeSlackTestResult(null)).toBe('Connection test failed');
    });
});
