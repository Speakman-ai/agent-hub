/**
 * Tests for the always-on `tool: design` ReAct step (design-react.ts).
 *
 * The Chromium render is injected as a stub, so nothing here launches a real
 * browser. Artifact writes go to a real tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  runDesignReActStep,
  toFullDesignDocument,
  resolveDesignRenderLocation,
  DESIGN_RENDER_FILENAME,
  MAX_DESIGN_HTML_BYTES,
  type DesignRenderResult,
} from './design-react.js';
import { worktreeDesignLocation, dataDirDesignLocation } from './design-artifact-store.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'design-react-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 1x1 transparent PNG, as base64 — enough for saveBrowserScreenshot to persist.
const TINY_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function okRender(): DesignRenderResult {
  return { ok: true, imageBase64: TINY_B64, mime: 'image/png' };
}

function makeDeps(over: Partial<Parameters<typeof runDesignReActStep>[1]> = {}) {
  return {
    location: dataDirDesignLocation(tmp, 'sess-1'),
    sessionId: 'sess-1',
    screenshotDataDir: path.join(tmp, 'shots'),
    servedPath: '/session-files/sess-1/design/index.html',
    render: async () => okRender(),
    ...over,
  } as Parameters<typeof runDesignReActStep>[1];
}

describe('toFullDesignDocument', () => {
  it('wraps a body fragment in a minimal document', () => {
    const doc = toFullDesignDocument('<h1>Hi</h1>', 'My Chart');
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('<title>My Chart</title>');
    expect(doc).toContain('<h1>Hi</h1>');
  });

  it('escapes the title', () => {
    const doc = toFullDesignDocument('<p>x</p>', '<script>alert(1)</script>');
    expect(doc).toContain('&lt;script&gt;');
    expect(doc).not.toContain('<title><script>');
  });

  it('leaves a full document untouched', () => {
    const full = '<!DOCTYPE html><html><head></head><body>done</body></html>';
    expect(toFullDesignDocument(full)).toBe(full);
  });

  it('treats an <html>-rooted document as full even without a doctype', () => {
    const full = '<html><body>ok</body></html>';
    expect(toFullDesignDocument(full)).toBe(full);
  });
});

describe('resolveDesignRenderLocation', () => {
  it('uses the worktree design dir when a worktree exists', () => {
    const loc = resolveDesignRenderLocation({
      worktreePath: '/wt/session-9',
      sessionId: 's9',
      dataDir: '/data',
    });
    expect(loc).toEqual(worktreeDesignLocation('/wt/session-9'));
    expect(loc.kind).toBe('worktree');
  });

  it('falls back to the per-session data-dir store with no worktree', () => {
    const loc = resolveDesignRenderLocation({
      worktreePath: '   ',
      sessionId: 's9',
      dataDir: '/data',
    });
    expect(loc).toEqual(dataDirDesignLocation('/data', 's9'));
    expect(loc.kind).toBe('data-dir');
  });
});

describe('runDesignReActStep — validation', () => {
  it('rejects an unsupported op', async () => {
    const r = await runDesignReActStep({ op: 'clear', html: '<p>x</p>' }, makeDeps());
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('bad_op');
  });

  it('rejects missing html', async () => {
    const r = await runDesignReActStep({ op: 'render' }, makeDeps());
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('missing_html');
  });

  it('rejects oversize html', async () => {
    const big = 'x'.repeat(MAX_DESIGN_HTML_BYTES + 1);
    const r = await runDesignReActStep({ op: 'render', html: big }, makeDeps());
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('html_too_large');
  });
});

describe('runDesignReActStep — render', () => {
  it('writes the artifact and streams the screenshot on success', async () => {
    const r = await runDesignReActStep(
      { op: 'render', html: '<h1>Chart</h1>', title: 'T' },
      makeDeps(),
    );
    expect(r.hostExit).toBe(0);
    expect(r.hostDetail).toBe('render');
    expect(r.markdown).toContain('## Design rendered');
    expect(r.ui?.screenshotCaptured).toBe(true);
    expect(r.ui?.screenshotWsUrl).toContain('data:image/png;base64,');

    const written = path.join(dataDirDesignLocation(tmp, 'sess-1').root, DESIGN_RENDER_FILENAME);
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toContain('<h1>Chart</h1>');
  });

  it('passes the wrapped full document to the renderer', async () => {
    let seen = '';
    await runDesignReActStep(
      { op: 'render', html: '<h1>Chart</h1>' },
      makeDeps({
        render: async (html: string) => {
          seen = html;
          return okRender();
        },
      }),
    );
    expect(seen).toContain('<!doctype html>');
    expect(seen).toContain('<h1>Chart</h1>');
  });

  it('still saves the artifact when the render fails (soft warning, exit 0)', async () => {
    const r = await runDesignReActStep(
      { op: 'render', html: '<h1>Chart</h1>' },
      makeDeps({ render: async () => ({ ok: false, error: 'Chromium failed to launch' }) }),
    );
    expect(r.hostExit).toBe(0);
    expect(r.hostDetail).toBe('render_failed');
    expect(r.markdown).toContain('artifact saved');
    expect(r.markdown).toContain('Chromium failed to launch');
    expect(r.ui?.screenshotCaptured).toBeUndefined();

    const written = path.join(dataDirDesignLocation(tmp, 'sess-1').root, DESIGN_RENDER_FILENAME);
    expect(existsSync(written)).toBe(true);
  });

  it('surfaces a persist failure as a warning but still renders (exit 1)', async () => {
    const r = await runDesignReActStep(
      { op: 'render', html: '<h1>Chart</h1>' },
      makeDeps({
        writeArtifact: () => {
          throw new Error('disk full');
        },
      }),
    );
    expect(r.markdown).toContain('could not persist the artifact');
    expect(r.markdown).toContain('disk full');
    // Render still produced an image, so the screenshot is streamed…
    expect(r.ui?.screenshotCaptured).toBe(true);
    // …but a lost artifact must NOT read as a fully successful host step:
    // the saved artifact is a required output, so the exit is non-zero.
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('persist_failed');
  });

  it('reports persist_failed with exit 1 when both write and render fail', async () => {
    const r = await runDesignReActStep(
      { op: 'render', html: '<h1>Chart</h1>' },
      makeDeps({
        writeArtifact: () => {
          throw new Error('disk full');
        },
        render: async () => ({ ok: false, error: 'Chromium failed to launch' }),
      }),
    );
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('persist_failed');
    expect(r.markdown).toContain('could not be saved');
    expect(r.ui?.screenshotCaptured).toBeUndefined();
  });
});
