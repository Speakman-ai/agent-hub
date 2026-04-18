// Clipboard helpers for the mobile app.
//
// Wraps expo-clipboard with null-safe defaults and a provider-injection hook
// so unit tests can exercise the logic without loading the native module.
// Call sites should use the async `copyToClipboard` / `pasteFromClipboard`
// functions; the pure helpers (`sanitizeCopyPayload`, `canCopy`) are exported
// for reuse in UI state (e.g., disabling a "Copy" button).

let defaultProviderPromise = null;

async function getDefaultProvider() {
  if (!defaultProviderPromise) {
    defaultProviderPromise = import('expo-clipboard').then((mod) => ({
      setStringAsync: (text) => mod.setStringAsync(text),
      getStringAsync: () => mod.getStringAsync(),
      hasStringAsync:
        typeof mod.hasStringAsync === 'function'
          ? () => mod.hasStringAsync()
          : null,
    }));
  }
  return defaultProviderPromise;
}

/**
 * Normalize text before writing it to the clipboard.
 *  - Returns '' for nullish / non-string input
 *  - Strips a single trailing newline (common from fenced markdown blocks)
 *  - Trims leading / trailing whitespace
 */
export function sanitizeCopyPayload(text) {
  if (text == null) return '';
  const str = typeof text === 'string' ? text : String(text);
  return str.replace(/\n$/, '').trim();
}

/** True when the value has non-empty content suitable for copying. */
export function canCopy(text) {
  return sanitizeCopyPayload(text).length > 0;
}

/**
 * Write `text` to the system clipboard. Returns `true` on success, `false`
 * when the payload was empty or the underlying provider threw.
 *
 * Optional `provider` is used in tests to avoid loading expo-clipboard.
 */
export async function copyToClipboard(text, { provider } = {}) {
  const payload = sanitizeCopyPayload(text);
  if (!payload) return false;
  const p = provider || (await getDefaultProvider());
  try {
    await p.setStringAsync(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a string from the system clipboard. Always resolves to a string —
 * returns '' when the clipboard is empty, unavailable, or non-text.
 *
 * Optional `provider` is used in tests.
 */
export async function pasteFromClipboard({ provider } = {}) {
  const p = provider || (await getDefaultProvider());
  try {
    if (typeof p.hasStringAsync === 'function') {
      const has = await p.hasStringAsync();
      if (!has) return '';
    }
    const text = await p.getStringAsync();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}
