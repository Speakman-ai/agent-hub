# API Overview — GraphQL Primer & Common Queries

Back to [SKILL.md](../SKILL.md).

## Contents

- [Endpoint & request shape](#endpoint--request-shape)
- [Pagination](#pagination)
- [Error handling](#error-handling)
- [Common queries](#common-queries)
  - [Viewer (current user)](#viewer-current-user)
  - [List teams](#list-teams)
  - [List workflow states](#list-workflow-states)
  - [List issues](#list-issues)
  - [Get issue by ID](#get-issue-by-id)
  - [Search issues](#search-issues)
  - [List projects](#list-projects)
  - [List cycles](#list-cycles)
  - [List comments](#list-comments)
- [Common mutations](#common-mutations)
  - [Create issue](#create-issue)
  - [Update issue](#update-issue)
  - [Create comment](#create-comment)
- [Priority values](#priority-values)
- [Rate limiting](#rate-limiting)

## Endpoint & request shape

```
POST https://api.linear.app/graphql
Content-Type: application/json
Authorization: <PERSONAL_API_KEY>
```

Body:
```json
{
  "query": "...",
  "variables": { "key": "value" }
}
```

Always prefer named variables over string interpolation to avoid injection
issues and to keep queries cacheable by the server.

## Pagination

Linear uses **Relay cursor-based pagination**:

```graphql
query Issues($cursor: String) {
  issues(first: 50, after: $cursor) {
    nodes { id title state { name } }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

- Use `first` + `after` to page forward; `last` + `before` to page backward.
- `pageInfo.hasNextPage` is true when more results exist.
- Pass `pageInfo.endCursor` as `after` in the next request.
- Default page size in `scripts/linear.sh` is 50; maximum is 250.

## Error handling

The API returns standard GraphQL errors:

```json
{
  "errors": [
    {
      "message": "Entity not found",
      "extensions": { "code": "ENTITY_NOT_FOUND", "type": "notFound" },
      "path": ["issue"]
    }
  ]
}
```

Check for `errors` in the response before reading `data`. The scripts handle
this automatically and print the error message to stderr with a non-zero exit.

Common error codes:
| Code                    | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| `AUTHENTICATION_ERROR`  | Missing or invalid API key               |
| `AUTHORIZATION_ERROR`   | Key lacks permission for the resource    |
| `ENTITY_NOT_FOUND`      | Issue / team / user ID does not exist    |
| `RATELIMITED`           | Too many requests — back off and retry   |

## Common queries

### Viewer (current user)

```graphql
query Viewer {
  viewer {
    id
    name
    email
    teams { nodes { id name key } }
  }
}
```

### List teams

```graphql
query Teams {
  teams(first: 50) {
    nodes {
      id
      name
      key
      timezone
    }
  }
}
```

### List workflow states

```graphql
query WorkflowStates($teamId: String!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }) {
    nodes {
      id
      name
      type   # "triage" | "backlog" | "unstarted" | "started" | "completed" | "cancelled"
      color
      position
    }
  }
}
```

### List issues

```graphql
query Issues($teamId: String, $cursor: String) {
  issues(
    first: 50
    after: $cursor
    filter: { team: { id: { eq: $teamId } } }
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier    # e.g. "LIN-42"
      title
      state { id name type }
      assignee { id name }
      priority
      priorityLabel
      createdAt
      updatedAt
      url
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### Get issue by ID

```graphql
query Issue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    state { id name type }
    assignee { id name email }
    priority
    priorityLabel
    labels { nodes { id name color } }
    project { id name }
    cycle { id name number }
    createdAt
    updatedAt
    url
    comments(first: 25) {
      nodes {
        id
        body
        user { id name }
        createdAt
      }
    }
  }
}
```

Pass either the UUID (`"abc123"`) or the human identifier (`"LIN-42"`) as `$id`.

### Search issues

```graphql
query SearchIssues($query: String!, $cursor: String) {
  issueSearch(query: $query, first: 25, after: $cursor) {
    nodes {
      id
      identifier
      title
      state { name }
      assignee { name }
      url
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### List projects

```graphql
query Projects($teamId: String, $cursor: String) {
  projects(
    first: 50
    after: $cursor
    filter: { accessibleTeams: { id: { eq: $teamId } } }
  ) {
    nodes {
      id
      name
      state
      targetDate
      progress
      url
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### List cycles

```graphql
query Cycles($teamId: String!) {
  cycles(filter: { team: { id: { eq: $teamId } } }, first: 20) {
    nodes {
      id
      name
      number
      startsAt
      endsAt
      completedAt
    }
  }
}
```

### List comments

```graphql
query Comments($issueId: String!, $cursor: String) {
  comments(
    filter: { issue: { id: { eq: $issueId } } }
    first: 50
    after: $cursor
  ) {
    nodes {
      id
      body
      user { id name }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

## Common mutations

### Create issue

```graphql
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}
```

Variables:
```json
{
  "input": {
    "title": "Bug: login fails on Safari",
    "teamId": "<team-uuid>",
    "description": "Steps to reproduce: ...",
    "stateId": "<state-uuid>",
    "priority": 2,
    "assigneeId": "<user-uuid>",
    "projectId": "<project-uuid>",
    "cycleId": "<cycle-uuid>",
    "labelIds": ["<label-uuid>"]
  }
}
```

All fields except `title` and `teamId` are optional.

### Update issue

```graphql
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      title
      state { name }
      url
    }
  }
}
```

Variables:
```json
{
  "id": "LIN-42",
  "input": {
    "stateId": "<target-state-uuid>",
    "title": "Updated title",
    "priority": 1
  }
}
```

### Create comment

```graphql
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
      createdAt
    }
  }
}
```

Variables:
```json
{
  "input": {
    "issueId": "<issue-uuid-or-identifier>",
    "body": "Fixed in PR #123."
  }
}
```

## Priority values

| Integer | Label     |
| ------- | --------- |
| `0`     | No priority |
| `1`     | Urgent    |
| `2`     | High      |
| `3`     | Medium    |
| `4`     | Low       |

## Rate limiting

Linear enforces rate limits per API key:

- **Queries**: ≈1 500 requests / minute
- **Mutations**: ≈100 requests / minute

When a limit is hit the API returns HTTP `429` with an `X-RateLimit-Reset`
header (Unix timestamp). The scripts back off with exponential jitter on `429`.

For bulk operations, batch queries using `first: 250` to reduce round trips.
