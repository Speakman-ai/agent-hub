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
