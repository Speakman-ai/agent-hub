import { describe, it, expect } from 'vitest';
import { buildCaptureArtifacts, formatCaptureSize, buildUploadsUrl } from '../utils/capture.js';

/**
 * Test the shared capture data helpers used by PreviewsPage CaptureGallery.
 */

describe('Preview capture data helpers', () => {
  const sampleCaptures = [
    {
      id: 'preview-1-ss-home',
      preview_id: 'preview-1',
      type: 'screenshot',
      route: '/',
      name: 'home',
      label: 'Home',
      filename: 'screenshot-home.png',
      file_path: 'captures/preview-1/screenshot-home.png',
      file_size: 45_000,
      created_at: '2026-04-16 00:10:00',
    },
    {
      id: 'preview-1-ss-chat',
      preview_id: 'preview-1',
      type: 'screenshot',
      route: '/chat',
      name: 'chat',
      label: 'Chat',
      filename: 'screenshot-chat.png',
      file_path: 'captures/preview-1/screenshot-chat.png',
      file_size: 62_000,
      created_at: '2026-04-16 00:10:01',
    },
    {
      id: 'preview-1-video',
      preview_id: 'preview-1',
      type: 'video',
      route: null,
      name: 'walkthrough',
      label: 'Video Walkthrough',
      filename: 'walkthrough.webm',
      file_path: 'captures/preview-1/walkthrough.webm',
      file_size: 2_500_000,
      created_at: '2026-04-16 00:10:05',
    },
  ];

  describe('buildCaptureArtifacts', () => {
    it('separates screenshots from videos', () => {
      const { screenshots, videos } = buildCaptureArtifacts(sampleCaptures);
      expect(screenshots).toHaveLength(2);
      expect(videos).toHaveLength(1);
    });

    it('returns empty arrays for no captures', () => {
      const { screenshots, videos } = buildCaptureArtifacts([]);
      expect(screenshots).toHaveLength(0);
      expect(videos).toHaveLength(0);
    });

    it('handles screenshots-only captures', () => {
      const screenshotsOnly = sampleCaptures.filter((c) => c.type === 'screenshot');
      const { screenshots, videos } = buildCaptureArtifacts(screenshotsOnly);
      expect(screenshots).toHaveLength(2);
      expect(videos).toHaveLength(0);
    });

    it('handles videos-only captures', () => {
      const videosOnly = sampleCaptures.filter((c) => c.type === 'video');
      const { screenshots, videos } = buildCaptureArtifacts(videosOnly);
      expect(screenshots).toHaveLength(0);
      expect(videos).toHaveLength(1);
    });
  });

  describe('formatCaptureSize', () => {
    it('formats bytes under 1KB', () => {
      expect(formatCaptureSize(500)).toBe('500 B');
    });

    it('formats KB values', () => {
      expect(formatCaptureSize(45_000)).toBe('44 KB');
    });

    it('formats large files in MB', () => {
      expect(formatCaptureSize(2_500_000)).toBe('2.4 MB');
    });

    it('formats zero bytes', () => {
      expect(formatCaptureSize(0)).toBe('0 B');
    });

    it('formats exactly 1 MB', () => {
      expect(formatCaptureSize(1_048_576)).toBe('1.0 MB');
    });
  });

  describe('buildUploadsUrl', () => {
    it('builds URL with empty server base (local mode)', () => {
      const url = buildUploadsUrl('', 'captures/preview-1/screenshot-home.png');
      expect(url).toBe('/uploads/captures/preview-1/screenshot-home.png');
    });

    it('builds URL with remote server base', () => {
      const url = buildUploadsUrl('https://remote:3051', 'captures/preview-1/screenshot-home.png');
      expect(url).toBe('https://remote:3051/uploads/captures/preview-1/screenshot-home.png');
    });

    it('builds video URL correctly', () => {
      const url = buildUploadsUrl('', 'captures/preview-1/walkthrough.webm');
      expect(url).toBe('/uploads/captures/preview-1/walkthrough.webm');
    });
  });

  describe('capture metadata structure', () => {
    it('screenshot captures have required fields', () => {
      const ss = sampleCaptures[0];
      expect(ss.type).toBe('screenshot');
      expect(ss.route).toBeTruthy();
      expect(ss.name).toBeTruthy();
      expect(ss.label).toBeTruthy();
      expect(ss.filename).toMatch(/\.png$/);
      expect(ss.file_path).toContain('captures/');
      expect(ss.file_size).toBeGreaterThan(0);
    });

    it('video captures have required fields', () => {
      const vid = sampleCaptures[2];
      expect(vid.type).toBe('video');
      expect(vid.route).toBeNull();
      expect(vid.name).toBe('walkthrough');
      expect(vid.filename).toMatch(/\.webm$/);
      expect(vid.file_size).toBeGreaterThan(0);
    });
  });
});
