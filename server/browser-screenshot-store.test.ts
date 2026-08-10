import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BROWSER_SCREENSHOT_DIR_NAME,
  browserScreenshotDirForSession,
  browserScreenshotStoreRoot,
  extensionForScreenshotMime,
  formatScreenshotBytes,
  pruneBrowserScreenshots,
  removeBrowserScreenshotsForSession,
  resolveScreenshotDataDir,
  saveBrowserScreenshot,
  screenshotObservationLines,
  sweepBrowserScreenshotStore,
} from './browser-screenshot-store.js';

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]).toString('base64');

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-shot-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('browserScreenshotDirForSession', () => {
  it('builds a per-session dir under the data dir', () => {
    const dir = browserScreenshotDirForSession('abc-123', '/data');
    expect(dir).toBe(path.join('/data', BROWSER_SCREENSHOT_DIR_NAME, 'abc-123'));
  });

  it('refuses session ids that would escape the data dir', () => {
    for (const bad of ['../evil', 'a/b', '..', '.', '', 'x'.repeat(200), 'a\0b']) {
      expect(browserScreenshotDirForSession(bad, '/data')).toBeNull();
    }
  });

  it('refuses an empty data dir', () => {
    expect(browserScreenshotDirForSession('abc-123', '')).toBeNull();
  });
});

describe('extensionForScreenshotMime', () => {
  it('maps known mimes and defaults to jpg', () => {
    expect(extensionForScreenshotMime('image/jpeg')).toBe('jpg');
    expect(extensionForScreenshotMime('image/PNG')).toBe('png');
    expect(extensionForScreenshotMime('image/webp')).toBe('webp');
    expect(extensionForScreenshotMime('application/pdf')).toBe('jpg');
    expect(extensionForScreenshotMime(undefined)).toBe('jpg');
  });
});

