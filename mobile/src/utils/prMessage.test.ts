// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { parsePrCreatedMetadata, shortSha } from './prMessage';
describe('parsePrCreatedMetadata', () => {
    const valid = {
        kind: 'pr_created',
        prUrl: 'https://github.com/acme/repo/pull/42',
        prNumber: 42,
        commitSha: 'abc123def4567',
        commitTitle: 'Fix login crash',
        cardId: 'card-uuid',
        cardTitle: 'Login task',
    };
    it('parses well-formed metadata', () => {
        const out = parsePrCreatedMetadata(JSON.stringify(valid));
        expect(out).toEqual({
            prUrl: 'https://github.com/acme/repo/pull/42',
            prNumber: 42,
            commitSha: 'abc123def4567',
            commitTitle: 'Fix login crash',
            cardId: 'card-uuid',
            cardTitle: 'Login task',
        });
    });
    it('accepts pre-parsed objects (idempotent)', () => {
        const out = parsePrCreatedMetadata(valid);
        expect(out?.prNumber).toBe(42);
    });
    it('returns null for null/undefined', () => {
        expect(parsePrCreatedMetadata(null)).toBeNull();
        expect(parsePrCreatedMetadata(undefined)).toBeNull();
    });
    it('returns null for malformed JSON', () => {
        expect(parsePrCreatedMetadata('{ not json')).toBeNull();
        expect(parsePrCreatedMetadata('')).toBeNull();
    });
    it('returns null when kind is not pr_created', () => {
        const wrong = JSON.stringify({ ...valid, kind: 'something_else' });
        expect(parsePrCreatedMetadata(wrong)).toBeNull();
    });
    it('returns null when prUrl is missing or empty', () => {
        expect(parsePrCreatedMetadata(JSON.stringify({ ...valid, prUrl: '' }))).toBeNull();
        expect(parsePrCreatedMetadata(JSON.stringify({ ...valid, prUrl: null }))).toBeNull();
        const { prUrl: _unused, ...noUrl } = valid;
        expect(parsePrCreatedMetadata(JSON.stringify(noUrl))).toBeNull();
    });
    it('tolerates null cardId/cardTitle (ad-hoc flow)', () => {
        const adhoc = JSON.stringify({ ...valid, cardId: null, cardTitle: null });
        const out = parsePrCreatedMetadata(adhoc);
        expect(out?.cardId).toBeNull();
        expect(out?.cardTitle).toBeNull();
        expect(out?.prUrl).toBe(valid.prUrl);
    });
    it('coerces non-number prNumber to null (future-proof against wire drift)', () => {
        const weird = JSON.stringify({ ...valid, prNumber: '42' });
        expect(parsePrCreatedMetadata(weird)?.prNumber).toBeNull();
    });
    it('coerces missing commitSha / commitTitle to empty strings', () => {
        const minimal = JSON.stringify({
            kind: 'pr_created',
            prUrl: 'https://x/pull/1',
            prNumber: 1,
            cardId: null,
            cardTitle: null,
        });
        const out = parsePrCreatedMetadata(minimal);
        expect(out?.commitSha).toBe('');
        expect(out?.commitTitle).toBe('');
    });
});
describe('shortSha', () => {
    it('returns the first 7 chars of a SHA', () => {
        expect(shortSha('abcdef1234567890')).toBe('abcdef1');
    });
    it('returns the whole string if shorter than 7', () => {
        expect(shortSha('abc')).toBe('abc');
    });
    it('returns empty string for null / undefined / non-strings', () => {
        expect(shortSha(null)).toBe('');
        expect(shortSha(undefined)).toBe('');
        expect(shortSha(42)).toBe('');
        expect(shortSha('')).toBe('');
    });
});
