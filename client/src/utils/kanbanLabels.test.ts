import { describe, it, expect } from 'vitest';
import { parseCardLabels, collectDistinctLabels, cardMatchesLabelFilter } from './kanbanLabels';

describe('kanbanLabels', () => {
  it('parses comma-separated labels', () => {
    expect(parseCardLabels(' bug, frontend ,')).toEqual(['bug', 'frontend']);
  });

  it('collects distinct sorted labels', () => {
    expect(
      collectDistinctLabels([
        { labels: 'zeta, alpha' },
        { labels: 'alpha, beta' },
        { labels: null },
      ]),
    ).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('matches cards with any selected label', () => {
    const selected = new Set(['bug']);
    expect(cardMatchesLabelFilter({ labels: 'bug, ui' }, selected)).toBe(true);
    expect(cardMatchesLabelFilter({ labels: 'feature' }, selected)).toBe(false);
    expect(cardMatchesLabelFilter({ labels: 'feature' }, new Set())).toBe(true);
  });
});
