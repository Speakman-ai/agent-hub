# API Escape Hatch — `gh api` for REST and GraphQL

Back to [SKILL.md](../SKILL.md).

## Contents

- [When to use `gh api`](#when-to-use-gh-api)
- [REST — quick reference](#rest--quick-reference)
- [GraphQL — quick reference](#graphql--quick-reference)
- [Pagination](#pagination)
- [Rate limits and secondary rate limits](#rate-limits-and-secondary-rate-limits)
- [JSON filtering with --jq](#json-filtering-with---jq)
- [Common escape-hatch examples](#common-escape-hatch-examples)

---

## When to use `gh api`

The wrapper scripts (`gh-pr.sh`, `gh-issue.sh`, `gh-release.sh`) cover the
most common workflows. Drop to `gh api` when:

- The operation is not in the `gh` CLI surface (e.g., Projects v2 field
  updates, team management, repository secrets).
- You need raw JSON output for downstream processing.
- You need fine-grained pagination control.
- You're using the GraphQL API for complex multi-resource queries.

`gh api` forwards the resolved `GITHUB_TOKEN` / `GH_TOKEN` automatically —
no extra auth setup needed.

---

## REST — quick reference

```bash
# GET — substitute {owner} and {repo} with literals, or use environment vars
gh api repos/{owner}/{repo}
gh api repos/octocat/hello-world/issues?state=open\&per_page=100

# POST
gh api repos/{owner}/{repo}/issues \
  --method POST \
  -f title="Bug: crash on save" \
  -f body="Steps to reproduce…" \
  -f labels='["bug"]'

# PATCH
gh api repos/{owner}/{repo}/issues/42 \
  --method PATCH \
  -f state=closed

# DELETE
gh api repos/{owner}/{repo}/git/refs/heads/old-branch \
  --method DELETE
```

`{owner}` and `{repo}` are placeholders filled by `gh` from the current
repo's remote — or supply the full path literally.

---

## GraphQL — quick reference

```bash
# Inline query
gh api graphql -f query='{ viewer { login } }'

# Multi-line query with variables
gh api graphql \
  -f query='
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: 10, states: OPEN) {
          nodes {
            number
            title
            author { login }
          }
        }
      }
    }
  ' \
  -f owner=octocat \
  -f name=hello-world

# Mutation
gh api graphql -f query='
  mutation($issueId: ID!, $labelIds: [ID!]!) {
    addLabelsToLabelable(input: {labelableId: $issueId, labelIds: $labelIds}) {
      labelable { ... on Issue { id title } }
    }
  }
' -f issueId="I_kwDO..." -F labelIds='["LA_kwDO..."]'
```

---

## Pagination

### REST — `--paginate`

```bash
# Fetch ALL open issues (follows Link headers automatically)
gh api repos/{owner}/{repo}/issues \
  --method GET \
  -F state=open \
  --paginate \
  --jq '.[] | "\(.number)\t\(.title)"'
```

`--paginate` makes successive requests following `next` in the `Link` header
until exhausted. Use with `--jq` to flatten the per-page arrays.

### GraphQL — cursor-based

```bash
# Page through PR list with endCursor
gh api graphql -f query='
  query($cursor: String) {
    repository(owner: "octocat", name: "hello-world") {
      pullRequests(first: 50, after: $cursor, states: OPEN) {
        nodes { number title }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
' --paginate --jq '.data.repository.pullRequests.nodes[] | "\(.number)\t\(.title)"'
```

`--paginate` with GraphQL calls the query repeatedly, substituting the
cursor automatically, until `hasNextPage` is `false`. Requires a `$cursor`
variable in the query.

---

## Rate limits and secondary rate limits

| Limit type | Threshold | Reset |
|-----------|-----------|-------|
| REST primary | 5 000 req/hr (authenticated) | 1 hour rolling |
| GraphQL primary | 5 000 points/hr | 1 hour rolling |
| Secondary (search) | 30 req/min | Short window |
| Secondary (write) | 80 concurrent / short burst | Short window |

Check your current usage:

```bash
gh api rate_limit --jq '.rate | "used: \(.used)/\(.limit), resets at \(.reset | todate)"'
```

When you hit a secondary rate limit, GitHub returns HTTP 403 with a
`Retry-After` header. `scripts/_common.sh`'s `gh_api` wrapper does NOT
automatically retry — inspect the response and back off manually for
now. A simple retry loop:

```bash
for attempt in 1 2 3; do
  if gh api "$path" ...; then break; fi
  echo "Rate limited — sleeping 30s (attempt $attempt)" >&2
  sleep 30
done
```

Docs: https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api

---

## JSON filtering with --jq

`gh api` ships with built-in `--jq` (uses `gojq`; full jq 1.6 syntax):

```bash
# Extract a single field
gh api repos/{owner}/{repo} --jq '.full_name'

# Filter array
gh api repos/{owner}/{repo}/issues?state=open \
  --paginate \
  --jq '.[] | select(.labels[].name == "bug") | "#\(.number) \(.title)"'

# Tabular output
gh api repos/{owner}/{repo}/pulls \
  --jq '.[] | [.number, .user.login, .title] | @tsv'
```

When `--jq` is absent, raw JSON is printed. Pipe to `python3 -m json.tool`
or `jq .` for pretty-printing if you don't have the `--jq` flag available.

---

## Common escape-hatch examples

### Repository secrets (CI/CD)

```bash
# List secrets (names only — values never returned by API)
gh api repos/{owner}/{repo}/actions/secrets --jq '.secrets[].name'

# Set a secret (value must be encrypted — use gh secret set instead)
gh secret set MY_SECRET --body "supersecret"
gh secret list
```

### Branch protection

```bash
# Get current protection rules
gh api repos/{owner}/{repo}/branches/main/protection | python3 -m json.tool

# Require 2 approvals before merge
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 2
  },
  "restrictions": null
}
EOF
```

### Team membership

```bash
# List teams in an org
gh api orgs/{org}/teams --jq '.[] | "\(.slug)\t\(.name)"'

# Add a member to a team
gh api orgs/{org}/teams/{team_slug}/memberships/{username} \
  --method PUT \
  -f role=member
```

### GitHub Projects v2 — status field update

```bash
# Find the project and field IDs first
gh api graphql -f query='
  query {
    user(login: "octocat") {
      projectsV2(first: 5) {
        nodes {
          id title
          fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
        }
      }
    }
  }
'

# Then update the status of a project item
gh api graphql -f query='
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }) {
      projectV2Item { id }
    }
  }
' \
  -f projectId="PVT_kwDO..." \
  -f itemId="PVTI_lADO..." \
  -f fieldId="PVTSSF_kwDO..." \
  -f optionId="f75ad846"
```

### Commit status (required checks)

```bash
# Post a commit status (useful for custom CI integrations)
gh api repos/{owner}/{repo}/statuses/{sha} \
  --method POST \
  -f state=success \
  -f context="my-custom-check" \
  -f description="All checks passed" \
  -f target_url="https://example.com/build/123"
```
