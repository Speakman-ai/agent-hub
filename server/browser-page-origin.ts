/**
 * The effective origin of a page's main frame, read from Chromium itself.
 *
 * A page's URL does not always say whose document it is: an `about:blank`
 * popup or `srcdoc` frame inherits its creator's origin, and `blob:` URLs
 * carry it in their path. The domain gate needs the real origin for those.
 *
 * `Page.getFrameTree`'s `securityOrigin` is derived from the URL, so it
 * reports such documents as opaque. Evaluating `self.origin` in the page's
 * own world is unsafe too, since page script can override it. A fresh
 * isolated world shares the document's security origin but none of the
 * page's globals, so `self.origin` there is the browser's answer.
 */
import type { CdpSessionLike } from './browser-context-fetch-guard.js';

const ISOLATED_WORLD_NAME = '__agenthub_origin_probe';

/** A serialized tuple origin such as `https://bank.com`, `"null"` when opaque, or null if unreadable. */
export async function readMainFrameOriginViaCdp(cdp: CdpSessionLike): Promise<string | null> {
  const tree = (await cdp.send('Page.getFrameTree')) as {
    frameTree?: { frame?: { id?: unknown } };
  };
  const frameId = tree?.frameTree?.frame?.id;
  if (typeof frameId !== 'string' || !frameId) return null;
  const world = (await cdp.send('Page.createIsolatedWorld', {
    frameId,
    worldName: ISOLATED_WORLD_NAME,
  })) as { executionContextId?: unknown };
  const contextId = world?.executionContextId;
  if (typeof contextId !== 'number') return null;
  const evaluated = (await cdp.send('Runtime.evaluate', {
    expression: 'self.origin',
    contextId,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (evaluated?.exceptionDetails) return null;
  const value = evaluated?.result?.value;
  return typeof value === 'string' && value ? value : null;
}

/** Hostname of a serialized tuple origin; null for opaque (`"null"`) or unparseable origins. */
export function hostOfSerializedOrigin(origin: string | null | undefined): string | null {
  if (!origin || origin === 'null') return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}
