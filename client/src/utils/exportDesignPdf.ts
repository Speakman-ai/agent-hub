// exportDesignPdf — client-side PDF export for Claude Design artifacts.
//
// Approach (Option B from the design doc):
//   1. Create a hidden, SAME-ORIGIN iframe pointing at
//      `/design-files/<id>/index.html` so the document's fonts, images and
//      scripts all resolve exactly the way the on-screen canvas does. Unlike
//      the user-facing `DesignCanvas` iframe (sandboxed for safety), the
//      export iframe is un-sandboxed so the parent can reach into
//      `contentDocument` and hand the DOM to html2canvas.
//   2. Wait for `load`, size the iframe body to its scrollHeight so
//      long-scrolling designs are captured in full, then rasterize the
//      document with html2canvas.
//   3. Slice the resulting canvas across A4 pages with jsPDF and trigger a
//      browser download of the resulting Blob.
//
// This path is fully client-side — no server work, no new backend
// dependencies, no headless-chromium system deps on EC2. Tradeoff: fidelity
// is whatever html2canvas can reproduce (fonts/SVG are rasterized), which is
// acceptable for a v1 and matches how this repo already uses html2canvas for
// bug-report screenshots (see client/src/utils/bugReport.js).
//
// Error-recovery layers (see card "Design not accessible for export"):
//   • Pre-flight probe — we `fetch()` the artifact URL first so we can
//     distinguish "artifact missing / 404" from "iframe loaded but DOM
//     access was denied". This surfaces a crisp error and, bonus, gives us
//     the raw HTML to feed the srcdoc fallback.
//   • Cross-origin detection — if the hub page (e.g. Vite dev on :3050) and
//     the API `base` (e.g. :3051) don't share an origin, iframe
//     contentDocument access will always be blocked by Same-Origin Policy.
//     We detect that up-front and throw a distinct, actionable error
//     instead of the generic "not accessible" message.
//   • srcdoc fallback — when the page IS same-origin as the API but the
//     iframe's contentDocument is still `null` (rare, usually a transient
//     navigation/CSP hiccup), we swap to `iframe.srcdoc` with the
//     prefetched HTML plus an injected `<base href>` so relative assets
//     still resolve. about:srcdoc inherits the parent's origin, so DOM
//     access is guaranteed to work.

/**
 * True if the given `base` URL shares an origin with the host page's
 * `window.location`. Returns `false` on any parse error (treat as
 * cross-origin — safer default).
 *
 * @param {string}   base
 * @param {Document} hostDoc  The host document whose `defaultView` we read.
 */
function isSameOrigin(base: any, hostDoc: any) {
  try {
    const win = hostDoc?.defaultView || (typeof window !== 'undefined' ? window : null);
    const href = win?.location?.href;
    if (!href) return false;
    const baseUrl = new URL(base, href);
    return baseUrl.origin === win.location.origin;
  } catch {
    return false;
  }
}

/**
 * Inject a `<base href>` into a fetched design HTML document so relative
 * asset URLs still resolve when the document is loaded via `srcdoc`.
 */
function withBaseHref(html: any, designUrl: any) {
  const tag = `<base href="${designUrl}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m: any) => `${m}${tag}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m: any) => `${m}<head>${tag}</head>`);
  }
  return `<head>${tag}</head>${html}`;
}

/**
 * Wait for an iframe `load` event (or `error`) with the given handlers.
 * Returns a promise the caller can await once it has set `src`/`srcdoc`.
 */
function awaitIframeLoad(iframe: any, errorMessage: any) {
  return new Promise((resolve: any, reject: any) => {
    const onLoad = () => {
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
      reject(new Error(errorMessage));
    };
    iframe.addEventListener('load', onLoad);
    iframe.addEventListener('error', onError);
  });
}

