import { describe, it, expect, vi } from 'vitest';
import { htmlToText } from './wiki-file-extract-core.mjs';
import {
  normalizeText,
  declaredZipExpandedSize,
  detectWikiFileKind,
  extractWikiFileText,
  UnsupportedWikiFileError,
  WikiFileTooLargeError,
  parseGate,
} from './wiki-file-extract.js';
import { AdmissionRejectedError, RequestCancelledError } from './upload-admission.js';
import { makePdf, makeDocx, makeCompressedStreamPdf } from './test/wiki-file-fixtures.js';

describe('detectWikiFileKind', () => {
  it('prefers the extension over a generic MIME type', () => {
    expect(detectWikiFileKind('sop.pdf', 'application/octet-stream')).toBe('pdf');
    expect(detectWikiFileKind('sop.docx', 'application/octet-stream')).toBe('docx');
    expect(detectWikiFileKind('notes.md', '')).toBe('markdown');
    expect(detectWikiFileKind('data.csv', 'application/octet-stream')).toBe('text');
    expect(detectWikiFileKind('page.HTML', '')).toBe('html');
  });

  it('falls back to text/* MIME types for unknown extensions', () => {
    expect(detectWikiFileKind('README', 'text/plain')).toBe('text');
  });

  it('returns null for binary formats it cannot read', () => {
    expect(detectWikiFileKind('photo.png', 'image/png')).toBeNull();
    expect(detectWikiFileKind('sheet.xlsx', 'application/octet-stream')).toBeNull();
  });
});

describe('extractWikiFileText', () => {
  it('reads plain text and strips a BOM', async () => {
    const out = await extractWikiFileText(
      Buffer.from('\uFEFFStep 1\r\nStep 2'),
      'a.txt',
      'text/plain',
    );
    expect(out.text).toBe('Step 1\nStep 2');
    expect(out.truncated).toBe(false);
  });

  it('strips HTML tags and scripts but keeps paragraph breaks', async () => {
    const html = '<h1>Lockout</h1><script>alert(1)</script><p>Isolate power &amp; verify.</p>';
    const out = await extractWikiFileText(Buffer.from(html), 'sop.html', 'text/html');
    expect(out.kind).toBe('html');
    expect(out.text).toContain('Lockout');
    expect(out.text).toContain('Isolate power & verify.');
    expect(out.text).not.toContain('alert');
    expect(out.text).not.toContain('<');
  });

  it('extracts text from a PDF', async () => {
    const out = await extractWikiFileText(
      makePdf('Forklift inspection checklist'),
      'forklift.pdf',
      'application/pdf',
    );
    expect(out.kind).toBe('pdf');
    expect(out.text).toContain('## Page 1');
    expect(out.text).toContain('Forklift inspection checklist');
  });

  it('extracts text from a DOCX', async () => {
    const docx = await makeDocx(['Emergency shutdown', 'Press the red button']);
    const out = await extractWikiFileText(docx, 'shutdown.docx', '');
    expect(out.kind).toBe('docx');
    expect(out.text).toContain('Emergency shutdown');
    expect(out.text).toContain('Press the red button');
  });

  it('truncates very large text and flags it', async () => {
    const out = await extractWikiFileText(Buffer.from('x'.repeat(50)), 'a.txt', '', {
      maxChars: 10,
    });
    expect(out.text).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });

  it('rejects unsupported formats', async () => {
    await expect(
      extractWikiFileText(Buffer.from([0x89, 0x50]), 'a.png', 'image/png'),
    ).rejects.toBeInstanceOf(UnsupportedWikiFileError);
  });
});

