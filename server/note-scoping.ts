/**
 * Kickoff prompt for a scoping session seeded from note content.
 *
 * Unlike the epic-linked scope session (which starts empty and lets the
 * scoping-mode preamble inject the epic), a note-seeded scoping session
 * auto-sends the captured notes as the first turn so the agent immediately
 * turns the free-form notes into an Epic → Phases → Tickets structure. The
 * scoping-mode preamble (chat.ts) still carries the hierarchy contract and
 * rules; this prompt only supplies the raw material and the ask.
 */

export function buildNoteScopingKickoff(args: {
  content: string;
  title?: string | null;
  projectName: string;
}): string {
  const { content, title, projectName } = args;
  const heading = title && title.trim() ? title.trim() : 'Untitled notes';

  return [
    `Scope the following notes from the "${projectName}" project into structured work on the kanban board.`,
    '',
    `**Source:** ${heading}`,
    '',
    'Read the notes, then organize them following the scoping-mode hierarchy contract — create an epic, add at least one phase, lock any spec decisions the notes imply, and file implementation tickets under the epic and its phase(s). Group related bullet points into cohesive tickets rather than one card per line. If the notes are too thin to scope, say so instead of inventing work.',
    '',
    '## Notes',
    '',
    content.trim(),
    '',
  ].join('\n');
}
