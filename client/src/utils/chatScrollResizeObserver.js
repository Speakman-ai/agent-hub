/**
 * When the user is following the chat tail (`shouldPin`), re-run `pinScroll` whenever
 * `observedElement` resizes (images, code blocks) without a React render.
 *
 * @param {object} opts
 * @param {Element} opts.observedElement
 * @param {() => boolean} opts.shouldPin
 * @param {() => void} opts.pinScroll
 * @returns {() => void} cleanup — disconnects the observer
 */
export function attachTailPinResizeObserver({ observedElement, shouldPin, pinScroll }) {
  if (!observedElement || typeof ResizeObserver === 'undefined') {
    return () => {};
  }
  const ro = new ResizeObserver(() => {
    if (!shouldPin()) return;
    pinScroll();
  });
  ro.observe(observedElement);
  return () => ro.disconnect();
}
