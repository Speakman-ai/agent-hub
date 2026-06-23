const TAGS = [
  'agenthub:react',
  'agenthub:skill',
  'agenthub:wiki',
  'agenthub:task-state',
  'agenthub:triage',
  'agenthub:close-card',
];

const STEP_MARKER_RE = /\[\[STEP:\s*(?:started|completed|failed)\s*:\s*[^\]\n]+?\s*\]\]/gi;

export function stripAssistantControlBlocks(
  text: string | null | undefined,
): string | null | undefined {
  if (text == null) return text;
  if (typeof text !== 'string' || !text) return text;

  let result = text;
  if (result.includes('[[STEP:')) {
    result = result.replace(STEP_MARKER_RE, '');
  }
  for (const tag of TAGS) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
