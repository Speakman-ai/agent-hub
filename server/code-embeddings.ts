/**
 * Code semantic search — repo-file indexing pipeline + hybrid ranker.
 *
 * This is the code-RAG sibling of `wiki-embeddings.ts`. It reuses the proven
 * embedding client, BLOB codec, cosine helper, and min-max score normalizer
 * from the wiki path and adds the parts that are specific to source code:
 *
 * - `chunkCode` splits a file into overlapping, line-aware windows so a
 *   retrieved chunk can be cited back as `path:startLine-endLine`. Code is
 *   denser than prose, so the default window (~1600 chars ≈ 400 tokens) is
 *   smaller than the wiki markdown chunker's.
 * - `indexProjectCode` walks a repo root, skips ignored dirs / binaries /
 *   generated files, and embeds each eligible file. It is **incremental**:
 *   a SHA-1 of the file content is stored per chunk, so unchanged files are
 *   skipped on re-runs and files that disappeared from disk are pruned.
 * - `searchCode` blends FTS5 BM25 keyword hits with cosine similarity over the
 *   stored vectors (50/50 by default), exactly like `searchWiki`, but returns
 *   chunk-level hits (file + line range + excerpt) rather than page rows.
 *
 * Storage: `code_chunks` (one row per chunk, with the raw Float32Array BLOB)
 * plus an external-content-style `code_chunks_fts` whose rowid is kept aligned
 * with `code_chunks.rowid` (same trick `wiki_pages_fts` uses). See `server/db.ts`.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db, stmts } from './db.js';
import type Database from 'better-sqlite3';
import type { Stmts } from './types.js';
import {
  type EmbedClient,
  getEmbedClient,
  isGeminiConfigured,
  encodeEmbedding,
  decodeEmbedding,
  cosineSimilarity,
  normalizeScores,
  DEFAULT_MODEL,
} from './wiki-embeddings.js';

export { isGeminiConfigured };

// ─── Types ──────────────────────────────────────────────────────────

export interface CodeChunk {
  idx: number;
  text: string;
  startLine: number;
  endLine: number;
}

export interface CodeEmbeddingRow {
  rowid: number;
  file_path: string;
  chunk_idx: number;
  chunk_text: string;
  start_line: number;
  end_line: number;
  embedding: Buffer;
  model: string;
}

export type CodeSearchMode = 'hybrid' | 'semantic' | 'fts';

export interface CodeSearchResult {
  filePath: string;
  chunkIdx: number;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  ftsScore?: number;
  semanticScore?: number;
  snippet?: string;
}

// ─── File-walk policy ───────────────────────────────────────────────

/** Directories never worth indexing — dependencies, build output, VCS, caches. */
export const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.nyc_output',
  '.cache',
  '.turbo',
  '.expo',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.worktrees',
  'worktrees',
  '.agent-hub',
  'tmp',
  '.idea',
  '.vscode',
]);

/** Extensions we treat as indexable source / text. */
export const DEFAULT_CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.vue',
  '.svelte',
  '.sh',
  '.bash',
  '.yml',
  '.yaml',
  '.toml',
  '.sql',
  '.graphql',
  '.gradle',
  '.txt',
]);

/** Filenames / suffixes that are generated or huge — skip even with a good ext. */
function isIgnoredFile(name: string): boolean {
  if (
    name === 'package-lock.json' ||
    name === 'yarn.lock' ||
    name === 'pnpm-lock.yaml' ||
    name === 'composer.lock'
  ) {
    return true;
  }
  return /\.(min\.(js|css)|map|d\.ts)$/.test(name);
}

const MAX_FILE_BYTES = 256 * 1024; // skip files larger than 256 KB

