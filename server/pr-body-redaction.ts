/**
 * Card descriptions flow into PR bodies and commit messages, which end up in
 * the public git history. Bug-report tickets carry a `### Reporter Context`
 * block (see `buildBugReportTicketBody` in `routes/bug-reports.ts`) with the
 * reporter's source URL, user agent, reporting project/agent, and replay path.
 * That is deployment telemetry: useful on the card, never appropriate in git.
 */

const REPORTER_CONTEXT_HEADING = /^#{1,6}\s*Reporter Context\s*$/i;
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^#{1,6}\s/;

/** Drop the Reporter Context section(s) from a card description. */
export function redactCardDescriptionForGit(description: string | null | undefined): string {
  if (!description) return '';
  const lines = description.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (REPORTER_CONTEXT_HEADING.test(line.trim())) {
      skipping = true;
      // The block is introduced by a `---` rule; drop that and the blank
      // lines around it so the redaction leaves no dangling separator.
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      if (out.length && HORIZONTAL_RULE.test(out[out.length - 1])) out.pop();
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      continue;
    }
    if (skipping) {
      if (HORIZONTAL_RULE.test(line) || HEADING.test(line)) {
        skipping = false;
        if (out.length) out.push('');
        // A rule that only closed the redacted block is redundant at the top.
        if (HORIZONTAL_RULE.test(line) && out.length === 0) continue;
      } else {
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n').trim();
}
