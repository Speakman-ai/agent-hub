import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// client/src -> repo client/
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(clientDir, p));
const readText = (p: string) => read(p).toString('utf8');

/** Parse a PNG buffer's IHDR dimensions; throws if not a PNG. */
function pngSize(buf: Buffer): { width: number; height: number } {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('not a PNG');
  // IHDR starts at byte 16 (after 8-byte sig + 4-byte len + 4-byte "IHDR")
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('brand assets: new pointy-hex mark', () => {
  it('favicon.svg carries the brand-blue rounded frame, hex outline, pointy blade, and hex hub', () => {
    const svg = readText('public/favicon.svg');
    // brand-blue rounded square background
    expect(svg).toMatch(/rx="96"/);
    expect(svg.toLowerCase()).toContain('#1e40af');
    // outer hexagon frame (6 vertices from favicon geometry)
    expect(svg).toContain('256,58 427.5,157 427.5,355 256,454 84.5,355 84.5,157');
    // exactly three round-cap line spokes (the 4th, the 2 o'clock, is a pointy polygon)
    expect(svg.match(/<line /g)?.length).toBe(3);
    // 6 o'clock spoke straight down to the bottom vertex
    expect(svg).toContain('x2="256" y2="454"');
    // two filled polygons beyond the outer frame: the pointy blade + the hex hub
    expect(svg.match(/<polygon /g)?.length).toBe(3); // frame + blade + hub
    expect(svg).toContain('stroke-linejoin="miter"'); // the sharp (pointy) blade tip
  });

  it('every referenced icon PNG exists and matches its declared size', () => {
    const expectations: Array<[string, number, number]> = [
      ['public/icon.png', 1024, 1024],
      ['public/logo-mark.png', 150, 150],
      ['public/favicon.png', 128, 128],
      ['public/apple-touch-icon.png', 180, 180],
      ['public/logo.png', 600, 148],
    ];
    for (const [file, w, h] of expectations) {
      const { width, height } = pngSize(read(file));
      expect(width, `${file} width`).toBe(w);
      expect(height, `${file} height`).toBe(h);
    }
  });

  it('web asset cache-bust stays in sync between index.html and BrandLogo', () => {
    const html = readText('index.html');
    const brandLogo = readText('src/components/BrandLogo.tsx');
    const versions = new Set(
      [...html.matchAll(/\?v=(\d+)/g), ...brandLogo.matchAll(/\?v=(\d+)/g)].map((m) => m[1]),
    );
    // A single, shared cache-bust version across both files (bump together on asset change).
    expect(versions.size, `mismatched ?v= versions: ${[...versions].join(', ')}`).toBe(1);
    expect([...versions][0]).toBe('4');
  });
});
