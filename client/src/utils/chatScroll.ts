/** Pixels from the bottom of the scroll container still treated as "following" the tail. */
export const CHAT_STICK_TO_BOTTOM_THRESHOLD_PX = 150;

/**
 * @param {HTMLElement | null} el
 * @param {number} [thresholdPx]
 * @returns {boolean}
 */
export function isNearBottom(el: any, thresholdPx: any = CHAT_STICK_TO_BOTTOM_THRESHOLD_PX) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx;
}

/**
 * Decide whether the chat should keep following the tail after a user scroll.
 *
 * Any deliberate upward scroll breaks follow immediately — even inside the
 * near-bottom band — so a live-growing block (e.g. the Finalize CI "Checks"
 * block, which polls and re-renders while a run is in flight) can't repeatedly
 * yank the viewport back to the bottom while the user is trying to read earlier
 * messages. Without this, a small wheel-up inside the 150px band leaves
 * follow=true and the next height change re-pins to the tail, trapping the user.
 *
 * Downward or same-position scrolls fall back to the near-bottom test, so
 * following resumes once the user scrolls back to the tail.
 *
 * @param {{prevScrollTop: number, scrollTop: number, nearBottom: boolean}} o
 * @returns {boolean} next value for "is following the tail"
 */
export function shouldFollowTailAfterScroll({ prevScrollTop, scrollTop, nearBottom }: any) {
  // 1px epsilon absorbs sub-pixel jitter from trackpads / zoom levels.
  if (scrollTop < prevScrollTop - 1) return false;
  return nearBottom;
}

/**
 * Snap the scroll container to the tail and re-arm tail-follow.
 *
 * Ordering matters while a response is actively streaming: the follow flag must
 * be re-armed **synchronously** (in `armFollow`), not deferred to the next frame.
 * `scrollToBottom` used to set the flag inside a requestAnimationFrame, which
 * left a one-frame gap: a streaming token arriving between the click and the rAF
 * fired the auto-scroll effect while follow was still off, so the fresh content
 * pushed the viewport back below the fold and the button never really "stuck".
 * Re-arming synchronously closes that gap — the next streamed delta already sees
 * follow=true and keeps pinning.
 *
 * Only `endProgrammatic` is deferred: the `el.scrollTop = …` write queues a
 * scroll event that must be ignored, so the programmatic guard is cleared on the
 * next frame, after the browser has dispatched it.
 *
 * @param {HTMLElement | null} el
 * @param {{
 *   beginProgrammatic: () => void,
 *   armFollow: (scrollTop: number) => void,
 *   endProgrammatic: () => void,
 *   raf?: (cb: () => void) => void,
 * }} hooks
 */
export function pinChatToBottom(
  el: any,
  { beginProgrammatic, armFollow, endProgrammatic, raf }: any,
) {
  if (!el) return;
  const schedule =
    raf ||
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: any) => cb());
  beginProgrammatic();
  el.scrollTop = el.scrollHeight;
  // Synchronous — a streaming delta on the very next tick must see follow armed.
  armFollow(el.scrollTop);
  schedule(() => {
    endProgrammatic();
  });
}

/**
 * Snap the scroll container to the tail several times so late layout (SessionTail
 * blocks, images, syntax highlight) does not leave the viewport anchored at the
 * top of a tall interrupted bubble.
 *
 * @param {HTMLElement | null} scrollEl
 * @param {(el: HTMLElement) => void} [pinOnce] — defaults to `el.scrollTop = el.scrollHeight`
 * @param {{ delayMs?: number }} [opts]
 * @returns {() => void} cancel pending delayed pin (e.g. on unmount / session switch)
 */
export function forcePinChatTailScroll(scrollEl: any, pinOnce: any, { delayMs = 100 }: any = {}) {
  if (!scrollEl) return () => {};
  const pin =
    pinOnce ||
    ((el: any) => {
      if (!el.isConnected) return;
      el.scrollTop = el.scrollHeight;
    });
  const safePin = (el: any) => {
    if (el?.isConnected) pin(el);
  };
  safePin(scrollEl);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      safePin(scrollEl);
      requestAnimationFrame(() => safePin(scrollEl));
    });
  }
  const timer = setTimeout(() => safePin(scrollEl), delayMs);
  return () => clearTimeout(timer);
}
