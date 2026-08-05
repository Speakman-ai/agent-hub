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

/**
 * Empty-state copy for the "Follow-ups" section when a narrative WAS produced
 * and it listed nothing. This is a positive answer to "what do I have to do?",
 * so it may assert that merging is enough.
 */
export const NO_FOLLOW_UPS_MESSAGE =
  'Nothing to run or configure by hand — merging is all this change needs.';

/**
 * Empty-state copy for the same section when no narrative was produced at all
 * (no API key, the call failed, or there was no change to describe).
 *
 * Kept distinct from {@link NO_FOLLOW_UPS_MESSAGE} on purpose: an empty list
 * because the model found nothing and an empty list because the model never
 * ran look identical in the payload, and telling an operator "merging is all
 * this needs" when we never checked is exactly the miss this section exists to
 * prevent.
 */
export const FOLLOW_UPS_UNAVAILABLE_MESSAGE =
  'Follow-up steps were not generated for this run — check the change yourself ' +
  'for migrations, config, or one-off commands before you rely on it.';

/**
 * Pick the empty-state line for an empty follow-up list.
 *
 * Lives here rather than in either renderer because the server markdown and the
 * web block must agree on when silence means "nothing to do" versus "we never
 * looked". `summarySource` is the only signal in the payload that tells the two
 * apart.
 */
export function followUpsEmptyStateMessage(summarySource: string | null | undefined): string {
  return summarySource === 'llm' ? NO_FOLLOW_UPS_MESSAGE : FOLLOW_UPS_UNAVAILABLE_MESSAGE;
}
