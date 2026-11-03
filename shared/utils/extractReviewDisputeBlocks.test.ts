import { describe, expect, it } from 'vitest';
import {
  extractReviewDisputeBlocks,
  formatReviewDisputeLocation,
} from './extractReviewDisputeBlocks.js';

const BODY = JSON.stringify({
  disputes: [
    {
      file_path: 'backend/tests/snapshot_permissions_tests.py',
      line_start: null,
      line_end: null,
      reason: 'The module is skipped in every CI run.',
    },
    { file_path: 'backend/dxf-bundle.mjs', line_start: 1015, line_end: 1025, reason: 'Required.' },
  ],
});

describe('extractReviewDisputeBlocks', () => {
  it('pulls a naked tag out of the prose and parses each dispute', () => {
    const { strippedText, blocks } = extractReviewDisputeBlocks(
      `Two findings are wrong.\n\n<agenthub:review-dispute>${BODY}</agenthub:review-dispute>`,
    );
    expect(strippedText).toBe('Two findings are wrong.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].partial).toBe(false);
    expect(blocks[0].disputes).toEqual([
      {
        filePath: 'backend/tests/snapshot_permissions_tests.py',
        lineStart: null,
        lineEnd: null,
        reason: 'The module is skipped in every CI run.',
      },
      { filePath: 'backend/dxf-bundle.mjs', lineStart: 1015, lineEnd: 1025, reason: 'Required.' },
    ]);
  });

  it('removes a code fence wrapped around the tag', () => {
    const { strippedText, blocks } = extractReviewDisputeBlocks(
      `Before\n\n\`\`\`\n<agenthub:review-dispute>\n${BODY}\n</agenthub:review-dispute>\n\`\`\`\n\nAfter`,
    );
    expect(strippedText).toBe('Before\n\nAfter');
    expect(blocks[0].disputes).toHaveLength(2);
  });

  it('accepts a closer without the agenthub prefix', () => {
    const { strippedText, blocks } = extractReviewDisputeBlocks(
      `<agenthub:review-dispute>${BODY}</review-dispute>`,
    );
    expect(strippedText).toBe('');
    expect(blocks[0].disputes).toHaveLength(2);
  });

  it('hides an unterminated block while it streams', () => {
    const { strippedText, blocks } = extractReviewDisputeBlocks(
      'Pushing back.\n<agenthub:review-dispute>{"disputes":[{"file_pa',
    );
    expect(strippedText).toBe('Pushing back.');
    expect(blocks[0].partial).toBe(true);
  });

  it('keeps the raw body when the JSON does not parse', () => {
    const { blocks } = extractReviewDisputeBlocks(
      '<agenthub:review-dispute>not json</agenthub:review-dispute>',
    );
    expect(blocks[0].disputes).toEqual([]);
    expect(blocks[0].raw).toBe('not json');
  });

  it('leaves text without a block untouched', () => {
    expect(extractReviewDisputeBlocks('plain')).toEqual({ strippedText: 'plain', blocks: [] });
    expect(extractReviewDisputeBlocks(null)).toEqual({ strippedText: '', blocks: [] });
  });
});

describe('formatReviewDisputeLocation', () => {
  it('formats file, single line, and range', () => {
    const base = { filePath: 'a.ts', reason: 'r' };
    expect(formatReviewDisputeLocation({ ...base, lineStart: null, lineEnd: null })).toBe('a.ts');
    expect(formatReviewDisputeLocation({ ...base, lineStart: 4, lineEnd: 4 })).toBe('a.ts:4');
    expect(formatReviewDisputeLocation({ ...base, lineStart: 4, lineEnd: 9 })).toBe('a.ts:4-9');
  });
});
