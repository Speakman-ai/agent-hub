import { describe, it, expect } from 'vitest';
import {
  deriveServerBase,
  buildCaptureAssetUrl,
  filterCapturesByPr,
  partitionArtifacts,
  formatFileSize,
  formatDuration,
  captureStatusBadge,
} from './captures';

describe('deriveServerBase', () => {
  it('strips trailing /api', () => {
    expect(deriveServerBase('https://hub.example.com/api')).toBe('https://hub.example.com');
  });

  it('strips trailing slash', () => {
    expect(deriveServerBase('https://hub.example.com/')).toBe('https://hub.example.com');
  });

  it('handles base already without /api', () => {
    expect(deriveServerBase('https://hub.example.com')).toBe('https://hub.example.com');
  });

  it('returns empty string for invalid input', () => {
    expect(deriveServerBase('')).toBe('');
    expect(deriveServerBase(null)).toBe('');
    expect(deriveServerBase(undefined)).toBe('');
  });

  it('handles localhost', () => {
    expect(deriveServerBase('http://localhost:3051/api')).toBe('http://localhost:3051');
  });
});

describe('buildCaptureAssetUrl', () => {
  it('builds a full upload URL', () => {
    expect(buildCaptureAssetUrl('https://hub.example.com', 'cap-1', 'shot.png')).toBe(
      'https://hub.example.com/uploads/captures/cap-1/shot.png',
    );
  });

  it('strips trailing slash on base', () => {
    expect(buildCaptureAssetUrl('https://hub.example.com/', 'cap-1', 'shot.png')).toBe(
      'https://hub.example.com/uploads/captures/cap-1/shot.png',
    );
  });

  it('returns null for missing pieces', () => {
    expect(buildCaptureAssetUrl('', 'cap', 'f.png')).toBeNull();
    expect(buildCaptureAssetUrl('https://x', '', 'f.png')).toBeNull();
    expect(buildCaptureAssetUrl('https://x', 'cap', '')).toBeNull();
  });
});

describe('filterCapturesByPr', () => {
  const captures = [
    { id: 'a', pr_number: 100 },
    { id: 'b', pr_number: 101 },
    { id: 'c', pr_number: 100 },
    { id: 'd', pr_number: '100' }, // string form also matches
  ];

  it('matches on numeric pr number', () => {
    const out = filterCapturesByPr(captures, 100);
    expect(out.map((c) => c.id)).toEqual(['a', 'c', 'd']);
  });

  it('matches on string pr number', () => {
    const out = filterCapturesByPr(captures, '101');
    expect(out.map((c) => c.id)).toEqual(['b']);
  });

  it('returns empty list when no match', () => {
    expect(filterCapturesByPr(captures, 999)).toEqual([]);
  });

  it('handles null/undefined/empty gracefully', () => {
    expect(filterCapturesByPr(null, 100)).toEqual([]);
    expect(filterCapturesByPr(captures, null)).toEqual([]);
    expect(filterCapturesByPr(captures, undefined)).toEqual([]);
    expect(filterCapturesByPr(captures, '')).toEqual([]);
  });
});

describe('partitionArtifacts', () => {
  it('splits screenshots and videos', () => {
    const artifacts = [
      { id: 1, type: 'screenshot', filename: 'a.png' },
      { id: 2, type: 'video', filename: 'b.webm' },
      { id: 3, type: 'screenshot', filename: 'c.png' },
    ];
    const { screenshots, videos, consoleErrors } = partitionArtifacts(artifacts);
    expect(screenshots.map((a) => a.id)).toEqual([1, 3]);
    expect(videos.map((a) => a.id)).toEqual([2]);
    expect(consoleErrors).toEqual([]);
  });

  it('parses JSON-array console_errors', () => {
    const artifacts = [
      {
        id: 1,
        type: 'screenshot',
        route: '/home',
        console_errors: JSON.stringify(['boom', 'kapow']),
      },
    ];
    const { consoleErrors } = partitionArtifacts(artifacts);
    expect(consoleErrors).toEqual([
      { route: '/home', error: 'boom' },
      { route: '/home', error: 'kapow' },
    ]);
  });

  it('falls back to raw string when console_errors is not valid JSON', () => {
    const artifacts = [
      { id: 1, type: 'screenshot', label: 'page1', console_errors: 'bad string' },
    ];
    const { consoleErrors } = partitionArtifacts(artifacts);
    expect(consoleErrors).toEqual([{ route: 'page1', error: 'bad string' }]);
  });

  it('returns empty lists for null input', () => {
    expect(partitionArtifacts(null)).toEqual({
      screenshots: [],
      videos: [],
      consoleErrors: [],
    });
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });
  it('formats KB', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(2048)).toBe('2 KB');
  });
  it('formats MB', () => {
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
  it('returns empty string for zero/null', () => {
    expect(formatFileSize(0)).toBe('');
    expect(formatFileSize(null)).toBe('');
    expect(formatFileSize(undefined)).toBe('');
  });
});

describe('formatDuration', () => {
  it('formats sub-second as ms', () => {
    expect(formatDuration(450)).toBe('450ms');
  });
  it('formats seconds', () => {
    expect(formatDuration(3000)).toBe('3s');
  });
  it('formats minutes and seconds', () => {
    expect(formatDuration(65000)).toBe('1m 05s');
    expect(formatDuration(3 * 60 * 1000 + 7 * 1000)).toBe('3m 07s');
  });
  it('returns empty string for zero/null', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
  });
});

describe('captureStatusBadge', () => {
  it('maps known statuses', () => {
    expect(captureStatusBadge('done').label).toBe('Done');
    expect(captureStatusBadge('error').label).toBe('Error');
    expect(captureStatusBadge('queued').label).toBe('Queued');
    expect(captureStatusBadge('building').label).toBe('Building');
    expect(captureStatusBadge('capturing').label).toBe('Capturing');
  });
  it('falls back for unknown status', () => {
    expect(captureStatusBadge('weird').label).toBe('weird');
    expect(captureStatusBadge(undefined).label).toBe('Unknown');
  });
  it('returns color + bg for every case', () => {
    for (const s of ['queued', 'building', 'capturing', 'done', 'error', 'x']) {
      const b = captureStatusBadge(s);
      expect(typeof b.color).toBe('string');
      expect(typeof b.bg).toBe('string');
    }
  });
});
