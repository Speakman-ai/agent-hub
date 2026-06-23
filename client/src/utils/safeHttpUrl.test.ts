import { describe, it, expect } from 'vitest';
import { safeHttpHref } from './safeHttpUrl';

describe('safeHttpHref', () => {
  it('allows http and https URLs', () => {
    expect(safeHttpHref('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(safeHttpHref('http://local.dev/')).toBe('http://local.dev/');
  });

  it('returns null for non-http schemes', () => {
    expect(safeHttpHref('javascript:alert(1)')).toBeNull();
    expect(safeHttpHref('data:text/html,<script>')).toBeNull();
    expect(safeHttpHref('file:///etc/passwd')).toBeNull();
  });

  it('returns null for empty or invalid input', () => {
    expect(safeHttpHref('')).toBeNull();
    expect(safeHttpHref('   ')).toBeNull();
    expect(safeHttpHref('not a url')).toBeNull();
    expect(safeHttpHref(null)).toBeNull();
    expect(safeHttpHref(undefined)).toBeNull();
  });
});
