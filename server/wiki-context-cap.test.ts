/**
 * Tests for the wiki context budget applied to `getWikiContext` /
 * `formatWikiContext` (server/wiki.ts). Before this cap the enriched
 * system prompt listed every wiki page on every turn — 12 to 20 KB of
 * metadata for mature projects. The cap keeps the most-recent slice and
 * defers the long tail to `wiki_search`.
 */
import { describe, it, expect } from 'vitest';
import { formatWikiContext, WIKI_CONTEXT_PAGE_CAP } from './wiki.js';

type FakePage = { title: string; category: string; updated_at: string };

function makePages(n: number, prefix = 'Page'): FakePage[] {
  // Most-recent first, matching `getWikiPages`'s ORDER BY updated_at DESC.
  return Array.from({ length: n }, (_, i) => ({
    title: `${prefix} ${i + 1}`,
    category: 'general',
    updated_at: `2026-05-${String(14 - (i % 14)).padStart(2, '0')} 00:00:00`,
  }));
}

describe('formatWikiContext', () => {
  it('returns empty string when there are no pages', () => {
    expect(formatWikiContext([])).toBe('');
  });

  it('lists every page without a hidden-count footer when total <= cap', () => {
    const pages = makePages(5);
    const out = formatWikiContext(pages);
    expect(out).toContain('## Project Wiki (5 pages)');
    expect(out).not.toContain('most-recent shown');
    expect(out).not.toContain('on demand');
    for (const p of pages) {
      expect(out).toContain(`- **${p.title}** (general) — updated ${p.updated_at}`);
    }
  });

  it('caps the rendered list at WIKI_CONTEXT_PAGE_CAP and mentions wiki_search for the rest', () => {
    const total = WIKI_CONTEXT_PAGE_CAP + 50;
    const pages = makePages(total);
    const out = formatWikiContext(pages);

    // Header reports both totals.
    expect(out).toContain(
      `## Project Wiki (${total} pages; ${WIKI_CONTEXT_PAGE_CAP} most-recent shown)`,
    );
    // Pointer to on-demand retrieval mentions the remainder.
    expect(out).toContain(`remaining ${total - WIKI_CONTEXT_PAGE_CAP} pages on demand`);
    expect(out).toContain('wiki_search');

    // Only the first N pages are listed as bullets.
    const bulletCount = (out.match(/^- \*\*/gm) || []).length;
    expect(bulletCount).toBe(WIKI_CONTEXT_PAGE_CAP);

    // The cap'd page is present; the first hidden page is absent.
    expect(out).toContain(`Page ${WIKI_CONTEXT_PAGE_CAP}`);
    expect(out).not.toContain(`Page ${WIKI_CONTEXT_PAGE_CAP + 1}`);
  });

  it('honors an explicit cap override', () => {
    const pages = makePages(10);
    const out = formatWikiContext(pages, 3);
    expect(out).toContain('## Project Wiki (10 pages; 3 most-recent shown)');
    expect(out).toContain('remaining 7 pages on demand');
    const bulletCount = (out.match(/^- \*\*/gm) || []).length;
    expect(bulletCount).toBe(3);
  });

  it('clamps a negative or zero cap to "no bullets" and still surfaces the search pointer', () => {
    const pages = makePages(5);
    const out = formatWikiContext(pages, 0);
    expect(out).toContain('## Project Wiki (5 pages; 0 most-recent shown)');
    expect(out).toContain('remaining 5 pages on demand');
    expect(out.match(/^- \*\*/gm)).toBeNull();
  });

  it('cuts at least 10 KB off a realistic 148-page board', () => {
    // Regression guard for the audit motivation. With WIKI_CONTEXT_PAGE_CAP
    // = 25 the rendered context for a 148-page wiki must be materially
    // smaller than the uncapped version. 10 KB is conservative; the
    // observed delta at the time of the audit was ~12 to 20 KB.
    const pages = makePages(148, 'Wiki page with a reasonably long title');
    const capped = formatWikiContext(pages);
    const uncapped = formatWikiContext(pages, pages.length);
    const delta = Buffer.byteLength(uncapped, 'utf8') - Buffer.byteLength(capped, 'utf8');
    expect(delta).toBeGreaterThanOrEqual(10 * 1024);
  });
});
