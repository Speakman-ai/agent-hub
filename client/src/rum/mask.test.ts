import { describe, it, expect } from 'vitest';
import {
  classifyElement,
  isAlwaysMaskedField,
  isBlocked,
  isFormControl,
  maskValue,
  shouldMaskValue,
  maskOptionsForMode,
  DEFAULT_MASK_OPTIONS,
} from './mask';

function makeEl(html: any) {
  const wrap = document.createElement('div');
  (wrap as any).innerHTML = html.trim();
  return wrap.firstElementChild;
}

describe('DEFAULT_MASK_OPTIONS', () => {
  it('is the fail-closed baseline: masks all inputs when no mode is supplied', () => {
    expect(DEFAULT_MASK_OPTIONS.maskAllInputs).toBe(true);
  });

  it('bare default masks an ordinary input; the wizard passwords-only mode does not', () => {
    // Encodes the distinction the two "defaults" must keep: a no-options call is
    // fail-closed (mask all inputs), but the wizard's passwords-only selection
    // (maskOptionsForMode(false)) deliberately records ordinary inputs.
    const ordinary = makeEl('<input type="text" name="comment" />');
    expect(classifyElement(ordinary)).toBe('mask'); // bare DEFAULT_MASK_OPTIONS
    expect(classifyElement(ordinary, maskOptionsForMode(false))).toBe('unmask');
  });
});

describe('maskOptionsForMode', () => {
  it('default mode (false) is passwords-only: inputs and text both unmasked', () => {
    const opts = maskOptionsForMode(false);
    expect(opts.maskAllInputs).toBe(false);
    expect(opts.maskAllText).toBe(false);
  });

  it('strict mode (true) masks all inputs and all text', () => {
    const opts = maskOptionsForMode(true);
    expect(opts.maskAllInputs).toBe(true);
    expect(opts.maskAllText).toBe(true);
  });

  it('coerces any non-true value to the default passwords-only policy', () => {
    for (const v of [undefined, 'yes', 1, null, 'true']) {
      expect(maskOptionsForMode(v)).toEqual({
        ...DEFAULT_MASK_OPTIONS,
        maskAllInputs: false,
        maskAllText: false,
      });
    }
  });

  it('text masking flows through classifyElement', () => {
    const el = makeEl('<div>visible text</div>');
    expect(classifyElement(el, maskOptionsForMode(false))).toBe('unmask');
    expect(classifyElement(el, maskOptionsForMode(true))).toBe('mask');
  });

  it('passwords-only records a non-PII input verbatim but still masks passwords (advertised policy)', () => {
    const text = makeEl('<input type="text" name="comment" />');
    const pwd = makeEl('<input type="password" name="pw" />');
    // The whole point of the default mode: ordinary inputs are recorded…
    expect(classifyElement(text, maskOptionsForMode(false))).toBe('unmask');
    // …while password/PII fields are always masked regardless of the mode.
    expect(classifyElement(pwd, maskOptionsForMode(false))).toBe('mask');
  });

  it('strict masks even ordinary inputs', () => {
    const text = makeEl('<input type="text" name="comment" />');
    expect(classifyElement(text, maskOptionsForMode(true))).toBe('mask');
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
  it.each(['<input />', '<textarea></textarea>', '<select></select>'])(
    'recognizes %s',
    (html: any) => {
      expect(isFormControl(makeEl(html))).toBe(true);
    },
  );

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
  ])('masks %s (%s)', (html: any) => {
    expect(isAlwaysMaskedField(makeEl(html))).toBe(true);
  });

  it.each([
    '<input type="text" name="firstName" />',
    '<input type="email" name="email" />',
    '<input name="export-format" />',
    '<select name="country"></select>',
  ])('does not over-match %s', (html: any) => {
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
