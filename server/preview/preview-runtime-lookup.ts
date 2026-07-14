/**
 * Minimal preview runtime surface for port lookup, worktree sync, and proxies.
 * Full {@link PreviewComposeRuntime} / {@link PreviewRuntime} classes are wider.
 */

export type ActivePreviewRow = {
  id: string;
  status: string;
  port: number;
};

export type PreviewRuntimeActiveLookup = {
  getActiveBySessionId(sessionId: string): ActivePreviewRow | null;
};

export type PreviewComposeRuntimeSync = PreviewRuntimeActiveLookup & {
  restartBackendForSession?(sessionId: string, serviceName?: string): Promise<void>;
};

/**
 * Dev-server surface the preview proxy needs to resolve an upstream host
 * port. Unlike compose/legacy previews (a single entry port), a dev server
 * can expose several `portMap` entries, so the lookup takes an optional
 * internal port: omitted → the primary host port; set → the mapped host
 * port for that specific internal port (the `/preview/proxy/p/<internalPort>`
 * sub-mount).
 */
export type DevServerPortLookup = {
  getSessionUpstreamPort(sessionId: string, internalPort?: number): number | null;
};

/**
 * Client-facing description of one mapped dev-server port. Feeds the session
 * preview pane's multi-port selector (rendered only when a group exposes more
 * than one). `url` is the browser-facing proxy URL for that port: the primary
 * keeps the back-compat `/preview/proxy/` mount, extras resolve to
 * `/preview/proxy/p/<internalPort>/`.
 */
export type PreviewPortEntry = {
  internalPort: number;
  label: string;
  primary: boolean;
  url: string;
};
