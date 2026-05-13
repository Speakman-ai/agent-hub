/**
 * Shared client + server helper: remove Agent Hub control-block tags (and
 * “documentation-example” fenced wrappers) from assistant-visible prose.
 *
 * Kept in `shared/` so web, mobile, Electron, and the Node server cannot drift.
 */

const TAGS = [
  'agenthub:react',
  'agenthub:skill',
  'agenthub:wiki',
  'agenthub:task-state',
  'agenthub:triage',
];

// `[[STEP:<status>:<label>]]` progress-marker protocol — see
// server/stream-parser.ts `STEP_MARKER_RE` (kept in sync). Long-running
// sessions (reviewer, autofix, heartbeat, cron) emit these markers to drive
// the Cursor-Bugbot-style timed checklist (OrchestrationTimelinePanel +
// ProgressPanel). The parser already extracts markers from **finalized**
// assistant events, but partial deltas, crashed/cancelled sessions that fall
// back to `partialFallback`, and legacy persisted messages can all carry raw
// markers into the renderer. Stripping here in the shared util closes the
// loop for streaming flicker, persisted message bodies, and the
// `eventsToBlocks` partial-fallback path uniformly.
const STEP_MARKER_RE = /\[\[STEP:\s*(?:started|completed|failed)\s*:\s*[^\]\n]+?\s*\]\]/gi;

/**
 * @param {string | null | undefined} text
 * @returns {string | null | undefined}
 */
export function stripAssistantControlBlocks(text) {
  if (text == null) return text;
  if (typeof text !== 'string' || !text) return text;

  let result = text;
  // Drop progress-step markers first. They can appear inline with the prose
  // (not fenced), so doing this before the tag-fence pass keeps the
  // trailing-whitespace / blank-line collapse below applicable to both.
  if (result.includes('[[STEP:')) {
    result = result.replace(STEP_MARKER_RE, '');
  }
  for (const tag of TAGS) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Triple-backtick fences (language line optional). Tolerate \r\n.
    result = result.replace(
      new RegExp(
        '```[^`\\n]*\\r?\\n[ \\t]*<' +
          escapedTag +
          '>[\\s\\S]*?</' +
          escapedTag +
          '>[ \\t]*\\r?\\n[ \\t]*```',
        'gi',
      ),
      '',
    );

    // Triple-tilde fences (same semantics as ``` for agents that copy wiki examples).
    result = result.replace(
      new RegExp(
        '~~~[^~\\n]*\\r?\\n[ \\t]*<' +
          escapedTag +
          '>[\\s\\S]*?</' +
          escapedTag +
          '>[ \\t]*\\r?\\n[ \\t]*~~~',
        'gi',
      ),
      '',
    );

    result = result.replace(
      new RegExp(`<${escapedTag}>\\s*[\\s\\S]*?\\s*</${escapedTag}>`, 'gi'),
      '',
    );
  }

  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}
