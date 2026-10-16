/**
 * Runs the approval gate's frame-origin script (CDP_FRAME_TREE_SCRIPT)
 * against a real Chromium, since what DevTools reports for inherited origins
 * cannot be checked with fixtures. Skipped when Playwright's Chromium is not
 * installed.
 */
import './../test/setup.js';
import { existsSync } from 'fs';
import http from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { CDP_FRAME_TREE_SCRIPT, parseTargetProbeOutput } from './computer-approval-gate.js';

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function runScript(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-'], {
      env: { ...process.env, AGENT_HUB_CDP_PORT: String(port) },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(CDP_FRAME_TREE_SCRIPT);
  });
}

interface Target {
  type: string;
  title: string;
  url: string;
  frameOrigins: string[] | null;
}

describe.skipIf(!hasChromium)('frame origins from a real Chromium', () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  let origin = '';
  let cdpPort = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/sub') {
        res.end('<title>sub</title>sub');
        return;
      }
      if (req.url === '/xsite') {
        // localhost is a different site from 127.0.0.1, so the frame gets its own process.
        const port = (server.address() as net.AddressInfo).port;
        res.end(
          `<title>A &amp; B &lt;x&gt; "q"</title><iframe src="http://localhost:${port}/sub"></iframe>`,
        );
        return;
      }
      res.end(`<title>Bank</title><iframe src="/sub"></iframe>
        <button id="open" onclick="const w = window.open('about:blank');
          w.document.title = 'Confirm transfer';
          w.document.body.innerHTML = '<button>Send</button>';">open</button>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    cdpPort = await freePort();
    browser = await chromium.launch({
      args: [`--remote-debugging-port=${cdpPort}`, '--site-per-process'],
    });
    page = await browser.newPage();
    await page.goto(`${origin}/`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  it('reports the origin an about:blank popup inherited, not an opaque one', async () => {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#open')]);
    await popup.waitForFunction(() => document.title === 'Confirm transfer');
    // Page script tries to lie about its origin in both windows.
    await page.evaluate(() =>
      Object.defineProperty(window, 'origin', { value: 'https://allowed.example.com' }),
    );
    await popup.evaluate(() =>
      Object.defineProperty(window, 'origin', { value: 'https://allowed.example.com' }),
    );

    const targets = JSON.parse(await runScript(cdpPort)) as Target[];
    const popupTarget = targets.find((t) => t.title === 'Confirm transfer')!;
    expect(popupTarget.url).toBe('about:blank');
    expect(popupTarget.frameOrigins).toEqual([origin]);
    const bank = targets.find((t) => t.title === 'Bank')!;
    // Main frame plus the same-process subframe, neither spoofed.
    expect(bank.frameOrigins).toEqual([origin, origin]);

    // Through the parser, for the popup's window bound to the DevTools process.
    const stdout = [
      'APP0:WM_CLASS(STRING) = "chromium", "Chromium"',
      'TITLE0:_NET_WM_NAME(UTF8_STRING) = "Confirm transfer - Chromium"',
      'PID0:100',
      'EXE0:/usr/lib/chromium/chromium',
      `CDP:${JSON.stringify(targets)}`,
      'CDPPID:100',
    ].join('\n');
    expect(parseTargetProbeOutput(stdout, 1, true)[0]).toMatchObject({
      hosts: ['127.0.0.1'],
      siteUnknown: false,
    });
  }, 60_000);

  it('reports cross-site frames through their own target and escapes titles as decoded', async () => {
    const other = await browser.newPage();
    await other.goto(`${origin}/xsite`);
    await other.waitForFunction(() => document.querySelector('iframe')?.contentWindow !== null);
    const port = new URL(origin).port;
    let targets: Target[] = [];
    await expect
      .poll(async () => {
        targets = JSON.parse(await runScript(cdpPort)) as Target[];
        return targets.some((t) => t.type === 'iframe' && t.url === `http://localhost:${port}/sub`);
      })
      .toBe(true);
    const tab = targets.find((t) => t.url === `${origin}/xsite`)! as Target & { id: string };
    // DevTools HTML-escapes the title; the parent lists only its own frame.
    expect(tab.title).toBe('A &amp; B &lt;x&gt; &quot;q&quot;');
    expect(tab.frameOrigins).toEqual([origin]);
    const frame = targets.find((t) => t.type === 'iframe')! as Target & { parentId: string };
    expect(frame.parentId).toBe(tab.id);
    expect(frame.frameOrigins).toEqual([`http://localhost:${port}`]);

    const stdout = [
      'APP0:WM_CLASS(STRING) = "chromium", "Chromium"',
      'TITLE0:_NET_WM_NAME(UTF8_STRING) = "A & B <x> \\"q\\" - Chromium"',
      'PID0:100',
      'EXE0:/usr/lib/chromium/chromium',
      `CDP:${JSON.stringify(targets)}`,
      'CDPPID:100',
    ].join('\n');
    // Matched despite the escaping; localhost has no attributable site, so
    // the tab is incomplete but keeps 127.0.0.1.
    expect(parseTargetProbeOutput(stdout, 1, true)[0]).toMatchObject({
      hosts: ['127.0.0.1'],
      siteUnknown: true,
    });
    await other.close();
  }, 60_000);
});
