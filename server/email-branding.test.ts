import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { inflateSync } from 'zlib';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({ emailLogoEnabled: true }));
vi.mock('./config.js', () => ({ default: mockConfig }));

import {
  BRAND_LOGO_CID,
  buildBrandedReleaseEmail,
  buildSampleReleaseDigestBody,
  renderBrandedEmailHtml,
  renderBrandedEmailPreviewHtml,
  renderSanitizedBodyHtml,
  resolveBrandLogoAttachment,
  resolveBrandLogoDataUrl,
  resetBrandLogoCacheForTest,
  toImageDataUrl,
} from './email-branding.js';

beforeEach(() => {
  mockConfig.emailLogoEnabled = true;
  resetBrandLogoCacheForTest();
});

describe('renderBrandedEmailHtml', () => {
  it('renders markdown digest bodies to HTML', () => {
    const html = renderBrandedEmailHtml('# Heading\n\n- one\n- two', BRAND_LOGO_CID);
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain(`cid:${BRAND_LOGO_CID}`);
    expect(html).toContain('<html>');
  });

  it('renders plain-text ticket bodies as paragraphs', () => {
    const html = renderBrandedEmailHtml('Your fix shipped.', null);
    expect(html).toContain('<p>Your fix shipped.</p>');
  });

  it('falls back to a text wordmark when no logo cid is supplied', () => {
    const html = renderBrandedEmailHtml('Body', null);
    expect(html).not.toContain('cid:');
    expect(html).toContain('Agent Hub');
  });
});

