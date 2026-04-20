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

describe('exportDesignPdf', () => {
  beforeEach(() => {
    addImageMock.mockClear();
    addPageMock.mockClear();
    saveMock.mockClear();
    html2canvasMock.mockReset();

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
  });

  it('throws if designId is missing', async () => {
    await expect(exportDesignPdf({ base: 'http://h' })).rejects.toThrow(/designId/);
  });

  it('throws if base is missing', async () => {
    await expect(exportDesignPdf({ designId: 'd-1' })).rejects.toThrow(/base/);
  });

  it('loads the design via same-origin iframe and saves a PDF', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas({ width: 800, height: 800 }));
    await exportDesignPdf({ designId: 'd-1', base: 'http://hub.test', filename: 'Neat design' });

    // html2canvas was invoked with the iframe's documentElement
    expect(html2canvasMock).toHaveBeenCalledTimes(1);

    // Single-page design → one addImage, zero addPage
    expect(addImageMock).toHaveBeenCalledTimes(1);
    expect(addPageMock).not.toHaveBeenCalled();

    // Saved with the sanitized filename
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toBe('Neat_design.pdf');
  });

  it('paginates long designs across multiple PDF pages', async () => {
    // canvas.height (4000) / pageHeightPx (canvas.width=800 / 210mm * 297mm ≈ 1131)
    // = ~4 pages. addPage is called once less than the total page count.
    html2canvasMock.mockResolvedValue(fakeCanvas({ width: 800, height: 4000 }));
    await exportDesignPdf({ designId: 'd-2', base: 'http://hub.test' });

    expect(addImageMock.mock.calls.length).toBeGreaterThan(1);
    expect(addPageMock.mock.calls.length).toBe(addImageMock.mock.calls.length - 1);
    expect(saveMock.mock.calls[0][0]).toBe('design-d-2.pdf');
  });

  it('removes the hidden iframe after a successful export', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas());
    await exportDesignPdf({ designId: 'd-1', base: 'http://hub.test' });
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });

  it('removes the hidden iframe even if rendering fails', async () => {
    html2canvasMock.mockRejectedValue(new Error('boom'));
    await expect(exportDesignPdf({ designId: 'd-1', base: 'http://hub.test' })).rejects.toThrow(
      /boom/,
    );
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });

  it('sanitizes unsafe characters in the filename', async () => {
    html2canvasMock.mockResolvedValue(fakeCanvas());
    await exportDesignPdf({
      designId: 'd-3',
      base: 'http://hub.test',
      filename: '../evil / name?.pdf',
    });
    const savedAs = saveMock.mock.calls[0][0];
    expect(savedAs).not.toContain('/');
    expect(savedAs).not.toContain('?');
    expect(savedAs).toMatch(/\.pdf$/);
  });
});
