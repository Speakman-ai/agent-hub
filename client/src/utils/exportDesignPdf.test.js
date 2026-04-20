import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// html2canvas and jsPDF are heavy, DOM-and-canvas-dependent libraries that
// don't run cleanly under jsdom. We mock both via vi.mock so the util's own
// logic (URL construction, iframe lifecycle, pagination loop, filename
// sanitization, download trigger) can be exercised in isolation.
const addImageMock = vi.fn();
const addPageMock = vi.fn();
const saveMock = vi.fn();

vi.mock('jspdf', () => {
  class FakeJsPDF {
    constructor() {
      this.internal = {
        pageSize: {
          getWidth: () => 210,
          getHeight: () => 297,
        },
      };
    }
    addImage(...args) {
      addImageMock(...args);
    }
    addPage(...args) {
      addPageMock(...args);
    }
    save(...args) {
      saveMock(...args);
    }
  }
  return { jsPDF: FakeJsPDF, default: FakeJsPDF };
});

const html2canvasMock = vi.fn();
vi.mock('html2canvas', () => ({
  default: (...args) => html2canvasMock(...args),
}));

import { exportDesignPdf } from './exportDesignPdf.js';

function fakeCanvas({ width = 800, height = 2000 } = {}) {
  return {
    width,
    height,
    toDataURL: () => 'data:image/png;base64,AAAA',
  };
}

// Vitest's jsdom env defaults to `http://localhost:3000`. We use that as the
// same-origin `base` for the happy-path tests so the cross-origin guard
// doesn't fire; see the dedicated cross-origin test below for the opposite.
const SAME_ORIGIN_BASE = 'http://localhost:3000';

