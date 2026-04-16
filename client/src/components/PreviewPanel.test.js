import { describe, it, expect } from 'vitest';
import { formatFileSize, buildUploadsUrl, separateCaptures } from './PreviewPanel.jsx';

describe('PreviewPanel utilities', () => {
  describe('formatFileSize', () => {
    it('returns "0 B" for zero', () => {
      expect(formatFileSize(0)).toBe('0 B');
    });

    it('returns "0 B" for null/undefined', () => {
      expect(formatFileSize(null)).toBe('0 B');
      expect(formatFileSize(undefined)).toBe('0 B');
    });

    it('formats bytes under 1KB', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('formats KB values', () => {
      expect(formatFileSize(2048)).toBe('2 KB');
      expect(formatFileSize(45000)).toBe('44 KB');
    });

    it('formats MB values', () => {
      expect(formatFileSize(1048576)).toBe('1.0 MB');
      expect(formatFileSize(2500000)).toBe('2.4 MB');
    });
  });

  describe('buildUploadsUrl', () => {
    it('builds local URL with empty server base', () => {
      expect(buildUploadsUrl('', 'captures/p1/screenshot.png')).toBe(
        '/uploads/captures/p1/screenshot.png',
      );
    });

    it('builds remote URL with server base', () => {
      expect(buildUploadsUrl('https://remote:3051', 'captures/p1/screenshot.png')).toBe(
        'https://remote:3051/uploads/captures/p1/screenshot.png',
      );
    });

    it('builds video URL', () => {
      expect(buildUploadsUrl('', 'captures/p1/walkthrough.webm')).toBe(
        '/uploads/captures/p1/walkthrough.webm',
      );
    });
  });

  describe('separateCaptures', () => {
    const sampleCaptures = [
      { id: '1', type: 'screenshot', label: 'Home' },
      { id: '2', type: 'screenshot', label: 'Chat' },
      { id: '3', type: 'video', label: 'Walkthrough' },
    ];

    it('separates screenshots from videos', () => {
      const { screenshots, videos } = separateCaptures(sampleCaptures);
      expect(screenshots).toHaveLength(2);
      expect(videos).toHaveLength(1);
    });

    it('returns empty arrays for no captures', () => {
      const { screenshots, videos } = separateCaptures([]);
      expect(screenshots).toHaveLength(0);
      expect(videos).toHaveLength(0);
    });

    it('handles screenshots only', () => {
      const { screenshots, videos } = separateCaptures([
        { id: '1', type: 'screenshot' },
        { id: '2', type: 'screenshot' },
      ]);
      expect(screenshots).toHaveLength(2);
      expect(videos).toHaveLength(0);
    });

    it('handles videos only', () => {
      const { screenshots, videos } = separateCaptures([{ id: '1', type: 'video' }]);
      expect(screenshots).toHaveLength(0);
      expect(videos).toHaveLength(1);
    });

    it('ignores unknown types', () => {
      const { screenshots, videos } = separateCaptures([
        { id: '1', type: 'screenshot' },
        { id: '2', type: 'unknown' },
      ]);
      expect(screenshots).toHaveLength(1);
      expect(videos).toHaveLength(0);
    });
  });
});
