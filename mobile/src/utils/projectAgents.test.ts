// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { resolveAgentIdFromProject } from './projectAgents';
describe('resolveAgentIdFromProject', () => {
    it('returns null for missing / malformed input', () => {
        expect(resolveAgentIdFromProject(null)).toBeNull();
        expect(resolveAgentIdFromProject(undefined)).toBeNull();
        expect(resolveAgentIdFromProject({})).toBeNull();
        expect(resolveAgentIdFromProject({ agents: [] })).toBeNull();
        expect(resolveAgentIdFromProject({ agents: null })).toBeNull();
        expect(resolveAgentIdFromProject({ agents: 'not-an-array' })).toBeNull();
    });
    it('returns a string-form agent id', () => {
        expect(resolveAgentIdFromProject({ agents: ['agent-a'] })).toBe('agent-a');
    });
    it('returns the id of the first agent object', () => {
        expect(resolveAgentIdFromProject({
            agents: [
                { id: 'agent-a', name: 'First' },
                { id: 'agent-b', name: 'Second' },
            ],
        })).toBe('agent-a');
    });
    it('returns null for object entries without an id', () => {
        expect(resolveAgentIdFromProject({ agents: [{ name: 'nameless' }] })).toBeNull();
    });
    it('returns null for empty string ids', () => {
        expect(resolveAgentIdFromProject({ agents: [''] })).toBeNull();
        expect(resolveAgentIdFromProject({ agents: [{ id: '' }] })).toBeNull();
    });
    it('returns null for unexpected entry types', () => {
        expect(resolveAgentIdFromProject({ agents: [42] })).toBeNull();
        expect(resolveAgentIdFromProject({ agents: [null] })).toBeNull();
    });
});
