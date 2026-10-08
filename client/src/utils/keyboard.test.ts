import { describe, it, expect } from 'vitest';
import { isImeComposing, isSubmitEnter } from './keyboard';

describe('keyboard helpers', () => {
  it('plain Enter submits; Shift+Enter and other keys do not', () => {
    expect(isSubmitEnter({ key: 'Enter' })).toBe(true);
    expect(isSubmitEnter({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(isSubmitEnter({ key: 'a' })).toBe(false);
  });

  it('Enter confirming an IME composition does not submit (Chrome/Firefox)', () => {
    expect(isSubmitEnter({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false);
    expect(isSubmitEnter({ key: 'Enter', isComposing: true })).toBe(false);
  });

  it('Safari composition confirm (isComposing false, keyCode 229) does not submit', () => {
    expect(isSubmitEnter({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: false } })).toBe(
      false,
    );
    expect(isSubmitEnter({ key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(false);
  });

  it('isImeComposing is false for ordinary keys', () => {
    expect(isImeComposing({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } })).toBe(
      false,
    );
  });
});
