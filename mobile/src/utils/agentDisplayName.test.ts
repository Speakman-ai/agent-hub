// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { resolveAgentDisplayName } from './agentDisplayName';
describe('resolveAgentDisplayName', () => {
    it('prefers the name stored on the message', () => {
        expect(resolveAgentDisplayName({ agent_name: 'Reviewer' }, 'Agent Hub Dev')).toBe('Reviewer');
    });
    it('falls back to the active agent name when the message has none', () => {
        expect(resolveAgentDisplayName({}, 'Agent Hub Dev')).toBe('Agent Hub Dev');
        expect(resolveAgentDisplayName(null, 'Agent Hub Dev')).toBe('Agent Hub Dev');
    });
    it('falls back to "Assistant" when no name is known', () => {
        expect(resolveAgentDisplayName(null, undefined)).toBe('Assistant');
        expect(resolveAgentDisplayName({ agent_name: '' }, '')).toBe('Assistant');
    });
});
