/**
 * Finalize workflow regression — documents user-visible failure modes and
 * the contracts that prevent them.
 */
import { describe, expect, it } from 'vitest';
import { detectReviewVerdictBlock, stripReviewVerdictBlock } from './review-verdict-block.js';

describe('Finalize workflow — reviewer verdict (scoreboard regression)', () => {
  it('parses bare fenced JSON that previously surfaced as review_failed + no CI steps', () => {
    const reviewerOutput = `This is a code review task with a specific JSON output contract.
The change is clean overall. Nothing crosses the severity-3 threshold.

\`\`\`json
{
  "verdict": "approved",
  "threads": [
    {
      "file_path": "backend/api/views.py",
      "line_start": 94,
      "line_end": 98,
      "body": "**[3/10]** The host gate is bypassable: RoomSerializer exposes player ids."
    }
  ]
}
\`\`\``;

    const parsed = detectReviewVerdictBlock(reviewerOutput);
    expect(parsed.present).toBe(true);
    expect(parsed.reason).toBeNull();
    expect(parsed.task?.verdict).toBe('approved');
    expect(parsed.task?.threads).toHaveLength(1);

    const visible = stripReviewVerdictBlock(reviewerOutput);
    expect(visible).not.toContain('"verdict"');
    expect(visible).toContain('code review task');
  });
});
