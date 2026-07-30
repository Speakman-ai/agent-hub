import { NO_COMMITS_MESSAGE } from '../../shared/utils/finalizeSummaryCopy.js';
import { describe, it, expect } from 'vitest';
import {
  MAX_COMMIT_SUBJECTS,
  MAX_FINDINGS_PER_ROUND,
  buildFinalizeRunSummaryPayload,
  collectFinalizeReviewRounds,
  parseDiffStatTotals,
  renderFinalizeRunSummaryMarkdown,
} from './run-summary-data.js';

function reviewRoundMessage(
  runId: string,
  round: number,
  verdict: string,
  threads: unknown[],
): { metadata: string } {
  return {
    metadata: JSON.stringify({ kind: 'finalize_review_round', runId, round, verdict, threads }),
  };
}

describe('collectFinalizeReviewRounds', () => {
  it('collects every round for the run, oldest first', () => {
    const rounds = collectFinalizeReviewRounds(
      [
        reviewRoundMessage('run-1', 2, 'approved', []),
        { metadata: JSON.stringify({ kind: 'finalize_run_started', runId: 'run-1' }) },
        reviewRoundMessage('run-1', 1, 'changes_requested', [
          { file_path: 'server/a.ts', line_start: 3, line_end: 5, body: 'fix this' },
        ]),
      ],
      'run-1',
    );

    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(rounds[0]?.verdict).toBe('changes_requested');
    expect(rounds[0]?.findings).toEqual([
      { filePath: 'server/a.ts', lineStart: 3, lineEnd: 5, body: 'fix this' },
    ]);
    expect(rounds[1]?.findings).toEqual([]);
  });

  it('ignores rounds belonging to a different run', () => {
    const rounds = collectFinalizeReviewRounds(
      [
        reviewRoundMessage('run-other', 1, 'changes_requested', [
          { file_path: 'x.ts', line_start: 1, line_end: 1, body: 'nope' },
        ]),
        reviewRoundMessage('run-1', 1, 'approved', []),
      ],
      'run-1',
    );

    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.verdict).toBe('approved');
  });

  it('lets a later message for the same round supersede the earlier one', () => {
    const rounds = collectFinalizeReviewRounds(
      [
        reviewRoundMessage('run-1', 1, 'changes_requested', [
          { file_path: 'a.ts', line_start: 1, line_end: 1, body: 'first pass' },
        ]),
        reviewRoundMessage('run-1', 1, 'approved', []),
      ],
      'run-1',
    );

    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.verdict).toBe('approved');
    expect(rounds[0]?.findings).toEqual([]);
  });

  it('drops findings with no body and defaults a missing file path', () => {
    const rounds = collectFinalizeReviewRounds(
      [
        reviewRoundMessage('run-1', 1, 'changes_requested', [
          { file_path: 'a.ts', body: '   ' },
          { body: 'file-level note' },
          'not-an-object',
        ]),
      ],
      'run-1',
    );

    expect(rounds[0]?.findings).toEqual([
      { filePath: '(unknown)', lineStart: null, lineEnd: null, body: 'file-level note' },
    ]);
  });

  it('caps findings per round and records how many were dropped', () => {
    const threads = Array.from({ length: MAX_FINDINGS_PER_ROUND + 4 }, (_, i) => ({
      file_path: `f${i}.ts`,
      line_start: i,
      line_end: i,
      body: `note ${i}`,
    }));

    const rounds = collectFinalizeReviewRounds(
      [reviewRoundMessage('run-1', 1, 'changes_requested', threads)],
      'run-1',
    );

    expect(rounds[0]?.findings).toHaveLength(MAX_FINDINGS_PER_ROUND);
    expect(rounds[0]?.truncatedFindings).toBe(4);
  });

  it('survives malformed and non-finalize metadata', () => {
    expect(
      collectFinalizeReviewRounds(
        [{ metadata: 'not json' }, { metadata: null }, {}, { metadata: '{"kind":"other"}' }],
        'run-1',
      ),
    ).toEqual([]);
  });
});

describe('parseDiffStatTotals', () => {
  it('parses a full totals line', () => {
    expect(
      parseDiffStatTotals(
        ' server/a.ts | 10 +++\n server/b.ts | 4 --\n 2 files changed, 10 insertions(+), 4 deletions(-)',
      ),
    ).toEqual({ filesChanged: 2, insertions: 10, deletions: 4 });
  });

  it('leaves an omitted clause null instead of zero', () => {
    expect(parseDiffStatTotals(' 1 file changed, 7 insertions(+)')).toEqual({
      filesChanged: 1,
      insertions: 7,
      deletions: null,
    });
  });

  it('returns nulls for empty or non-stat input', () => {
    expect(parseDiffStatTotals('')).toEqual({
      filesChanged: null,
      insertions: null,
      deletions: null,
    });
    expect(parseDiffStatTotals('nothing to see')).toEqual({
      filesChanged: null,
      insertions: null,
      deletions: null,
    });
    expect(parseDiffStatTotals(null)).toEqual({
      filesChanged: null,
      insertions: null,
      deletions: null,
    });
  });
});