function looksBinary(buf: Buffer): boolean {
  // NUL byte in the first 8 KB is a reliable binary signal.
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Recursively collect indexable files under `root`, returning paths relative to
 * `root` (POSIX-style separators so the stored key is portable) plus a
 * `truncated` flag that is `true` when the walk stopped early because `maxFiles`
 * was hit. The flag matters for pruning: a truncated (partial) scan must NOT be
 * treated as the authoritative set of files on disk, or files that simply
 * weren't visited would be wrongly deleted from the index.
 */
export function collectCodeFilesWithMeta(
  root: string,
  maxFiles = 5000,
): { files: string[]; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!DEFAULT_CODE_EXTENSIONS.has(ext)) continue;
        if (isIgnoredFile(entry.name)) continue;
        out.push(abs);
      }
    }
  };
  walk(root);
  // Return relative, POSIX-normalized paths.
  const files = out.map((abs) => path.relative(root, abs).split(path.sep).join('/'));
  return { files, truncated };
}

/**
 * Convenience wrapper over {@link collectCodeFilesWithMeta} that returns just
 * the file list. Prefer the `*WithMeta` form when the truncation flag matters
 * (e.g. before pruning).
 */
export function collectCodeFiles(root: string, maxFiles = 5000): string[] {
  return collectCodeFilesWithMeta(root, maxFiles).files;
}

// ─── Chunker ────────────────────────────────────────────────────────

const DEFAULT_CHUNK_CHARS = 1600; // ~400 tokens — code is denser than prose
const DEFAULT_OVERLAP_LINES = 8;

/**
 * Split source into overlapping, line-aligned chunks. Each chunk carries its
 * 1-based `startLine`/`endLine` so retrieval can cite `path:start-end`. A chunk
 * boundary is taken when adding the next line would push the running buffer past
 * `maxChars`; `overlapLines` trailing lines are carried into the next chunk so a
 * symbol that straddles the seam is still retrievable. Single lines longer than
 * `maxChars` are hard-sliced.
 */
