/**
 * Replay player — sandbox + CSP render verification.
 *
 * The replay player runs rrweb-player inside a `sandbox="allow-scripts"` iframe
 * whose document carries a restrictive Content-Security-Policy (see
 * client/src/utils/replayPlayer.js `PLAYER_CSP`). The unit tests assert the CSP
 * *string*, but only a real browser proves the policy doesn't refuse rrweb's own
 * replay surface — rrweb's Replayer renders the captured DOM into an iframe it
 * creates (the initial about:blank), which `frame-src` governs.
 *
 * This spec records a real rrweb session, streams it through the EXACT
 * production srcDoc in a sandboxed iframe, and asserts the player actually
 * renders the recorded DOM under the CSP (not just constructs). If the CSP
 * blocked rrweb's internal frame, `new rrwebPlayer()` would throw (contentDocument
 * null) and the bootstrap would post `{type:'error'}` — so a clean `playing`
 * signal plus the rebuilt marker proves the policy and playback coexist.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildReplayPlayerSrcDoc, REPLAY_CHANNEL } from '../../client/src/utils/replayPlayer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '../../client');
const read = (rel: string) => readFileSync(path.join(clientDir, rel), 'utf8');

interface RrwebEvent {
  type: number;
}

interface ReplaySignal {
  type: string;
  ch?: string;
  message?: string;
}

test.describe('Replay player (sandboxed rrweb-player under CSP)', () => {
  // No app server needed — everything is driven via page.setContent + local
  // bundles, so this test is independent of the Hub backend.
  test('renders a real recording inside the CSP-locked sandbox iframe', async ({ page }) => {
    const playerJs = read('node_modules/rrweb-player/dist/rrweb-player.umd.min.cjs');
    const playerCss = read('node_modules/rrweb-player/dist/style.css');
    const rrwebJs = read('node_modules/rrweb/dist/rrweb.umd.min.cjs');
    const srcDoc = buildReplayPlayerSrcDoc(playerJs, playerCss);

    // 1. Record a tiny real rrweb session (full snapshot + an incremental
    //    mutation) of a page that contains a known marker.
    await page.setContent(
      '<!doctype html><html><body><h1 id="marker">REPLAY MARKER</h1><div id="box">a</div></body></html>',
    );
    await page.addScriptTag({ content: rrwebJs });
    const events = (await page.evaluate(
      () =>
        new Promise<RrwebEvent[]>((resolve) => {
          const evts: RrwebEvent[] = [];
          const rrweb = (
            window as Window & {
              rrweb?: { record: (opts: { emit: (e: RrwebEvent) => void }) => unknown };
            }
          ).rrweb;
          const stop = rrweb?.record({ emit: (e) => evts.push(e) });
          setTimeout(() => {
            document.getElementById('box')!.textContent = 'b';
          }, 60);
          setTimeout(() => {
            if (typeof stop === 'function') (stop as () => void)();
            resolve(evts);
          }, 450);
        }),
    )) as RrwebEvent[];
    expect(events.length).toBeGreaterThan(0);
    // A replay is unreconstructable without a FullSnapshot (rrweb EventType 2).
    expect(events.some((e) => e.type === 2)).toBe(true);

    // 2. Render through the production srcDoc in a sandbox="allow-scripts" iframe,
    //    exactly as ReplayPlayerModal does. Install the message listener BEFORE
    //    setting srcdoc so the bootstrap's "ready" can't be missed.
    await page.setContent(
      `<!doctype html><html><body>
        <iframe id="player" sandbox="allow-scripts" style="width:900px;height:600px;border:0"></iframe>
        <script>
          window.__signals = [];
          window.addEventListener('message', function (e) {
            if (e.data && e.data.ch === ${JSON.stringify(REPLAY_CHANNEL)}) window.__signals.push(e.data);
          });
        </script>
      </body></html>`,
    );
    await page.evaluate((doc: string) => {
      const player = document.getElementById('player') as HTMLIFrameElement | null;
      if (player) player.srcdoc = doc;
    }, srcDoc);

    // 3. Wait for the sandbox to announce ready, then stream the events in.
    await page.waitForFunction(
      () =>
        (window as Window & { __signals?: ReplaySignal[] }).__signals?.some(
          (s) => s.type === 'ready',
        ),
      null,
      {
        timeout: 20_000,
      },
    );
    await page.evaluate(
      ({ ch, evts }: { ch: string; evts: RrwebEvent[] }) => {
        const player = document.getElementById('player') as HTMLIFrameElement | null;
        const win = player?.contentWindow;
        if (!win) return;
        win.postMessage({ ch, type: 'chunk', events: evts }, '*');
        win.postMessage({ ch, type: 'end' }, '*');
      },
      { ch: REPLAY_CHANNEL, evts: events },
    );

    // 4. The bootstrap reports PLAYING only if `new rrwebPlayer()` succeeded —
    //    which requires the CSP to have permitted rrweb's internal replay frame.
    await page.waitForFunction(
      () =>
        (window as Window & { __signals?: ReplaySignal[] }).__signals?.some(
          (s) => s.type === 'playing',
        ),
      null,
      {
        timeout: 20_000,
      },
    );
    const signals = (await page.evaluate(
      () => (window as Window & { __signals?: ReplaySignal[] }).__signals ?? [],
    )) as ReplaySignal[];
    expect(
      signals.some((s) => s.type === 'error'),
      `player posted an error under the CSP: ${JSON.stringify(signals)}`,
    ).toBe(false);

    // 5. Strongest proof: the recorded DOM was actually rebuilt INTO rrweb's
    //    internal iframe. We evaluate inside the sandboxed player frame and reach
    //    into its child iframe's contentDocument (same opaque origin, so the
    //    player's own script can read it). A frame-src block would leave
    //    contentDocument null and the marker absent.
    const playerFrame = page.frames().find((f) => f.url() === 'about:srcdoc');
    expect(playerFrame, 'sandboxed player frame should exist').toBeTruthy();
    await playerFrame!.waitForFunction(
      () => {
        const inner = document.querySelector('iframe');
        const doc = inner && inner.contentDocument;
        return !!(doc && doc.body && /REPLAY MARKER/.test(doc.body.innerText));
      },
      null,
      { timeout: 20_000 },
    );

    const rendered = await playerFrame!.evaluate(() => {
      const inner = document.querySelector('iframe');
      return {
        hasPlayerRoot: !!document.querySelector('.rr-player'),
        hasInnerFrame: !!inner,
        markerInInnerFrame: !!(
          inner &&
          inner.contentDocument &&
          inner.contentDocument.body &&
          /REPLAY MARKER/.test(inner.contentDocument.body.innerText)
        ),
      };
    });
    expect(rendered.hasInnerFrame).toBe(true); // frame-src did NOT block rrweb's frame
    expect(rendered.markerInInnerFrame).toBe(true); // captured DOM actually replayed
    expect(rendered.hasPlayerRoot).toBe(true); // rrweb-player UI mounted
  });
});
