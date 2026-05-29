/**
 * Unit tests for the `<agenthub:review-verdict>` action-block parser.
 *
 * The reviewer-driver swap from out-of-band JSON envelope to in-session
 * chat with a structured tail relies on this parser being defensive
 * against the same pathological model outputs we already see for
 * `<agenthub:close-card>` (fenced JSON, prose lead-in, raw newlines
 * inside string values).
 *
 * Coverage map:
 *   - happy path (approved + zero threads, changes_requested + N threads)
 *   - tolerant lexical frames (markdown fence, leading prose, raw \n)
 *   - missing block / not-an-object / invalid-json
 *   - missing or invalid verdict
 *   - threads not an array
 *   - oversized thread list capped to REVIEWER_THREAD_HARD_CAP_DEFAULT
 *   - per-thread body truncation marker
 *   - blank file_path / blank body / null lines all dropped or coerced
 *   - stripReviewVerdictBlock removes the tail cleanly
 */
import { describe, expect, it } from 'vitest';

import {
  REVIEWER_THREAD_BODY_LIMIT_DEFAULT,
  REVIEWER_THREAD_HARD_CAP_DEFAULT,
  detectReviewVerdictBlock,
  sanitiseThreadInputs,
  stripReviewVerdictBlock,
} from './review-verdict-block.js';

describe('detectReviewVerdictBlock — happy path', () => {
  it('parses approved + empty threads', () => {
    const text = `Looks good to me.

<agenthub:review-verdict>
{"verdict": "approved", "threads": []}
</agenthub:review-verdict>`;
    const result = detectReviewVerdictBlock(text);
    expect(result.present).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.task).toEqual({ verdict: 'approved', threads: [] });
  });

  it('parses approved with missing threads (defaults to [])', () => {
    const text = `<agenthub:review-verdict>
{"verdict": "approved"}
</agenthub:review-verdict>`;
    const result = detectReviewVerdictBlock(text);
    expect(result.task).toEqual({ verdict: 'approved', threads: [] });
  });

  it('parses changes_requested with multiple threads', () => {
    const text = `Found a few things.

<agenthub:review-verdict>
{
  "verdict": "changes_requested",
  "threads": [
    {"file_path": "server/foo.ts", "line_start": 42, "line_end": 45, "body": "**[6/10]** Race on config."},
    {"file_path": "server/bar.ts", "line_start": 10, "line_end": 10, "body": "**[4/10]** Missing null guard."}
  ]
}
</agenthub:review-verdict>`;
    const result = detectReviewVerdictBlock(text);
    expect(result.task?.verdict).toBe('changes_requested');
    expect(result.task?.threads).toHaveLength(2);
    expect(result.task?.threads[0]).toEqual({
      file_path: 'server/foo.ts',
      line_start: 42,
      line_end: 45,
      body: '**[6/10]** Race on config.',
    });
  });

  it('accepts file-level comment (null line anchors)', () => {
    const text = `<agenthub:review-verdict>
{"verdict": "changes_requested", "threads": [
  {"file_path": "README.md", "line_start": null, "line_end": null, "body": "**[2/10]** Stale link."}
]}
</agenthub:review-verdict>`;
    const result = detectReviewVerdictBlock(text);
    expect(result.task?.threads[0]?.line_start).toBeNull();
    expect(result.task?.threads[0]?.line_end).toBeNull();
  });
});

describe('detectReviewVerdictBlock — verdict aliases', () => {
  it('accepts "approve" (singular) as "approved"', () => {
    const text = `<agenthub:review-verdict>{"verdict":"approve"}</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).task?.verdict).toBe('approved');
  });

  it('accepts "changes-requested" (hyphen) as "changes_requested"', () => {
    const text = `<agenthub:review-verdict>{"verdict":"changes-requested"}</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).task?.verdict).toBe('changes_requested');
  });

  it('accepts "request_changes" and "request-changes" as "changes_requested"', () => {
    for (const v of ['request_changes', 'request-changes']) {
      const text = `<agenthub:review-verdict>{"verdict":"${v}"}</agenthub:review-verdict>`;
      expect(detectReviewVerdictBlock(text).task?.verdict).toBe('changes_requested');
    }
  });

  it('accepts "rejected" as "changes_requested" (informal alias)', () => {
    const text = `<agenthub:review-verdict>{"verdict":"rejected"}</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).task?.verdict).toBe('changes_requested');
  });

  it('uppercase verdict normalised case-insensitively', () => {
    const text = `<agenthub:review-verdict>{"verdict":"APPROVED"}</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).task?.verdict).toBe('approved');
  });
});

