import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { clampPaneWidth } from '../utils/sessionPreviewState';

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
 */
export function useResizablePaneWidth({
  storageKey,
  defaultWidth,
  min,
  max,
  maxViewportFraction = 0.6,
  keyStep = 16,
  keyPageStep = 64,
}: any) {
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

  const [width, setWidth] = useState(readStored);
  const [isResizing, setIsResizing] = useState(false);

  const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setViewportWidth(readViewportWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const effectiveMax = useMemo(() => {
    if (!Number.isFinite(viewportWidth)) return max;
    const vpCap = Math.round(viewportWidth * maxViewportFraction);
    return Math.max(min, Math.min(max, vpCap));
  }, [viewportWidth, maxViewportFraction, min, max]);

  const displayWidth = Math.min(width, effectiveMax);

  useEffect(() => {
    setWidth(readStored());
  }, [readStored]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      /* storage unavailable */
    }
  }, [storageKey, width]);

  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
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
    (e: React.PointerEvent) => {
      if (!dragStateRef.current) return;
      const { startX, startWidth } = dragStateRef.current;
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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
    'aria-orientation': 'vertical' as const,
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
