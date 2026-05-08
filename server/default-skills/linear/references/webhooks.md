# Webhooks — Event Payloads & HMAC Verification

Back to [SKILL.md](../SKILL.md).

## Contents

- [Overview](#overview)
- [Registration](#registration)
- [Supported events](#supported-events)
- [Payload structure](#payload-structure)
- [HMAC signature verification](#hmac-signature-verification)
- [Example payloads](#example-payloads)

## Overview

Linear webhooks send HTTP `POST` requests to your endpoint when workspace events
occur. Each request carries a JSON body describing the event and an HMAC-SHA256
signature in the `Linear-Signature` header.

Reference: <https://linear.app/developers/webhooks>

## Registration

```graphql
mutation WebhookCreate($input: WebhookCreateInput!) {
  webhookCreate(input: $input) {
    success
    webhook { id label url resourceTypes }
  }
}
```

Variables:
```json
{
  "input": {
    "url": "https://your-server.example.com/webhooks/linear",
    "label": "Agent Hub integration",
    "resourceTypes": ["Issue", "Comment", "Project"],
    "teamId": "<team-uuid>",
    "secret": "<random-32-char-string-you-generate>"
  }
}
```

`secret` is set once at creation time — store it securely alongside your
`LINEAR_API_KEY`. Linear never returns it again after creation.

## Supported events

| `type`          | Fires when                                     |
| --------------- | ---------------------------------------------- |
| `Issue`         | Created, updated, removed                      |
| `IssueLabel`    | Label added or removed from an issue           |
| `Comment`       | Created, updated, removed                      |
| `Project`       | Created, updated, removed                      |
| `ProjectUpdate` | A project update (progress post) is created    |
| `Cycle`         | Created, updated, removed                      |
| `Reaction`      | Emoji reaction added or removed                |

## Payload structure

Every webhook payload has this outer shape:

```json
{
  "action": "create" | "update" | "remove",
  "type": "Issue" | "Comment" | ...,
  "organizationId": "<org-uuid>",
  "createdAt": "<ISO 8601 timestamp>",
  "data": { /* resource-specific fields */ },
  "url": "<Linear app URL for the resource>"
}
```

For `update` actions a `updatedFrom` object is included alongside `data`,
showing the previous values of fields that changed:

```json
{
  "action": "update",
  "type": "Issue",
  "data": {
    "id": "...",
    "stateId": "<new-state-uuid>",
    "updatedAt": "..."
  },
  "updatedFrom": {
    "stateId": "<old-state-uuid>",
    "updatedAt": "..."
  }
}
```

## HMAC signature verification

Every webhook POST includes a `Linear-Signature` header. Verify it before
processing any payload:

```bash
EXPECTED=$(echo -n "$RAW_BODY" | openssl dgst -sha256 -hmac "$LINEAR_WEBHOOK_SECRET" | awk '{print $2}')
if [ "$LINEAR_SIGNATURE" != "$EXPECTED" ]; then
  echo "Signature mismatch — rejecting" >&2
  exit 1
fi
```

In Node.js:
```typescript
import { createHmac } from 'crypto';

function verifyLinearSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  return expected === signature;
}
```

Always compare with a constant-time equality function to prevent timing attacks.

## Example payloads

### Issue created

```json
{
  "action": "create",
  "type": "Issue",
  "organizationId": "org-uuid",
  "createdAt": "2024-01-15T10:00:00.000Z",
  "data": {
    "id": "issue-uuid",
    "identifier": "LIN-42",
    "title": "New bug report",
    "priority": 2,
    "stateId": "state-uuid",
    "teamId": "team-uuid",
    "creatorId": "user-uuid",
    "url": "https://linear.app/team/LIN/issue/LIN-42"
  }
}
```

### Issue state changed

```json
{
  "action": "update",
  "type": "Issue",
  "organizationId": "org-uuid",
  "createdAt": "2024-01-15T11:30:00.000Z",
  "data": {
    "id": "issue-uuid",
    "identifier": "LIN-42",
    "stateId": "done-state-uuid",
    "updatedAt": "2024-01-15T11:30:00.000Z"
  },
  "updatedFrom": {
    "stateId": "in-progress-state-uuid",
    "updatedAt": "2024-01-15T09:00:00.000Z"
  }
}
```

### Comment created

```json
{
  "action": "create",
  "type": "Comment",
  "organizationId": "org-uuid",
  "createdAt": "2024-01-15T12:00:00.000Z",
  "data": {
    "id": "comment-uuid",
    "body": "Fixed in PR #123",
    "issueId": "issue-uuid",
    "userId": "user-uuid",
    "createdAt": "2024-01-15T12:00:00.000Z"
  }
}
```
