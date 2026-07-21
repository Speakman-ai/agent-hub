import { describe, expect, it } from 'vitest';
import { safeHttpHref } from './safeHttpUrl';

describe('safeHttpHref (mobile)', () => {
  it('accepts http and https URLs', () => {
    expect(safeHttpHref('https://linear.app/docs')).toBe('https://linear.app/docs');
    expect(safeHttpHref('http://example.com/')).toBe('http://example.com/');
  });

  it('trims surrounding whitespace', () => {
    expect(safeHttpHref('  https://example.com/  ')).toBe('https://example.com/');
  });

  it('rejects dangerous or non-http schemes', () => {
    expect(safeHttpHref('javascript:alert(1)')).toBeNull();
    expect(safeHttpHref('data:text/html,<script>')).toBeNull();
    expect(safeHttpHref('file:///etc/passwd')).toBeNull();
  });

  it('rejects empty / non-string / unparseable input', () => {
    expect(safeHttpHref('')).toBeNull();
    expect(safeHttpHref('   ')).toBeNull();
    expect(safeHttpHref(null)).toBeNull();
    expect(safeHttpHref(undefined)).toBeNull();
    expect(safeHttpHref(42)).toBeNull();
    expect(safeHttpHref('not a url')).toBeNull();
  });
});
