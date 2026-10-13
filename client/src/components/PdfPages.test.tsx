import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

type Size = { width: number; height: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}));

vi.mock('pdfjs-dist', () => pdfjs);
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }));

import PdfPages from './PdfPages';

function fakeDoc(
  pages: Size[],
  fail: { render?: readonly number[]; getPage?: readonly number[] } = {},
) {
  const render = vi.fn((n: number) => ({
    promise: fail.render?.includes(n)
      ? Promise.reject(new Error('broken page'))
      : Promise.resolve(),
  }));
  return {
    numPages: pages.length,
    render,
    getPage: vi.fn(async (n: number) => {
      if (fail.getPage?.includes(n) && n !== 1) throw new Error('unreadable page');
      return {
        getViewport: ({ scale }: { scale: number }) => ({
          width: pages[n - 1].width * scale,
          height: pages[n - 1].height * scale,
        }),
        render: () => render(n),
      };
    }),
  };
}

/** A loading task whose document resolves when the test says so. */
function fakeTask() {
  const doc = deferred<ReturnType<typeof fakeDoc>>();
  const task = { promise: doc.promise, destroy: vi.fn(() => Promise.resolve()) };
  pdfjs.getDocument.mockReturnValue(task);
  return { task, doc };
}

let observed: Element[] = [];
let fireIntersect: (targets: Element[]) => void = () => {};

beforeEach(() => {
  pdfjs.getDocument.mockReset();
  observed = [];
  class FakeObserver {
    constructor(cb: IntersectionObserverCallback) {
      fireIntersect = (targets) =>
        cb(
          targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
          this as unknown as IntersectionObserver,
        );
    }
    observe(el: Element) {
      observed.push(el);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const pdfBlob = () => new Blob(['%PDF']);

describe('PdfPages', () => {
  it('destroys the loading task when closed before the document loads', async () => {
    const { task, doc } = fakeTask();
    const { unmount } = render(<PdfPages data={pdfBlob()} title="spec.pdf" />);
    await waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalled());

    unmount();
    expect(task.destroy).toHaveBeenCalledTimes(1);

    // The document arriving after close must not render anything.
    const loaded = fakeDoc([{ width: 612, height: 792 }]);
    await act(async () => doc.resolve(loaded));
    expect(loaded.getPage).not.toHaveBeenCalled();
    expect(observed).toHaveLength(0);
  });

  it('never starts loading when closed while the bytes are still being read', async () => {
    const bytes = deferred<ArrayBuffer>();
    const data = { arrayBuffer: () => bytes.promise } as unknown as Blob;
    const { unmount } = render(<PdfPages data={data} title="spec.pdf" />);
    unmount();
    await act(async () => bytes.resolve(new ArrayBuffer(4)));
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
  });

  it('gives each page its own shape in a mixed portrait/landscape PDF', async () => {
    const { doc } = fakeTask();
    const loaded = fakeDoc([
      { width: 612, height: 792 },
      { width: 792, height: 612 },
    ]);
    render(<PdfPages data={pdfBlob()} title="spec.pdf" />);
    await act(async () => doc.resolve(loaded));
    await waitFor(() => expect(observed).toHaveLength(2));

    const [portrait, landscape] = observed as HTMLCanvasElement[];
    await act(async () => fireIntersect([portrait, landscape]));
    await waitFor(() => expect(loaded.render).toHaveBeenCalledTimes(2));

    const ratio = (c: HTMLCanvasElement) => {
      const [w, h] = c.style.aspectRatio.split('/').map(Number);
      return w / h;
    };
    expect(ratio(portrait)).toBeCloseTo(612 / 792);
    expect(ratio(landscape)).toBeCloseTo(792 / 612);
    expect(screen.getByRole('document', { name: 'spec.pdf' })).toBeInTheDocument();
  });

  it('points pdf.js at the shipped decoder, cmap, font, and ICC data', async () => {
    fakeTask();
    render(<PdfPages data={pdfBlob()} title="spec.pdf" />);
    await waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalled());
    expect(pdfjs.getDocument.mock.calls[0][0]).toMatchObject({
      wasmUrl: '/pdfjs/wasm/',
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      iccUrl: '/pdfjs/iccs/',
    });
  });

  it.each([
    ['render', { render: [2] }],
    ['getPage', { getPage: [2] }],
  ] as const)('shows a page error when %s rejects', async (_step, fail) => {
    const { doc } = fakeTask();
    const loaded = fakeDoc(
      [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
      ],
      fail,
    );
    render(<PdfPages data={pdfBlob()} title="spec.pdf" />);
    await act(async () => doc.resolve(loaded));
    await waitFor(() => expect(observed).toHaveLength(2));
    await act(async () => fireIntersect(observed));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Page 2 of 2 could not be displayed');
    expect(alert).toHaveTextContent('Download');
    expect(screen.getByLabelText('Page 1 of 2').tagName).toBe('CANVAS');
  });

  it('shows a document error when the PDF cannot be opened', async () => {
    const { doc } = fakeTask();
    render(<PdfPages data={pdfBlob()} title="spec.pdf" />);
    await act(async () => doc.reject(new Error('Invalid PDF structure')));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be displayed');
  });
});