/**
 * Render the given design as a PDF and trigger a browser download.
 *
 * @param {object}   opts
 * @param {string}   opts.designId   Design id — used to build the default
 *                                   `/design-files/:id/` URL (when no
 *                                   `srcBase` is given) and the fallback
 *                                   download filename.
 * @param {string}   opts.base       Server base URL (from `getServerBase`).
 * @param {string}  [opts.srcBase]   Optional server-relative directory the
 *                                   artifacts load from, e.g.
 *                                   `/session-files/<id>/design`. Lets a
 *                                   design-mode session export from its
 *                                   worktree mount instead of the standalone
 *                                   Design Studio `/design-files/<id>/` path.
 *                                   Mirrors `DesignCanvas`'s `srcBase` prop.
 *                                   CONTRACT: must be an already-URL-safe path
 *                                   fragment — it is interpolated raw into the
 *                                   fetch URL (no per-segment encoding here),
 *                                   so callers must `encodeURIComponent` any
 *                                   dynamic id segments (session ids can carry
 *                                   `#`, `?`, spaces, `/`). The default
 *                                   `/design-files/<id>/` path encodes
 *                                   `designId` for you; `srcBase` does not.
 * @param {string}  [opts.filename]  Optional output filename (without .pdf);
 *                                   falls back to `design-<id>`.
 * @param {Document}[opts.doc]       Host document (defaults to `document`).
 *                                   Tests pass jsdom's document explicitly.
 * @returns {Promise<void>}          Resolves once the download has been
 *                                   initiated; rejects on fetch/render
 *                                   failure so callers can surface errors.
 */
