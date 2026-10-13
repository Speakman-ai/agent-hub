import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsAssetUrls } from '../utils/pdfjsAssets';

type Props = { data: Blob; title: string };

/** Pages render once they come within this distance of the visible area. */
const RENDER_MARGIN = '800px';
const PAGE_WIDTH = 900;

async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

function pageFailure(pageNumber: number, total: number, style: CSSStyleDeclaration) {
  const el = document.createElement('div');
  el.dataset.page = String(pageNumber);
  el.setAttribute('role', 'alert');
  el.className =
    'mx-auto mb-3 flex items-center justify-center bg-gray-900 p-4 text-center text-sm text-red-300';
  el.style.width = style.width;
  el.style.aspectRatio = style.aspectRatio;
  el.textContent = `Page ${pageNumber} of ${total} could not be displayed. Use Download to get the full file.`;
  return el;
}

/**
 * Renders a PDF onto canvases in this document. An <iframe> would hand the
 * PDF to a separate document (and, in Electron, a plugin), which swallows
 * keyboard events, so a dialog hosting it could not be dismissed or keep
 * focus once the user clicked into the PDF.
 *
 * Everything the effect starts is owned by one cancellation flag and the
 * loading task: closing at any point stops further work and tears down the
 * worker, and any failure that is not caused by closing is shown, never
 * swallowed.
 */
export default function PdfPages({ data, title }: Props) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const host = pagesRef.current;
    if (!host) return;
    let cancelled = false;
    // The loading task, not the document: destroying it tears down the worker
    // whether or not the document has finished loading.
    let task: PDFDocumentLoadingTask | null = null;
    let observer: IntersectionObserver | null = null;

    const renderPage = async (pdf: PDFDocumentProxy, canvas: HTMLCanvasElement, width: number) => {
      const pageNumber = Number(canvas.dataset.page);
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({
          scale: (width / page.getViewport({ scale: 1 }).width) * ratio,
        });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        // Placeholders take page 1's shape; each page keeps its own once drawn.
        canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
        await page.render({ canvas, viewport }).promise;
      } catch {
        if (cancelled || !canvas.isConnected) return;
        canvas.replaceWith(pageFailure(pageNumber, pdf.numPages, canvas.style));
      }
    };

    (async () => {
      const pdfjs = await loadPdfjs();
      if (cancelled) return;
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (cancelled) return;
      task = pdfjs.getDocument({ data: bytes, ...pdfjsAssetUrls(import.meta.env.BASE_URL) });
      const pdf = await task.promise;
      if (cancelled) return;
      const width = Math.min(PAGE_WIDTH, window.innerWidth * 0.9);

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const canvas = entry.target as HTMLCanvasElement;
            observer?.unobserve(canvas);
            void renderPage(pdf, canvas, width);
          }
        },
        { root: host.parentElement, rootMargin: RENDER_MARGIN },
      );

      const first = await pdf.getPage(1);
      if (cancelled) return;
      const base = first.getViewport({ scale: 1 });
      for (let n = 1; n <= pdf.numPages; n++) {
        const canvas = document.createElement('canvas');
        canvas.dataset.page = String(n);
        canvas.setAttribute('aria-label', `Page ${n} of ${pdf.numPages}`);
        canvas.className = 'mx-auto mb-3 block bg-white shadow';
        canvas.style.width = `${width}px`;
        canvas.style.aspectRatio = `${base.width} / ${base.height}`;
        host.appendChild(canvas);
        observer.observe(canvas);
      }
      setStatus('ready');
    })().catch(() => {
      if (!cancelled) setStatus('error');
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      host.replaceChildren();
      void task?.destroy();
    };
  }, [data]);

  return (
    <div
      tabIndex={0}
      role="document"
      aria-label={title}
      data-testid="pdf-pages"
      className="h-[80vh] w-[min(90vw,940px)] overflow-auto bg-gray-800 p-3 outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      {status === 'loading' && (
        <div className="flex h-full items-center justify-center text-gray-400">
          <Loader2 size={20} className="animate-spin" />
        </div>
      )}
      {status === 'error' && (
        <p role="alert" className="p-6 text-sm text-red-300">
          This PDF could not be displayed. Use Download to get the file.
        </p>
      )}
      <div ref={pagesRef} />
    </div>
  );
}
