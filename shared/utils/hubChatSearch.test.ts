import { describe, it, expect } from 'vitest';
import { hubChatSearchExcerpt, hubChatSearchTerms } from './hubChatSearch';

describe('hubChatSearchTerms', () => {
  it('splits on punctuation and lowercases', () => {
    expect(hubChatSearchTerms('Deploy "prod"-db')).toEqual(['deploy', 'prod', 'db']);
  });
});

describe('hubChatSearchExcerpt', () => {
  it('marks words that start with a term', () => {
    expect(hubChatSearchExcerpt('We deployed prod today', 'deploy')).toEqual([
      { text: 'We ', match: false },
      { text: 'deployed', match: true },
      { text: ' prod today', match: false },
    ]);
  });

  it('centres a long body on the first match with ellipses', () => {
    const body = `${'filler '.repeat(40)}the zebra ran ${'tail '.repeat(40)}`;
    const parts = hubChatSearchExcerpt(body, 'zebra', 60);
    expect(parts[0]!.text).toMatch(/^…filler /);
    expect(parts[parts.length - 1]!.text.endsWith('…')).toBe(true);
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['zebra']);
  });

  it('returns the plain start when nothing matches', () => {
    expect(hubChatSearchExcerpt('hello world', 'zzz')).toEqual([
      { text: 'hello world', match: false },
    ]);
  });
});
