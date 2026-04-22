/** Indent each line so markdown renders as a literal block (safe with nested ```). */
export function indentMarkdownLines(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * Append streamed verify stdout/stderr to a system message using the same
 * indented-block style as failures (no outer triple-backtick fences).
 */
export function appendVerifyOutputToMarkdownBody(markdown: string, accumulated: string): string {
  const t = accumulated.trim();
  if (!t) return markdown;
  return `${markdown}\n\n**Verify command output:**\n\n${indentMarkdownLines(t)}`;
}

/**
 * Build markdown for a pre-done verification failure without triple-backtick
 * fences (command output can contain ``` and break rendering).
 */
export function buildVerifyFailureMarkdownBody(errMsg: string, accumulated: string): string {
  let body =
    '**Pre-done verification failed.** The linked kanban card was **not** moved to Done.\n\n**Error:**\n\n';
  body += indentMarkdownLines(errMsg);
  if (accumulated.trim()) {
    body += '\n\n**Command output:**\n\n';
    body += indentMarkdownLines(accumulated.trim());
  }
  return body;
}
