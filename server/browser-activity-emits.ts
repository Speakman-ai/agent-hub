import type { BrowserReActStepOutcome } from './browser-tools.js';
import type { BrowserToolActivityEvent } from './types.js';

export function buildBrowserActivityStartedEvent(params: {
  actionId: string;
  op: string;
  label: string;
  startedAtMs: number;
}): BrowserToolActivityEvent {
  const { actionId, op, label, startedAtMs } = params;
  return {
    type: 'browser_tool_activity',
    actionId,
    phase: 'started',
    op,
    label,
    startedAtMs,
  };
}

export function buildBrowserActivityEndedEvent(params: {
  actionId: string;
  op: string;
  label: string;
  startedAtMs: number;
  durationMs: number;
  b: BrowserReActStepOutcome;
}): BrowserToolActivityEvent {
  const { actionId, op, label, startedAtMs, durationMs, b } = params;
  return {
    type: 'browser_tool_activity',
    actionId,
    phase: 'ended',
    op,
    label,
    startedAtMs,
    durationMs,
    ok: b.hostExit === 0,
    summary: b.ui?.summary,
    extractPreview: b.ui?.extractPreview,
    hasScreenshot: Boolean(b.ui?.screenshotCaptured),
    targetSummary: b.ui?.targetSummary,
    error: b.ui?.errorLine,
  };
}

/** When `runBrowserReActStep` throws before returning. */
export function buildBrowserActivityEndedThrowEvent(params: {
  actionId: string;
  op: string;
  label: string;
  startedAtMs: number;
  durationMs: number;
  err: unknown;
}): BrowserToolActivityEvent {
  const { actionId, op, label, startedAtMs, durationMs, err } = params;
  const msg = err instanceof Error ? err.message : String(err);
  return {
    type: 'browser_tool_activity',
    actionId,
    phase: 'ended',
    op,
    label,
    startedAtMs,
    durationMs,
    ok: false,
    summary: 'Browser step failed',
    error: msg,
    hasScreenshot: false,
  };
}

export type BrowserActivityScreenshotBroadcast = {
  type: 'browser_activity_screenshot';
  sessionId: string;
  messageId: string;
  actionId: string;
  screenshotDataUrl: string;
};

export function buildBrowserActivityScreenshotBroadcast(params: {
  sessionId: string;
  messageId: string;
  actionId: string;
  screenshotWsUrl: string | undefined;
}): BrowserActivityScreenshotBroadcast | null {
  const { sessionId, messageId, actionId, screenshotWsUrl } = params;
  if (!screenshotWsUrl) return null;
  return {
    type: 'browser_activity_screenshot',
    sessionId,
    messageId,
    actionId,
    screenshotDataUrl: screenshotWsUrl,
  };
}
