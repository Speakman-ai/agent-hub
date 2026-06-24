/**
 * Replay player — isolated-origin render + host-isolation verification.
 *
 * The replay player loads its document as a `data:` URL (opaque origin) into an
 * iframe with `sandbox="allow-scripts allow-same-origin"` and a restrictive CSP
 * (see client/src/utils/replayPlayer.ts `PLAYER_CSP`). Two properties only a real
 * browser can prove, and that this spec asserts:
 *
 *   1. RENDER — rrweb's Replayer rebuilds the captured DOM into a nested iframe.
 *      That nested frame must share the player's opaque origin to be writable;
 *      `allow-same-origin` (on top of the data: opaque origin) is what permits
 *      that. Without it the nested frame gets its own opaque origin, the player
 *      can't reach its contentDocument, and the replay renders blank.
 *
 *   2. HOST ISOLATION — because the document is a data: URL (opaque origin), the
 *      frame is CROSS-origin to the embedding page. `allow-same-origin` does NOT
 *      relax that (a data: origin is opaque regardless), so the player frame
 *      cannot read the host `document` / cookies / `localStorage` — those throw
 *      SecurityError. This is the trust boundary protecting sensitive replay
 *      content, and the unit tests can only pin the wiring; this proves the
 *      boundary actually holds in a browser.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildReplayPlayerDataUrl, REPLAY_CHANNEL } from '../../client/src/utils/replayPlayer.js';

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
    const playerSrc = buildReplayPlayerDataUrl(playerJs, playerCss);

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

    // 2. Render through the production data: URL in a sandboxed iframe, exactly
    //    as ReplayPlayerModal does. The host page stashes a secret on `window`
    //    so step 6 can prove the player frame (a distinct opaque origin) cannot
    //    read host JS state. Install the message listener BEFORE setting src so
    //    the bootstrap's "ready" can't be missed. No app server needed.
    await page.setContent(
      `<!doctype html><html><body>
        <iframe id="player" sandbox="allow-scripts allow-same-origin" style="width:900px;height:600px;border:0"></iframe>
        <script>
          window.__hostSecret = 'TOP-SECRET-HOST-STATE';
          window.__signals = [];
          window.addEventListener('message', function (e) {
            if (e.data && e.data.ch === ${JSON.stringify(REPLAY_CHANNEL)}) window.__signals.push(e.data);
          });
        </script>
      </body></html>`,
    );
    await page.evaluate((src: string) => {
      const player = document.getElementById('player') as HTMLIFrameElement | null;
      if (player) player.src = src;
    }, playerSrc);

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

    // 5. Strongest render proof: the recorded DOM was actually rebuilt INTO
    //    rrweb's internal iframe. We evaluate inside the player frame and reach
    //    into its child iframe's contentDocument (same-origin — the child shares
    //    the player's opaque origin via allow-same-origin, so the player's own
    //    script can read it). Without that the nested frame is a distinct opaque
    //    origin, the read throws / contentDocument is null, and the replay is
    //    blank — the production bug this guards against.
    const playerFrame = page.frames().find((f) => f.url().startsWith('data:text/html'));
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

    // 6. HOST ISOLATION (the security invariant): the player frame runs at an
    //    opaque origin (data: URL), so it is CROSS-origin to the embedding host
    //    page. Reaching for host JS state, the host document, or host storage
    //    must throw SecurityError — even though allow-scripts allow-same-origin
    //    is set, because allow-same-origin does not relax a data: opaque origin.
    //    If this ever passes (frame became same-origin to host), the isolation
    //    boundary for sensitive replay content is gone — fail loudly.
    const isolation = await playerFrame!.evaluate(() => {
      const probe = (fn: () => unknown) => {
        try {
          return { blocked: false, value: String(fn()) };
        } catch (e) {
          return { blocked: true, name: (e as Error).name };
        }
      };
      return {
        hostSecret: probe(
          () => (window.parent as unknown as { __hostSecret: string }).__hostSecret,
        ),
        hostDocument: probe(() => window.parent.document.title),
        hostLocalStorage: probe(() => window.parent.localStorage.length),
      };
    });
    expect(isolation.hostSecret.blocked, 'host window state must be unreadable').toBe(true);
    expect(isolation.hostDocument.blocked, 'host document must be unreadable').toBe(true);
    expect(isolation.hostLocalStorage.blocked, 'host localStorage must be unreadable').toBe(true);
  });
});
