/** Pixels from the bottom of the scroll container still treated as "following" the tail. */
export const CHAT_STICK_TO_BOTTOM_THRESHOLD_PX = 150;

/**
 * @param {HTMLElement | null} el
 * @param {number} [thresholdPx]
 * @returns {boolean}
 */
export function isNearBottom(el, thresholdPx = CHAT_STICK_TO_BOTTOM_THRESHOLD_PX) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx;
}

/**
 * Snap the scroll container to the tail several times so late layout (SessionTail
 * blocks, images, syntax highlight) does not leave the viewport anchored at the
 * top of a tall interrupted bubble.
 *
 * @param {HTMLElement | null} scrollEl
 * @param {(el: HTMLElement) => void} [pinOnce] — defaults to `el.scrollTop = el.scrollHeight`
 */
export function forcePinChatTailScroll(scrollEl, pinOnce) {
  if (!scrollEl) return;
  const pin =
    pinOnce ||
    ((el) => {
      el.scrollTop = el.scrollHeight;
    });
  pin(scrollEl);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      pin(scrollEl);
      requestAnimationFrame(() => pin(scrollEl));
    });
  }
  setTimeout(() => pin(scrollEl), 100);
}
