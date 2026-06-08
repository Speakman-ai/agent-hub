import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  chunkCode,
  toFtsMatchQuery,
  collectCodeFiles,
  indexProjectCode,
  searchCode,
  countProjectCodeChunks,
} from './code-embeddings.js';
import { setEmbedClient, type EmbedClient, type EmbeddingVector } from './wiki-embeddings.js';

// ─── Deterministic mock embedder ────────────────────────────────────
// Maps text → a small bag-of-words vector over a fixed vocabulary so cosine
// similarity is meaningful and reproducible without hitting the network.
const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'widget', 'parser', 'render', 'token'];

function embed(text: string): EmbeddingVector {
  const lower = text.toLowerCase();
  const values = VOCAB.map((w) => {
    const re = new RegExp(`\\b${w}\\b`, 'g');
    return (lower.match(re) || []).length + 0.01; // small floor so zero vectors don't collapse
  });
  return { values };
}

const mockClient: EmbedClient = {
  async embedTexts(texts: string[]): Promise<EmbeddingVector[]> {
    return texts.map(embed);
  },
};

describe('chunkCode', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkCode('')).toEqual([]);
    expect(chunkCode('   \n\n  ')).toEqual([]);
  });

  it('returns a single chunk for short content with 1-based line range', () => {
    const chunks = chunkCode('line one\nline two\nline three');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(3);
    expect(chunks[0]!.text).toContain('line two');
  });

  it('splits into multiple line-aligned chunks when exceeding maxChars', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `const v${i} = ${'x'.repeat(40)};`);
    const chunks = chunkCode(lines.join('\n'), 300, 2);
    expect(chunks.length).toBeGreaterThan(1);
    // Lines are 1-based and contiguous (allowing for overlap re-emitting tails).
    expect(chunks[0]!.startLine).toBe(1);
    for (const c of chunks) {
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
    // Later chunk start should be > 1 (advanced through the file).
    expect(chunks[chunks.length - 1]!.startLine).toBeGreaterThan(1);
  });

  it('carries overlap lines between adjacent chunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i} ${'y'.repeat(30)}`);
    const chunks = chunkCode(lines.join('\n'), 250, 3);
    if (chunks.length >= 2) {
      // The second chunk's start line should be <= the first chunk's end line
      // because the overlap re-includes trailing lines.
      expect(chunks[1]!.startLine).toBeLessThanOrEqual(chunks[0]!.endLine);
    }
  });

  it('hard-slices a single line longer than maxChars', () => {
    const mega = 'z'.repeat(5000);
    const chunks = chunkCode(mega, 1000, 4);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000);
    }
  });
});

describe('toFtsMatchQuery', () => {
  it('extracts identifier tokens and ORs them, quoting each', () => {
    expect(toFtsMatchQuery('how does the parser render tokens?')).toBe(
      '"how" OR "does" OR "the" OR "parser" OR "render" OR "tokens"',
    );
  });

  it('strips punctuation that would break FTS5 syntax', () => {
    const q = toFtsMatchQuery('foo("bar"): baz.qux');
    expect(q).toContain('"foo"');
    expect(q).toContain('"bar"');
    expect(q).not.toContain('(');
    expect(q).not.toContain(':');
  });

  it('returns empty string when nothing usable remains', () => {
    expect(toFtsMatchQuery('?! * : ( )')).toBe('');
    expect(toFtsMatchQuery('')).toBe('');
  });

  it('dedupes repeated tokens', () => {
    expect(toFtsMatchQuery('alpha alpha alpha')).toBe('"alpha"');
  });
});

describe('collectCodeFiles', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-collect-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(root, 'src', 'b.tsx'), 'export const b = 2;');
    fs.writeFileSync(path.join(root, 'README.md'), '# hi');
    fs.writeFileSync(path.join(root, 'image.png'), 'binary');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'bundle.min.js'), 'x');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports={}');
    fs.writeFileSync(path.join(root, 'dist', 'out.js'), 'built');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('includes source files, excludes deps/build/generated/binary', () => {
    const files = collectCodeFiles(root).sort();
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/b.tsx');
    expect(files).toContain('README.md');
    expect(files).not.toContain('image.png');
    expect(files).not.toContain('package-lock.json');
    expect(files).not.toContain('bundle.min.js');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false);
  });

  it('respects maxFiles cap', () => {
    expect(collectCodeFiles(root, 1)).toHaveLength(1);
  });
});

