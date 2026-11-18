/**
 * Example Finalize pre-push hook offered in project settings: open a GitHub
 * issue, rename the branch to `<issue#>-<slug>`, and close the issue from the
 * PR. A retry on an already renamed branch re-links the same issue instead
 * of opening another. It stops at the first failed step (`set -euo pipefail`) and checks the
 * issue number, so a failed `gh issue create` or `git branch -m` fails the
 * hook and Finalize does not push.
 */
export const PRE_PUSH_HOOK_EXAMPLE = [
  'set -euo pipefail',
  '# Open a GitHub issue, rename the branch to <issue#>-<slug>, link the PR.',
  '# A branch an earlier run already renamed carries its issue number. Re-link',
  '# it so a retry after a failed push still closes the issue from the PR.',
  'prefix=${AGENT_HUB_BRANCH%%-*}',
  'if [ "$prefix" != "$AGENT_HUB_BRANCH" ] && [ -n "$prefix" ] && [ -z "${prefix//[0-9]/}" ]; then',
  '  echo "Fixes #$prefix" >> "$AGENT_HUB_PR_BODY_APPEND"',
  '  exit 0',
  'fi',
  '[ -z "$AGENT_HUB_EXISTING_PR_URL" ] || exit 0',
  'title="${AGENT_HUB_CARD_TITLE:-$AGENT_HUB_BRANCH}"',
  'url=$(gh issue create --title "$title" --body "Opened by Agent Hub Finalize.")',
  'num=${url##*/}',
  'case "$num" in',
  '  ""|*[!0-9]*) echo "gh issue create returned no issue number: $url" >&2; exit 1 ;;',
  'esac',
  "slug=$(printf '%s' \"$title\" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | cut -c1-40 | sed 's/^-//; s/-$//')",
  'git branch -m "$num-${slug:-change}"',
  'echo "Fixes #$num" >> "$AGENT_HUB_PR_BODY_APPEND"',
].join('\n');
