import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Regression guard for rrweb-io/rrweb#1872.
//
// `ReplayPlayerModal` inlines `rrweb-player/dist/rrweb-player.umd.min.cjs` as
// raw text into a sandboxed iframe and instantiates `window.rrwebPlayer`. The
// player's published 2.0.0 / 2.0.1 builds shipped a BROKEN dist: a Vite/Svelte
// build regression stripped the component lifecycle, so the bundle declared
// `let replayer;` but never created it — `new Replayer(...)` and the entire
// rrweb Replayer engine were absent from the artifact. At runtime the player
// mounted only an empty `.rr-player__frame` shell and every recording played
// back blank-white with no JS error (status stuck on "Playing"). The browser
// e2e (`e2e/tests/replay-player.spec.ts`) would catch it, but only when the
// E2E suite runs; this is a fast, dependency-only guard that fails the instant
// a Replayer-less player build lands in the tree — at unit-test speed, no
// browser, no recording.
//
// We assert against the EXACT file the modal inlines, so a silent dependency
// bump back to a broken build trips here regardless of version string.

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = resolve(here, '../../node_modules/rrweb-player/dist/rrweb-player.umd.min.cjs');
const STYLE_PATH = resolve(here, '../../node_modules/rrweb-player/dist/style.css');

describe('rrweb-player UMD bundle (the file ReplayPlayerModal inlines)', () => {
  const bundle = readFileSync(BUNDLE_PATH, 'utf8');

  it('exposes the rrwebPlayer UMD global the iframe bootstrap reads', () => {
    // IFRAME_BOOTSTRAP does `window.rrwebPlayer || {}` then `ns.default || ns.Player || ns`.
    expect(bundle).toContain('rrwebPlayer');
  });

  it('contains the rrweb Replayer engine, not just the empty player shell', () => {
    // These are rrweb Replayer internals that survive minification (method /
    // property names). All were ABSENT from the broken rrweb-player@2.0.1 dist,
    // which is exactly why playback was blank. If any goes missing the player
    // can mount its chrome but can never reconstruct the recorded DOM.
    const engineMarkers = [
      'applyMutation',
      'applyIncremental',
      'rebuildFullSnapshot',
      'legacy_missingNodeRetryMap',
    ];
    const missing = engineMarkers.filter((m) => !bundle.includes(m));
    expect(
      missing,
      `rrweb-player bundle is missing Replayer engine symbols: ${missing.join(', ')}. ` +
        'This is the rrweb-io/rrweb#1872 broken-dist regression (player ships an ' +
        'empty .rr-player__frame shell, replays blank-white). Do not use ' +
        'rrweb-player 2.0.0 / 2.0.1 — pin 2.0.0-alpha.20 (last good build).',
    ).toEqual([]);
  });

  it('is large enough to include the engine (shell-only builds are far smaller)', () => {
    // The broken shell-only 2.0.1 UMD-min was ~132 KB; the working build that
    // bundles the Replayer engine is ~220 KB. A hard floor catches a silent
    // regression to a stripped build even if symbol names change upstream.
    expect(bundle.length).toBeGreaterThan(180_000);
  });

  it('ships the stylesheet the modal inlines alongside the bundle', () => {
    const css = readFileSync(STYLE_PATH, 'utf8');
    expect(css).toContain('.rr-player');
  });
});
