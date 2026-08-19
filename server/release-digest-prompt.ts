/**
 * Shared grouping and coverage rules for every release-digest prompt surface.
 * Keep this the single source of truth so the fact-bounded template, last-in-
 * prompt generation instructions, and model-only system prompt cannot drift.
 */
export const RELEASE_DIGEST_GROUPING_AND_COVERAGE_RULES = [
  'Follow operator guidance for grouping, tone, audience, and emphasis.',
  'The facts.groups array classifies items for prioritization. It is a hint, not a required outline. Do not copy those group labels as section headings when operator guidance specifies a different grouping.',
  'Account for every included release item. Related items may be grouped or summarized, but do not drop a distinct customer-visible change. Only omit work the operator prompt classifies as internal-only, and only when that work does not explain a customer-visible change.',
].join('\n');
