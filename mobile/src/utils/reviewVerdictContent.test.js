import { describe, expect, it } from 'vitest';
import { parseRawReviewVerdictContent } from './reviewVerdictContent.js';

describe('parseRawReviewVerdictContent', () => {
  it('parses raw reviewer verdict JSON with nested thread objects', () => {
    const meta = parseRawReviewVerdictContent(
      JSON.stringify({
        verdict: 'changes_requested',
        threads: [
          {
            file_path: 'mobile/src/screens/SettingsScreen.js',
            line_start: 286,
            line_end: 287,
            body: '**[4/10]** Fix the mobile settings copy.',
          },
        ],
      }),
    );

    expect(meta).toEqual({
      verdict: 'changes_requested',
      threads: [
        {
          file_path: 'mobile/src/screens/SettingsScreen.js',
          line_start: 286,
          line_end: 287,
          body: '**[4/10]** Fix the mobile settings copy.',
        },
      ],
    });
  });

  it('ignores non-JSON prose', () => {
    expect(parseRawReviewVerdictContent('Earlier: {"verdict":"approved"}')).toBeNull();
  });
});
