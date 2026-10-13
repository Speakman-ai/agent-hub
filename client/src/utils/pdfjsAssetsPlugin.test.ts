import path from 'path';
import { describe, it, expect } from 'vitest';
import { listPdfjsAssets } from './pdfjsAssetsPlugin';
import { pdfjsAssetUrls } from './pdfjsAssets';

const root = path.resolve(__dirname, '../../node_modules/pdfjs-dist');

describe('listPdfjsAssets', () => {
  const names = listPdfjsAssets(root).map((a) => a.fileName);

  it('ships the decoders and data pdf.js fetches by URL', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'pdfjs/wasm/openjpeg.wasm',
        'pdfjs/wasm/openjpeg_nowasm_fallback.js',
        'pdfjs/wasm/jbig2.wasm',
        'pdfjs/wasm/qcms_bg.wasm',
        'pdfjs/cmaps/UniJIS-UCS2-H.bcmap',
        'pdfjs/standard_fonts/LiberationSans-Bold.ttf',
      ]),
    );
    expect(names.some((n) => n.startsWith('pdfjs/iccs/') && n.endsWith('.icc'))).toBe(true);
  });

  it('skips the scripting sandbox and license files', () => {
    expect(names.some((n) => n.includes('quickjs'))).toBe(false);
    expect(names.some((n) => n.includes('LICENSE'))).toBe(false);
  });

  it('fails the build when pdfjs-dist is missing a data directory', () => {
    expect(() => listPdfjsAssets('/nonexistent')).toThrow(/missing wasm/);
  });
});

describe('pdfjsAssetUrls', () => {
  it('builds directory URLs under the app base, with trailing slashes', () => {
    expect(pdfjsAssetUrls('/')).toMatchObject({ wasmUrl: '/pdfjs/wasm/', iccUrl: '/pdfjs/iccs/' });
    expect(pdfjsAssetUrls('/hub')).toMatchObject({ cMapUrl: '/hub/pdfjs/cmaps/' });
  });
});
