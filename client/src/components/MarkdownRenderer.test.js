import { describe, it, expect } from 'vitest';
import { extractText, markdownCodeIsBlock } from './MarkdownRenderer.jsx';

describe('extractText', () => {
  it('returns a plain string as-is', () => {
    expect(extractText('hello world')).toBe('hello world');
  });

  it('converts a number to a string', () => {
    expect(extractText(42)).toBe('42');
    expect(extractText(0)).toBe('0');
  });

  it('joins an array of strings', () => {
    expect(extractText(['hello', ' ', 'world'])).toBe('hello world');
  });

  it('handles nested arrays', () => {
    expect(extractText([['a', 'b'], ['c']])).toBe('abc');
  });

  it('extracts text from a node with props.children', () => {
    const node = { props: { children: 'inner text' } };
    expect(extractText(node)).toBe('inner text');
  });

  it('recursively extracts text from deeply nested children', () => {
    const node = {
      props: {
        children: {
          props: {
            children: ['deep', ' ', 'value'],
          },
        },
      },
    };
    expect(extractText(node)).toBe('deep value');
  });

  it('handles mixed arrays of strings, numbers, and nodes', () => {
    const node = { props: { children: 'click' } };
    expect(extractText(['Count: ', 5, ' ', node])).toBe('Count: 5 click');
  });

  it('returns empty string for null/undefined', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
  });

  it('returns empty string for objects without props.children', () => {
    expect(extractText({})).toBe('');
    expect(extractText({ props: {} })).toBe('');
  });

  it('returns empty string for boolean values', () => {
    expect(extractText(true)).toBe('');
    expect(extractText(false)).toBe('');
  });
});

describe('markdownCodeIsBlock', () => {
  it('treats explicit inline as not block', () => {
    expect(markdownCodeIsBlock({ inline: true, className: undefined, children: 'a\nb' })).toBe(
      false,
    );
  });

  it('treats explicit block as block', () => {
    expect(markdownCodeIsBlock({ inline: false, className: undefined, children: 'x' })).toBe(true);
  });

  it('when inline is omitted, uses hljs / language- class as block', () => {
    expect(
      markdownCodeIsBlock({ inline: undefined, className: 'hljs language-ts', children: 'x' }),
    ).toBe(true);
  });

  it('when inline is omitted, newline in text implies fenced block', () => {
    expect(
      markdownCodeIsBlock({ inline: undefined, className: undefined, children: 'plain\n' }),
    ).toBe(true);
  });

  it('when inline is omitted, single-line snippet without newline is inline', () => {
    expect(
      markdownCodeIsBlock({ inline: undefined, className: undefined, children: 'npm test' }),
    ).toBe(false);
  });
});
