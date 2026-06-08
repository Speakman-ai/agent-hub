import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Regression guard: the legacy heavy grey "cross-agent" streaming bubble was
 * retired from the web client. It rendered whenever the streaming agent's id
 * differed from the active agent (`streamingAgent.agentId !== activeAgentId`)
 * and dumped raw `whitespace-pre-wrap` narration into a `bg-gray-800
 * rounded-2xl` bubble — the bubble that "kept getting mistriggered". The web
 * chat now always streams through <SessionTail/> (Cursor-style thin stripe).
 *
 * Mobile intentionally keeps its own StreamingMessage bubble, so this guard is
 * scoped to the web client only.
 *
 * These are source-level assertions on purpose: the offending markup lived in
 * inline JSX inside the very large App.jsx render tree, which is impractical to
 * mount with live websocket streaming state. A static guard would have caught
 * the original bug and prevents the bubble from being reintroduced.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, 'App.jsx'), 'utf8');

describe('retired web cross-agent streaming bubble', () => {
  it('App.jsx no longer gates rendering on streamingAgent.agentId !== activeAgentId', () => {
    expect(appSource).not.toMatch(/streamingAgent\.agentId\s*!==\s*activeAgentId/);
  });

  it('App.jsx no longer renders the heavy grey streaming bubble markup', () => {
    // The retired bubble paired a gray-800 rounded bubble with a raw
    // whitespace-pre-wrap streaming-content dump. SessionTail renders markdown
    // inside a thin left stripe instead, never this combination.
    const hasGreyBubble =
      /bg-gray-800 rounded-2xl[^"]*"[\s\S]{0,400}whitespace-pre-wrap[\s\S]{0,200}streamingContent/.test(
        appSource,
      );
    expect(hasGreyBubble).toBe(false);
  });

  it('streaming assistant turns render through SessionTail', () => {
    expect(appSource).toMatch(/streamingMsgId && \(\s*<SessionTail/);
  });

  it('the dead legacy web StreamingMessage component is deleted', () => {
    expect(existsSync(join(here, 'components', 'StreamingMessage.jsx'))).toBe(false);
  });

  it('no web source imports the legacy StreamingMessage component', () => {
    // Mobile keeps its own copy; the web client must not reference it.
    expect(appSource).not.toMatch(/import\s+StreamingMessage/);
  });
});