describe('extraction resource bounds', () => {
  it('rejects a DOCX whose expanded size exceeds the limit before parsing it', async () => {
    // ~4 MB of XML that compresses to a few KB: the zip-bomb shape.
    const docx = await makeDocx(['A'.repeat(4 * 1024 * 1024)]);
    expect(docx.length).toBeLessThan(200 * 1024);
    expect(declaredZipExpandedSize(docx)).toBeGreaterThan(4 * 1024 * 1024);
    await expect(
      extractWikiFileText(docx, 'bomb.docx', '', { maxExpandedBytes: 1024 * 1024 }),
    ).rejects.toBeInstanceOf(WikiFileTooLargeError);
  });

  it('rejects a DOCX that is not a zip without parsing it', async () => {
    await expect(
      extractWikiFileText(Buffer.from('not a zip at all, just text'), 'x.docx', ''),
    ).rejects.toThrow('not a valid DOCX');
  });

  it('stops reading PDF pages at the page limit', async () => {
    const out = await extractWikiFileText(
      makePdf(['First page', 'Second page', 'Third page']),
      'three.pdf',
      '',
      { maxPages: 2 },
    );
    expect(out.text).toContain('Second page');
    expect(out.text).not.toContain('Third page');
    expect(out.truncated).toBe(true);
  });

  it('stops reading PDF pages once enough text is collected', async () => {
    const out = await extractWikiFileText(
      makePdf(['Alpha page text', 'Beta page text', 'Gamma page text']),
      'three.pdf',
      '',
      { maxChars: 20 },
    );
    expect(out.text).not.toContain('Gamma');
    expect(out.truncated).toBe(true);
  });

  // A clean parser process uses ~64-96 MB; 160 MB leaves room for real
  // documents while making the bombs below unmistakable.
  const CAP_MB = 160;

  it('parses normal documents within the total-memory cap', async () => {
    await expect(
      extractWikiFileText(makePdf('Normal page'), 'ok.pdf', '', { memoryMb: CAP_MB }),
    ).resolves.toMatchObject({ kind: 'pdf' });
    await expect(
      extractWikiFileText(await makeDocx(['Normal doc']), 'ok.docx', '', { memoryMb: CAP_MB }),
    ).resolves.toMatchObject({ kind: 'docx' });
  });

  it('kills a compressed-stream PDF whose off-heap inflation exceeds the cap; the server survives', async () => {
    // ~260 KB on disk; pdf.js inflates the content stream into ArrayBuffers
    // (outside the V8 heap limit) and would reach ~600 MB RSS unchecked.
    const bomb = await makeCompressedStreamPdf(256 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const rssBefore = process.memoryUsage().rss;

    await expect(
      extractWikiFileText(bomb, 'bomb.pdf', '', { memoryMb: CAP_MB }),
    ).rejects.toBeInstanceOf(WikiFileTooLargeError);

    // The inflation happened in the child, not here.
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(64 * 1024 * 1024);
    expect(parseGate.stats).toEqual({ active: 0, queued: 0 });
    // And the parser path still works afterwards.
    await expect(
      extractWikiFileText(makePdf('after'), 'after.pdf', '', { memoryMb: CAP_MB }),
    ).resolves.toMatchObject({ kind: 'pdf' });
  }, 60_000);

  it('kills the parser process on cancellation and releases its slot only after exit', async () => {
    const controller = new AbortController();
    const bomb = await makeCompressedStreamPdf(256 * 1024 * 1024);
    const pending = extractWikiFileText(bomb, 'slow.pdf', '', {
      memoryMb: 4096,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(parseGate.stats.active).toBe(1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
    expect(parseGate.stats).toEqual({ active: 0, queued: 0 });
  }, 60_000);

  it('kills a parse that exceeds the time budget', async () => {
    await expect(
      extractWikiFileText(makePdf('slow'), 'slow.pdf', '', { timeoutMs: 1 }),
    ).rejects.toThrow(/Timed out/);
  });

  it('slices oversized text input before decoding it', async () => {
    const out = await extractWikiFileText(Buffer.from('y'.repeat(1000)), 'big.txt', '', {
      maxChars: 10,
    });
    expect(out.text).toBe('y'.repeat(10));
    expect(out.truncated).toBe(true);
  });
});

describe('child output bound', () => {
  it('truncates a large DOCX text inside the parser before it reaches the server', async () => {
    const docx = await makeDocx(
      Array.from({ length: 2000 }, (_, i) => `paragraph ${i} `.repeat(20)),
    );
    const out = await extractWikiFileText(docx, 'long.docx', '', { maxChars: 1000 });
    expect(out.text.length).toBeLessThanOrEqual(1000);
    expect(out.truncated).toBe(true);
  });
});

describe('parser admission', () => {
  it('rejects parses of any format beyond the bounded queue instead of holding their buffers', async () => {
    const { maxActive, maxQueued } = parseGate.opts;
    const releases = await Promise.all(
      Array.from({ length: maxActive }, () => parseGate.acquire()),
    );
    const queued = Array.from({ length: maxQueued }, () => parseGate.acquire());
    try {
      await expect(extractWikiFileText(makePdf('x'), 'x.pdf', '')).rejects.toBeInstanceOf(
        AdmissionRejectedError,
      );
      // Plain text goes through the child too: the server never parses content itself.
      await expect(extractWikiFileText(Buffer.from('ok'), 'x.txt', '')).rejects.toBeInstanceOf(
        AdmissionRejectedError,
      );
    } finally {
      releases.forEach((r) => r());
      // Release each queued slot as it is admitted (they admit one another).
      await Promise.all(queued.map((q) => q.then((r) => r())));
    }
    expect(parseGate.stats).toEqual({ active: 0, queued: 0 });
  });
});

describe('linear-time normalization (no super-linear regex on untrusted text)', () => {
  const time = (fn: () => void) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it('keeps the old semantics: line endings, trailing blanks, blank-line runs, trim', () => {
    expect(normalizeText('  a  \r\nb\t\r   \n\n\n\nc   ')).toBe('a\nb\n\nc');
    expect(normalizeText('\n\n x \n\n')).toBe('x');
  });

  it('handles a long whitespace run with no newline in linear time', () => {
    // The old /[ \t]+\n/g took ~3.3 s on 64k spaces and grows quadratically;
    // the text path admits up to 2M characters.
    let out = '';
    expect(time(() => (out = normalizeText(' \t'.repeat(1_000_000) + 'x')))).toBeLessThan(1000);
    expect(out).toBe('x'); // leading blanks are trimmed, as before
    expect(time(() => (out = normalizeText('x' + ' '.repeat(2_000_000) + 'y')))).toBeLessThan(1000);
    expect(out.length).toBe(2_000_002);
  });

  it('strips HTML with many unclosed <script> tags in linear time', () => {
    // The old lazy /<(script|style)[^>]*>[\s\S]*?<\/\1>/ rescanned to the end
    // from every unclosed opener.
    const html = '<script>x'.repeat(50_000) + '<p>visible</p>';
    expect(time(() => htmlToText(html))).toBeLessThan(2000);
    const ok = htmlToText('<h1>Lockout</h1><script>alert(1)</script><p>Isolate &amp; verify.</p>');
    expect(ok).toContain('Lockout');
    expect(ok).toContain('Isolate & verify.');
    expect(ok).not.toContain('alert');
  });

  it('extracts the flagged whitespace input end to end without stalling', async () => {
    const t = performance.now();
    const out = await extractWikiFileText(Buffer.from(' '.repeat(64_000) + 'x'), 'ws.txt', '');
    expect(out.text).toBe('x');
    expect(performance.now() - t).toBeLessThan(5000);
  });
});

describe('main-process invariant', () => {
  it('the server-side module never parses document content itself', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('./wiki-file-extract.ts', import.meta.url), 'utf8');
    // Parsers and sanitizers belong in wiki-file-extract-core.mjs, which only
    // the time-boxed, memory-capped child process runs.
    for (const lib of ['sanitize-html', 'unpdf', 'mammoth', 'jszip']) {
      expect(src).not.toContain(`'${lib}'`);
    }
    expect(src).not.toMatch(/\bextractDocumentText\b|\bhtmlToText\b/);
    expect(src).not.toMatch(/\.replace\(\s*\//);
  });
});
