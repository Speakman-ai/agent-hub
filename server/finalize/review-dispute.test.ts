import { describe, it, expect } from 'vitest';
import {
  attachDisputesToFindings,
  buildDisputedNotice,
  detectReviewDisputeBlock,
  findUpheldDisputes,
  renderDisputesForReviewer,
} from './review-dispute.js';

const finding = (file_path: string, line_start: number | null, body: string) => ({
  file_path,
  line_start,
  line_end: line_start,
  body,
});

describe('detectReviewDisputeBlock', () => {
  it('parses disputes from the tail block', () => {
    const text =
      'Fixed two, disputing one.\n<agenthub:review-dispute>\n{"disputes":[{"file_path":"a.ts","line_start":3,"reason":"already guarded at a.ts:1"}]}\n</agenthub:review-dispute>';
    expect(detectReviewDisputeBlock(text)).toEqual([
      { file_path: 'a.ts', line_start: 3, line_end: 3, reason: 'already guarded at a.ts:1' },
    ]);
  });

  it('accepts a bare array and fenced JSON', () => {
    const text =
      '<agenthub:review-dispute>```json\n[{"file_path":"a.ts","line_start":null,"reason":"x"}]\n```</agenthub:review-dispute>';
    expect(detectReviewDisputeBlock(text)).toHaveLength(1);
  });

  it('returns nothing for no block, bad JSON, or entries without a reason', () => {
    expect(detectReviewDisputeBlock('no block here')).toEqual([]);
    expect(
      detectReviewDisputeBlock('<agenthub:review-dispute>{oops</agenthub:review-dispute>'),
    ).toEqual([]);
    expect(
      detectReviewDisputeBlock(
        '<agenthub:review-dispute>{"disputes":[{"file_path":"a.ts","reason":"  "}]}</agenthub:review-dispute>',
      ),
    ).toEqual([]);
  });
});

describe('attachDisputesToFindings', () => {
  it('pairs disputes with the finding at the same spot and drops strays', () => {
    const disputes = [
      { file_path: 'a.ts', line_start: 11, line_end: 11, reason: 'r1' },
      { file_path: 'b.ts', line_start: 5, line_end: 5, reason: 'r2' },
    ];
    const findings = [{ file_path: 'a.ts', line_start: 10, line_end: 12, body: '**[6/10]** bug' }];
    expect(attachDisputesToFindings(disputes, findings)).toEqual([
      { ...disputes[0], finding: '**[6/10]** bug', id: 'D1' },
    ]);
  });
});

describe('findUpheldDisputes', () => {
  it('matches an upheld dispute by its id after a commit moved the lines', () => {
    const [attached] = attachDisputesToFindings(
      [{ file_path: 'a.ts', line_start: 10, line_end: 12, reason: 'r' }],
      [{ file_path: 'a.ts', line_start: 10, line_end: 12, body: '**[6/10]** bug' }],
    );
    expect(attached.id).toBe('D1');
    const upheld = findUpheldDisputes(
      [attached],
      [finding('a.ts', 48, '**[6/10]** [upholds D1] still a bug, the guard is unreachable')],
    );
    expect(upheld).toHaveLength(1);
    // A different dispute id does not match.
    expect(
      findUpheldDisputes([attached], [finding('a.ts', 48, '**[6/10]** [upholds D10] other')]),
    ).toEqual([]);
  });

  const disputes = [{ file_path: 'a.ts', line_start: 10, line_end: 12, reason: 'r', id: 'D1' }];

  it('flags a blocking finding that cites the dispute', () => {
    const upheld = findUpheldDisputes(disputes, [
      finding('a.ts', 11, '**[7/10]** [upholds D1] still wrong'),
    ]);
    expect(upheld).toHaveLength(1);
    expect(upheld[0].upheld).toContain('still wrong');
  });

  it('does not treat a different blocking finding at the disputed spot as an uphold', () => {
    // The reviewer accepted D1 but kept (or newly found) another defect in
    // the same range: that needs a fix turn, not a human ruling.
    expect(
      findUpheldDisputes(disputes, [
        finding('a.ts', 11, '**[7/10]** separate off-by-one in the same block'),
        finding('a.ts', null, '**[6/10]** file-level note'),
      ]),
    ).toEqual([]);
  });

  it('ignores a non-blocking citation and disputes without an id', () => {
    expect(
      findUpheldDisputes(disputes, [finding('a.ts', 11, '**[2/10]** [upholds D1] nit')]),
    ).toEqual([]);
    expect(
      findUpheldDisputes(
        [{ ...disputes[0], id: undefined }],
        [finding('a.ts', 11, '**[7/10]** [upholds D1] x')],
      ),
    ).toEqual([]);
  });
});

describe('rendering', () => {
  it('puts the finding and rebuttal side by side for the reviewer', () => {
    const out = renderDisputesForReviewer([
      {
        file_path: 'a.ts',
        line_start: 10,
        line_end: 12,
        reason: 'guarded',
        finding: '**[6/10]** bug',
      },
    ]);
    expect(out).toContain('## Disputed findings');
    expect(out).toContain('`a.ts:10-12`');
    expect(out).toContain('> **[6/10]** bug');
    expect(out).toContain('> guarded');
    expect(renderDisputesForReviewer([])).toBe('');
  });

  it('builds a notice that tells the human both sides', () => {
    const notice = buildDisputedNotice([
      {
        dispute: { file_path: 'a.ts', line_start: 1, line_end: 1, reason: 'agent side' },
        upheld: '**[6/10]** reviewer side',
      },
    ]);
    expect(notice).toContain('Agent: agent side');
    expect(notice).toContain('Reviewer: **[6/10]** reviewer side');
    expect(notice).toContain('push anyway');
  });
});
