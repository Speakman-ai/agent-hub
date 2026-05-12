import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Regression coverage for the project-import wiki section
 * (server/routes/config.ts → `runProjectImport`).
 *
 * Background: a real export with 26 wiki pages caused
 *
 *     500: Import failed: [wiki] Too few parameter values were provided
 *
 * because the wiki loop passed `page.title` / `page.slug` straight to
 * better-sqlite3 with no defensive fallback. A single row missing one of
 * those fields aborted the whole import (wiki + crons + rooms + kanban +
 * webhooks). The hardened loop validates per-row, skips malformed entries
 * with a console.warn, and never throws back into runSection.
 *
 * Separately, the import path bypassed `server/wiki.ts` so newly imported
 * pages were inserted into `wiki_pages` but never into the `wiki_pages_fts`
 * FTS index. They became searchable only after the next edit. The loop
 * now calls `syncWikiPageFts(...)` after both create and update.
 */
describe('POST /api/projects/import — wiki section hardening', () => {
  function baseExport(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 3,
      type: 'project',
      project: {
        id: `imp-wiki-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Wiki Import ${Date.now()}`,
        cwd: '/tmp',
        color: '#abcdef',
        agents: [],
      },
      ...extra,
    };
  }

  it('does not 500 when a wiki page is missing its title; the good pages still import', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodSlug = `good-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const res = await request
      .post('/api/projects/import')
      .send(
        baseExport({
          wiki: [
            // Missing `title` — historically blew the whole import up.
            { slug: 'bad-no-title', content: '# Orphan' },
            { slug: goodSlug, title: 'Good Page', content: '# Hello' },
          ],
        }),
      )
      .expect(201);

    expect(res.body.results.wiki).toMatch(/1 new, 0 updated, 1 skipped/);

    const newId = res.body.project.id as string;
    const good = await request.get(`/api/projects/${newId}/wiki/${goodSlug}`).expect(200);
    expect(good.body.title).toBe('Good Page');
    await request.get(`/api/projects/${newId}/wiki/bad-no-title`).expect(404);

    // The skip should be visible in logs so operators can triage the bad row.
    expect(warn).toHaveBeenCalled();
    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).toMatch(/wiki/i);
    expect(warned).toMatch(/skip/i);
  });

  it('skips pages with missing or empty slug without aborting the import', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodSlug = `slug-ok-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const res = await request
      .post('/api/projects/import')
      .send(
        baseExport({
          wiki: [
            { title: 'No Slug Here', content: '# nope' }, // undefined slug
            { slug: '   ', title: 'Whitespace Slug', content: '# nope' }, // whitespace-only
            { slug: goodSlug, title: 'Real Page', content: '# yep' },
          ],
        }),
      )
      .expect(201);

    expect(res.body.results.wiki).toMatch(/1 new, 0 updated, 2 skipped/);
    const newId = res.body.project.id as string;
    await request.get(`/api/projects/${newId}/wiki/${goodSlug}`).expect(200);
  });

  it('imports wiki pages into the FTS index so search returns them immediately', async () => {
    const uniqueToken = `phraseimport${Math.random().toString(36).slice(2, 10)}`;
    const slug = `fts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const res = await request
      .post('/api/projects/import')
      .send(
        baseExport({
          wiki: [
            {
              slug,
              title: 'FTS Imported Page',
              content: `This page contains a unique marker: ${uniqueToken}.`,
              category: 'general',
              updated_by: 'import-test',
            },
          ],
        }),
      )
      .expect(201);

    const newId = res.body.project.id as string;

    // Search by the unique token. If the FTS index was never written, this
    // returns []; the assertion below catches the regression.
    const search = await request
      .get(`/api/projects/${newId}/wiki`)
      .query({ q: uniqueToken })
      .expect(200);

    const hits = Array.isArray(search.body) ? search.body : search.body.pages || [];
    expect(hits.length).toBeGreaterThan(0);
    const found = (hits as Array<{ slug: string }>).find((p) => p.slug === slug);
    expect(found).toBeDefined();
  });

  it('coerces non-string content/category/updated_by safely (no 500 on partial fields)', async () => {
    const slug = `coerce-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const res = await request
      .post('/api/projects/import')
      .send(
        baseExport({
          wiki: [
            {
              slug,
              title: 'Coerce Me',
              // All optional fields omitted — must fall back without crashing
              // better-sqlite3 with "Too few parameter values".
            },
          ],
        }),
      )
      .expect(201);

    const newId = res.body.project.id as string;
    const page = await request.get(`/api/projects/${newId}/wiki/${slug}`).expect(200);
    expect(page.body.title).toBe('Coerce Me');
    expect(page.body.content).toBe('');
    expect(page.body.category).toBe('general');
    expect(page.body.updated_by).toBe('import');
  });
});
