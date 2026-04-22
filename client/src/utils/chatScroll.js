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
