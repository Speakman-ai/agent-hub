/**
 * Ships the data pdf.js fetches at runtime by URL: WebAssembly decoders
 * (JPEG2000, JBIG2, color management), CJK character maps, the standard 14
 * fonts, and ICC profiles. pdf.js renders without them but silently drops
 * whatever needs them, e.g. JPEG2000 images in scanned PDFs come out blank.
 *
 * Dev serves the files straight from node_modules; builds emit them under
 * `pdfjs/`. The client points getDocument at the same paths (see
 * `pdfjsAssetUrls` in ./pdfjsAssets.ts).
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import { PDFJS_ASSET_DIRS, PDFJS_ASSET_PREFIX } from './pdfjsAssets';

/** pdf.js scripting sandbox; the viewer never runs PDF JavaScript. */
const SKIP = /^quickjs-eval\./;

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
};

export function listPdfjsAssets(pdfjsRoot: string): { fileName: string; source: string }[] {
  const out: { fileName: string; source: string }[] = [];
  for (const dir of PDFJS_ASSET_DIRS) {
    const abs = path.join(pdfjsRoot, dir);
    if (!existsSync(abs)) throw new Error(`pdfjs-dist is missing ${dir}/ (looked in ${abs})`);
    for (const name of readdirSync(abs)) {
      if (SKIP.test(name) || name.startsWith('LICENSE')) continue;
      out.push({ fileName: `${PDFJS_ASSET_PREFIX}${dir}/${name}`, source: path.join(abs, name) });
    }
  }
  return out;
}

export function pdfjsAssetsPlugin(pdfjsRoot: string): Plugin {
  const assets = () => listPdfjsAssets(pdfjsRoot);
  return {
    name: 'agent-hub-pdfjs-assets',
    configureServer(server) {
      const byUrl = new Map(assets().map((a) => [`/${a.fileName}`, a.source]));
      server.middlewares.use((req, res, next) => {
        const source = byUrl.get((req.url ?? '').split('?')[0]);
        if (!source) return next();
        const type = CONTENT_TYPES[path.extname(source)] ?? 'application/octet-stream';
        res.setHeader('Content-Type', type);
        res.end(readFileSync(source));
      });
    },
    generateBundle() {
      for (const asset of assets()) {
        this.emitFile({
          type: 'asset',
          fileName: asset.fileName,
          source: readFileSync(asset.source),
        });
      }
    },
  };
}
