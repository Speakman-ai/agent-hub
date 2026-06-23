// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { filterForwardTargets } from './forwardTargets';
const source = {
    id: 'src-1',
    name: 'Hub Frontend',
    projectId: 'proj-a',
    active: true,
};
const siblingA = {
    id: 'sib-a',
    name: 'Hub Backend',
    projectId: 'proj-a',
    active: true,
};
const siblingB = {
    id: 'sib-b',
    name: 'Hub Lead',
    projectId: 'proj-a',
    active: true,
};
const otherProject = {
    id: 'other-1',
    name: 'Side Agent',
    projectId: 'proj-b',
    active: true,
};
const inactiveSibling = {
    id: 'inactive-1',
    name: 'Retired',
    projectId: 'proj-a',
    active: false,
};
describe('filterForwardTargets (mobile)', () => {
    it('keeps active agents from the same project with source pinned first', () => {
        const agents = [source, siblingA, siblingB, otherProject, inactiveSibling];
        const result = filterForwardTargets(agents, source);
        // Source agent is now included (self-forward) and comes first
        expect(result.map((a: any) => a.id)).toEqual(['src-1', 'sib-a', 'sib-b']);
    });
    it('returns just the source when no siblings exist (self-forward only)', () => {
        const result = filterForwardTargets([source, otherProject, inactiveSibling], source);
        expect(result.map((a: any) => a.id)).toEqual(['src-1']);
    });
    it('drops agents from other projects even if active', () => {
        const result = filterForwardTargets([source, otherProject], source);
        // Only the source remains — other project agent is filtered out
        expect(result.map((a: any) => a.id)).toEqual(['src-1']);
    });
    it('drops inactive agents from the same project but keeps the source', () => {
        const result = filterForwardTargets([source, inactiveSibling], source);
        expect(result.map((a: any) => a.id)).toEqual(['src-1']);
    });
    it('returns [] when source is missing or has no project', () => {
        expect(filterForwardTargets([source, siblingA], null)).toEqual([]);
        expect(filterForwardTargets([source, siblingA], { id: 'x', active: true })).toEqual([]);
    });
    it('returns [] on non-array input', () => {
        expect(filterForwardTargets(null, source)).toEqual([]);
        expect(filterForwardTargets(undefined, source)).toEqual([]);
    });
    it('omits the source when the source is inactive', () => {
        const inactiveSource = { ...source, active: false };
        const result = filterForwardTargets([inactiveSource, siblingA], inactiveSource);
        expect(result.map((a: any) => a.id)).toEqual(['sib-a']);
    });
});
