import { describe, it, expect } from 'vitest';

/**
 * Unit tests for NotesEditor utility functions.
 * We re-implement the pure functions (parseSnippet, stripTags, relativeTime)
 * for testing since they're not exported from the component.
 */

function stripTags(str: any) {
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseSnippet(html: any) {
  if (!html) return [];
  const parts = html.split(/(<b>.*?<\/b>)/gi);
  return parts
    .map((part: any) => {
      const boldMatch = part.match(/^<b>(.*?)<\/b>$/i);
      if (boldMatch) {
        return { text: stripTags(boldMatch[1]), bold: true };
      }
      return { text: stripTags(part), bold: false };
    })
    .filter((seg: any) => seg.text);
}

function relativeTime(dateStr: any) {
  if (!dateStr) return '';
  const date = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

describe('parseSnippet', () => {
  it('returns empty array for falsy input', () => {
    expect(parseSnippet(null)).toEqual([]);
    expect(parseSnippet(undefined)).toEqual([]);
    expect(parseSnippet('')).toEqual([]);
  });

  it('extracts bold segments from FTS snippet', () => {
    const input = 'some text <b>highlighted</b> more text';
    const result = parseSnippet(input);
    expect(result!).toEqual([
      { text: 'some text ', bold: false },
      { text: 'highlighted', bold: true },
      { text: ' more text', bold: false },
    ]);
  });

  it('strips malicious HTML while preserving bold markers', () => {
    const input = '<b>hello</b> <script>alert("xss")</script> world';
    const result = parseSnippet(input);
    // Bold content is preserved
    expect(result[0]).toEqual({ text: 'hello', bold: true });
    // Script tag content is stripped of tags but text remains
    expect(result!.some((s: any) => s.text.includes('alert("xss")'))).toBe(true);
    // No raw HTML tags in any segment
    result.forEach((seg: any) => {
      expect(seg.text).not.toMatch(/<script/i);
    });
  });

  it('strips arbitrary HTML tags', () => {
    const input = '<div class="evil"><img src=x onerror=alert(1)>test</div>';
    const result = parseSnippet(input);
    const allText = result.map((s: any) => s.text).join('');
    expect(allText!).not.toContain('<div');
    expect(allText!).not.toContain('<img');
    expect(allText!).toContain('test');
  });

  it('decodes HTML entities', () => {
    const input = '&lt;script&gt;&amp;';
    const result = parseSnippet(input);
    expect(result[0].text).toBe('<script>&');
  });

  it('handles bold tags case-insensitively', () => {
    const input = '<B>LOUD</B>';
    const result = parseSnippet(input);
    expect(result!).toEqual([{ text: 'LOUD', bold: true }]);
  });

  it('handles multiple bold segments', () => {
    const input = '<b>one</b> middle <b>two</b>';
    const result = parseSnippet(input);
    expect(result!).toEqual([
      { text: 'one', bold: true },
      { text: ' middle ', bold: false },
      { text: 'two', bold: true },
    ]);
  });
});

describe('relativeTime', () => {
  it('returns empty string for falsy input', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime(undefined)).toBe('');
    expect(relativeTime('')).toBe('');
  });

  it('returns "just now" for very recent dates', () => {
    const now = new Date().toISOString();
    expect(relativeTime(now)).toBe('just now');
  });

  it('returns minutes for dates within the hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(relativeTime(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours for dates within the day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(threeHoursAgo)).toBe('3h ago');
  });

  it('returns days for dates within the month', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(fiveDaysAgo)).toBe('5d ago');
  });

  it('returns months for older dates', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(sixtyDaysAgo)).toBe('2mo ago');
  });

  it('handles date-only strings (no T separator)', () => {
    const result = relativeTime('2020-01-01');
    expect(result!).toMatch(/\d+mo ago/);
  });
});