describe('detectReviewVerdictBlock — lexical tolerance', () => {
  it('strips markdown fence around inner JSON', () => {
    const text = `<agenthub:review-verdict>
\`\`\`json
{"verdict": "approved", "threads": []}
\`\`\`
</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).task?.verdict).toBe('approved');
  });

  it('skips leading prose before the JSON', () => {
    const text = `<agenthub:review-verdict>
Here is my verdict:
{"verdict": "changes_requested", "threads": []}
</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).task?.verdict).toBe('changes_requested');
  });

  it('normalises raw newlines inside body string', () => {
    const text = `<agenthub:review-verdict>
{"verdict": "changes_requested", "threads": [
  {"file_path": "a.ts", "line_start": 1, "line_end": 1, "body": "line one
line two"}
]}
</agenthub:review-verdict>`;
    const result = detectReviewVerdictBlock(text);
    expect(result.task?.threads[0]?.body).toBe('line one\nline two');
  });

  it('only the first block is considered when two are emitted', () => {
    const text = `<agenthub:review-verdict>{"verdict":"approved"}</agenthub:review-verdict>
<agenthub:review-verdict>{"verdict":"changes_requested"}</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).task?.verdict).toBe('approved');
  });
});

describe('detectReviewVerdictBlock — malformed payloads', () => {
  it('returns present:false when no block exists', () => {
    expect(detectReviewVerdictBlock('Hello with no block')).toEqual({
      present: false,
      task: null,
      reason: null,
      rawBody: null,
    });
  });

  it('flags invalid JSON inside a present block', () => {
    const text = `<agenthub:review-verdict>{not valid json}</agenthub:review-verdict>`;
    const result = detectReviewVerdictBlock(text);
    expect(result.present).toBe(true);
    expect(result.task).toBeNull();
    expect(result.reason).toBe('invalid-json');
  });

  it('flags an array payload as not-object', () => {
    const text = `<agenthub:review-verdict>[1,2,3]</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).reason).toBe('not-object');
  });

  it('flags missing verdict field', () => {
    const text = `<agenthub:review-verdict>{"threads": []}</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).reason).toBe('missing-verdict');
  });

  it('flags unknown verdict value', () => {
    const text = `<agenthub:review-verdict>{"verdict": "meh"}</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).reason).toBe('invalid-verdict');
  });

  it('flags non-array threads field', () => {
    const text = `<agenthub:review-verdict>{"verdict":"approved","threads":"oops"}</agenthub:review-verdict>`;
    expect(detectReviewVerdictBlock(text).reason).toBe('threads-not-array');
  });

  it('non-string input returns absent', () => {
    expect(detectReviewVerdictBlock(undefined as unknown as string).present).toBe(false);
    expect(detectReviewVerdictBlock(null as unknown as string).present).toBe(false);
  });
});

describe('sanitiseThreadInputs — defensive coercion', () => {
  it('drops blank file_path entries', () => {
    const out = sanitiseThreadInputs([
      { file_path: '', line_start: 1, line_end: 1, body: 'x' },
      { file_path: '   ', line_start: 1, line_end: 1, body: 'x' },
      { file_path: 'a.ts', line_start: 1, line_end: 1, body: 'x' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.file_path).toBe('a.ts');
  });

  it('drops blank or non-string body entries', () => {
    const out = sanitiseThreadInputs([
      { file_path: 'a.ts', line_start: 1, line_end: 1, body: '' },
      { file_path: 'b.ts', line_start: 1, line_end: 1, body: '   ' },
      { file_path: 'c.ts', line_start: 1, line_end: 1, body: 42 },
      { file_path: 'd.ts', line_start: 1, line_end: 1, body: 'real' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.file_path).toBe('d.ts');
  });

  it('coerces non-finite or sub-1 line numbers to null', () => {
    const out = sanitiseThreadInputs([
      { file_path: 'a.ts', line_start: 0, line_end: -3, body: 'x' },
      { file_path: 'b.ts', line_start: 'NaN', line_end: null, body: 'y' },
      { file_path: 'c.ts', line_start: 3.7, line_end: 9.9, body: 'z' },
    ]);
    expect(out[0]?.line_start).toBeNull();
    expect(out[0]?.line_end).toBeNull();
    expect(out[1]?.line_start).toBeNull();
    expect(out[2]?.line_start).toBe(3);
    expect(out[2]?.line_end).toBe(9);
  });

  it('caps the input list at REVIEWER_THREAD_HARD_CAP_DEFAULT', () => {
    const oversized = Array.from({ length: REVIEWER_THREAD_HARD_CAP_DEFAULT + 25 }, (_, i) => ({
      file_path: `f${i}.ts`,
      line_start: 1,
      line_end: 1,
      body: 'x',
    }));
    const out = sanitiseThreadInputs(oversized);
    expect(out).toHaveLength(REVIEWER_THREAD_HARD_CAP_DEFAULT);
  });

  it('truncates over-long body with explicit marker', () => {
    const big = 'a'.repeat(REVIEWER_THREAD_BODY_LIMIT_DEFAULT + 500);
    const out = sanitiseThreadInputs([
      { file_path: 'a.ts', line_start: 1, line_end: 1, body: big },
    ]);
    const body = out[0]?.body ?? '';
    expect(body.length).toBeLessThan(big.length);
    expect(body).toContain('[…500 chars truncated]');
  });

  it('skips non-object thread entries', () => {
    const out = sanitiseThreadInputs([
      null,
      'oops',
      42,
      undefined,
      true,
      [],
      { file_path: 'a.ts', body: 'x', line_start: 1, line_end: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.file_path).toBe('a.ts');
  });
});

describe('stripReviewVerdictBlock', () => {
  it('removes a trailing block + surrounding whitespace', () => {
    const text = `Looks good to me.

<agenthub:review-verdict>
{"verdict":"approved","threads":[]}
</agenthub:review-verdict>`;
    expect(stripReviewVerdictBlock(text)).toBe('Looks good to me.');
  });

  it('idempotent for messages with no block', () => {
    const text = 'No block here.';
    expect(stripReviewVerdictBlock(text)).toBe(text);
  });

  it('leaves a non-trailing block in place (treats it as part of prose)', () => {
    const text = `<agenthub:review-verdict>{"verdict":"approved"}</agenthub:review-verdict>
followup prose`;
    // Only the trailing block is stripped; a mid-message block stays.
    expect(stripReviewVerdictBlock(text)).toBe(text);
  });
});
