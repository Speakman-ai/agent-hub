/**
 * Right-hand session slot exclusivity.
 *
 * Changes, Artifacts, the full-size Terminal, and Preview share one slot
 * and must never render as siblings. A *ready* preview is the exception
 * that keeps the iframe: a Terminal request then selects the footer tab
 * instead of mounting SessionTerminalPane next to SessionPreviewPane.
 *
 * Kept as a pure function so the double-render cannot regress without a
 * failing unit test (review: ready-vs-full-size exclusivity).
 */

export type SessionPreviewFooterTab = 'boot' | 'terminal';

export interface SessionRightPaneRequests {
  previewEligible: boolean;
  /** Latest `agenthub_preview` event kind, or null when none. */
  previewKind: string | null | undefined;
  terminalRequested: boolean;
  diffRequested: boolean;
  artifactsRequested: boolean;
}

export interface SessionRightPaneFlags {
  previewReady: boolean;
  showSessionPreviewPane: boolean;
  showSessionTerminalPane: boolean;
  showSessionDiffPane: boolean;
  showSessionArtifactsPane: boolean;
  footerTab: SessionPreviewFooterTab;
}

export function resolveSessionRightPaneFlags({
  previewEligible,
  previewKind,
  terminalRequested,
  diffRequested,
  artifactsRequested,
}: SessionRightPaneRequests): SessionRightPaneFlags {
  // Footer tabs only exist once the iframe is up. While starting/failed/
  // unavailable (or closed), a requested terminal still takes the full slot.
  const previewReady = previewEligible && previewKind === 'preview';
  const showSessionTerminalPane = terminalRequested && !previewReady;
  const showSessionDiffPane = !showSessionTerminalPane && diffRequested;
  // Changes wins if somehow both Changes and Artifacts are flagged.
  const showSessionArtifactsPane =
    !showSessionDiffPane && !showSessionTerminalPane && artifactsRequested;
  // Restore `!showSessionTerminalPane`: when preview is ready that flag is
  // already false, so the iframe+footer path is unchanged. When preview is
  // starting/failed/unavailable and Terminal is requested, preview yields.
  const showSessionPreviewPane =
    !showSessionDiffPane &&
    !showSessionArtifactsPane &&
    !showSessionTerminalPane &&
    previewEligible;

  return {
    previewReady,
    showSessionPreviewPane,
    showSessionTerminalPane,
    showSessionDiffPane,
    showSessionArtifactsPane,
    footerTab: terminalRequested ? 'terminal' : 'boot',
  };
}
