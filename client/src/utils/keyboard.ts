/**
 * IME-safe keyboard helpers for Enter-to-send inputs.
 *
 * While an input method editor (Japanese, Chinese, Korean, …) is composing,
 * Enter confirms the candidate text; it must not submit. Browsers signal this
 * differently:
 * - `isComposing` is true on keydown during composition (Chrome, Firefox, and
 *   React's synthetic event exposes it via `nativeEvent`);
 * - Safari fires the confirming keydown after `compositionend`, so
 *   `isComposing` is already false there, but `keyCode` is 229 ("IME is
 *   processing"), which every major browser sets for composition keydowns.
 */

type KeyLikeEvent = {
  key?: string;
  shiftKey?: boolean;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

/** True while the key event belongs to an IME composition. */
export function isImeComposing(e: KeyLikeEvent): boolean {
  return (
    e.nativeEvent?.isComposing === true ||
    e.isComposing === true ||
    e.keyCode === 229 ||
    e.nativeEvent?.keyCode === 229
  );
}

/** Plain Enter (no Shift) that is not confirming an IME composition. */
export function isSubmitEnter(e: KeyLikeEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !isImeComposing(e);
}
