// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { attachmentKind } from './attachmentKind';
describe('attachmentKind — server-record classification', () => {
    it('detects images via contentType', () => {
        expect(attachmentKind({ contentType: 'image/png' })).toBe('image');
        expect(attachmentKind({ contentType: 'image/jpeg' })).toBe('image');
    });
    it('detects videos via contentType', () => {
        expect(attachmentKind({ contentType: 'video/mp4' })).toBe('video');
        expect(attachmentKind({ contentType: 'video/quicktime' })).toBe('video');
    });
    it('falls back to URL extension for images', () => {
        expect(attachmentKind({ url: '/uploads/abc.png' })).toBe('image');
        expect(attachmentKind({ url: '/uploads/abc.JPG' })).toBe('image');
    });
    it('falls back to URL extension for videos', () => {
        expect(attachmentKind({ url: '/uploads/abc.mp4' })).toBe('video');
        expect(attachmentKind({ url: '/uploads/abc.MOV' })).toBe('video');
        expect(attachmentKind({ url: '/uploads/abc.mkv' })).toBe('video');
    });
    it('handles query strings / fragments in the URL', () => {
        expect(attachmentKind({ url: '/uploads/abc.mp4?v=1' })).toBe('video');
        expect(attachmentKind({ url: '/uploads/abc.png#frag' })).toBe('image');
    });
    it('treats unknown types as generic files', () => {
        expect(attachmentKind({ contentType: 'application/pdf' })).toBe('file');
        expect(attachmentKind({ url: '/uploads/weird.bin' })).toBe('file');
        expect(attachmentKind({})).toBe('file');
        expect(attachmentKind(null)).toBe('file');
    });
    it('prefers contentType over extension when both present', () => {
        // Mislabeled extension shouldn't override an explicit video/* content-type.
        expect(attachmentKind({ contentType: 'video/mp4', url: '/uploads/file.pdf' })).toBe('video');
    });
});
