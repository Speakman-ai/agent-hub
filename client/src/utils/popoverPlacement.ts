export interface PopoverPlacement {
  /** Exactly one of `top` / `bottom` is set; `bottom` anchors a popover that opens upward. */
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  /** Never taller than the viewport space on the side it opens toward. */
  maxHeight: number;
}

interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const GAP = 4;
/** Below this much room, a below-placed popover flips above if there is more room there. */
const MIN_COMFORTABLE_HEIGHT = 280;

/**
 * Where a fixed popover goes so its whole box (header, list, footer) stays
 * inside the viewport. `below` opens under the trigger and flips above it
 * when the space below is short; `right` opens beside the trigger and slides
 * up when the trigger sits low.
 */
export function placePopover(
  rect: AnchorRect,
  viewport: { width: number; height: number },
  placement: 'below' | 'right',
  {
    preferredWidth,
    preferredHeight,
    margin,
  }: {
    preferredWidth: number;
    preferredHeight: number;
    margin: number;
  },
): PopoverPlacement {
  const width = Math.max(0, Math.min(preferredWidth, viewport.width - margin * 2));
  const rawLeft = placement === 'right' ? rect.right + GAP : rect.left;
  const left = Math.max(margin, Math.min(rawLeft, viewport.width - width - margin));
  const fullHeight = Math.max(0, Math.min(preferredHeight, viewport.height - margin * 2));

  if (placement === 'right') {
    // Slide up just enough that the full height fits below `top`.
    const top = Math.max(margin, Math.min(rect.top, viewport.height - margin - fullHeight));
    return { top, left, width, maxHeight: Math.max(0, viewport.height - margin - top) };
  }

  const top = rect.bottom + GAP;
  const below = Math.max(0, viewport.height - margin - top);
  const above = Math.max(0, rect.top - GAP - margin);
  if (below < Math.min(fullHeight, MIN_COMFORTABLE_HEIGHT) && above > below) {
    return {
      bottom: viewport.height - (rect.top - GAP),
      left,
      width,
      maxHeight: Math.min(fullHeight, above),
    };
  }
  return { top, left, width, maxHeight: Math.min(fullHeight, below) };
}
