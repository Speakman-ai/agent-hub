import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import config from './config.js';
import type { EmailAttachment } from './email-sender.js';

/**
 * Branded HTML email shell for customer-facing deployment/release
 * notifications. The release digest and ticket-release emails are stored as
 * markdown/plain text; at delivery time we render them to an HTML part wrapped
 * in a simple table-based layout with the Agent Hub logo in the header. The
 * plain-text part is kept unchanged, so clients that block HTML still get the
 * original body.
 *
 * The logo travels as an inline `cid:` attachment (not a hosted URL) so it
 * renders even when the recipient's client blocks remote images and without
 * depending on a publicly reachable asset URL.
 */

/** Content-ID the HTML shell references via `<img src="cid:...">`. */
export const BRAND_LOGO_CID = 'agenthub-brand-logo';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const LOGO_ASSET_PATH = join(moduleDir, 'assets', 'email-logo.png');

// Read once and cache. `null` means the asset could not be read; callers then
// fall back to an unbranded (but still HTML) email rather than failing to send.
let cachedLogo: Buffer | null | undefined;

function loadLogoBuffer(): Buffer | null {
  if (cachedLogo !== undefined) return cachedLogo;
  try {
    cachedLogo = readFileSync(LOGO_ASSET_PATH);
  } catch (err) {
    console.warn(`[email-branding] logo asset unavailable: ${(err as Error).message}`);
    cachedLogo = null;
  }
  return cachedLogo;
}

/** Test seam: reset the cached logo buffer so a re-read is forced. */
export function resetBrandLogoCacheForTest(): void {
  cachedLogo = undefined;
}

/**
 * Returns the inline logo attachment, or `null` when branding is disabled
 * (`config.emailLogoEnabled === false`) or the asset cannot be read.
 */
export function resolveBrandLogoAttachment(): EmailAttachment | null {
  if (!config.emailLogoEnabled) return null;
  const content = loadLogoBuffer();
  if (!content) return null;
  return {
    filename: 'agent-hub-logo.png',
    content,
    cid: BRAND_LOGO_CID,
    contentType: 'image/png',
  };
}

