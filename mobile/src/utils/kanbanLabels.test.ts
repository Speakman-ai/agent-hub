import { describe, it, expect } from 'vitest';
import { parseCardLabels, collectDistinctLabels, cardMatchesLabelFilter } from './kanbanLabels';

describe('kanbanLabels (mobile)', () => {
  it('splits, trims, and drops empty tags', () => {
    expect(parseCardLabels(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(parseCardLabels(null)).toEqual([]);
    expect(parseCardLabels(undefined)).toEqual([]);
  });

  it('collects distinct labels sorted for display', () => {
    expect(
      collectDistinctLabels([{ labels: 'b, a' }, { labels: 'a, c' }, { labels: null }]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('matches with OR semantics; empty selection matches everything', () => {
    expect(cardMatchesLabelFilter({ labels: 'a, b' }, new Set())).toBe(true);
    expect(cardMatchesLabelFilter({ labels: 'a, b' }, new Set(['b']))).toBe(true);
    expect(cardMatchesLabelFilter({ labels: 'a, b' }, new Set(['z']))).toBe(false);
  });
});