describe('formatScreenshotBytes', () => {
  it('renders B / KB / MB', () => {
    expect(formatScreenshotBytes(512)).toBe('512 B');
    expect(formatScreenshotBytes(2048)).toBe('2.0 KB');
    expect(formatScreenshotBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('saveBrowserScreenshot', () => {
  it('writes decoded bytes and returns a readable absolute path', () => {
    const saved = saveBrowserScreenshot({
      sessionId: 'sess-1',
      dataDir,
      imageBase64: JPEG_B64,
      mime: 'image/jpeg',
    });
    expect(saved).not.toBeNull();
    expect(path.isAbsolute(saved!.absPath)).toBe(true);
    expect(saved!.fileName).toMatch(/^browser-\d+-[0-9a-f]{8}\.jpg$/);
    expect(saved!.bytes).toBe(8);
    expect(fs.readFileSync(saved!.absPath)).toEqual(Buffer.from(JPEG_B64, 'base64'));
    expect(
      saved!.absPath.startsWith(path.join(dataDir, BROWSER_SCREENSHOT_DIR_NAME, 'sess-1')),
    ).toBe(true);
  });

  it('honours the label and mime in the file name', () => {
    const saved = saveBrowserScreenshot({
      sessionId: 'sess-1',
      dataDir,
      imageBase64: JPEG_B64,
      mime: 'image/png',
      label: 'preview',
    });
    expect(saved!.fileName).toMatch(/^preview-\d+-[0-9a-f]{8}\.png$/);
  });

  it('falls back to the default label when the label is not a safe slug', () => {
    const saved = saveBrowserScreenshot({
      sessionId: 'sess-1',
      dataDir,
      imageBase64: JPEG_B64,
      label: '../../etc/passwd',
    });
    expect(saved!.fileName.startsWith('browser-')).toBe(true);
  });

  it('returns null (never throws) for an unsafe session id', () => {
    expect(
      saveBrowserScreenshot({ sessionId: '../escape', dataDir, imageBase64: JPEG_B64 }),
    ).toBeNull();
  });

  it('returns null for empty image data', () => {
    expect(saveBrowserScreenshot({ sessionId: 'sess-1', dataDir, imageBase64: '' })).toBeNull();
  });

  it('prunes to the newest N captures per session', () => {
    const dir = browserScreenshotDirForSession('sess-prune', dataDir)!;
    for (let i = 0; i < 6; i++) {
      const saved = saveBrowserScreenshot({
        sessionId: 'sess-prune',
        dataDir,
        imageBase64: JPEG_B64,
        retain: 3,
      });
      expect(saved).not.toBeNull();
      // Distinct mtimes so prune ordering is deterministic.
      fs.utimesSync(
        saved!.absPath,
        new Date(1_700_000_000_000 + i * 1000),
        new Date(1_700_000_000_000 + i * 1000),
      );
    }
    expect(fs.readdirSync(dir)).toHaveLength(3);
  });

  it('keeps sessions isolated from each other', () => {
    saveBrowserScreenshot({ sessionId: 'a', dataDir, imageBase64: JPEG_B64, retain: 1 });
    saveBrowserScreenshot({ sessionId: 'b', dataDir, imageBase64: JPEG_B64, retain: 1 });
    expect(fs.readdirSync(browserScreenshotDirForSession('a', dataDir)!)).toHaveLength(1);
    expect(fs.readdirSync(browserScreenshotDirForSession('b', dataDir)!)).toHaveLength(1);
  });
});

describe('pruneBrowserScreenshots', () => {
  it('is a no-op on a missing directory', () => {
    expect(pruneBrowserScreenshots(path.join(dataDir, 'nope'), 5)).toBe(0);
  });
});

describe('removeBrowserScreenshotsForSession', () => {
  it('drops the whole directory for a deleted session', () => {
    saveBrowserScreenshot({ sessionId: 'gone', dataDir, imageBase64: JPEG_B64 });
    saveBrowserScreenshot({ sessionId: 'stays', dataDir, imageBase64: JPEG_B64 });
    const goneDir = browserScreenshotDirForSession('gone', dataDir)!;
    expect(fs.existsSync(goneDir)).toBe(true);

    expect(removeBrowserScreenshotsForSession('gone', dataDir)).toBe(true);

    expect(fs.existsSync(goneDir)).toBe(false);
    // Sibling sessions are untouched.
    expect(fs.existsSync(browserScreenshotDirForSession('stays', dataDir)!)).toBe(true);
  });

  it('is a no-op for a session that never captured anything', () => {
    expect(removeBrowserScreenshotsForSession('never', dataDir)).toBe(false);
  });

  it('refuses an unsafe session id rather than deleting outside the store', () => {
    expect(removeBrowserScreenshotsForSession('../..', dataDir)).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(true);
  });
});

describe('sweepBrowserScreenshotStore', () => {
  const NOW = 1_800_000_000_000;

  /** Create a session dir with `count` files, all aged `ageMs` old. */
  function seedSession(sessionId: string, count: number, ageMs: number, bytes = 8): void {
    const dir = browserScreenshotDirForSession(sessionId, dataDir)!;
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      const file = path.join(dir, `browser-${i}.jpg`);
      fs.writeFileSync(file, Buffer.alloc(bytes, 1));
      const when = new Date(NOW - ageMs);
      fs.utimesSync(file, when, when);
    }
  }

  it('reclaims an orphaned directory whose session is long gone', () => {
    // The regression the reviewer asked for: nothing else collects a session
    // dir whose row vanished without passing through the hard-delete path.
    seedSession('orphan', 20, 30 * 24 * 60 * 60 * 1000);
    seedSession('recent', 3, 60 * 60 * 1000);

    const r = sweepBrowserScreenshotStore({ dataDir, nowMs: NOW });

    expect(r.dirsRemoved).toBe(1);
    expect(fs.existsSync(browserScreenshotDirForSession('orphan', dataDir)!)).toBe(false);
    expect(fs.existsSync(browserScreenshotDirForSession('recent', dataDir)!)).toBe(true);
    expect(r.bytesReclaimed).toBe(20 * 8);
    expect(r.bytesRemaining).toBe(3 * 8);
  });

  it('keeps a directory whose newest capture is still inside the age window', () => {
    seedSession('busy', 1, 6 * 24 * 60 * 60 * 1000);
    const r = sweepBrowserScreenshotStore({ dataDir, nowMs: NOW });
    expect(r.dirsRemoved).toBe(0);
    expect(fs.existsSync(browserScreenshotDirForSession('busy', dataDir)!)).toBe(true);
  });

  it('enforces the global size ceiling oldest-first once age alone is not enough', () => {
    // All three are inside the age window, so only the size bound can act.
    seedSession('oldest', 1, 3 * 60 * 60 * 1000, 1000);
    seedSession('middle', 1, 2 * 60 * 60 * 1000, 1000);
    seedSession('newest', 1, 1 * 60 * 60 * 1000, 1000);

    const r = sweepBrowserScreenshotStore({ dataDir, nowMs: NOW, maxTotalBytes: 2500 });

    expect(r.dirsRemoved).toBe(1);
    expect(fs.existsSync(browserScreenshotDirForSession('oldest', dataDir)!)).toBe(false);
    expect(fs.existsSync(browserScreenshotDirForSession('middle', dataDir)!)).toBe(true);
    expect(fs.existsSync(browserScreenshotDirForSession('newest', dataDir)!)).toBe(true);
    expect(r.bytesRemaining).toBe(2000);
  });

  it('removes as many oldest dirs as the budget requires', () => {
    seedSession('a', 1, 5 * 60 * 60 * 1000, 1000);
    seedSession('b', 1, 4 * 60 * 60 * 1000, 1000);
    seedSession('c', 1, 3 * 60 * 60 * 1000, 1000);
    seedSession('d', 1, 2 * 60 * 60 * 1000, 1000);

    const r = sweepBrowserScreenshotStore({ dataDir, nowMs: NOW, maxTotalBytes: 1500 });

    expect(r.dirsRemoved).toBe(3);
    expect(r.bytesRemaining).toBe(1000);
    expect(fs.existsSync(browserScreenshotDirForSession('d', dataDir)!)).toBe(true);
  });

  it('sweeps an empty leftover directory', () => {
    fs.mkdirSync(browserScreenshotDirForSession('empty', dataDir)!, { recursive: true });
    const r = sweepBrowserScreenshotStore({ dataDir, nowMs: NOW });
    expect(r.dirsRemoved).toBe(1);
  });

  it('is a no-op when the store was never created', () => {
    const r = sweepBrowserScreenshotStore({ dataDir, nowMs: NOW });
    expect(r).toEqual({ dirsRemoved: 0, bytesReclaimed: 0, bytesRemaining: 0 });
  });

  it('bounds the store across many accumulated sessions end to end', () => {
    // The actual reported risk: sessions completing normally, each within its
    // own 20-capture cap, growing the store without limit.
    for (let i = 0; i < 40; i++) {
      seedSession(`sess-${i}`, 20, (i + 1) * 60 * 60 * 1000, 1000);
    }
    expect(fs.readdirSync(browserScreenshotStoreRoot(dataDir)!)).toHaveLength(40);

    const r = sweepBrowserScreenshotStore({ dataDir, nowMs: NOW, maxTotalBytes: 100_000 });

    expect(r.bytesRemaining).toBeLessThanOrEqual(100_000);
    expect(fs.readdirSync(browserScreenshotStoreRoot(dataDir)!).length).toBeLessThan(40);
  });
});

describe('screenshotObservationLines', () => {
  it('reports the saved path and stays tiny', () => {
    const lines = screenshotObservationLines(
      {
        absPath: '/data/browser-screenshots/s/browser-1.jpg',
        fileName: 'browser-1.jpg',
        bytes: 4096,
      },
      'image/jpeg',
    );
    const text = lines.join('\n');
    expect(text).toContain('/data/browser-screenshots/s/browser-1.jpg');
    expect(text).toContain('4.0 KB');
    expect(text).not.toContain('base64');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(400);
  });

  it('explains the miss when the capture could not be persisted', () => {
    const text = screenshotObservationLines(null, 'image/jpeg').join('\n');
    expect(text).toMatch(/could not be written to disk/i);
  });
});

describe('resolveScreenshotDataDir', () => {
  const prev = process.env.AGENT_HUB_DATA_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_HUB_DATA_DIR;
    else process.env.AGENT_HUB_DATA_DIR = prev;
  });

  it('prefers AGENT_HUB_DATA_DIR', () => {
    process.env.AGENT_HUB_DATA_DIR = '/custom/data';
    expect(resolveScreenshotDataDir()).toBe('/custom/data');
  });

  it('falls back to the home data dir', () => {
    delete process.env.AGENT_HUB_DATA_DIR;
    expect(resolveScreenshotDataDir()).toBe(path.join(os.homedir(), '.agent-hub', 'data'));
  });
});
