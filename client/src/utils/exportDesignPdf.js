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

/**
 * Render the given design as a PDF and trigger a browser download.
 *
 * @param {object}   opts
 * @param {string}   opts.designId   Design id — used to build both the
 *                                   `/design-files/:id/index.html` URL and
 *                                   the default download filename.
 * @param {string}   opts.base       Server base URL (from `getServerBase`).
 * @param {string}  [opts.filename]  Optional output filename (without .pdf);
 *                                   falls back to `design-<id>`.
 * @param {Document}[opts.doc]       Host document (defaults to `document`).
 *                                   Tests pass jsdom's document explicitly.
 * @returns {Promise<void>}          Resolves once the download has been
 *                                   initiated; rejects on fetch/render
 *                                   failure so callers can surface errors.
 */
export async function exportDesignPdf({ designId, base, filename, doc } = {}) {
  if (!designId) throw new Error('designId is required');
  if (!base) throw new Error('base is required');
  const hostDoc = doc || (typeof document !== 'undefined' ? document : null);
  if (!hostDoc) throw new Error('No document available for PDF export');

  const safeName = (filename || `design-${designId}`).replace(/[^a-z0-9._-]+/gi, '_');

  // 1. Offscreen iframe that loads the design document same-origin.
  const iframe = hostDoc.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.left = '-10000px';
  iframe.style.top = '0';
  iframe.style.width = '1024px';
  iframe.style.height = '768px';
  iframe.style.border = '0';
  iframe.src = `${base}/design-files/${encodeURIComponent(designId)}/index.html`;
  hostDoc.body.appendChild(iframe);

  try {
    await new Promise((resolve, reject) => {
      const onLoad = () => {
        iframe.removeEventListener('load', onLoad);
        iframe.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        iframe.removeEventListener('load', onLoad);
        iframe.removeEventListener('error', onError);
        reject(new Error('Failed to load design for export'));
      };
      iframe.addEventListener('load', onLoad);
      iframe.addEventListener('error', onError);
    });

    const inner = iframe.contentDocument;
    if (!inner || !inner.body) {
      throw new Error('Design document is not accessible for export');
    }

    // Resize the iframe to the document's natural height so long-scroll
    // designs render in full on the canvas.
    const fullHeight = Math.max(
      inner.body.scrollHeight,
      inner.documentElement ? inner.documentElement.scrollHeight : 0,
      768,
    );
    iframe.style.height = `${fullHeight}px`;

    // 2. Rasterize via html2canvas — dynamic import mirrors bugReport.js.
    const canvasMod = await import('html2canvas');
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

    pdf.save(`${safeName}.pdf`);
  } finally {
    iframe.remove();
  }
}
