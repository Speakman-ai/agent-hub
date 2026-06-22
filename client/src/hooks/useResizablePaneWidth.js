import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { clampPaneWidth } from '../utils/sessionPreviewState.js';

/** Read the current viewport width, or +Infinity when there is no window
 *  (SSR / non-DOM test env) so the viewport cap is a no-op there. */
function readViewportWidth() {
  if (typeof window === 'undefined') return Number.POSITIVE_INFINITY;
  const w = window.innerWidth;
  return typeof w === 'number' && w > 0 ? w : Number.POSITIVE_INFINITY;
}

/**
 * useResizablePaneWidth — shared resizable-width behavior for the right-hand
 * session side panes (preview, changes, design). Encapsulates:
 *   - width state initialized from / persisted to localStorage (per key),
 *   - clamping to [min, max] via the shared `clampPaneWidth` util,
 *   - pointer-driven drag handlers for a left-edge resize handle, and
 *   - a body `user-select: none` lock while dragging.
 *
 * The pane sits on the RIGHT, so dragging the left-edge handle leftward
 * widens it (`startWidth + (startX - clientX)`). The same geometry drives
 * the keyboard path: ArrowLeft/PageUp widen, ArrowRight/PageDown narrow,
 * Home snaps to the minimum width and End to the maximum. The returned
 * `handleProps` make the separator focusable (`tabIndex: 0`) and operable
 * from the keyboard so the `role="separator"` + aria-value semantics are
 * not a screen-reader-only promise.
 *
 * @param {object} opts
 * @param {string|null} opts.storageKey  localStorage key for the width; when
 *   falsy the width is in-memory only (still resizable, just not persisted).
 * @param {number} opts.defaultWidth     fallback width (px) when nothing stored.
 * @param {number} opts.min              minimum width (px).
 * @param {number} opts.max              absolute maximum width (px) — the
 *   stored preference ceiling. The *rendered/operable* width is additionally
 *   capped to a fraction of the viewport (see `maxViewportFraction`) so a
 *   width persisted on a wide monitor can't overflow / crush the chat on a
 *   narrower laptop or tablet. The stored preference is preserved across
 *   viewport changes; only the displayed width shrinks to fit.
 * @param {number} [opts.maxViewportFraction] cap the rendered width to this
 *   fraction of `window.innerWidth` (default 0.6). At the smallest `lg`
 *   viewport (1024px) this allows ~614px, leaving room for the chat.
 * @param {number} [opts.keyStep]        px per Arrow keypress (default 16).
 * @param {number} [opts.keyPageStep]    px per Page{Up,Down} keypress (default 64).
 * @returns {{
 *   width: number,        // viewport-capped width to render & operate on
 *   isResizing: boolean,
 *   handleProps: object,  // spread onto the resize separator element
 * }}
 */
export function useResizablePaneWidth({
  storageKey,
  defaultWidth,
  min,
  max,
  maxViewportFraction = 0.6,
  keyStep = 16,
  keyPageStep = 64,
}) {
  const readStored = useCallback(() => {
    if (!storageKey) return defaultWidth;
    try {
      return clampPaneWidth(window.localStorage.getItem(storageKey), {
        min,
        max,
        fallback: defaultWidth,
      });
    } catch {
      return defaultWidth;
    }
  }, [storageKey, defaultWidth, min, max]);

  // `width` is the stored *preference*, clamped only to the absolute [min, max]
  // ceiling. It is what we persist, so a wide-monitor choice survives a detour
  // through a narrow viewport.
  const [width, setWidth] = useState(readStored);
  const [isResizing, setIsResizing] = useState(false);

  // Track the viewport so the effective cap reacts to window resizes (and to
  // the device rotating / a window moving between monitors).
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setViewportWidth(readViewportWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The viewport-aware ceiling actually applied to the rendered pane. Never
  // below `min` (so the pane stays usable) and never above the absolute `max`.
  const effectiveMax = useMemo(() => {
    if (!Number.isFinite(viewportWidth)) return max;
    const vpCap = Math.round(viewportWidth * maxViewportFraction);
    return Math.max(min, Math.min(max, vpCap));
  }, [viewportWidth, maxViewportFraction, min, max]);

  // What we actually render and operate on — the stored preference clamped down
  // to the current viewport cap.
  const displayWidth = Math.min(width, effectiveMax);

  // Re-read when the storage key changes (e.g. the active session rotates) so
  // a wide session doesn't drag a narrow one's width along with it.
  useEffect(() => {
    setWidth(readStored());
  }, [readStored]);

  // Persist on width changes. Storage failures (private mode, quota) are
  // non-fatal — the width just won't survive a reload.
  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      /* storage unavailable */
    }
  }, [storageKey, width]);

  const dragStateRef = useRef(null);

  const onPointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Anchor the drag at the *displayed* width so the handle tracks the
      // pointer from where it visually sits (which may be the viewport cap).
      dragStateRef.current = { startX: e.clientX, startWidth: displayWidth };
      setIsResizing(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported in some test environments */
      }
    },
    [displayWidth],
  );

  const onPointerMove = useCallback(
    (e) => {
      if (!dragStateRef.current) return;
      const { startX, startWidth } = dragStateRef.current;
      // Pane is on the right — drag the left edge leftward to widen. Clamp to
      // the viewport-aware ceiling so the pane can't grow past what fits.
      setWidth(
        clampPaneWidth(startWidth + (startX - e.clientX), {
          min,
          max: effectiveMax,
          fallback: defaultWidth,
        }),
      );
    },
    [min, effectiveMax, defaultWidth],
  );

  const endResize = useCallback(() => {
    dragStateRef.current = null;
    setIsResizing(false);
  }, []);

  // Keyboard operability — a separator presented with aria-value semantics
  // must be adjustable without a pointer. ArrowLeft/PageUp widen (the pane is
  // right-anchored, so a smaller separator x means a wider pane), ArrowRight/
  // PageDown narrow, Home → min, End → max.
  const onKeyDown = useCallback(
    (e) => {
      let next;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          next = displayWidth + keyStep;
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          next = displayWidth - keyStep;
          break;
        case 'PageUp':
          next = displayWidth + keyPageStep;
          break;
        case 'PageDown':
          next = displayWidth - keyPageStep;
          break;
        case 'Home':
          next = min;
          break;
        case 'End':
          next = effectiveMax;
          break;
        default:
          return;
      }
      e.preventDefault();
      // Operate against the same viewport-aware ceiling as the pointer path.
      setWidth(clampPaneWidth(next, { min, max: effectiveMax, fallback: defaultWidth }));
    },
    [displayWidth, min, effectiveMax, defaultWidth, keyStep, keyPageStep],
  );

  useEffect(() => {
    if (!isResizing) return undefined;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = prev;
    };
  }, [isResizing]);

  const handleProps = {
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': 'vertical',
    // Report the *operable* range — what the user can actually reach right now
    // (`effectiveMax`), not the absolute ceiling they can't render past.
    'aria-valuenow': displayWidth,
    'aria-valuemin': min,
    'aria-valuemax': effectiveMax,
    onPointerDown,
    onPointerMove,
    onPointerUp: endResize,
    onPointerCancel: endResize,
    onKeyDown,
  };

  return { width: displayWidth, isResizing, handleProps };
}

export default useResizablePaneWidth;
