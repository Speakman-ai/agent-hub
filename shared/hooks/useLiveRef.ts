/**
 * A ref that is `true` while the component is mounted and `false` after it
 * unmounts, for async callbacks that must not start new work once their view
 * is gone.
 *
 * The effect sets `true` in setup and `false` in cleanup. Setting it only in
 * cleanup is wrong: React Strict Mode (and Fast Refresh) run
 * setup -> cleanup -> setup on a live component, which would leave the flag
 * stuck at `false` and silently disable every later refresh.
 */

type LiveRefHooks = {
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useRef: <T>(initial: T) => { current: T };
};

// Web and native install different React versions. Use the renderer's own hooks.
export function createUseLiveRef({ useEffect, useRef }: LiveRefHooks) {
  return function useLiveRef(): { readonly current: boolean } {
    const live = useRef(false);
    useEffect(() => {
      live.current = true;
      return () => {
        live.current = false;
      };
    }, []);
    return live;
  };
}