export async function exportDesignPdf({ designId, base, srcBase, filename, doc }: any = {}) {
  if (!designId) throw new Error('designId is required');
  if (!base) throw new Error('base is required');
  const hostDoc = doc || (typeof document !== 'undefined' ? document : null);
  if (!hostDoc) throw new Error('No document available for PDF export');

  const safeName = (filename || `design-${designId}`).replace(/[^a-z0-9._-]+/gi, '_');
  // Directory the artifact loads from. Standalone Design Studio defaults to
  // `/design-files/<id>/`; design-mode sessions pass `srcBase` for the worktree
  // mount (`/session-files/<id>/design/`). Same shape as DesignCanvas's dirBase
  // so the on-screen canvas and the exported PDF resolve assets identically.
  const dirBase = srcBase
    ? `${base}${srcBase.endsWith('/') ? srcBase : `${srcBase}/`}`
    : `${base}/design-files/${encodeURIComponent(designId)}/`;
  const designUrl = `${dirBase}index.html`;

  // Layer 1: cross-origin guard. iframe.contentDocument is unreadable when
  // the page and the iframe don't share an origin — no amount of retrying
  // fixes it. Fail fast with a message the user can act on.
  if (!isSameOrigin(base, hostDoc)) {
    throw new Error(
      'PDF export requires the hub to be served from the same origin as the API. ' +
        'Open the design from the deployed hub or the Electron desktop app ' +
        '(the Vite dev server on :3050 cannot export from an API on a different origin).',
    );
  }

  // Layer 2: pre-flight probe. Surfaces a crisp 404/network error before we
  // stand up the iframe, and hands us the raw HTML for the srcdoc fallback.
  let prefetchedHtml = null;
  try {
    const res = await fetch(designUrl, { credentials: 'include' });
    if (!res.ok) {
      throw new Error(
        `Design artifact is unavailable (HTTP ${res.status}). ` +
          'The design may have been deleted, or the dev server is not proxying the design artifact directory.',
      );
    }
    prefetchedHtml = await res.text();
  } catch (err: any) {
    if (err instanceof Error && /HTTP \d+/.test(err.message)) throw err;
    throw new Error(`Unable to reach design artifact for export: ${err?.message || String(err)}`);
  }

  // 1. Offscreen iframe that loads the design document same-origin.
  const iframe = hostDoc.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.left = '-10000px';
  iframe.style.top = '0';
  iframe.style.width = '1024px';
  iframe.style.height = '768px';
  iframe.style.border = '0';
  iframe.src = designUrl;
  hostDoc.body.appendChild(iframe);

  try {
    await awaitIframeLoad(iframe, 'Failed to load design for export');

    let inner = iframe.contentDocument;
    if (!inner || !inner.body) {
      // Layer 3: srcdoc fallback. about:srcdoc inherits the parent's origin
      // so contentDocument is always readable; the injected <base> keeps
      // relative asset URLs resolving against the real artifact path.
      iframe.srcdoc = withBaseHref(prefetchedHtml, designUrl);
      await awaitIframeLoad(iframe, 'srcdoc fallback failed to load');
      inner = iframe.contentDocument;
      if (!inner || !inner.body) {
        throw new Error('Design document is not accessible for export');
      }
    }

    // Resize the iframe to the document's natural height so long-scroll
    // designs render in full on the canvas.
    const fullHeight = Math.max(
      inner.body.scrollHeight,
      inner.documentElement ? inner.documentElement.scrollHeight : 0,
      768,
    );
    iframe.style.height = `${fullHeight}px`;

    // 2. Rasterize via html2canvas-pro — dynamic import mirrors bugReport.ts.
    // The pro fork parses modern oklch()/oklab()/color() values that Chrome
    // emits in computed styles and stock html2canvas 1.4.1 chokes on.
    const canvasMod = await import('html2canvas-pro');
    const html2canvas = canvasMod.default || canvasMod;
    const canvas = await html2canvas(inner.documentElement, {
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: inner.documentElement.scrollWidth,
      windowHeight: fullHeight,
      scale: Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2),
    });

    // 3. Paginate the canvas onto an A4 portrait PDF. The A4 page is
    // 210mm × 297mm; we derive the pixel-per-mm ratio from the canvas width
    // so the image stays proportional, then slice vertically into pages.
    const jspdfMod = await import('jspdf');
    const JsPDF = jspdfMod.jsPDF || jspdfMod.default || jspdfMod;

    const pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageWidthMm = pdf.internal.pageSize.getWidth();
    const pageHeightMm = pdf.internal.pageSize.getHeight();
    const pxPerMm = canvas.width / pageWidthMm;
    const pageHeightPx = pageHeightMm * pxPerMm;

    let renderedHeightPx = 0;
    let pageIndex = 0;
    while (renderedHeightPx < canvas.height) {
      const sliceHeightPx = Math.min(pageHeightPx, canvas.height - renderedHeightPx);
      const sliceCanvas = hostDoc.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeightPx;
      const ctx = sliceCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(
          canvas,
          0,
          renderedHeightPx,
          canvas.width,
          sliceHeightPx,
          0,
          0,
          canvas.width,
          sliceHeightPx,
        );
      }
      const dataUrl = sliceCanvas.toDataURL('image/png');
      if (pageIndex > 0) pdf.addPage();
      pdf.addImage(dataUrl, 'PNG', 0, 0, pageWidthMm, sliceHeightPx / pxPerMm);
      renderedHeightPx += sliceHeightPx;
      pageIndex += 1;
    }

    await finalizeDesignPdfDownload(pdf, safeName);
  } finally {
    iframe.remove();
  }
}

/**
 * In Electron, jsPDF's anchor/blob download path is unreliable; delegate to the
 * main process (native save dialog + fs.writeFile). Browsers keep using
 * pdf.save().
 *
 * @param {*} pdf  jsPDF instance
 * @param {string} safeName  Filename stem (already sanitized).
 */
async function finalizeDesignPdfDownload(pdf: any, safeName: any) {
  const filename = `${safeName}.pdf`;
  const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (electron?.saveDesignPdf) {
    let arrayBuffer: any;
    try {
      arrayBuffer = pdf.output('arraybuffer');
    } catch (err: any) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    const result = await electron.saveDesignPdf({
      defaultFilename: filename,
      data: new Uint8Array(arrayBuffer),
    });
    if (result?.error) throw new Error(result.error);
    return;
  }
  pdf.save(filename);
}