export function chunkCode(
  content: string,
  maxChars: number = DEFAULT_CHUNK_CHARS,
  overlapLines: number = DEFAULT_OVERLAP_LINES,
): CodeChunk[] {
  const normalized = (content || '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];

  const lines = normalized.split('\n');
  const chunks: CodeChunk[] = [];
  let buf: string[] = [];
  let bufStart = 1;
  let bufChars = 0;

  const push = (text: string, startLine: number, endLine: number): void => {
    if (!text.trim()) return;
    chunks.push({ idx: chunks.length, text, startLine, endLine });
  };

  const flush = (): void => {
    if (buf.length === 0) return;
    push(buf.join('\n'), bufStart, bufStart + buf.length - 1);
    const keepCount = Math.min(overlapLines, Math.max(0, buf.length - 1));
    const kept = keepCount > 0 ? buf.slice(buf.length - keepCount) : [];
    bufStart = bufStart + buf.length - kept.length;
    buf = kept;
    bufChars = kept.reduce((acc, l) => acc + l.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const lineNo = i + 1;

    // Hard-slice a pathologically long single line.
    if (line.length > maxChars) {
      if (buf.length) flush();
      for (let off = 0; off < line.length; off += maxChars) {
        push(line.slice(off, off + maxChars), lineNo, lineNo);
      }
      buf = [];
      bufStart = lineNo + 1;
      bufChars = 0;
      continue;
    }

    if (buf.length && bufChars + line.length + 1 > maxChars) {
      flush();
    }
    if (buf.length === 0) bufStart = lineNo;
    buf.push(line);
    bufChars += line.length + 1;
  }
  if (buf.length) flush();

  // De-duplicate the trailing overlap-only chunk that `flush()` can leave when
  // the final buffer is purely carried-over lines already emitted.
  return chunks.map((c, idx) => ({ ...c, idx }));
}

// ─── FTS query sanitization ─────────────────────────────────────────

/**
 * Build a safe FTS5 MATCH expression from free-form text. Code queries contain
 * punctuation that the default tokenizer treats as syntax (`"`, `:`, `(`, `*`),
 * so we extract bare identifier tokens and OR them. Returns '' when nothing
 * usable remains (caller then skips the FTS leg).
 */
export function toFtsMatchQuery(raw: string): string {
  const tokens = (raw.match(/[A-Za-z0-9_]+/g) || []).filter((t) => t.length >= 2).slice(0, 24);
  if (tokens.length === 0) return '';
  return [...new Set(tokens)].map((t) => `"${t}"`).join(' OR ');
}

// ─── Indexer ────────────────────────────────────────────────────────

export interface IndexResult {
  projectId: string;
  root: string;
  scanned: number;
  indexed: number;
  skipped: number;
  removed: number;
  chunks: number;
  errors: { file: string; error: string }[];
  geminiConfigured: boolean;
  /**
   * `true` when the file walk was capped by `maxFiles` and therefore only a
   * subset of the tree was scanned. Pruning of "deleted" files is SKIPPED on a
   * truncated run so a partial scan can't wipe still-present files' chunks.
   */
  truncated: boolean;
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Replace all chunks for one file inside a single transaction, keeping the FTS
 * rowids aligned with `code_chunks.rowid`.
 */
function replaceFileChunks(
  projectId: string,
  filePath: string,
  rows: { chunk: CodeChunk; buf: Buffer; hash: string }[],
): void {
  const s = stmts as Stmts;
  const database = db as Database.Database;
  const tx = database.transaction(() => {
    const existing = s.getCodeChunkRowidsByFile.all(projectId, filePath) as { rowid: number }[];
    for (const r of existing) s.deleteCodeFtsByRowid.run(r.rowid);
    s.deleteCodeChunksByFile.run(projectId, filePath);
    for (const r of rows) {
      const info = s.insertCodeChunk.run(
        projectId,
        filePath,
        r.chunk.idx,
        r.chunk.text,
        r.chunk.startLine,
        r.chunk.endLine,
        r.hash,
        r.buf,
        DEFAULT_MODEL,
      );
      s.insertCodeFts.run(info.lastInsertRowid as number, filePath, r.chunk.text, projectId);
    }
  });
  tx();
}

function removeFileChunks(projectId: string, filePath: string): void {
  const s = stmts as Stmts;
  const database = db as Database.Database;
  const tx = database.transaction(() => {
    const existing = s.getCodeChunkRowidsByFile.all(projectId, filePath) as { rowid: number }[];
    for (const r of existing) s.deleteCodeFtsByRowid.run(r.rowid);
    s.deleteCodeChunksByFile.run(projectId, filePath);
  });
  tx();
}

/**
 * Index (or incrementally re-index) every eligible file under `root` for
 * `projectId`. Idempotent and safe to re-run: files whose content hash matches
 * the stored hash are skipped, and files removed from disk are pruned. Returns
 * a per-run report. Non-throwing per file — one unreadable file does not abort
 * the run.
 */
export async function indexProjectCode(
  projectId: string,
  root: string,
  opts: { client?: EmbedClient; maxFiles?: number } = {},
): Promise<IndexResult> {
  const client = opts.client ?? getEmbedClient();
  const s = stmts as Stmts;
  const result: IndexResult = {
    projectId,
    root,
    scanned: 0,
    indexed: 0,
    skipped: 0,
    removed: 0,
    chunks: 0,
    errors: [],
    geminiConfigured: isGeminiConfigured(),
    truncated: false,
  };

  if (!isGeminiConfigured()) {
    return result; // nothing to do without an embedding key
  }

  // Defensive clamp: a non-positive maxFiles would otherwise collect zero files
  // and (pre-fix) prune everything. The route layer also validates this, but we
  // keep the indexer safe for any direct caller.
  const cap = opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : 5000;
  const { files, truncated } = collectCodeFilesWithMeta(root, cap);
  const seen = new Set<string>(files);
  result.scanned = files.length;
  result.truncated = truncated;

  // Existing per-file hashes for incremental skip.
  const hashRows = s.getCodeFileHashes.all(projectId) as { file_path: string; file_hash: string }[];
  const storedHash = new Map(hashRows.map((r) => [r.file_path, r.file_hash]));

  for (const rel of files) {
    const abs = path.join(root, rel);
    let raw: Buffer;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        result.skipped++;
        continue;
      }
      raw = fs.readFileSync(abs);
    } catch (err) {
      result.errors.push({ file: rel, error: (err as Error).message });
      continue;
    }
    if (looksBinary(raw)) {
      result.skipped++;
      continue;
    }
    const content = raw.toString('utf-8');
    const hash = sha1(content);
    if (storedHash.get(rel) === hash) {
      result.skipped++;
      continue;
    }

    const codeChunks = chunkCode(content);
    if (codeChunks.length === 0) {
      // Empty/whitespace file — drop any stale rows.
      if (storedHash.has(rel)) removeFileChunks(projectId, rel);
      result.skipped++;
      continue;
    }

    try {
      const vectors = await client.embedTexts(
        codeChunks.map((c) => c.text),
        'RETRIEVAL_DOCUMENT',
      );
      if (vectors.length !== codeChunks.length) {
        throw new Error(`embed returned ${vectors.length} vectors for ${codeChunks.length} chunks`);
      }
      replaceFileChunks(
        projectId,
        rel,
        codeChunks.map((c, i) => ({
          chunk: c,
          buf: encodeEmbedding(vectors[i]!.values),
          hash,
        })),
      );
      result.indexed++;
      result.chunks += codeChunks.length;
    } catch (err) {
      result.errors.push({ file: rel, error: (err as Error).message });
    }
  }

  // Prune files that no longer exist on disk — but ONLY after a complete scan.
  // On a truncated run `seen` is a partial subset, so files outside it may still
  // exist on disk; deleting their chunks would silently corrupt the index.
  if (!truncated) {
    const known = s.getDistinctCodeFiles.all(projectId) as { file_path: string }[];
    for (const { file_path } of known) {
      if (!seen.has(file_path)) {
        removeFileChunks(projectId, file_path);
        result.removed++;
      }
    }
  }

  return result;
}

export function countProjectCodeChunks(projectId: string): number {
  const row = (stmts as Stmts).countCodeChunksByProject.get(projectId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ─── Search ─────────────────────────────────────────────────────────

interface FtsCodeHit {
  rowid: number;
  filePath: string;
  chunkIdx: number;
  startLine: number;
  endLine: number;
  text: string;
  bm25Rank: number;
  snippet?: string;
}

function runCodeFts(projectId: string, query: string, limit: number): FtsCodeHit[] {
  const match = toFtsMatchQuery(query);
  if (!match) return [];
  try {
    const rows = (db as Database.Database)
      .prepare(
        `
        SELECT cc.rowid as rowid, cc.file_path, cc.chunk_idx, cc.start_line, cc.end_line,
               cc.chunk_text,
               snippet(code_chunks_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
               rank
        FROM code_chunks_fts fts
        JOIN code_chunks cc ON cc.rowid = fts.rowid
        WHERE code_chunks_fts MATCH ? AND cc.project_id = ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(match, projectId, limit) as {
      rowid: number;
      file_path: string;
      chunk_idx: number;
      start_line: number;
      end_line: number;
      chunk_text: string;
      snippet: string;
      rank: number;
    }[];
    return rows.map((r) => ({
      rowid: r.rowid,
      filePath: r.file_path,
      chunkIdx: r.chunk_idx,
      startLine: r.start_line,
      endLine: r.end_line,
      text: r.chunk_text,
      bm25Rank: r.rank,
      snippet: r.snippet,
    }));
  } catch {
    return [];
  }
}

interface SemanticCodeHit {
  rowid: number;
  filePath: string;
  chunkIdx: number;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

function runCodeSemantic(
  projectId: string,
  queryVector: number[],
  limit: number,
): SemanticCodeHit[] {
  // Filter to the active embedding model in SQL so mismatched-model rows are
  // never loaded or decoded on the retrieval hot path (see runSemantic in
  // wiki-embeddings.ts for the rationale on incompatible embedding spaces).
  const rows = (stmts as Stmts).getCodeEmbeddingsByProject.all(
    projectId,
    DEFAULT_MODEL,
  ) as CodeEmbeddingRow[];
  if (rows.length === 0) return [];
  const q = new Float32Array(queryVector);
  const scored = rows.map((r) => ({
    rowid: r.rowid,
    filePath: r.file_path,
    chunkIdx: r.chunk_idx,
    startLine: r.start_line,
    endLine: r.end_line,
    text: r.chunk_text,
    score: cosineSimilarity(q, decodeEmbedding(r.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(limit * 5, 25));
}

/** Cap how many chunks any one file contributes so results stay diverse. */
const MAX_CHUNKS_PER_FILE = 3;

function capPerFile(results: CodeSearchResult[], limit: number): CodeSearchResult[] {
  const perFile = new Map<string, number>();
  const out: CodeSearchResult[] = [];
  for (const r of results) {
    const n = perFile.get(r.filePath) ?? 0;
    if (n >= MAX_CHUNKS_PER_FILE) continue;
    perFile.set(r.filePath, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Hybrid (default) / semantic / fts search over indexed project code. Returns
 * chunk-level hits with a file path + line range. Degrades to FTS when no
 * embedding key is configured or the query embedding fails.
 */
export async function searchCode(
  projectId: string,
  query: string,
  opts: {
    mode?: CodeSearchMode;
    limit?: number;
    client?: EmbedClient;
    ftsWeight?: number;
    semanticWeight?: number;
  } = {},
): Promise<CodeSearchResult[]> {
  const mode: CodeSearchMode = opts.mode ?? 'hybrid';
  const limit = opts.limit ?? 8;
  const client = opts.client ?? getEmbedClient();
  if (!query || !query.trim()) return [];

  const ftsToResult = (h: FtsCodeHit): CodeSearchResult => ({
    filePath: h.filePath,
    chunkIdx: h.chunkIdx,
    startLine: h.startLine,
    endLine: h.endLine,
    text: h.text,
    score: -h.bm25Rank,
    ftsScore: -h.bm25Rank,
    snippet: h.snippet,
  });

  if (mode === 'fts') {
    return capPerFile(
      runCodeFts(projectId, query, Math.max(limit * 3, 24)).map(ftsToResult),
      limit,
    );
  }

  let queryVector: number[] | null = null;
  if (isGeminiConfigured()) {
    try {
      const [vec] = await client.embedTexts([query], 'RETRIEVAL_QUERY');
      queryVector = vec?.values ?? null;
    } catch (err) {
      console.warn('[code-embeddings] query embed failed:', (err as Error).message);
    }
  }

  if (!queryVector) {
    if (mode === 'semantic') return [];
    return capPerFile(
      runCodeFts(projectId, query, Math.max(limit * 3, 24)).map(ftsToResult),
      limit,
    );
  }

  const semantic = runCodeSemantic(projectId, queryVector, limit);

  if (mode === 'semantic') {
    return capPerFile(
      semantic.map((h) => ({
        filePath: h.filePath,
        chunkIdx: h.chunkIdx,
        startLine: h.startLine,
        endLine: h.endLine,
        text: h.text,
        score: h.score,
        semanticScore: h.score,
      })),
      limit,
    );
  }

  // Hybrid: blend normalized FTS + normalized cosine, keyed by chunk rowid.
  const fts = runCodeFts(projectId, query, Math.max(limit * 3, 24));
  const ftsNorm = normalizeScores(fts.map((h) => -h.bm25Rank));
  const semNorm = normalizeScores(semantic.map((h) => h.score));
  const ftsWeight = opts.ftsWeight ?? 0.5;
  const semanticWeight = opts.semanticWeight ?? 0.5;

  const byRowid = new Map<number, CodeSearchResult>();
  fts.forEach((h, i) => {
    byRowid.set(h.rowid, {
      filePath: h.filePath,
      chunkIdx: h.chunkIdx,
      startLine: h.startLine,
      endLine: h.endLine,
      text: h.text,
      score: ftsNorm[i]! * ftsWeight,
      ftsScore: ftsNorm[i]!,
      snippet: h.snippet,
    });
  });
  semantic.forEach((h, i) => {
    const existing = byRowid.get(h.rowid);
    if (existing) {
      existing.score += semNorm[i]! * semanticWeight;
      existing.semanticScore = semNorm[i]!;
    } else {
      byRowid.set(h.rowid, {
        filePath: h.filePath,
        chunkIdx: h.chunkIdx,
        startLine: h.startLine,
        endLine: h.endLine,
        text: h.text,
        score: semNorm[i]! * semanticWeight,
        semanticScore: semNorm[i]!,
      });
    }
  });

  const merged = [...byRowid.values()].sort((a, b) => b.score - a.score);
  return capPerFile(merged, limit);
}
