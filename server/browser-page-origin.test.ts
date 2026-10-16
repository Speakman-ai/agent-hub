import './test/setup.js';
import { existsSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { hostOfSerializedOrigin, readMainFrameOriginViaCdp } from './browser-page-origin.js';
import { readActivePageOrigin } from './browser-tools.js';

describe('hostOfSerializedOrigin', () => {
  it('returns the host of http(s) tuple origins only', () => {
    expect(hostOfSerializedOrigin('https://WWW.Bank.com')).toBe('www.bank.com');
    expect(hostOfSerializedOrigin('http://127.0.0.1:8080')).toBe('127.0.0.1');
    expect(hostOfSerializedOrigin('null')).toBeNull();
    expect(hostOfSerializedOrigin(null)).toBeNull();
    expect(hostOfSerializedOrigin(undefined)).toBeNull();
    expect(hostOfSerializedOrigin('chrome-extension://abc')).toBeNull();
    expect(hostOfSerializedOrigin('not an origin')).toBeNull();
  });
});

const chromiumPath = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return '';
  }
})();
const haveChromium = !!chromiumPath && existsSync(chromiumPath);

// Real Chromium: the point is to check what DevTools actually reports, which
// a fake cannot tell us.
describe.skipIf(!haveChromium)('readMainFrameOriginViaCdp (real Chromium)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: http.Server;
  let origin = '';

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>opener</title><p>opener</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
    context = await browser.newContext();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reports the inherited origin of an about:blank popup even when page script lies', async () => {
    const opener = await context.newPage();
    await opener.goto(`${origin}/`);
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      opener.evaluate(() => {
        const w = window.open('about:blank')!;
        // Fill through DOM APIs: document.write would change the popup's URL.
        const b = w.document.createElement('button');
        b.textContent = 'Pay';
        w.document.body.appendChild(b);
        Object.defineProperty(w, 'origin', { value: 'https://evil.example' });
      }),
    ]);
    expect(popup.url()).toBe('about:blank');
    expect(await popup.evaluate(() => window.origin)).toBe('https://evil.example');

    const cdp = await context.newCDPSession(popup);
    try {
      expect(await readMainFrameOriginViaCdp(cdp)).toBe(origin);
    } finally {
      await cdp.detach();
    }
    // The host-level wrapper reads the context's active page.
    expect(await readActivePageOrigin({ page: popup, context })).toBe(origin);
    await popup.close();
    await opener.close();
  });

  it('reports an opaque origin for data: documents', async () => {
    const page = await context.newPage();
    await page.goto('data:text/html,<button>x</button>');
    expect(await readActivePageOrigin({ page, context })).toBe('null');
    await page.close();
  });

  it('returns null when no Playwright CDP session can be opened', async () => {
    const page = await context.newPage();
    expect(await readActivePageOrigin({ page })).toBeNull();
    await page.close();
  });
});
