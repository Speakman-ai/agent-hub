import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from './config.js';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  type BrowserSession,
} from './browser.js';
import {
  browserBack,
  browserForward,
  browserNavigate,
  runBrowserReActStep,
} from './browser-tools.js';
import { navigateBrowserViewer } from './browser-screencast.js';

const hubOrigin = 'http://192.168.50.45';
const hubUrl = `${hubOrigin}/#/pulls/3d-printing?pr=31`;
const originalPublicUrl = config.publicUrl;

function fakeBrowser(id = 'trusted-hub', initialUrl = hubUrl) {
  let currentUrl = initialUrl;
  const page = {
    url: () => currentUrl,
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    title: vi.fn(async () => 'Agent Hub'),
    innerText: vi.fn(async () => 'Pull requests'),
  };
  const session: BrowserSession = {
    id,
    page,
    createdAt: Date.now(),
    timeoutMs: 1000,
    close: async () => {},
  };
  __registerBrowserSessionForTests(session);
  return { session, page };
}

beforeEach(() => {
  config.publicUrl = `${hubOrigin}/hub/`;
});
afterEach(() => {
  config.publicUrl = originalPublicUrl;
  __resetBrowserRegistryForTests();
});

describe('configured Hub origin browser access', () => {
  it('opens the local Hub PR page through the agent browser', async () => {
    const { page } = fakeBrowser();
    const result = await runBrowserReActStep('trusted-hub', { op: 'navigate', url: hubUrl });
    expect(result.hostExit).toBe(0);
    expect(page.goto).toHaveBeenCalledWith(hubUrl, expect.any(Object));
  });

  it('opens the same origin through the human address bar', async () => {
    fakeBrowser();
    expect(await navigateBrowserViewer('trusted-hub', hubUrl)).toEqual({ ok: true, url: hubUrl });
  });

  it.each([browserBack, browserForward])(
    'allows history navigation to the Hub',
    async (navigate) => {
      const { session } = fakeBrowser();
      expect(await navigate(session)).toMatchObject({ ok: true, data: { url: hubUrl } });
    },
  );

  it.each([
    'http://192.168.50.46/',
    'http://192.168.50.45:3051/',
    'https://192.168.50.45/',
    'http://localhost/',
    'http://169.254.169.254/',
    'http://user:password@192.168.50.45/',
    'file:///etc/passwd',
  ])('refuses other private origins and unsafe URLs: %s', async (url) => {
    const { session, page } = fakeBrowser();
    expect(await browserNavigate(session, url)).toMatchObject({ ok: false });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it.each([null, '', 'not a URL', 'file:///etc/passwd', 'http://user:password@192.168.50.45/'])(
    'does not trust a missing or invalid public URL: %s',
    async (publicUrl) => {
      config.publicUrl = publicUrl;
      const { session, page } = fakeBrowser();
      expect(await browserNavigate(session, hubUrl)).toMatchObject({ ok: false });
      expect(page.goto).not.toHaveBeenCalled();
    },
  );

  it('does not merge Hub trust into an explicit preview policy', async () => {
    const { session, page } = fakeBrowser();
    expect(
      await browserNavigate(session, hubUrl, 1000, {
        allowOrigins: ['http://127.0.0.1:4123'],
      }),
    ).toMatchObject({ ok: false });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('keeps the preview viewer pinned even when the Hub is trusted', async () => {
    fakeBrowser('preview:preview-chat', 'http://127.0.0.1:4123/');
    expect(await navigateBrowserViewer('preview-chat', hubUrl)).toMatchObject({
      ok: false,
      code: 'refused',
    });
  });

  it('refuses a redirect from the Hub to another private origin', async () => {
    const { session, page } = fakeBrowser('redirect', 'http://10.0.0.1/');
    page.goto.mockImplementation(async () => {});
    expect(await browserNavigate(session, hubUrl)).toMatchObject({ ok: false });
    expect(page.goto).toHaveBeenCalled();
  });

  it('applies the Hub exception to intercepted document requests without trusting redirect targets', async () => {
    const { session, page } = fakeBrowser();
    let onRequest: ((event: unknown) => void) | undefined;
    const cdp = {
      send: vi.fn(async () => ({})),
      on: vi.fn((_event: string, handler: (event: unknown) => void) => {
        onRequest = handler;
      }),
      off: vi.fn(),
    };
    session.page = { ...page, mainSession: cdp };
    page.goto.mockImplementation(async () => {
      for (const [requestId, url] of [
        ['hub', hubUrl],
        ['redirect', 'http://10.0.0.1/'],
      ]) {
        onRequest?.({ requestId, resourceType: 'Document', request: { url } });
      }
    });
    await browserNavigate(session, hubUrl);
    expect(cdp.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'hub' });
    expect(cdp.send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'redirect',
      errorReason: 'BlockedByClient',
    });
  });
});
