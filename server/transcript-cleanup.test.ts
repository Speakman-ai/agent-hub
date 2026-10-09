import { describe, it, expect } from 'vitest';
import { collapseRepeatedPhrases } from './transcript-cleanup.js';

describe('collapseRepeatedPhrases', () => {
  it('reduces a looped sentence to one copy', () => {
    const sentence = 'Покладіть тісто на тісто і дайте йому відпочити 10 хвилин.';
    const looped = Array(13).fill(sentence).join(' ');
    expect(collapseRepeatedPhrases(looped)).toBe(sentence);
  });

  it('collapses a looped short phrase and keeps surrounding text', () => {
    const tail = Array(12).fill('1茶匙 蜂蜜').join(' ');
    expect(collapseRepeatedPhrases(`1茶匙 砂糖 1茶匙 塩 ${tail} done`)).toBe(
      '1茶匙 砂糖 1茶匙 塩 1茶匙 蜂蜜 done',
    );
  });

  it('treats punctuation and case differences as the same phrase', () => {
    expect(collapseRepeatedPhrases('Thank you. thank you, Thank you! Bye')).toBe('Thank you. Bye');
  });

  it('leaves normal speech alone', () => {
    const speech = 'We said no, no, no to the plan. Then we shipped it, and it worked.';
    expect(collapseRepeatedPhrases(speech)).toBe(speech);
  });

  it('keeps a phrase said twice', () => {
    const speech = 'one more time one more time and done';
    expect(collapseRepeatedPhrases(speech)).toBe(speech);
  });

  it('collapses a single word only after a long run', () => {
    expect(collapseRepeatedPhrases('ok ok ok ok ok ok fine')).toBe('ok fine');
  });

  it('collapses exactly five repeated words with nothing after them', () => {
    expect(collapseRepeatedPhrases('ok ok ok ok ok')).toBe('ok');
  });

  it('keeps four repeated words', () => {
    expect(collapseRepeatedPhrases('ok ok ok ok')).toBe('ok ok ok ok');
  });

  it('preserves paragraph breaks in transcripts without a loop', () => {
    const speech = 'First agenda item is hiring.\n\nSecond agenda item is budget.';
    expect(collapseRepeatedPhrases(speech)).toBe(speech);
  });

  it('keeps the whitespace around a removed loop', () => {
    const looped = `Intro line.\n\n${Array(4).fill('Thank you.').join(' ')}\n\nNext topic.`;
    expect(collapseRepeatedPhrases(looped)).toBe('Intro line.\n\nThank you.\n\nNext topic.');
  });

  it('collapses a loop that spans line breaks', () => {
    expect(collapseRepeatedPhrases('go on\ngo on\ngo on\nstop')).toBe('go on\nstop');
  });

  it('returns short and empty input unchanged', () => {
    expect(collapseRepeatedPhrases('')).toBe('');
    expect(collapseRepeatedPhrases('  hi there \n')).toBe('  hi there \n');
  });
});
