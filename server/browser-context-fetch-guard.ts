/**
 * browser-context-fetch-guard.ts — the SINGLE CDP Fetch owner per browser context.
 *
 * There must be exactly one Fetch interceptor per Chromium context. Playwright's
 * own `context.route('**\/*')` is a Fetch client, and a second raw CDP
 * `Fetch.enable` on the same target races it: `Fetch.disable` from one client
 * disables the other, and two pause-handlers fight over the same requestId, so a
 * disallowed Document can egress before it is failed. We therefore do NOT use
 * Playwright routing at all — this module is the one Fetch owner, installed at
 * launch, and it handles both concerns:
 *
 *   • ad/tracker blocking (all resource types, static hostname list), and
 *   • main-frame document URL policy (a mutable predicate the navigate-time and
 *     preview-origin-pin callers install into the same session).
 *
 * Using CDP rather than Playwright routing is deliberate: Playwright's route
 * handler is NOT invoked for the requests that follow a 30x redirect (microsoft/
 * playwright#3993, #34994), so a redirect hop to loopback/metadata would egress.
 * CDP `Fetch.enable` with `requestStage: 'Request'` pauses every hop, including
 * redirect targets, so the document policy fails them before egress.
 */

import { isBlockedAdTrackerHostname } from './browser-host-policy.js';

/** Minimal CDP session shape (Playwright CDPSession or a test fake). */
export type CdpSessionLike = {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
  /** Playwright CDPSession.detach — drop the session so it does not leak on the target. */
  detach?: () => Promise<void>;
};

/** Returns true when a main-frame document request to `url` is allowed to proceed. */
export type DocumentUrlPolicy = (url: string) => boolean;

/** Shape of a paused-request event as far as the URL policy needs it. */
export type FetchRequestPausedParams = {
  requestId: string;
  /** Per the CDP spec, `resourceType` is a TOP-LEVEL event field. */
  resourceType?: unknown;
  request: { url: string; resourceType?: unknown };
};

/**
 * `Network.ResourceType` of a `Fetch.requestPaused` event. The spec puts
 * `resourceType` at the event's top level (NOT inside `request`); the nested
 * fallback tolerates shape drift but real Chromium uses the top-level field.
 */
export function pausedRequestResourceType(params: FetchRequestPausedParams): string | undefined {
  if (typeof params.resourceType === 'string') return params.resourceType;
  const nested = params.request?.resourceType;
  return typeof nested === 'string' ? nested : undefined;
}

export interface ContextFetchGuard {
  /** True once `Fetch.enable` succeeded; false leaves callers on their post-op backstops. */
  readonly installed: boolean;
  /**
   * Install `policy` as the active document-URL policy and return a restore fn
   * that reverts to whatever was active before. Single slot: navigate-time and
   * preview-origin-pin callers never overlap on one context (preview drives
   * `page.goto` directly), so save/restore matches the prior single-guard
   * semantics without a second Fetch client.
   */
  setDocumentPolicy(policy: DocumentUrlPolicy | null): () => void;
  /** Detach the sole Fetch client from the context. */
  uninstall(): Promise<void>;
}

const guardByContext = new WeakMap<object, ContextFetchGuard>();

/** Resolve the launch-time Fetch guard registered for a Playwright context (if any). */
export function getContextFetchGuard(context: unknown): ContextFetchGuard | undefined {
  if (context && typeof context === 'object') return guardByContext.get(context as object);
  return undefined;
}

const NOOP_GUARD: ContextFetchGuard = {
  installed: false,
  setDocumentPolicy: () => () => {},
  uninstall: async () => {},
};

/**
 * Install the single CDP Fetch interceptor for a context. Only registered in the
 * context→guard map (and thus discoverable by {@link getContextFetchGuard}) when
 * `Fetch.enable` succeeds; on failure returns an uninstalled no-op so callers
 * fall back to their own transient interception.
 */
export async function installContextFetchGuard(
  context: object,
  session: CdpSessionLike,
  opts: { blockAdsTrackers: boolean },
): Promise<ContextFetchGuard> {
  let docPolicy: DocumentUrlPolicy | null = null;

  const fail = (requestId: string) => {
    void session
      .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      .catch(() => {});
  };
  const cont = (requestId: string) => {
    void session.send('Fetch.continueRequest', { requestId }).catch(() => {});
  };

  const handler = (raw: unknown) => {
    const params = raw as FetchRequestPausedParams;
    const requestId = params.requestId;
    const url = params.request?.url ?? '';
    if (opts.blockAdsTrackers) {
      try {
        if (isBlockedAdTrackerHostname(new URL(url).hostname)) {
          fail(requestId);
          return;
        }
      } catch {
        // Malformed URL — fall through to the document check / continue.
      }
    }
    if (pausedRequestResourceType(params) === 'Document' && docPolicy && !docPolicy(url)) {
      fail(requestId);
      return;
    }
    cont(requestId);
  };

  // Attach BEFORE enabling: Chromium may pause in-flight requests the moment
  // Fetch.enable resolves — with no handler attached they would never be
  // continued and the page would hang.
  session.on('Fetch.requestPaused', handler);
  try {
    await session.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
  } catch (err) {
    session.off('Fetch.requestPaused', handler);
    await session.detach?.().catch(() => {});
    console.warn(
      '[browser] context Fetch guard: Fetch.enable failed; ad-block + document URL policy are degraded for this context:',
      err instanceof Error ? err.message : String(err),
    );
    return NOOP_GUARD;
  }

  const guard: ContextFetchGuard = {
    installed: true,
    setDocumentPolicy(policy) {
      const prev = docPolicy;
      docPolicy = policy;
      return () => {
        docPolicy = prev;
      };
    },
    uninstall: async () => {
      guardByContext.delete(context);
      session.off('Fetch.requestPaused', handler);
      await session.send('Fetch.disable').catch(() => {});
      await session.detach?.().catch(() => {});
    },
  };
  guardByContext.set(context, guard);
  return guard;
}
