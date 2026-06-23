import { describe, it, expect } from 'vitest';
import { sanitizeForSpeech, splitSentences, planReadback } from './readbackText';

describe('sanitizeForSpeech', () => {
  it('strips fenced code blocks entirely', () => {
    const md = 'Here is code:\n```js\nconst x = 1;\n```\nDone.';
    const out = sanitizeForSpeech(md);
    expect(out!).not.toContain('const x');
    expect(out!).toContain('Here is code:');
    expect(out!).toContain('Done.');
  });

  it('strips an unterminated trailing code fence', () => {
    const md = 'Look at this:\n```js\nconst y = 2;';
    const out = sanitizeForSpeech(md);
    expect(out!).not.toContain('const y');
    expect(out!).toContain('Look at this:');
  });

  it('strips inline code spans', () => {
    expect(sanitizeForSpeech('Run `npm test` now.')).toBe('Run now.');
  });

  it('keeps link text but drops the URL', () => {
    expect(sanitizeForSpeech('See [the docs](https://x.io/y) here.')).toBe('See the docs here.');
  });

  it('drops images', () => {
    expect(sanitizeForSpeech('A ![alt](img.png) B.')).toBe('A B.');
  });

  it('removes heading, list, and emphasis markers but keeps the words', () => {
    expect(sanitizeForSpeech('## Title')).toBe('Title');
    expect(sanitizeForSpeech('- item one')).toBe('item one');
    expect(sanitizeForSpeech('1. first')).toBe('first');
    expect(sanitizeForSpeech('This is **bold** and _italic_.')).toBe('This is bold and italic.');
  });

  it('returns empty for non-strings / empty', () => {
    expect(sanitizeForSpeech('')).toBe('');
    expect(sanitizeForSpeech(null)).toBe('');
    expect(sanitizeForSpeech(undefined)).toBe('');
  });
});

describe('splitSentences', () => {
  it('splits on sentence punctuation', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('splits on newlines', () => {
    expect(splitSentences('Line one\nLine two')).toEqual(['Line one', 'Line two']);
  });

  it('drops fragments with no letters or digits', () => {
    expect(splitSentences('Hello. --- ***')).toEqual(['Hello.']);
  });

  it('returns empty array for empty input', () => {
    expect(splitSentences('')).toEqual([]);
  });
});

describe('planReadback', () => {
  it('only emits complete sentences and holds back the trailing fragment', () => {
    const content = 'First sentence. Second senten';
    const { utterances, consumed } = planReadback(content, 0);
    expect(utterances!).toEqual(['First sentence.']);
    // consumed should sit at the boundary after "First sentence. "
    expect(content.slice(0, consumed)).toContain('First sentence.');
    expect(content.slice(consumed)).toContain('Second senten');
  });

  it('does not re-speak already-consumed text across incremental calls', () => {
    const c1 = 'Alpha beta. Gamma del';
    const r1 = planReadback(c1, 0);
    expect(r1.utterances).toEqual(['Alpha beta.']);

    const c2 = 'Alpha beta. Gamma delta. Epsilon';
    const r2 = planReadback(c2, r1.consumed);
    expect(r2.utterances).toEqual(['Gamma delta.']);
    expect(r2.utterances).not.toContain('Alpha beta.');
  });

  it('does not speak into an unterminated code fence', () => {
    const content = 'Here is the fix.\n```js\nconst a = 1;';
    const { utterances } = planReadback(content, 0);
    expect(utterances!).toEqual(['Here is the fix.']);
    expect(utterances.join(' ')).not.toContain('const a');
  });

  it('speaks past a closed code fence', () => {
    const content = 'Intro line.\n```js\ncode();\n```\nOutro sentence.\n';
    const { utterances } = planReadback(content, 0);
    expect(utterances!).toContain('Intro line.');
    expect(utterances!).toContain('Outro sentence.');
    expect(utterances.join(' ')).not.toContain('code()');
  });

  it('final flush emits the trailing fragment even without punctuation', () => {
    const content = 'Done sentence. Trailing bit with no period';
    const mid = planReadback(content, 0);
    const fin = planReadback(content, mid.consumed, { final: true });
    expect(fin.utterances).toEqual(['Trailing bit with no period']);
    expect(fin.consumed).toBe(content.length);
  });

  it('returns nothing when there is no new complete sentence', () => {
    const content = 'No boundary yet';
    expect(planReadback(content, 0).utterances).toEqual([]);
  });

  it('handles non-string content safely', () => {
    expect(planReadback(null, 0).utterances).toEqual([]);
    expect(planReadback(undefined, 5).utterances).toEqual([]);
  });
});