describe('buildFinalizeRunSummaryPayload', () => {
  const baseArgs = {
    runId: 'run-1',
    round: 2,
    headSha: 'abc123',
    commits: [{ subject: 'Add thing' }, { subject: 'Fix review note' }],
    diffStat: ' 2 files changed, 10 insertions(+), 4 deletions(-)',
    reviewRounds: [
      {
        round: 1,
        verdict: 'changes_requested',
        findings: [{ filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: 'nit' }],
        truncatedFindings: 0,
      },
      { round: 2, verdict: 'approved', findings: [], truncatedFindings: 0 },
    ],
  };

  it('marks the narrative source and carries the final verdict', () => {
    const payload = buildFinalizeRunSummaryPayload({
      ...baseArgs,
      narrative: { summary: 'Adds a thing.', reviewNotes: 'One nit, fixed.', manualTesting: ['a'] },
    });

    expect(payload.summarySource).toBe('llm');
    expect(payload.summary).toBe('Adds a thing.');
    expect(payload.finalVerdict).toBe('approved');
    expect(payload.totalFindings).toBe(1);
    expect(payload.filesChanged).toBe(2);
    expect(payload.manualTesting).toEqual(['a']);
  });

  it('falls back to a deterministic payload when the narrative is null', () => {
    const payload = buildFinalizeRunSummaryPayload({ ...baseArgs, narrative: null });

    expect(payload.summarySource).toBe('none');
    expect(payload.summary).toBe('');
    expect(payload.reviewNotes).toBe('');
    expect(payload.manualTesting).toEqual([]);
    // The deterministic half still carries the whole story.
    expect(payload.commits).toEqual(['Add thing', 'Fix review note']);
    expect(payload.totalFindings).toBe(1);
  });

  it('leaves finalVerdict null when the run never went through review', () => {
    const payload = buildFinalizeRunSummaryPayload({
      ...baseArgs,
      reviewRounds: [],
      narrative: null,
    });
    expect(payload.finalVerdict).toBeNull();
    expect(payload.totalFindings).toBe(0);
  });

  it('caps commit subjects and counts the overflow', () => {
    const commits = Array.from({ length: MAX_COMMIT_SUBJECTS + 3 }, (_, i) => ({
      subject: `commit ${i}`,
    }));
    const payload = buildFinalizeRunSummaryPayload({ ...baseArgs, commits, narrative: null });

    expect(payload.commits).toHaveLength(MAX_COMMIT_SUBJECTS);
    expect(payload.truncatedCommits).toBe(3);
  });

  it('counts truncated findings toward the total', () => {
    const payload = buildFinalizeRunSummaryPayload({
      ...baseArgs,
      reviewRounds: [
        {
          round: 1,
          verdict: 'changes_requested',
          findings: [{ filePath: 'a.ts', lineStart: null, lineEnd: null, body: 'x' }],
          truncatedFindings: 9,
        },
      ],
      narrative: null,
    });
    expect(payload.totalFindings).toBe(10);
  });
});

describe('renderFinalizeRunSummaryMarkdown', () => {
  it('renders all three sections with content', () => {
    const md = renderFinalizeRunSummaryMarkdown(
      buildFinalizeRunSummaryPayload({
        runId: 'run-1',
        round: 2,
        headSha: 'abc',
        commits: [{ subject: 'Add widget' }],
        diffStat: ' 1 file changed, 3 insertions(+)',
        reviewRounds: [
          {
            round: 1,
            verdict: 'changes_requested',
            findings: [{ filePath: 'server/a.ts', lineStart: 4, lineEnd: 9, body: 'guard null' }],
            truncatedFindings: 0,
          },
        ],
        narrative: {
          summary: 'Adds a widget.',
          reviewNotes: 'Reviewer asked for a null guard.',
          manualTesting: ['Open the widget page and toggle it'],
        },
      }),
    );

    expect(md).toContain('## Finalize summary');
    expect(md).toContain('Adds a widget.');
    expect(md).toContain('### What changed');
    expect(md).toContain('1 file changed, +3');
    expect(md).toContain('- Add widget');
    expect(md).toContain('### Review');
    expect(md).toContain('Reviewer asked for a null guard.');
    expect(md).toContain('- Round 1: changes requested (1 finding)');
    expect(md).toContain('`server/a.ts` L4-9: guard null');
    expect(md).toContain('### Manual testing');
    expect(md).toContain('- [ ] Open the widget page and toggle it');
  });

  it('states the empty case for each section rather than omitting it', () => {
    const md = renderFinalizeRunSummaryMarkdown(
      buildFinalizeRunSummaryPayload({
        runId: 'run-1',
        round: 0,
        commits: [],
        diffStat: '',
        reviewRounds: [],
        narrative: null,
      }),
    );

    expect(md).toContain(NO_COMMITS_MESSAGE);
    expect(md).toContain('No review rounds recorded for this run.');
    expect(md).toContain('No manual testing steps were generated for this change.');
  });

  it('renders a file-level finding anchor without a line number', () => {
    const md = renderFinalizeRunSummaryMarkdown(
      buildFinalizeRunSummaryPayload({
        runId: 'run-1',
        round: 1,
        commits: [{ subject: 'c' }],
        diffStat: '',
        reviewRounds: [
          {
            round: 1,
            verdict: 'changes_requested',
            findings: [{ filePath: 'a.ts', lineStart: null, lineEnd: null, body: 'whole file' }],
            truncatedFindings: 0,
          },
        ],
        narrative: null,
      }),
    );

    expect(md).toContain('`a.ts` file-level: whole file');
  });
});
