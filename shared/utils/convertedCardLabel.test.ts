import { describe, it, expect } from 'vitest';
import { convertedCardId, convertedCardLabel } from './convertedCardLabel';

describe('convertedCardLabel', () => {
  it('names the card by short id and title', () => {
    expect(
      convertedCardLabel({
        converted_card_id: 'card-uuid',
        converted_card: { id: 'card-uuid', short_id: 1768, title: 'Cant find linked card' },
      }),
    ).toBe('#1768 · Cant find linked card');
  });

  it('falls back to the bare title when the card has no short id', () => {
    expect(
      convertedCardLabel({
        converted_card: { id: 'card-uuid', short_id: null, title: 'Fix the thing' },
      }),
    ).toBe('Fix the thing');
  });

  it('returns null when the server could not resolve the card', () => {
    // The regression this guards: a ticket carrying only the opaque card id
    // must not be labelled with that uuid — it matches nothing on the board.
    expect(convertedCardLabel({ converted_card_id: 'card-uuid', converted_card: null })).toBeNull();
    expect(convertedCardLabel({ converted_card: { id: 'card-uuid', title: '   ' } })).toBeNull();
    expect(convertedCardLabel(null)).toBeNull();
  });
});

describe('convertedCardId', () => {
  it('prefers the resolved card id and falls back to the ticket column', () => {
    expect(convertedCardId({ converted_card: { id: 'from-summary' } })).toBe('from-summary');
    expect(convertedCardId({ converted_card_id: 'from-column' })).toBe('from-column');
  });

  it('returns null when there is no card', () => {
    expect(convertedCardId({ converted_card_id: '  ' })).toBeNull();
    expect(convertedCardId(undefined)).toBeNull();
  });
});
