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
    it('orders source first, then same-project, then other-project agents', () => {
        const agents = [source, siblingA, siblingB, otherProject, inactiveSibling];
        const result = filterForwardTargets(agents, source);
        // Source pinned first (self-forward), same-project siblings next,
        // cross-project agent last. Inactive dropped.
        expect(result.map((a: any) => a.id)).toEqual(['src-1', 'sib-a', 'sib-b', 'other-1']);
    });
    it('includes an other-project agent even when no siblings exist', () => {
        const result = filterForwardTargets([source, otherProject, inactiveSibling], source);
        expect(result.map((a: any) => a.id)).toEqual(['src-1', 'other-1']);
    });
    it('keeps agents from other projects when active (cross-project forwarding)', () => {
        const result = filterForwardTargets([source, otherProject], source);
        expect(result.map((a: any) => a.id)).toEqual(['src-1', 'other-1']);
    });
    it('drops inactive agents from the same project but keeps the source', () => {
        const result = filterForwardTargets([source, inactiveSibling], source);
        expect(result.map((a: any) => a.id)).toEqual(['src-1']);
    });
    it('returns [] when source is missing', () => {
        expect(filterForwardTargets([source, siblingA], null)).toEqual([]);
    });
    it('still lists agents when source has no project (all treated cross-project)', () => {
        // No projectId match and source not in list → every active agent is a candidate.
        expect(filterForwardTargets([source, siblingA], { id: 'x', active: true }).map((a: any) => a.id)).toEqual(['src-1', 'sib-a']);
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
