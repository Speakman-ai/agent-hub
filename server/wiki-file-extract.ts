/**
 * Text extraction for files uploaded into the wiki. The extracted text becomes
 * the content of a linked wiki page, which is what FTS5, embeddings, and the
 * automatic RAG pass actually index. The original bytes are stored separately
 * for download.
 *
 * Invariant: the server's main process never parses document content. This
 * module only picks a format from the filename and hands the bytes to a
 * child process (wiki-file-extract-child.mjs -> wiki-file-extract-core.mjs)
 * that is time-boxed, memory-capped from outside, and killed on overrun.
 * Every format goes through the child, plain text included, so no decoder,
 * sanitizer, or regex can block the event loop or grow the server's heap.
 */
import path from 'path';
import { fork, execFile } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AdmissionGate, RequestCancelledError, throwIfCancelled } from './upload-admission.js';

export type WikiFileKind = 'text' | 'markdown' | 'html' | 'pdf' | 'docx';

/** Hard cap on extracted characters so one huge upload can't flood the index. */
export const MAX_EXTRACTED_CHARS = 500_000;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'log',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'ini',
  'toml',
  'rst',
  'adoc',
]);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export class UnsupportedWikiFileError extends Error {
  constructor(filename: string) {
    super(
      `Unsupported file type for "${filename}". Supported: PDF, DOCX, Markdown, HTML, and plain-text formats (txt, csv, json, yaml, xml, …).`,
    );
    this.name = 'UnsupportedWikiFileError';
  }
}

function extOf(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

/** Decide how to read a file, preferring the extension over a vague MIME type. */
export function detectWikiFileKind(filename: string, contentType: string): WikiFileKind | null {
  const ext = extOf(filename);
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mime === DOCX_MIME) return 'docx';
  if (MARKDOWN_EXTENSIONS.has(ext) || mime === 'text/markdown') return 'markdown';
  if (HTML_EXTENSIONS.has(ext) || mime === 'text/html') return 'html';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json'))
    return 'text';
  if (mime === 'application/xml' || mime === 'application/yaml') return 'text';
  return null;
}

export interface ExtractLimits {
  /** Characters of text kept for indexing; the rest is dropped. */
  maxChars: number;
  /** Cap on a DOCX's declared uncompressed size, checked before parsing. */
  maxExpandedBytes: number;
  /** PDF pages read; later pages are skipped. */
  maxPages: number;
  /** Wall-clock budget for one PDF/DOCX parse. */
  timeoutMs: number;
  /**
   * Total memory (RSS) the parser process may use, heap and ArrayBuffers
   * alike. Enforced from outside the process, which is killed past it.
   */
  memoryMb: number;
  /** Cancels the parse (kills the process) when the requester goes away. */
  signal?: AbortSignal;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxChars: MAX_EXTRACTED_CHARS,
  maxExpandedBytes: 100 * 1024 * 1024,
  maxPages: 2000,
  timeoutMs: 60_000,
  memoryMb: 512,
};

/** Parser processes allowed at once, so parallel uploads can't stack memory. */
const MAX_CONCURRENT_PARSES = 2;

/** The document is too large to process once expanded (maps to HTTP 413). */
export class WikiFileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiFileTooLargeError';
  }
}

// Pure extraction helpers, re-exported for tests. They run only in the child.
export { declaredZipExpandedSize, normalizeText } from './wiki-file-extract-core.mjs';

/**
 * Parser workers allowed at once, with a short bounded wait. Excess callers
 * are rejected (AdmissionRejectedError, retryable) instead of queueing
 * without limit while holding their upload buffers.
 */
export const parseGate = new AdmissionGate({
  name: 'Document text extraction',
  maxActive: MAX_CONCURRENT_PARSES,
  maxQueued: 2,
  maxWaitMs: 30_000,
});

const CHILD_PATH = fileURLToPath(new URL('./wiki-file-extract-child.mjs', import.meta.url));
const RSS_POLL_MS = 20;

/** Resident memory of a process in bytes, or null when it can't be read. */
async function readRssBytes(pid: number): Promise<number | null> {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    if (kb) return Number(kb) * 1024;
  } catch {
    /* not Linux, or the process is gone */
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1000 }, (err, stdout) => {
      const kb = Number(String(stdout).trim());
      resolve(err || !Number.isFinite(kb) || kb <= 0 ? null : kb * 1024);
    });
  });
}

function tooLarge(): WikiFileTooLargeError {
  return new WikiFileTooLargeError(
    'The document expands past the memory limit for text extraction',
  );
}

type ParseOutcome =
  | { ok: true; value: { text: string; truncated: boolean } }
  | { ok: false; error: Error };

/**
 * Parse any upload in a separate, memory-watched, time-boxed process.
 *
 * The promise settles only on the child's `exit`, so the parser slot (and
 * the caller's upload buffer) is released only once the process and all of
 * its memory are actually gone, whether it finished, failed, timed out, was
 * cancelled, or was killed for exceeding `memoryMb`.
 */
