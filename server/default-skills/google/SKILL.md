---
name: google
description: >-
  Read and write the SESSION OWNER's Google Workspace (Calendar, Gmail, Sheets)
  through Agent Hub's server-side proxy. The Hub holds the OAuth tokens
  (encrypted at rest) and scopes every call to the user who linked their Google
  account, so wrappers never touch a Google access token. TRIGGER when the user
  asks to read/list/search/create calendar events, read/search/send/label Gmail
  threads or messages, or read/append/update Google Sheets values for the
  account linked in Settings → Account → Google. Also trigger on "my calendar",
  "my agenda", "my inbox", "email <person>", "add to the spreadsheet" when an
  Agent Hub Google connection is in view. DO NOT TRIGGER on: third-party
  calendars/mail (Outlook, Apple, Proton, Fastmail); spreadsheet work in
  Excel/CSV files on disk; Google Drive file management (no wrapper yet — use
  ah-api.sh GET /api/google/drive/files); or generic OAuth/Google-Cloud
  questions with no Workspace data request.
category: integration
version: 1.0.0
keep-coding-instructions: true
---

# Google Workspace

Read and act on the **session owner's** Google Calendar, Gmail, and Sheets via
the Hub proxy under `/api/google/*`. The connection is per-Hub-user and lives in
**Settings → Account → Google**. All calls run server-side: the Hub fetches a
fresh access token for the owner, calls Google, and returns shaped JSON.
**Agents never receive a Google token.**

## Scope of access (v1)

Only **non-sensitive + sensitive** scopes, requested incrementally per surface:

- **Calendar** — read/create/update events (`calendar.events`).
- **Gmail** — read threads, send mail, add/remove labels (`gmail.modify` +
  `gmail.send`). No permanent delete, no `gmail.readonly`.
- **Sheets** — read and write values (`spreadsheets`).

If a surface's scope was never granted, the proxy returns a `*_scope_required`
error and the wrapper tells you to enable it under Settings → Account → Google.

## Wrappers

The scripts live in this skill's `scripts/` directory (run them by their path
under the skill dir; the absolute skill dir is shown in the **References** index
of this injection). They resolve auth through the agent-hub skill's `ah-api.sh`
and send the acting session id so the proxy attributes the call to the owner.

```bash
# Calendar
scripts/google-cal.sh list   --from 2026-06-30T00:00:00Z --to 2026-07-01T00:00:00Z [--q TEXT] [--max N] [--calendar ID]
scripts/google-cal.sh create --summary "Launch review" --start 2026-06-30T10:00:00Z --end 2026-06-30T11:00:00Z \
                             [--description T] [--location T] [--timezone TZ] [--attendee a@x.com]… [--calendar ID]
scripts/google-cal.sh update <eventId> [--summary T] [--start ISO] [--end ISO] [--description T] [--calendar ID]

# Gmail
scripts/google-mail.sh threads [--q "is:unread"] [--label INBOX]… [--max N] [--include-spam-trash]
scripts/google-mail.sh thread  <threadId> [--format full|metadata|minimal]
scripts/google-mail.sh send    --to a@x.com… [--cc …] [--bcc …] --subject "…" (--text "…" | --html "…") [--thread <id>]
scripts/google-mail.sh modify  <messageId> [--add-label ID]… [--remove-label ID]…

# Sheets
scripts/google-sheets.sh get    <spreadsheetId>
scripts/google-sheets.sh values <spreadsheetId> --range Sheet1!A1:C10 [--major-dimension ROWS|COLUMNS] [--value-render …]
scripts/google-sheets.sh append <spreadsheetId> --range Sheet1!A1 --values '[["Name","Score"],["Alice",42]]' [--input-option USER_ENTERED]
scripts/google-sheets.sh update <spreadsheetId> --range Sheet1!A1:B2 --values '[["a",1],["b",2]]' [--input-option RAW]
```

Timestamps are RFC3339 (`2026-06-30T09:00:00-07:00`), or pass `--timezone` with
an offset-less local time. `--values` is a JSON row-major matrix. Read ops need
no extra tooling; create/send/append/update build the request body with `jq`.

## Not linked?

If the owner has not linked Google (or the OAuth app isn't configured, or a
surface scope is missing), the wrapper exits **3** and prints a clear pointer to
**Settings → Account → Google**. That is expected — relay it to the user; do not
retry blindly.

## Inline context (ReAct)

For a quick read inside a turn without shelling out, emit a `google` ReAct
action (read-only — calendar/gmail/sheets):

```
<agenthub:react>
{"actions":[{"tool":"google","surface":"calendar","from":"2026-06-30T00:00:00Z","to":"2026-07-01T00:00:00Z"}]}
</agenthub:react>
```

See **[references/usage.md](references/usage.md)** for the full ReAct action
shape and response examples.

## Guardrails

- Never print or log a Google access token — the proxy never returns one.
- Writes (create event, send mail, modify labels, append/update cells) act on
  the owner's real account. Confirm intent for anything user-visible (an email
  going out, an invite, a destructive overwrite) unless the user already said
  "go ahead".
- Drive is not wrapped in v1; for app-created/opened files use
  `ah-api.sh GET /api/google/drive/files`.

## See also

- Core skill `agent-hub` — env contract, auth (`ah-api.sh`), error reporting.
- `references/usage.md` — recipes, ReAct action shape, response shapes.