/** Encode raw image bytes as a `data:` URL for inline browser rendering. */
export function toImageDataUrl(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

/**
 * The global default logo as a `data:` URL for the browser email preview, or
 * `null` when branding is disabled or the asset can't be read (the preview then
 * shows the text-wordmark header, matching what recipients would receive).
 */
export function resolveBrandLogoDataUrl(): string | null {
  if (!config.emailLogoEnabled) return null;
  const content = loadLogoBuffer();
  if (!content) return null;
  return toImageDataUrl(content, 'image/png');
}

/**
 * A representative release-digest body used by the Settings email preview so an
 * admin can see the logo + messaging together before a real deployment ships.
 * Intentionally static (no LLM call): it mirrors the shape a generated digest
 * takes without depending on any queued/sent notification existing yet.
 */
export function buildSampleReleaseDigestBody(projectName?: string): string {
  const name = (projectName ?? '').trim() || 'your project';
  return [
    `# What's new in ${name}`,
    '',
    'This is a preview of how your release and deployment notification emails will look with the branding above.',
    '',
    '## Highlights',
    '',
    '- **Faster dashboards** — pages that used to take seconds now load instantly.',
    '- **Fixed a sign-in edge case** that could log some users out early.',
    '- Polished a handful of rough edges across settings and reports.',
    '',
    '## Fixes',
    '',
    '- Resolved a support-reported issue where exports occasionally omitted the last row.',
    '- Corrected a timezone display bug on scheduled items.',
    '',
    'Thanks for using the product — reply to this email if anything looks off.',
  ].join('\n');
}

/**
 * Allowlist for the rendered body. `marked` preserves raw HTML and does NOT
 * escape it, so its output must be sanitized before it lands in an email — the
 * release digest is LLM-generated and ticket-release bodies derive from
 * customer-supplied ticket content, either of which could otherwise inject
 * deceptive links, remote tracking images, `<script>`/`<style>`, or
 * layout-breaking markup. We keep only inert formatting tags: no `img` (blocks
 * tracking pixels), no `style`/`class` on body content (the trusted shell owns
 * all styling), and links restricted to http/https/mailto (blocks
 * `javascript:` / `data:` URLs).
 */
const BODY_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'hr',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'del',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'a',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
  ],
  allowedAttributes: {
    a: ['href'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Drop the tag AND its text content for these (default already covers
  // script/style; listed explicitly so a payload's inner text never survives).
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe'],
  disallowedTagsMode: 'discard',
};

/** Render markdown/plain text to a sanitized HTML fragment safe for email. */
export function renderSanitizedBodyHtml(bodyText: string): string {
  return sanitizeHtml(marked.parse(bodyText ?? '', { async: false }), BODY_SANITIZE_OPTIONS);
}

/** Header markup for the logo: an `<img>` at `logoSrc`, or a text wordmark. */
function renderHeaderHtml(logoSrc: string | null): string {
  return logoSrc
    ? `<img src="${logoSrc}" alt="Agent Hub" width="180" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:180px;" />`
    : `<span style="font-size:20px;font-weight:600;color:#0f172a;">Agent Hub</span>`;
}

/** The shared table-based email shell. `bodyHtml` must already be sanitized. */
function renderEmailShell(headerHtml: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>',
    '<body style="margin:0;padding:0;background:#f1f5f9;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">',
    `<tr><td style="padding:24px 32px;border-bottom:1px solid #e2e8f0;">${headerHtml}</td></tr>`,
    `<tr><td style="padding:24px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">${bodyHtml}</td></tr>`,
    '<tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#64748b;">Sent by Agent Hub.</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
}

/**
 * Render a markdown/plain-text body into a branded HTML email. Both the
 * release digest (markdown) and ticket-release (plain text) bodies render
 * correctly: plain paragraphs pass through markdown unchanged.
 *
 * When `logoCid` is provided the header shows an inline `<img src="cid:...">`;
 * otherwise the header falls back to a text wordmark.
 */
export function renderBrandedEmailHtml(bodyText: string, logoCid: string | null): string {
  return renderEmailShell(
    renderHeaderHtml(logoCid ? `cid:${logoCid}` : null),
    renderSanitizedBodyHtml(bodyText),
  );
}

/**
 * Browser-facing twin of {@link renderBrandedEmailHtml} for the Settings email
 * preview. Real emails embed the logo as an inline `cid:` attachment, which a
 * browser can't resolve — so the preview inlines the same bytes as a `data:`
 * URL instead. `null` renders the text-wordmark fallback (branding disabled or
 * asset unreadable), exactly matching the sent email's header for that state.
 */
export function renderBrandedEmailPreviewHtml(
  bodyText: string,
  logoDataUrl: string | null,
): string {
  return renderEmailShell(renderHeaderHtml(logoDataUrl), renderSanitizedBodyHtml(bodyText));
}

export interface BrandedEmailParts {
  html: string;
  attachments: EmailAttachment[];
}

/**
 * Build the HTML part + inline attachments for a release/ticket notification
 * body. The caller keeps sending the original `bodyText` as the plain-text
 * part; this adds the branded HTML alternative.
 *
 * `projectLogo` is an optional per-project override attachment (see
 * `server/project-branding.ts`). When provided it replaces the global logo,
 * but the global `config.emailLogoEnabled` kill switch still wins: with
 * branding disabled, no logo ships regardless of project settings.
 */
export function buildBrandedReleaseEmail(
  bodyText: string,
  projectLogo?: EmailAttachment | null,
): BrandedEmailParts {
  const logo = config.emailLogoEnabled ? (projectLogo ?? resolveBrandLogoAttachment()) : null;
  const html = renderBrandedEmailHtml(bodyText, logo ? BRAND_LOGO_CID : null);
  return { html, attachments: logo ? [logo] : [] };
}
