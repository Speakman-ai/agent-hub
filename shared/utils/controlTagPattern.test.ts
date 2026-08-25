import { describe, it, expect } from 'vitest';
import { openTagPatternSource, closeTagPatternSource } from './controlTagPattern.js';

describe('controlTagPattern', () => {
  it('builds a full-form opening tag pattern', () => {
    expect(openTagPatternSource('agenthub:react')).toBe('<agenthub:react>');
  });

  it('builds a close pattern tolerant of a dropped agenthub: prefix', () => {
    const src = closeTagPatternSource('agenthub:react');
    expect(src).toBe('</(?:agenthub:)?react>');
    const re = new RegExp(src);
    expect(re.test('</agenthub:react>')).toBe(true);
    expect(re.test('</react>')).toBe(true);
  });

  it('handles the hyphenated close-card local name', () => {
    const re = new RegExp(closeTagPatternSource('agenthub:close-card'));
    expect(re.test('</agenthub:close-card>')).toBe(true);
    expect(re.test('</close-card>')).toBe(true);
  });

  it('falls back to the literal tag when there is no colon', () => {
    expect(closeTagPatternSource('plain')).toBe('</plain>');
  });
});
