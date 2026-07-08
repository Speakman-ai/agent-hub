import { describe, it, expect } from 'vitest';
import { RRWEB_PLAYER_JS, RRWEB_PLAYER_CSS } from './rrwebPlayerBundle.generated';

// Mobile mirror of client/src/utils/replayPlayerBundle.test.ts — a fast,
// dependency-only guard for the rrweb-io/rrweb#1872 broken-dist regression.
//
// The mobile WebView player inlines RRWEB_PLAYER_JS (the rrweb-player UMD, byte-
// identical to the file the web player inlines) into an opaque-origin data: URL
// and instantiates `window.rrwebPlayer`. rrweb-player's 2.0.0 / 2.0.1 builds
// shipped a Replayer-less shell that plays back blank-white with no JS error.
// This trips the instant a stripped build lands in the generated bundle — at
// unit speed, no WebView, no recording. Regenerate the bundle after a bump:
// `npm run generate:mobile-rrweb-bundle`.

describe('generated rrweb-player bundle (the module the WebView player inlines)', () => {
  it('exposes the rrwebPlayer UMD global the WebView bootstrap reads', () => {
    expect(RRWEB_PLAYER_JS).toContain('rrwebPlayer');
  });

  it('contains the rrweb Replayer engine, not just the empty player shell', () => {
    const engineMarkers = [
      'applyMutation',
      'applyIncremental',
      'rebuildFullSnapshot',
      'legacy_missingNodeRetryMap',
    ];
    const missing = engineMarkers.filter((m) => !RRWEB_PLAYER_JS.includes(m));
    expect(
      missing,
      `generated rrweb-player bundle is missing Replayer engine symbols: ${missing.join(', ')}. ` +
        'This is the rrweb-io/rrweb#1872 broken-dist regression. Regenerate from the ' +
        'pinned dist: npm run generate:mobile-rrweb-bundle (rrweb-player must stay 2.0.0-alpha.20).',
    ).toEqual([]);
  });

  it('is large enough to include the engine (shell-only builds are far smaller)', () => {
    // The broken shell-only 2.0.1 UMD-min was ~132 KB; the working build is ~220 KB.
    expect(RRWEB_PLAYER_JS.length).toBeGreaterThan(180_000);
  });

  it('ships the stylesheet the player inlines alongside the bundle', () => {
    expect(RRWEB_PLAYER_CSS).toContain('.rr-player');
  });
});
