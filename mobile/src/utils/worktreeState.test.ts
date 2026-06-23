// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { resolveSessionWorktree, applyDetectedFlag, describeDetectionBadge, } from './worktreeState';
describe('resolveSessionWorktree', () => {
    it('defaults to enabled + unknown when the session row is null', () => {
        expect(resolveSessionWorktree(null)).toEqual({ enabled: true, detected: null });
    });
    it('treats missing use_worktree as enabled (parity with web client)', () => {
        // The server column defaults to 1; older rows may omit it entirely.
        expect(resolveSessionWorktree({ id: 's1' })).toEqual({
            enabled: true,
            detected: null,
        });
    });
    it('flips to disabled only when use_worktree === 0', () => {
        expect(resolveSessionWorktree({ use_worktree: 0 }).enabled).toBe(false);
        expect(resolveSessionWorktree({ use_worktree: 1 }).enabled).toBe(true);
        // Non-canonical truthy values still count as enabled, mirroring
        // App.jsx's `use_worktree !== 0` guard.
        expect(resolveSessionWorktree({ use_worktree: true }).enabled).toBe(true);
    });
    it('maps git_worktree_detected 1/0 to true/false, null to null', () => {
        expect(resolveSessionWorktree({ git_worktree_detected: 1 }).detected).toBe(true);
        expect(resolveSessionWorktree({ git_worktree_detected: 0 }).detected).toBe(false);
        expect(resolveSessionWorktree({ git_worktree_detected: null }).detected).toBe(null);
        expect(resolveSessionWorktree({}).detected).toBe(null);
    });
    it('accepts boolean git_worktree_detected values too', () => {
        expect(resolveSessionWorktree({ git_worktree_detected: true }).detected).toBe(true);
        expect(resolveSessionWorktree({ git_worktree_detected: false }).detected).toBe(false);
    });
});
describe('applyDetectedFlag', () => {
    const base = [
        { id: 'a', git_worktree_detected: null },
        { id: 'b', git_worktree_detected: 0 },
    ];
    it('returns an empty array when sessions is not an array', () => {
        expect(applyDetectedFlag(null, 'a', true)).toEqual([]);
        expect(applyDetectedFlag(undefined, 'a', true)).toEqual([]);
    });
    it('returns the original array when sessionId is missing', () => {
        expect(applyDetectedFlag(base, null, true)).toBe(base);
    });
    it('updates only the matching session, leaving others untouched', () => {
        const next = applyDetectedFlag(base, 'b', true);
        expect(next).not.toBe(base);
        expect(next[0]).toBe(base[0]); // unchanged by reference
        expect(next[1]).toEqual({ id: 'b', git_worktree_detected: 1 });
    });
    it('stores the SQLite 0/1 convention, not booleans', () => {
        const next = applyDetectedFlag(base, 'a', false);
        expect(next[0].git_worktree_detected).toBe(0);
    });
    it('tolerates noisy entries without crashing', () => {
        const noisy = [null, { id: 'a' }, undefined];
        const next = applyDetectedFlag(noisy, 'a', true);
        expect(next[1].git_worktree_detected).toBe(1);
        expect(next[0]).toBe(null);
        expect(next[2]).toBe(undefined);
    });
});
describe('describeDetectionBadge', () => {
    it('returns null when detected is unknown so the badge stays hidden', () => {
        expect(describeDetectionBadge({ enabled: true, detected: null })).toBe(null);
        expect(describeDetectionBadge({ enabled: false, detected: null })).toBe(null);
    });
    it('returns the ok tone when CLI confirmed a worktree', () => {
        const b = describeDetectionBadge({ enabled: true, detected: true });
        expect(b.tone).toBe('ok');
        expect(b.label).toBe('WT');
    });
    it('returns the warn tone when toggle is on but CLI reports no worktree', () => {
        const b = describeDetectionBadge({ enabled: true, detected: false });
        expect(b.tone).toBe('warn');
        expect(b.hint).toMatch(/worktree mode is ON/);
    });
    it('returns the off tone when toggle is off and CLI confirms no worktree', () => {
        const b = describeDetectionBadge({ enabled: false, detected: false });
        expect(b.tone).toBe('off');
        expect(b.label).toBe('—');
    });
});