describe('indexProjectCode + searchCode (integration)', () => {
  let root: string;
  const projectId = `code-rag-test-${process.pid}`;
  let prevKey: string | undefined;

  beforeAll(() => {
    prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key'; // make isGeminiConfigured() true
    setEmbedClient(mockClient);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'alpha.ts'),
      'export function alpha() {\n  // alpha widget alpha\n  return "alpha";\n}\n',
    );
    fs.writeFileSync(
      path.join(root, 'src', 'beta.ts'),
      'export function beta() {\n  // beta parser beta\n  return "beta";\n}\n',
    );
  });
  afterAll(() => {
    setEmbedClient(null);
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('indexes files and stores chunks', async () => {
    const r = await indexProjectCode(projectId, root);
    expect(r.geminiConfigured).toBe(true);
    expect(r.indexed).toBe(2);
    expect(r.chunks).toBeGreaterThanOrEqual(2);
    expect(countProjectCodeChunks(projectId)).toBe(r.chunks);
  });

  it('semantic search ranks the relevant file first', async () => {
    const results = await searchCode(projectId, 'alpha widget', { mode: 'semantic', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.filePath).toBe('src/alpha.ts');
    expect(results[0]!.startLine).toBeGreaterThanOrEqual(1);
  });

  it('fts search finds chunks by keyword', async () => {
    const results = await searchCode(projectId, 'parser', { mode: 'fts', limit: 5 });
    expect(results.some((r) => r.filePath === 'src/beta.ts')).toBe(true);
  });

  it('hybrid search returns blended scores', async () => {
    const results = await searchCode(projectId, 'alpha', { mode: 'hybrid', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.filePath).toBe('src/alpha.ts');
  });

  it('is incremental: a re-run skips unchanged files', async () => {
    const r = await indexProjectCode(projectId, root);
    expect(r.indexed).toBe(0);
    expect(r.skipped).toBe(2);
  });

  it('re-embeds a changed file', async () => {
    fs.writeFileSync(
      path.join(root, 'src', 'alpha.ts'),
      'export function alpha() {\n  // alpha widget render alpha\n  return "alpha gamma";\n}\n',
    );
    const r = await indexProjectCode(projectId, root);
    expect(r.indexed).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('prunes chunks for deleted files', async () => {
    fs.rmSync(path.join(root, 'src', 'beta.ts'));
    const r = await indexProjectCode(projectId, root);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    const results = await searchCode(projectId, 'parser', { mode: 'fts', limit: 5 });
    expect(results.some((res) => res.filePath === 'src/beta.ts')).toBe(false);
  });
});

describe('indexProjectCode pruning safety (truncated scans)', () => {
  let root: string;
  const projectId = `code-rag-trunc-${process.pid}`;
  let prevKey: string | undefined;

  beforeAll(() => {
    prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    setEmbedClient(mockClient);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-trunc-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = "alpha alpha";\n');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = "beta beta";\n');
    fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = "gamma gamma";\n');
  });
  afterAll(() => {
    setEmbedClient(null);
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a full scan is not truncated and indexes all files', async () => {
    const r = await indexProjectCode(projectId, root);
    expect(r.truncated).toBe(false);
    expect(r.indexed).toBe(3);
    expect(r.removed).toBe(0);
  });

  it('does NOT prune unvisited files when the scan is capped by maxFiles', async () => {
    const before = countProjectCodeChunks(projectId);
    const r = await indexProjectCode(projectId, root, { maxFiles: 1 });
    expect(r.truncated).toBe(true);
    expect(r.removed).toBe(0); // critical: a partial scan must not delete real files
    // Chunks for the files that were never visited this run survive.
    expect(countProjectCodeChunks(projectId)).toBe(before);
    const beta = await searchCode(projectId, 'beta', { mode: 'fts', limit: 5 });
    expect(beta.some((res) => res.filePath === 'src/b.ts')).toBe(true);
    const gamma = await searchCode(projectId, 'gamma', { mode: 'fts', limit: 5 });
    expect(gamma.some((res) => res.filePath === 'src/c.ts')).toBe(true);
  });

  it('treats a non-positive maxFiles as the default (no mass prune)', async () => {
    const before = countProjectCodeChunks(projectId);
    const r = await indexProjectCode(projectId, root, { maxFiles: 0 });
    expect(r.removed).toBe(0);
    expect(countProjectCodeChunks(projectId)).toBe(before);
  });
});