describe('renderSanitizedBodyHtml — untrusted body content is neutralized', () => {
  it('strips <script> tags and their contents', () => {
    const out = renderSanitizedBodyHtml('Hello <script>alert("xss")</script> world');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert("xss")');
    expect(out).toContain('Hello');
  });

  it('strips raw <img> so remote tracking pixels cannot load', () => {
    const out = renderSanitizedBodyHtml(
      '![t](https://evil.example/track.gif)\n\nraw <img src="https://evil.example/pixel.gif">',
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('evil.example');
  });

  it('removes javascript: link hrefs while keeping the link text', () => {
    const out = renderSanitizedBodyHtml('[click me](javascript:alert(1))');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('click me');
  });

  it('strips <style> and <iframe> layout-hijack payloads', () => {
    const out = renderSanitizedBodyHtml(
      '<style>body{display:none}</style><iframe src="https://evil.example"></iframe>ok',
    );
    expect(out).not.toContain('<style');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('display:none');
    expect(out).toContain('ok');
  });

  it('drops style/class attributes injected into body content', () => {
    const out = renderSanitizedBodyHtml('<p style="position:fixed" class="evil">text</p>');
    expect(out).not.toContain('style=');
    expect(out).not.toContain('class=');
    expect(out).toContain('text');
  });

  it('preserves legitimate http(s) links from the digest', () => {
    const out = renderSanitizedBodyHtml('[release notes](https://good.example/notes)');
    expect(out).toContain('href="https://good.example/notes"');
    expect(out).toContain('release notes');
  });
});

describe('renderBrandedEmailHtml — malicious payload does not reach the shell', () => {
  it('sanitizes body markup but keeps the trusted logo header', () => {
    const html = renderBrandedEmailHtml(
      'Digest <script>steal()</script> body <img src="https://evil.example/p.gif">',
      BRAND_LOGO_CID,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('steal()');
    expect(html).not.toContain('evil.example');
    // Trusted shell (its own inline styles + cid logo) is untouched.
    expect(html).toContain(`cid:${BRAND_LOGO_CID}`);
    expect(html).toContain('<html>');
  });
});

describe('resolveBrandLogoAttachment', () => {
  it('returns an inline png attachment when branding is enabled', () => {
    const att = resolveBrandLogoAttachment();
    expect(att).not.toBeNull();
    expect(att?.cid).toBe(BRAND_LOGO_CID);
    expect(att?.contentType).toBe('image/png');
    expect(Buffer.isBuffer(att?.content)).toBe(true);
    expect((att?.content as Buffer).length).toBeGreaterThan(0);
  });

  it('returns null when branding is disabled', () => {
    mockConfig.emailLogoEnabled = false;
    expect(resolveBrandLogoAttachment()).toBeNull();
  });
});

describe('buildBrandedReleaseEmail', () => {
  it('includes an HTML part and one inline logo attachment when enabled', () => {
    const parts = buildBrandedReleaseEmail('Release digest body');
    expect(parts.html).toContain(`cid:${BRAND_LOGO_CID}`);
    expect(parts.attachments).toHaveLength(1);
    expect(parts.attachments[0]?.cid).toBe(BRAND_LOGO_CID);
  });

  it('omits the logo and attachment when disabled but still returns HTML', () => {
    mockConfig.emailLogoEnabled = false;
    const parts = buildBrandedReleaseEmail('Release digest body');
    expect(parts.attachments).toEqual([]);
    expect(parts.html).not.toContain('cid:');
    expect(parts.html).toContain('<html>');
  });
});

describe('buildBrandedReleaseEmail — per-project logo override', () => {
  const projectLogo = {
    filename: 'email-logo.png',
    content: Buffer.from('project-logo-bytes'),
    cid: BRAND_LOGO_CID,
    contentType: 'image/png',
  };

  it('uses the project logo attachment when one is provided', () => {
    const parts = buildBrandedReleaseEmail('Body', projectLogo);
    expect(parts.attachments).toHaveLength(1);
    expect(parts.attachments[0]).toBe(projectLogo);
    expect(parts.html).toContain(`cid:${BRAND_LOGO_CID}`);
  });

  it('falls back to the global logo when no project logo is given', () => {
    const parts = buildBrandedReleaseEmail('Body', null);
    expect(parts.attachments).toHaveLength(1);
    // The global asset ships under its own filename, not the project one.
    expect(parts.attachments[0]?.filename).toBe('agent-hub-logo.png');
  });

  it('ships no logo when branding is globally disabled, even with a project logo', () => {
    mockConfig.emailLogoEnabled = false;
    const parts = buildBrandedReleaseEmail('Body', projectLogo);
    expect(parts.attachments).toEqual([]);
    expect(parts.html).not.toContain('cid:');
    expect(parts.html).toContain('<html>');
  });
});

describe('toImageDataUrl', () => {
  it('encodes bytes as a base64 data URL with the given content type', () => {
    const url = toImageDataUrl(Buffer.from('abc'), 'image/gif');
    expect(url).toBe(`data:image/gif;base64,${Buffer.from('abc').toString('base64')}`);
  });
});

describe('resolveBrandLogoDataUrl', () => {
  it('returns the global asset as an image/png data URL when enabled', () => {
    const url = resolveBrandLogoDataUrl();
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('returns null when branding is disabled', () => {
    mockConfig.emailLogoEnabled = false;
    expect(resolveBrandLogoDataUrl()).toBeNull();
  });
});

describe('renderBrandedEmailPreviewHtml', () => {
  it('inlines the logo as an <img src> data URL (not a cid) and renders the body', () => {
    const dataUrl = toImageDataUrl(Buffer.from('logo'), 'image/png');
    const html = renderBrandedEmailPreviewHtml('# Hi\n\nbody text', dataUrl);
    expect(html).toContain(`<img src="${dataUrl}"`);
    expect(html).not.toContain('cid:');
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<p>body text</p>');
  });

  it('falls back to the text wordmark when no logo data URL is supplied', () => {
    const html = renderBrandedEmailPreviewHtml('body', null);
    expect(html).not.toContain('<img');
    expect(html).toContain('Agent Hub');
  });

  it('sanitizes malicious body markup while keeping the trusted shell', () => {
    const html = renderBrandedEmailPreviewHtml(
      'x <script>steal()</script> <img src="https://evil.example/p.gif">',
      null,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('<html>');
  });
});

describe('buildSampleReleaseDigestBody', () => {
  it('includes the project name in the heading', () => {
    expect(buildSampleReleaseDigestBody('Acme')).toContain("What's new in Acme");
  });

  it('falls back to a generic subject when no name is given', () => {
    expect(buildSampleReleaseDigestBody('  ')).toContain("What's new in your project");
  });
});

// Minimal decoder for 8-bit RGBA, non-interlaced PNGs (color type 6). Both the
// email logo and the app brand logo are saved in that form; a decoder lets us
// assert on pixels without pulling an image dependency into the test suite.
function decodePngRgba(buf: Buffer): { width: number; height: number; data: Buffer } {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace})`,
    );
  }
  const idat: Buffer[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[rowStart - stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[rowStart - stride + x - bpp] : 0;
      let val: number;
      switch (filter) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = rawByte + left;
          break;
        case 2:
          val = rawByte + up;
          break;
        case 3:
          val = rawByte + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          val = rawByte + pred;
          break;
        }
        default:
          throw new Error(`bad PNG filter byte ${filter}`);
      }
      out[rowStart + x] = val & 0xff;
    }
  }
  return { width, height, data: out };
}

describe('email logo asset carries the current brand mark', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // The mark (blue hexagon + tool glyph) lives left of this column; the wordmark
  // text sits to the right. The email asset recolors only the wordmark for
  // legibility on the white shell, so the mark must stay pixel-identical.
  const MARK_MAX_X = 146;

  it('mark region is pixel-identical to the app brand logo (guards against a stale email logo)', () => {
    const email = decodePngRgba(readFileSync(join(here, 'assets', 'email-logo.png')));
    const brand = decodePngRgba(readFileSync(join(here, '..', 'client', 'public', 'logo.png')));
    expect({ w: email.width, h: email.height }).toEqual({ w: brand.width, h: brand.height });

    let markDiffs = 0;
    for (let y = 0; y < email.height; y++) {
      for (let x = 0; x < MARK_MAX_X; x++) {
        const i = (y * email.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          if (email.data[i + c] !== brand.data[i + c]) markDiffs++;
        }
      }
    }
    expect(markDiffs).toBe(0);
  });

  it('recolors the wordmark to a dark, legible ink for the white email header', () => {
    const email = decodePngRgba(readFileSync(join(here, 'assets', 'email-logo.png')));
    // Every opaque pixel in the wordmark region must be dark (not the near-white
    // ink the on-dark app logo uses), otherwise the wordmark vanishes on white.
    let opaqueInk = 0;
    for (let y = 0; y < email.height; y++) {
      for (let x = 160; x < email.width; x++) {
        const i = (y * email.width + x) * 4;
        const alpha = email.data[i + 3];
        if (alpha < 200) continue;
        opaqueInk++;
        const luminance = (email.data[i] + email.data[i + 1] + email.data[i + 2]) / 3;
        expect(luminance).toBeLessThan(96);
      }
    }
    // Sanity: the region actually contains wordmark pixels.
    expect(opaqueInk).toBeGreaterThan(500);
  });
});
