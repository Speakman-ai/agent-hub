import { describe, it, expect } from 'vitest';
import {
  classifyElement,
  isAlwaysMaskedField,
  isBlocked,
  isFormControl,
  maskValue,
  shouldMaskValue,
  DEFAULT_MASK_OPTIONS,
} from './mask.js';

function makeEl(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

describe('DEFAULT_MASK_OPTIONS', () => {
  it('masks all inputs by default (compliance fail-closed)', () => {
    expect(DEFAULT_MASK_OPTIONS.maskAllInputs).toBe(true);
  });
});

describe('maskValue', () => {
  it('preserves length and whitespace, hides every visible char', () => {
    expect(maskValue('4111 1111')).toBe('**** ****');
    expect(maskValue('hunter2')).toBe('*******');
  });

  it('passes through null/undefined untouched', () => {
    expect(maskValue(null)).toBe(null);
    expect(maskValue(undefined)).toBe(undefined);
  });

  it('honors a custom mask char', () => {
    expect(maskValue('abc', '•')).toBe('•••');
  });
});

describe('isFormControl', () => {
  it.each(['<input />', '<textarea></textarea>', '<select></select>'])('recognizes %s', (html) => {
    expect(isFormControl(makeEl(html))).toBe(true);
  });

  it('rejects non-controls', () => {
    expect(isFormControl(makeEl('<div></div>'))).toBe(false);
  });
});

describe('isAlwaysMaskedField: autocomplete-sensitive fields', () => {
  it.each([
    ['<input type="password" />', 'password type'],
    ['<input autocomplete="cc-number" />', 'cc-number token'],
    ['<input autocomplete="cc-csc" />', 'cvv token'],
    ['<input autocomplete="cc-exp" />', 'expiry token'],
    ['<input autocomplete="cc-exp-month" />', 'expiry month token'],
    ['<input autocomplete="cc-exp-year" />', 'expiry year token'],
    ['<input autocomplete="current-password" />', 'current-password token'],
    ['<input name="cardNumber" />', 'name heuristic card number'],
    ['<input id="cvv" />', 'id heuristic cvv'],
    ['<input name="cvc" />', 'name heuristic cvc'],
    ['<input placeholder="Security code" />', 'placeholder heuristic security code'],
    ['<input aria-label="Expiration date" />', 'aria-label heuristic expiration'],
    ['<input name="exp-month" />', 'name heuristic exp month'],
  ])('masks %s (%s)', (html) => {
    expect(isAlwaysMaskedField(makeEl(html))).toBe(true);
  });

  it.each([
    '<input type="text" name="firstName" />',
    '<input type="email" name="email" />',
    '<input name="export-format" />',
    '<select name="country"></select>',
  ])('does not over-match %s', (html) => {
    expect(isAlwaysMaskedField(makeEl(html))).toBe(false);
  });

  it('refuses to unmask a sensitive field even with an explicit unmask hint', () => {
    const el = makeEl('<input autocomplete="cc-number" data-rum-unmask />');
    expect(classifyElement(el)).toBe('mask');
  });
});

describe('isBlocked', () => {
  it('honors data-rum-block and the rum-block class', () => {
    expect(isBlocked(makeEl('<div data-rum-block></div>'))).toBe(true);
    expect(isBlocked(makeEl('<div class="rum-block"></div>'))).toBe(true);
    expect(isBlocked(makeEl('<div></div>'))).toBe(false);
  });
});

describe('classifyElement priority order', () => {
  it('block wins over everything', () => {
    const el = makeEl('<input data-rum-block data-rum-unmask />');
    expect(classifyElement(el)).toBe('block');
  });

  it('masks a plain input by default (maskAllInputs on)', () => {
    expect(classifyElement(makeEl('<input name="firstName" />'))).toBe('mask');
    expect(shouldMaskValue(makeEl('<input name="firstName" />'))).toBe(true);
  });

  it('respects an explicit mask hint on a non-control', () => {
    expect(classifyElement(makeEl('<span data-rum-mask>hi</span>'))).toBe('mask');
    expect(classifyElement(makeEl('<span class="rum-mask">hi</span>'))).toBe('mask');
  });

  it('allows opt-out on a NON-sensitive input via unmask hint', () => {
    const el = makeEl('<input name="favoriteColor" data-rum-unmask />');
    expect(classifyElement(el)).toBe('unmask');
  });

  it('leaves non-control elements unmasked unless maskAllText is on', () => {
    expect(classifyElement(makeEl('<div>plain</div>'))).toBe('unmask');
    expect(classifyElement(makeEl('<div>plain</div>'), { maskAllText: true })).toBe('mask');
  });

  it('can disable input masking via maskAllInputs:false', () => {
    const el = makeEl('<input name="firstName" />');
    expect(classifyElement(el, { maskAllInputs: false })).toBe('unmask');
  });
});
