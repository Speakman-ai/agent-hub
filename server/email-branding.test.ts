import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({ emailLogoEnabled: true }));
vi.mock('./config.js', () => ({ default: mockConfig }));

import {
  BRAND_LOGO_CID,
  buildBrandedReleaseEmail,
  renderBrandedEmailHtml,
  renderSanitizedBodyHtml,
  resolveBrandLogoAttachment,
  resetBrandLogoCacheForTest,
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
