import { describe, it, expect } from 'vitest';
import {
  appendVerifyOutputToMarkdownBody,
  buildVerifyFailureMarkdownBody,
} from './verify-before-done-markdown.js';

describe('buildVerifyFailureMarkdownBody', () => {
  it('uses indented blocks (no outer ``` fences) so markdown stays well-formed', () => {
    const body = buildVerifyFailureMarkdownBody('exit 1', 'line1\n```text\noops\n```\nline4');
    expect(body).not.toContain('<details>');
    expect(body.split('\n').some((line) => /^\s{0,3}```/.test(line))).toBe(false);
    expect(body).toContain('    ```text');
    expect(body).toContain('    oops');
    expect(body).toContain('**Error:**');
    expect(body).toContain('**Command output:**');
  });

  it('omits command output section when accumulated is blank', () => {
    const body = buildVerifyFailureMarkdownBody('timed out', '   \n');
    expect(body).not.toContain('**Command output:**');
    expect(body).toContain('timed out');
  });
});

describe('appendVerifyOutputToMarkdownBody', () => {
  it('returns base unchanged when transcript is whitespace', () => {
    expect(appendVerifyOutputToMarkdownBody('**Hi**', '  \n')).toBe('**Hi**');
  });

  it('appends indented verify output section', () => {
    const out = appendVerifyOutputToMarkdownBody('**Passed.**', 'a\nb');
    expect(out).toContain('**Passed.**');
    expect(out).toContain('**Verify command output:**');
    expect(out).toContain('    a');
    expect(out).toContain('    b');
  });
});
