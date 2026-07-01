# Google Workspace — usage & shapes

All calls go through the Hub proxy under `/api/google/*`, scoped to the SESSION
OWNER. Tokens stay server-side. The wrappers send `x-api-key` (resolved by the
agent-hub skill's `ah-api.sh`) plus `X-Agent-Hub-Session-Id`, so the proxy
resolves the owner even on the global break-glass key.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | 2xx — JSON body on stdout |
| `2` | Bad invocation (missing/invalid args) — usage on stderr |
| `3` | Proxy returned 4xx/5xx — a clear, mapped message on stderr |
| `7` | Could not reach the Hub |

A `3` with "has not linked a Google account" means the owner must connect Google
under **Settings → Account → Google**. Do not retry blindly — relay it.

## Calendar

```bash
# Agenda for a window (timeMin/timeMax are required, RFC3339)
scripts/google-cal.sh list --from 2026-06-30T00:00:00Z --to 2026-07-01T00:00:00Z --max 20

# Create an event (offset-less local time + --timezone is fine)
scripts/google-cal.sh create \
  --summary "Design review" \
  --start 2026-06-30T14:00:00 --end 2026-06-30T15:00:00 --timezone America/Los_Angeles \
  --attendee dana@example.com --description "Q3 roadmap" --send-updates all

# Patch an existing event
scripts/google-cal.sh update <eventId> --summary "Design review (moved)" --start 2026-06-30T15:00:00Z --end 2026-06-30T16:00:00Z
```

## Gmail

```bash
scripts/google-mail.sh threads --q "from:alerts is:unread" --max 10
scripts/google-mail.sh thread  <threadId> --format metadata
scripts/google-mail.sh send    --to a@example.com --cc b@example.com --subject "Status" --text "All green."
scripts/google-mail.sh modify  <messageId> --add-label STARRED --remove-label UNREAD
```

`send` requires at least one `--to` and one of `--text` / `--html`. Header
fields reject embedded line breaks (the proxy enforces this).

## Sheets

```bash
scripts/google-sheets.sh get    <spreadsheetId>
scripts/google-sheets.sh values <spreadsheetId> --range 'Sheet1!A1:C10'
scripts/google-sheets.sh append <spreadsheetId> --range 'Sheet1!A1' --values '[["Name","Score"],["Alice",42]]' --input-option USER_ENTERED
scripts/google-sheets.sh update <spreadsheetId> --range 'Sheet1!A1:B2' --values '[["a",1],["b",2]]'
```

`--values` is a JSON row-major matrix of primitive cells (string/number/boolean/null).

## ReAct inline read action

For a quick read inside a single turn (no shelling out), emit a `google` action.
It is **read-only** and scoped to the session owner; writes stay on the wrappers.

```
<agenthub:react>
{"actions":[
  {"tool":"google","surface":"calendar","from":"2026-06-30T00:00:00Z","to":"2026-07-01T00:00:00Z","max":10},
  {"tool":"google","surface":"gmail","q":"is:unread","max":10},
  {"tool":"google","surface":"gmail","threadId":"<id>"},
  {"tool":"google","surface":"sheets","spreadsheetId":"<id>","range":"Sheet1!A1:C10"}
]}
</agenthub:react>
```

Fields by surface:

- `calendar` — `from` + `to` (required, RFC3339), optional `q`, `max`, `calendarId`.
- `gmail` — optional `q`, `max`; or `threadId` to read one thread's headers.
- `sheets` — `spreadsheetId` + `range` (both required).

The host injects a compact markdown summary into the next turn. When the owner
has no connection (or a surface scope is missing), the host injects a
not-linked note pointing to Settings → Account → Google instead.
