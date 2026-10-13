/** Directories of pdf.js runtime data, relative to the pdfjs-dist package. */
export const PDFJS_ASSET_DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs'] as const;

/** Where the data is served, relative to the app's base URL. */
export const PDFJS_ASSET_PREFIX = 'pdfjs/';

/**
 * getDocument options pointing pdf.js at the shipped data. Every URL is a
 * directory with a trailing slash; pdf.js appends the file name.
 */
export function pdfjsAssetUrls(baseUrl: string) {
  const root = `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}${PDFJS_ASSET_PREFIX}`;
  return {
    wasmUrl: `${root}wasm/`,
    cMapUrl: `${root}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${root}standard_fonts/`,
    iccUrl: `${root}iccs/`,
  };
}
