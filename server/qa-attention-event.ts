/**
 * Broadcast type for a QA plan that needs its owner: fixes landed but nothing
 * tells the plan they reached the target, auto-rerun hit `max_iterations`, or
 * the automatic rerun failed to start. The notification fan-out maps it onto
 * the `qa_attention` inbox category.
 */
export const QA_ATTENTION_EVENT = 'qa_attention';
