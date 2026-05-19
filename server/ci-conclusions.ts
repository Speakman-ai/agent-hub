/** GitHub check-run conclusions that mean CI failed and the author should fix something. */
export const CI_FAIL_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'cancelled',
]);
