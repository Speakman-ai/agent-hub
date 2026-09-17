/**
 * Which Chromium the Agent browser pane should mirror for a chat session.
 *
 * A session can have two live Playwright contexts: public-web (`<chatId>`)
 * and the origin-pinned preview drive (`preview:<chatId>`). The pane attaches
 * with the chat id; this helper picks the registry id that is actually being
 * driven so humans can watch preview verify, not only public-web browsing.
 */

export const PREVIEW_BROWSER_SESSION_PREFIX = 'preview:';

export type BrowserScreencastSurface = 'web' | 'preview';

export function previewBrowserRegistryId(chatSessionId: string): string {
  return `${PREVIEW_BROWSER_SESSION_PREFIX}${chatSessionId}`;
}

export function isPreviewBrowserRegistryId(id: string): boolean {
  return id.startsWith(PREVIEW_BROWSER_SESSION_PREFIX);
}

export function browserScreencastSurfaceOf(registryId: string): BrowserScreencastSurface {
  return isPreviewBrowserRegistryId(registryId) ? 'preview' : 'web';
}

export interface ChatBrowserScreencastTarget {
  targetId: string;
  surface: BrowserScreencastSurface;
}

export interface ResolveChatBrowserScreencastTargetOpts {
  hasSession: (id: string) => boolean;
  /**
   * In-flight *agent* ops on this registry id. Callers must subtract the
   * screencast feed's own keepalive hold so watching a surface does not pin
   * the pane to it forever.
   */
  agentOpsInFlight: (id: string) => number;
  /** Last surface this pane (or the agent) actually drove. */
  lastDriven?: BrowserScreencastSurface | null;
}

/**
 * Pick the Chromium to screencast for `chatSessionId`.
 *
 * Priority: the surface with an in-flight agent op, then the last-driven
 * surface if it is still live, then whichever Chromium exists. When both are
 * idle with no last-driven hint, prefer preview so session-preview verify is
 * visible in the Agent browser pane.
 */
export function resolveChatBrowserScreencastTarget(
  chatSessionId: string,
  opts: ResolveChatBrowserScreencastTargetOpts,
): ChatBrowserScreencastTarget | null {
  const webId = chatSessionId;
  const previewId = previewBrowserRegistryId(chatSessionId);
  const previewLive = opts.hasSession(previewId);
  const webLive = opts.hasSession(webId);
  if (!previewLive && !webLive) return null;

  const previewOps = previewLive ? opts.agentOpsInFlight(previewId) : 0;
  const webOps = webLive ? opts.agentOpsInFlight(webId) : 0;
  if (previewOps > 0) return { targetId: previewId, surface: 'preview' };
  if (webOps > 0) return { targetId: webId, surface: 'web' };

  if (opts.lastDriven === 'preview' && previewLive) {
    return { targetId: previewId, surface: 'preview' };
  }
  if (opts.lastDriven === 'web' && webLive) {
    return { targetId: webId, surface: 'web' };
  }

  if (previewLive && !webLive) return { targetId: previewId, surface: 'preview' };
  if (webLive && !previewLive) return { targetId: webId, surface: 'web' };
  return { targetId: previewId, surface: 'preview' };
}