describe('exportDesignPdf', () => {
  let fetchMock;

  beforeEach(() => {
    addImageMock.mockClear();
    addPageMock.mockClear();
    saveMock.mockClear();
    html2canvasMock.mockReset();

    // Default: pre-flight probe succeeds with a minimal HTML document.
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><head></head><body>design</body></html>',
    });
    globalThis.fetch = fetchMock;

    // Patch HTMLIFrameElement so `src` setter fires a synthetic load event
    // and contentDocument exposes a minimally-shaped body/documentElement.
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true,
      set(value) {
        this._src = value;
        const doc = {
          body: { scrollHeight: 2000 },
          documentElement: { scrollHeight: 2000, scrollWidth: 800 },
        };
        Object.defineProperty(this, 'contentDocument', {
          configurable: true,
          get: () => doc,
        });
        setTimeout(() => this.dispatchEvent(new Event('load')), 0);
      },
      get() {
        return this._src;
      },
    });

    // jsdom's <canvas> has no real 2d context. Stub it to a noop.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: vi.fn(),
    }));
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it('throws if designId is missing', async () => {
    await expect(exportDesignPdf({ base: SAME_ORIGIN_BASE })).rejects.toThrow(/designId/);
  });

  it('throws if base is missing', async () => {
    await expect(exportDesignPdf({ designId: 'd-1' })).rejects.toThrow(/base/);
  });

  it('loads the design via same-origin iframe and saves a PDF', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas({ width: 800, height: 800 }));
    await exportDesignPdf({
      designId: 'd-1',
      base: SAME_ORIGIN_BASE,
      filename: 'Neat design',
    });

    // html2canvas was invoked with the iframe's documentElement
    expect(html2canvasMock).toHaveBeenCalledTimes(1);

    // Single-page design → one addImage, zero addPage
    expect(addImageMock).toHaveBeenCalledTimes(1);
    expect(addPageMock).not.toHaveBeenCalled();

    // Saved with the sanitized filename
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toBe('Neat_design.pdf');

    // Pre-flight probe was actually issued against the expected URL
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SAME_ORIGIN_BASE}/design-files/d-1/index.html`);
  });

  it('paginates long designs across multiple PDF pages', async () => {
    // canvas.height (4000) / pageHeightPx (canvas.width=800 / 210mm * 297mm ≈ 1131)
    // = ~4 pages. addPage is called once less than the total page count.
    html2canvasMock.mockResolvedValue(fakeCanvas({ width: 800, height: 4000 }));
    await exportDesignPdf({ designId: 'd-2', base: SAME_ORIGIN_BASE });

    expect(addImageMock.mock.calls.length).toBeGreaterThan(1);
    expect(addPageMock.mock.calls.length).toBe(addImageMock.mock.calls.length - 1);
    expect(saveMock.mock.calls[0][0]).toBe('design-d-2.pdf');
  });

  it('removes the hidden iframe after a successful export', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas());
    await exportDesignPdf({ designId: 'd-1', base: SAME_ORIGIN_BASE });
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });

  it('removes the hidden iframe even if rendering fails', async () => {
    html2canvasMock.mockRejectedValue(new Error('boom'));
    await expect(exportDesignPdf({ designId: 'd-1', base: SAME_ORIGIN_BASE })).rejects.toThrow(
      /boom/,
    );
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });

  it('sanitizes unsafe characters in the filename', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas());
    await exportDesignPdf({
      designId: 'd-3',
      base: SAME_ORIGIN_BASE,
      filename: '../evil / name?.pdf',
    });
    const savedAs = saveMock.mock.calls[0][0];
    expect(savedAs).not.toContain('/');
    expect(savedAs).not.toContain('?');
    expect(savedAs).toMatch(/\.pdf$/);
  });

  // ─── Cross-origin guard ──────────────────────────────────────────────
  //
  // When the hub page (e.g. Vite on :3050) and the API base (e.g. :3051)
  // differ in origin, iframe contentDocument is blocked by Same-Origin
  // Policy. We should bail out with a distinct, actionable message before
  // spending a network round-trip or attaching the iframe to the DOM.

  it('throws a distinct error when base is cross-origin vs the host page', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas());
    await expect(
      exportDesignPdf({ designId: 'd-4', base: 'http://other-origin.test:9999' }),
    ).rejects.toThrow(/same origin/i);

    // Guard fires BEFORE the pre-flight fetch — we shouldn't have hit the network.
    expect(fetchMock).not.toHaveBeenCalled();
    // And no iframe should have been attached.
    expect(document.querySelectorAll('iframe').length).toBe(0);
    // And no PDF should have been saved.
    expect(saveMock).not.toHaveBeenCalled();
  });

  // ─── Pre-flight probe ────────────────────────────────────────────────
  //
  // If the artifact URL 404s (e.g. design was deleted) or the fetch throws
  // (network error, dev server not proxying /design-files/), we should
  // surface an explanatory error rather than a generic "not accessible".

  it('surfaces a 404 from the pre-flight probe with a clear message', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas());
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' });

    await expect(exportDesignPdf({ designId: 'gone', base: SAME_ORIGIN_BASE })).rejects.toThrow(
      /HTTP 404/,
    );
    // No iframe should have been stood up — we bailed before that.
    expect(document.querySelectorAll('iframe').length).toBe(0);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('surfaces a network error from the pre-flight probe', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas());
    fetchMock.mockRejectedValueOnce(new Error('net down'));

    await expect(exportDesignPdf({ designId: 'x', base: SAME_ORIGIN_BASE })).rejects.toThrow(
      /Unable to reach design artifact.*net down/,
    );
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });

  // ─── srcdoc fallback ─────────────────────────────────────────────────
  //
  // If the iframe loads but contentDocument is unexpectedly null (a rare
  // transient case — usually a CSP or navigation edge case), we fall back
  // to iframe.srcdoc using the prefetched HTML. about:srcdoc documents
  // inherit the parent's origin so DOM access works.

  it('falls back to srcdoc when the initial iframe load exposes no contentDocument', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas({ width: 800, height: 800 }));

    // Override the default iframe patch: first `src` set → load fires with
    // NULL contentDocument. Setting `srcdoc` is what ultimately populates a
    // readable contentDocument and a second load event.
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true,
      set(value) {
        this._src = value;
        Object.defineProperty(this, 'contentDocument', {
          configurable: true,
          get: () => null,
        });
        setTimeout(() => this.dispatchEvent(new Event('load')), 0);
      },
      get() {
        return this._src;
      },
    });
    Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
      configurable: true,
      set(value) {
        this._srcdoc = value;
        const doc = {
          body: { scrollHeight: 2000 },
          documentElement: { scrollHeight: 2000, scrollWidth: 800 },
        };
        Object.defineProperty(this, 'contentDocument', {
          configurable: true,
          get: () => doc,
        });
        setTimeout(() => this.dispatchEvent(new Event('load')), 0);
      },
      get() {
        return this._srcdoc;
      },
    });

    await exportDesignPdf({ designId: 'd-5', base: SAME_ORIGIN_BASE });

    // Successful save means srcdoc recovered the export.
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toBe('design-d-5.pdf');
    // html2canvas actually got called with a live documentElement.
    expect(html2canvasMock).toHaveBeenCalledTimes(1);
  });

  it('injects a <base href> into the srcdoc HTML so relative assets still resolve', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas({ width: 800, height: 800 }));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        '<html><head><title>t</title></head><body><img src="logo.png"></body></html>',
    });

    let capturedSrcdoc = null;
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true,
      set(value) {
        this._src = value;
        Object.defineProperty(this, 'contentDocument', {
          configurable: true,
          get: () => null,
        });
        setTimeout(() => this.dispatchEvent(new Event('load')), 0);
      },
      get() {
        return this._src;
      },
    });
    Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
      configurable: true,
      set(value) {
        this._srcdoc = value;
        capturedSrcdoc = value;
        const doc = {
          body: { scrollHeight: 2000 },
          documentElement: { scrollHeight: 2000, scrollWidth: 800 },
        };
        Object.defineProperty(this, 'contentDocument', {
          configurable: true,
          get: () => doc,
        });
        setTimeout(() => this.dispatchEvent(new Event('load')), 0);
      },
      get() {
        return this._srcdoc;
      },
    });

    await exportDesignPdf({ designId: 'd-6', base: SAME_ORIGIN_BASE });

    expect(capturedSrcdoc).toMatch(
      /<base href="http:\/\/localhost:3000\/design-files\/d-6\/index\.html">/,
    );
    // The base tag must be inside <head>, before <body>, so it's honored.
    expect(capturedSrcdoc.indexOf('<base')).toBeLessThan(capturedSrcdoc.indexOf('<body'));
  });
});
