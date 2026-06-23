// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { buildNotesListUrl, buildNoteUrl } from './notesUrl';
describe('buildNotesListUrl', () => {
    it('builds the bare list URL when no query/limit provided', () => {
        expect(buildNotesListUrl('agent-hub')).toBe('/projects/agent-hub/notes');
    });
    it('appends a search query', () => {
        expect(buildNotesListUrl('agent-hub', 'hooks')).toBe('/projects/agent-hub/notes?q=hooks');
    });
    it('URL-encodes query values with special characters', () => {
        expect(buildNotesListUrl('p', 'a&b c')).toBe('/projects/p/notes?q=a%26b+c');
    });
    it('trims whitespace-only queries to nothing', () => {
        expect(buildNotesListUrl('p', '   ')).toBe('/projects/p/notes');
    });
    it('ignores empty-string query', () => {
        expect(buildNotesListUrl('p', '')).toBe('/projects/p/notes');
    });
    it('appends the limit when provided', () => {
        expect(buildNotesListUrl('p', null, 20)).toBe('/projects/p/notes?limit=20');
    });
    it('combines query and limit', () => {
        expect(buildNotesListUrl('p', 'foo', 5)).toBe('/projects/p/notes?q=foo&limit=5');
    });
    it('ignores non-positive limits', () => {
        expect(buildNotesListUrl('p', 'foo', 0)).toBe('/projects/p/notes?q=foo');
        expect(buildNotesListUrl('p', 'foo', -3)).toBe('/projects/p/notes?q=foo');
    });
    it('ignores NaN / non-numeric limits', () => {
        expect(buildNotesListUrl('p', 'foo', NaN)).toBe('/projects/p/notes?q=foo');
        expect(buildNotesListUrl('p', 'foo', 'abc')).toBe('/projects/p/notes?q=foo');
    });
});
describe('buildNoteUrl', () => {
    it('builds the single-note URL', () => {
        expect(buildNoteUrl('agent-hub', 'abc-123')).toBe('/projects/agent-hub/notes/abc-123');
    });
});
