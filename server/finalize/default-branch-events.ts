/**
 * Broadcast once when a default-branch CI run opens (or reopens) a breakage.
 * Later red runs in the same streak only comment on the breakage card, so
 * people are notified when the branch goes red, not on every failing push
 * after that. Kept dependency-free so the notification fan-out can import it.
 */
export const DEFAULT_BRANCH_CI_FAILED_EVENT = 'default_branch_ci_failed';
