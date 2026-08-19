import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { getStmts } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression coverage for the two cheap RAG hot-path wins:
 *   1. `WHERE model = ?` in the embedding load statements so stale-model
 *      BLOBs never enter JS (was a post-load `.filter(r => r.model === …)`).
 *   2. wiki-RAG and code-RAG fired concurrently via `Promise.all` instead
 *      of back-to-back `await`s on every eligible user turn.
 */
describe('RAG retrieval hot-path', () => {
  it('loads wiki embeddings with a SQL model predicate, not a post-scan JS filter', () => {
    const sql = getStmts().getWikiEmbeddingsByProject.source;
    expect(sql).toMatch(/WHERE\s+project_id\s*=\s*\?\s+AND\s+model\s*=\s*\?/i);
    expect(sql).not.toMatch(/WHERE\s+project_id\s*=\s*\?\s*$/i);
  });

  it('loads code embeddings with a SQL model predicate, not a post-scan JS filter', () => {
    const sql = getStmts().getCodeEmbeddingsByProject.source;
    expect(sql).toMatch(/WHERE\s+project_id\s*=\s*\?\s+AND\s+model\s*=\s*\?/i);
    expect(sql).not.toMatch(/WHERE\s+project_id\s*=\s*\?\s*$/i);
  });

  it('runs wiki-RAG and code-RAG concurrently on each eligible user turn', () => {
    const src = readFileSync(path.join(here, 'chat.ts'), 'utf8');
    expect(src).toMatch(
      /const \[wikiRag,\s*codeRag\] = await Promise\.all\(\[\s*runWikiHybridRagForUserTurn\(/s,
    );
    expect(src).toMatch(
      /await Promise\.all\(\[[\s\S]*?runWikiHybridRagForUserTurn\([\s\S]*?runCodeRagForUserTurn\(/,
    );
    expect(src).not.toMatch(/const wikiRag = await runWikiHybridRagForUserTurn/);
    expect(src).not.toMatch(/const codeRag = await runCodeRagForUserTurn/);
  });
});
