import { useCallback, useLayoutEffect, useRef } from 'react';

/** Within this many pixels of the bottom, the list keeps following its tail. */
export const FOLLOW_TAIL_SLOP_PX = 48;

export function isNearBottom(
  el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_TAIL_SLOP_PX;
}

/**
 * Keeps a scrolling message list on its newest message.
 *
 * A one-shot `scrollIntoView` lands short whenever content grows after it
 * runs (images decode, drafts load below the list, the composer resizes), so
 * this pins the list to the bottom and re-pins whenever the container or any
 * of its direct children resizes, until the user scrolls away from the tail.
 * Changing `openKey` (another channel) pins it again; a new `newestKey` (a new
 * last message) scrolls only while still pinned.
 */
export function useStickToBottom(openKey: unknown, newestKey: unknown) {
  const elRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef(true);
  const detachRef = useRef<(() => void) | null>(null);

  const pin = useCallback(() => {
    const el = elRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const attach = useCallback(
    (el: HTMLElement) => {
      const onScroll = () => {
        pinnedRef.current = isNearBottom(el);
      };
      el.addEventListener('scroll', onScroll, { passive: true });

      let resize: ResizeObserver | null = null;
      let mutations: MutationObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          if (pinnedRef.current) pin();
        });
        resize = ro;
        ro.observe(el);
        for (const child of Array.from(el.children)) ro.observe(child);
        if (typeof MutationObserver !== 'undefined') {
          mutations = new MutationObserver((records) => {
            for (const record of records) {
              for (const node of Array.from(record.addedNodes)) {
                if (node instanceof Element) ro.observe(node);
              }
              for (const node of Array.from(record.removedNodes)) {
                if (node instanceof Element) ro.unobserve(node);
              }
            }
            if (pinnedRef.current) pin();
          });
          mutations.observe(el, { childList: true });
        }
      }

      return () => {
        el.removeEventListener('scroll', onScroll);
        resize?.disconnect();
        mutations?.disconnect();
      };
    },
    [pin],
  );

  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      detachRef.current?.();
      detachRef.current = null;
      elRef.current = el;
      if (!el) return;
      detachRef.current = attach(el);
      if (pinnedRef.current) pin();
    },
    [attach, pin],
  );

  // Ref callbacks attach before this runs. It re-attaches when the effect is
  // torn down and re-run without the ref re-attaching (StrictMode).
  useLayoutEffect(() => {
    if (!detachRef.current && elRef.current) detachRef.current = attach(elRef.current);
    return () => {
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [attach]);

  // A different conversation always opens at its newest message.
  useLayoutEffect(() => {
    pinnedRef.current = true;
    pin();
  }, [openKey, pin]);

  // A new message is followed only by a reader who is still at the bottom.
  useLayoutEffect(() => {
    if (pinnedRef.current) pin();
  }, [newestKey, pin]);

  /** Stop following, e.g. before jumping to an older message or page. */
  const release = useCallback(() => {
    pinnedRef.current = false;
  }, []);

  /** Jump to the bottom and follow again, e.g. when the reader sends a message. */
  const follow = useCallback(() => {
    pinnedRef.current = true;
    pin();
  }, [pin]);

  return { scrollRef, release, follow };
}
