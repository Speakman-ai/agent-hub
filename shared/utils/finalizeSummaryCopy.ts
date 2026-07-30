/**
 * Shared copy for the Finalize run summary.
 *
 * The web client renders the structured payload while mobile, notifications, and
 * transcript export only ever see the markdown body the server builds. Both must
 * say the same thing, so the strings live here rather than in either renderer.
 */

/**
 * Empty-state copy for the summary's "What changed" section.
 *
 * States the consequence, not just the fact. An operator looking at a Changes
 * badge counting their staged files reads a bare "no commits found" as the
 * summary being broken; the usual cause is work that was staged but never
 * committed, and Finalize only ever ships commits.
 */
export const NO_COMMITS_MESSAGE =
  'No commits on this branch, so nothing would ship. Finalize only pushes ' +
  'commits — if your changes are staged or unsaved, commit them and run ' +
  'Finalize again.';