function parseInChild(
  kind: WikiFileKind,
  buf: Buffer,
  limits: ExtractLimits,
): Promise<{ text: string; truncated: boolean }> {
  return parseGate.run(
    () =>
      new Promise((resolve, reject) => {
        throwIfCancelled(limits.signal);
        const limitBytes = limits.memoryMb * 1024 * 1024;
        const child = fork(CHILD_PATH, [], {
          // Heap flag keeps V8 honest well below the total cap; the RSS
          // watchdog below covers everything the flag does not (ArrayBuffers).
          execArgv: [`--max-old-space-size=${Math.max(32, Math.floor(limits.memoryMb * 0.6))}`],
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        let outcome: ParseOutcome | null = null;
        let exited = false;
        const settle = (o: ParseOutcome) => {
          if (outcome) return;
          outcome = o;
          if (!exited) child.kill('SIGKILL');
        };

        if (child.pid) {
          try {
            // Linux: make the parser the kernel's first OOM victim, never the server.
            writeFileSync(`/proc/${child.pid}/oom_score_adj`, '1000');
          } catch {
            /* not Linux */
          }
        }

        let polling = false;
        const watchdog = setInterval(() => {
          if (polling || !child.pid) return;
          polling = true;
          void readRssBytes(child.pid).then((rss) => {
            polling = false;
            if (rss !== null && rss > limitBytes) settle({ ok: false, error: tooLarge() });
          });
        }, RSS_POLL_MS);
        const timer = setTimeout(
          () =>
            settle({
              ok: false,
              error: new Error(`Timed out reading the document after ${limits.timeoutMs}ms`),
            }),
          limits.timeoutMs,
        );
        const onAbort = () => settle({ ok: false, error: new RequestCancelledError() });
        limits.signal?.addEventListener('abort', onAbort, { once: true });

        child.on(
          'message',
          (msg: {
            ok: boolean;
            text?: string;
            truncated?: boolean;
            error?: string;
            code?: string;
          }) =>
            settle(
              msg.ok
                ? { ok: true, value: { text: msg.text ?? '', truncated: Boolean(msg.truncated) } }
                : {
                    ok: false,
                    error:
                      msg.code === 'too_large'
                        ? new WikiFileTooLargeError(msg.error || 'Document too large')
                        : new Error(msg.error || 'Could not read the document'),
                  },
            ),
        );
        child.once('error', (err) => {
          settle({ ok: false, error: err });
          // A process that never spawned emits no 'exit'.
          if (!child.pid) finish();
        });
        child.once('exit', (code, sig) => {
          exited = true;
          if (!outcome) {
            // Died on its own: V8 heap abort, or the kernel OOM killer.
            const oom = sig === 'SIGKILL' || sig === 'SIGABRT' || code === 134;
            outcome = {
              ok: false,
              error: oom ? tooLarge() : new Error(`Document parser exited (code ${code})`),
            };
          }
          finish();
        });

        function finish() {
          clearInterval(watchdog);
          clearTimeout(timer);
          limits.signal?.removeEventListener('abort', onAbort);
          const o = outcome!;
          if (o.ok) resolve(o.value);
          else reject(o.error);
        }

        child.send({
          kind,
          bytes: buf,
          maxChars: limits.maxChars,
          maxPages: limits.maxPages,
          maxExpandedBytes: limits.maxExpandedBytes,
        });
      }),
    limits.signal,
  );
}

export interface ExtractedWikiFile {
  kind: WikiFileKind;
  text: string;
  truncated: boolean;
}

/**
 * Extract searchable text from an uploaded file. All parsing runs in the
 * child process (see the module comment), which slices input before decoding,
 * checks DOCX expanded size before inflating, stops PDF pages once enough text
 * is collected, normalizes in linear time, and caps its output.
 *
 * Throws `UnsupportedWikiFileError` (unknown format), `WikiFileTooLargeError`
 * (expands past a limit), or a plain Error for corrupt input and timeouts.
 */
export async function extractWikiFileText(
  buf: Buffer,
  filename: string,
  contentType: string,
  limitOverrides: Partial<ExtractLimits> = {},
): Promise<ExtractedWikiFile> {
  const limits = { ...DEFAULT_EXTRACT_LIMITS, ...limitOverrides };
  const kind = detectWikiFileKind(filename, contentType);
  if (!kind) throw new UnsupportedWikiFileError(filename);

  const out = await parseInChild(kind, buf, limits);
  // The child already capped its output; this is a constant-time guard.
  const text = out.text.length > limits.maxChars ? out.text.slice(0, limits.maxChars) : out.text;
  const truncated = out.truncated || text.length < out.text.length;
  return { kind, text, truncated };
}
