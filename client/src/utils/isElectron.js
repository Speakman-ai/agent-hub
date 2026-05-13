/**
 * Detect whether the React client is running inside the Electron shell.
 *
 * The Electron preload script (`electron/preload.js`) attaches a non-enumerable
 * `electronAPI` object on `window` with `isElectron: true`. Plain browsers
 * never expose this bridge, so checking for it cleanly separates the two
 * runtimes.
 *
 * Why a helper instead of inlining `window.electronAPI?.isElectron` everywhere:
 *   - centralises the SSR/non-browser guard (`typeof window === 'undefined'`)
 *   - gives us a single seam to mock in Vitest (override the helper, not
 *     `globalThis.window` from every test file)
 *   - signals intent at call sites: "this UI is Electron-only" reads better
 *     than a bare optional-chain on a global bridge.
 *
 * The check is intentionally conservative: it returns `true` ONLY when the
 * bridge is present *and* the bridge declares itself as Electron. Anything
 * else — missing bridge, missing flag, falsy flag — returns `false`.
 */
export function isElectron() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.electronAPI?.isElectron);
}
